"""实验：局部重解码需要多少前置/后置上下文（pad），才能与全曲解码一致？

背景：
  产品要做「局部重绘」—— 用户框选一段时间，用某个档位重新解码这一段，
  然后覆盖或保留原结果。

  但 HMM 是 Viterbi 解码，有状态、依赖前后文。只解一小段，
  片段首尾会因缺少上下文而出错。所以必须带 pad，只采纳中间目标区间。

本实验要回答：
  Q1. pad 多大，局部解码在目标区间内与全曲解码完全一致？
  Q2. pad 的收益是否随长度饱和？前置/后置是否对称？
  Q3. 三档词典的 pad 需求是否不同？

方法：
  1. 全曲一次性解码，作为 ground truth
  2. 取一组目标区间（覆盖不同音乐段落、不同长度）
  3. 对每个目标区间，用 pad ∈ {0, 1, 2, 3, 5, 8, 10, 15, 20} 局部解码
  4. 比较「目标区间内」的段边界与和弦，与 ground truth 的差异

用法：
    conda activate harmonize
    python neural/probe_local_redecode.py "E:\\音乐\\Aimer - Refrain.flac"
"""

import sys
import time
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"
sys.path.insert(0, str(NEURAL / "lv-chordia"))

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - Refrain.flac")
SR = 22050
HOP = 512
FPS = SR / HOP          # 43.07

# 目标测试区间（秒）：不同长度、不同音乐段落
TARGETS = [
    (18.0, 25.0),    # 长度 7s，副歌前
    (40.0, 50.0),    # 长度 10s
    (60.0, 65.0),    # 长度 5s，短
    (100.0, 130.0),  # 长度 30s，长
    (170.0, 180.0),  # 长度 10s，之前发现有八度错误的位置
    (250.0, 260.0),  # 长度 10s，尾部稠密段
]

PADS = [0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 10.0, 15.0, 20.0]
DICTS = ["submission", "full"]


def hr(t):
    print()
    print("=" * 78)
    print(f"  {t}")
    print("=" * 78)


def slice_labels(labels, t0, t1):
    """把重叠的段切开，返回 [t0,t1) 内每个时间点的和弦（以段边界为节点）。

    返回 [(start, end, chord), ...] 已裁剪到 [t0, t1)。
    """
    out = []
    for s, e, ch in labels:
        a = max(s, t0)
        b = min(e, t1)
        if b - a > 1e-6:
            out.append((a, b, ch))
    return out


def compare(local, truth, t0, t1, tol=0.01):
    """比较目标区间内的解码结果。

    指标：
      seg_match  : 段数与边界+和弦完全一致 -> True
      chord_acc  : 按 100ms 网格采样的和弦一致率（更宽容、更贴近听感）
      n_local / n_truth : 段数
      max_edge_err : 边界时间最大误差
    """
    lt = slice_labels(truth, t0, t1)
    lo = slice_labels(local, t0, t1)

    # 网格采样比较和弦
    grid = np.arange(t0 + 0.05, t1 - 0.05, 0.1)
    if len(grid) == 0:
        return None

    def chord_at(labels, t):
        for s, e, ch in labels:
            if s - 1e-9 <= t < e - 1e-9:
                return ch
        return None

    same = sum(1 for t in grid if chord_at(lt, t) == chord_at(lo, t))
    acc = same / len(grid)

    exact = (len(lt) == len(lo) and all(
        abs(a[0] - b[0]) < tol and a[2] == b[2]
        for a, b in zip(lt, lo)))

    max_edge = 0.0
    if len(lt) == len(lo):
        max_edge = max(abs(a[0] - b[0]) for a, b in zip(lt, lo))

    return {
        "seg_match": exact,
        "chord_acc": acc,
        "n_local": len(lo),
        "n_truth": len(lt),
        "max_edge_err": max_edge,
    }


