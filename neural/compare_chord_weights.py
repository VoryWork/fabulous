"""对比 lv-chordia 不同 label-reweighting 权重的识别效果。

## 为什么要做这个

实测《満ちてゆく》有 2 段大长 `N`（7.7s / 18.5s），三个词典档位一致判 N，
音频 RMS 与前后段落一致（不是静音）—— 判断为模型识别失效。

lv-chordia 官方提供了 6 组 label-reweighting 参数训练的权重：

    (0.0,10.0)  ← 当前内置（gamma=0 等价于 no_reweight）
    (0.3,10.0)
    (0.5,10.0)
    (0.7,20.0)
    (1.0, 1.0)
    (1.0,20.0)  ← 稀有和弦加权最强

reweighting 按 w(i) = (n_max/n(i))^gamma 放大稀有类的损失权重，
理论上会让模型更"敢"输出低频和弦，而不是退化成 N。

## 判据（不是"感觉更好"）

对同一首歌，比较：
  1. `N` 段的数量与总时长（主指标：N 越少说明越少放弃）
  2. 和弦段总数（变化太剧烈说明在乱猜）
  3. 每段平均时长
  4. 特定可疑区间（31~38.68s、215.46~233.94s）的判定

用法：
    python -u neural/compare_chord_weights.py <audio_path>
"""

import sys
import json
from pathlib import Path

import numpy as np


NEURAL = Path(__file__).parent.resolve()
LV = NEURAL / "lv-chordia"
TEST_RANGES = [(31.0, 38.68), (215.46, 233.94)]


def load_cqt(audio_path: Path):
    """计算 CQT（只算一次，所有权重共用）。"""
    import librosa
    import soxr
    import soundfile as sf

    with sf.SoundFile(str(audio_path)) as f:
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
    y = soxr.resample(sig, sr0, 22050) if sr0 != 22050 else sig

    cqt = np.abs(
        librosa.core.hybrid_cqt(
            y, sr=22050, bins_per_octave=36, n_bins=288,
            fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=512,
        )
    ).T.astype(np.float32)
    return cqt


def decode_with(cqt, audio_path: Path, weights_dir: Path, reweight: str):
    """用指定的权重目录跑一遍 guitar decode。"""
    import importlib.resources
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
    from lv_chordia.mir import DataEntry, io
    from lv_chordia.mir.nn.network import NetworkInterface

    names = [f"joint_chord_net_ismir_naive_v1.0_reweight({reweight})_s{i}.best"
             for i in range(5)]

    probs = []
    # `NetworkInterface.__init__` 里是 `from ..common import WEIGHTS_PATH`，
    # 每次构造都会重新读模块属性，所以在这里 patch 是生效的。
    import lv_chordia.mir.common as common
    orig = common.WEIGHTS_PATH
    common.WEIGHTS_PATH = str(weights_dir)
    try:
        for n in names:
            net = ChordNet(cross_subpart_counter=None, use_gpu=False)
            ni = NetworkInterface(net, n)
            probs.append(ni.inference(cqt))
    finally:
        common.WEIGHTS_PATH = orig
    avg = [np.mean([p[k] for p in probs], axis=0) for k in range(6)]

    entry = DataEntry()
    entry.prop.set("sr", 22050)
    entry.prop.set("hop_length", 512)
    entry.append_file(str(audio_path), io.MusicIO, "music")
    entry.cqt = cqt

    with importlib.resources.path("lv_chordia.data", "submission_chord_list.txt") as tpl:
        hmm = XHMMDecoder(template_file=str(tpl))
    lab = hmm.decode_to_chordlab(entry, avg, False)
    return [
        {"start": round(float(s), 3), "end": round(float(e), 3), "chord": str(ch)}
        for (s, e, ch) in lab
    ]


def stats(segs, label):
    ns = [c for c in segs if c["chord"] == "N"]
    n_dur = sum(c["end"] - c["start"] for c in ns)
    total = segs[-1]["end"] - segs[0]["start"] if segs else 0
    print(f"\n--- {label} ---")
    print(f"  段数 {len(segs)}   N 段 {len(ns)} 个 / 共 {n_dur:.1f}s "
          f"({n_dur / total * 100:.1f}%)")
    print(f"  平均段长 {total / max(1, len(segs)):.2f}s")
    for lo, hi in TEST_RANGES:
        mid = (lo + hi) / 2
        hit = [c for c in segs if c["start"] <= mid < c["end"]]
        got = hit[0]["chord"] if hit else "?"
        # 该区间覆盖了几个和弦
        inside = [c for c in segs if c["end"] > lo and c["start"] < hi]
        print(f"  区间 {lo:.1f}~{hi:.1f}s: 中点={got:10s} 区间内 {len(inside)} 段: "
              f"{', '.join(c['chord'] for c in inside[:6])}")
    return {"segs": len(segs), "n_count": len(ns), "n_dur": n_dur}


def main():
    if len(sys.argv) < 2:
        print("用法: python compare_chord_weights.py <audio_path>")
        return
    audio = Path(sys.argv[1])
    sys.path.insert(0, str(LV))

    print(f"音频: {audio}")
    print("计算 CQT…")
    cqt = load_cqt(audio)
    print(f"CQT shape {cqt.shape}")

    builtin = LV / "weights"
    alt = builtin / "alt"

    results = {}
    for rw, wdir in [
        ("0.0,10.0", builtin),
        ("0.3,10.0", alt),
        ("1.0,20.0", alt),
    ]:
        print(f"\n推理 reweight({rw}) …")
        try:
            segs = decode_with(cqt, audio, wdir, rw)
        except Exception as e:  # noqa: BLE001
            print(f"  失败: {type(e).__name__}: {e}")
            continue
        results[rw] = stats(segs, f"reweight({rw})")
        (NEURAL / f"chords_cmp_{rw.replace(',', '_')}.json").write_text(
            json.dumps(segs, ensure_ascii=False, indent=1), encoding="utf-8"
        )

    print("\n\n==== 汇总 ====")
    print(f"{'权重':<14} {'段数':>5} {'N 段':>5} {'N 时长':>8}")
    for rw, r in results.items():
        print(f"{rw:<14} {r['segs']:>5} {r['n_count']:>5} {r['n_dur']:>7.1f}s")


if __name__ == "__main__":
    main()