def main():
    import librosa
    import soxr
    import soundfile as sf
    import importlib.resources
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.mir.nn.network import NetworkInterface
    from lv_chordia.mir import DataEntry, io
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
    from lv_chordia.config import model_names

    hr("1. 加载音频 + CQT")
    with sf.SoundFile(str(AUDIO)) as f:
        sr0 = f.samplerate
        chunks = []
        while True:
            try:
                d = f.read(sr0 * 5, dtype="float32", always_2d=True)
            except Exception:  # noqa: BLE001
                break
            if len(d) == 0:
                break
            chunks.append(d)
    sig = np.concatenate(chunks, axis=0)
    sig = sig.mean(axis=1) if sig.shape[1] > 1 else sig[:, 0]
    y = soxr.resample(sig, sr0, SR) if sr0 != SR else sig
    dur = len(y) / SR

    cqt = np.abs(librosa.core.hybrid_cqt(
        y, sr=SR, bins_per_octave=36, n_bins=288,
        fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=HOP,
    )).T.astype(np.float32)
    print(f"音频 {dur:.2f}s  cqt {cqt.shape}  fps={FPS:.2f}")

    hr("2. 5 模型 ensemble 推理（只做一次，三档与所有 pad 共用）")
    probs = []
    for n in model_names():
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        ni = NetworkInterface(net, n)
        probs.append(ni.inference(cqt))
    avg = [np.mean([p[k] for p in probs], axis=0) for k in range(6)]
    print(f"完成，每头形状 {avg[0].shape}")

    hr("3. 全曲解码 = ground truth")
    entry_full = DataEntry()
    entry_full.prop.set("sr", SR)
    entry_full.prop.set("hop_length", HOP)
    entry_full.append_file(str(AUDIO), io.MusicIO, "music")
    entry_full.cqt = cqt

    truths = {}
    for name in DICTS:
        with importlib.resources.path("lv_chordia.data", f"{name}_chord_list.txt") as tpl:
            hmm = XHMMDecoder(template_file=str(tpl))
        truths[name] = hmm.decode_to_chordlab(entry_full, avg, False)
        print(f"  {name:12s} 全曲 {len(truths[name])} 段")

    hr("4. 局部解码：不同 pad 对目标区间的还原度")

    results = {}
    for name in DICTS:
        print(f"\n{'─'*78}")
        print(f"  档位: {name}")
        print(f"{'─'*78}")
        with importlib.resources.path("lv_chordia.data", f"{name}_chord_list.txt") as tpl:
            hmm = XHMMDecoder(template_file=str(tpl))

        print(f"  {'目标区间':>16s}  {'pad':>5s}  {'段一致':>7s} {'和弦一致率':>10s} "
              f"{'段数':>9s} {'边界误差':>9s}")
        for (t0, t1) in TARGETS:
            for pad in PADS:
                a = max(0.0, t0 - pad)
                b = min(dur, t1 + pad)
                f0 = int(round(a * FPS))
                f1 = int(round(b * FPS))
                f1 = min(f1, cqt.shape[0])
                if f1 - f0 < 20:
                    continue

                sub_cqt = cqt[f0:f1]
                sub_probs = [p[f0:f1] for p in avg]

                entry = DataEntry()
                entry.prop.set("sr", SR)
                entry.prop.set("hop_length", HOP)
                entry.cqt = sub_cqt
                # 关键：让解码拿到正确的起始时间，否则输出时间戳从 0 开始
                entry.append_file(str(AUDIO), io.MusicIO, "music")
                entry.cqt = sub_cqt

                lab = hmm.decode_to_chordlab(entry, sub_probs, False)
                # decode_to_chordlab 的时间戳是相对片段的，加回 a
                lab_abs = [(s + a, e + a, ch) for (s, e, ch) in lab]

                r = compare(lab_abs, truths[name], t0, t1)
                if r is None:
                    continue
                tag = "OK" if r["seg_match"] else "diff"
                print(f"  [{t0:6.1f},{t1:6.1f}]  {pad:5.1f}  {tag:>7s} "
                      f"{r['chord_acc']*100:9.1f}% "
                      f"{r['n_local']:3d}/{r['n_truth']:3d} "
                      f"{r['max_edge_err']*1000:8.1f}ms")
                results[(name, t0, t1, pad)] = r
                if r["seg_match"] and r["chord_acc"] > 0.999:
                    break

    hr("5. 汇总：达到 100% 一致所需的最小 pad")

    for name in DICTS:
        print(f"\n  【{name}】")
        print(f"    {'目标区间':>16s}  {'最小 pad':>9s}")
        needs = []
        for (t0, t1) in TARGETS:
            best = None
            for pad in PADS:
                r = results.get((name, t0, t1, pad))
                if r and r["chord_acc"] > 0.999 and r["seg_match"]:
                    best = pad
                    break
            print(f"    [{t0:6.1f},{t1:6.1f}]  {('%.0fs' % best) if best is not None else '>20s':>9s}")
            if best is not None:
                needs.append(best)
        if needs:
            print(f"    -> 中位需求 {np.median(needs):.0f}s, 最大 {max(needs):.0f}s")

    hr("6. 关键问题：pad 是否只影响边界，还是影响整段？")
    print("  下面看一个具体例子：目标 [18,25]，各 pad 下的和弦序列")
    name = "submission"
    t0, t1 = 18.0, 25.0
    truth = slice_labels(truths[name], t0, t1)
    print(f"\n  ground truth:")
    for s, e, ch in truth:
        print(f"    {s:6.2f} ~ {e:6.2f}  {ch}")
    for pad in (0.0, 1.0, 3.0, 5.0):
        a = t0 - pad
        b = t1 + pad
        f0 = max(0, int(round(a * FPS)))
        f1 = min(int(round(b * FPS)), cqt.shape[0])
        entry = DataEntry()
        entry.prop.set("sr", SR)
        entry.prop.set("hop_length", HOP)
        entry.cqt = cqt[f0:f1]
        entry.append_file(str(AUDIO), io.MusicIO, "music")
        entry.cqt = cqt[f0:f1]
        with importlib.resources.path("lv_chordia.data", f"{name}_chord_list.txt") as tpl:
            hmm = XHMMDecoder(template_file=str(tpl))
        lab = hmm.decode_to_chordlab(entry, [p[f0:f1] for p in avg], False)
        lab_abs = [(s + f0 / FPS, e + f0 / FPS, ch) for (s, e, ch) in lab]
        got = slice_labels(lab_abs, t0, t1)
        print(f"\n  pad={pad}s -> {len(got)} 段:")
        for s, e, ch in got:
            print(f"    {s:6.2f} ~ {e:6.2f}  {ch}")


if __name__ == "__main__":
    main()
