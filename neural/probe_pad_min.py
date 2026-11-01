"""确认最小安全 pad：为什么 1s 有时够、有时不够？

上一轮观察：
  [18,25]   pad=1s -> 100%（但 pad=0s 只有 44.9%）
  [250,260] pad=1/2s 仍不一致，需 10s
  [60,65]   pad=1s -> OK，但和弦一致率 98%（不是 100%）

怀疑：差异集中在目标区间的**两端边界**，而不是整段错。
      pad 的作用是给 Viterbi 一个"起手正确的状态"，其影响按帧向外衰减。

本实验：
  1. 对固定目标区间，测 pad 从 0 到 6 秒（步长 0.5s）的逐步变化
  2. 把误差按"距离区间端点的位置"分桶统计，看衰减曲线
  3. 给出建议：为了让 N 秒内的误差 < 1%，需要多大的 pad
"""

import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
sys.path.insert(0, str(NEURAL / "lv-chordia"))

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - Refrain.flac")
SR, HOP = 22050, 512
FPS = SR / HOP

TARGET = (250.0, 262.0)      # 上一轮最难的区间
PADS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]


def hr(t):
    print()
    print("=" * 76)
    print(f"  {t}")
    print("=" * 76)


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

    hr("准备：CQT + 5 模型（一次性）")
    cqt = np.abs(librosa.core.hybrid_cqt(
        y, sr=SR, bins_per_octave=36, n_bins=288,
        fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=HOP,
    )).T.astype(np.float32)
    probs = []
    for n in model_names():
        probs.append(NetworkInterface(
            ChordNet(cross_subpart_counter=None, use_gpu=False), n).inference(cqt))
    avg = [np.mean([p[k] for p in probs], axis=0) for k in range(6)]
    print(f"完成 cqt={cqt.shape}")

    entry_full = DataEntry()
    entry_full.prop.set("sr", SR)
    entry_full.prop.set("hop_length", HOP)
    entry_full.append_file(str(AUDIO), io.MusicIO, "music")
    entry_full.cqt = cqt

    with importlib.resources.path("lv_chordia.data", "submission_chord_list.txt") as tpl:
        hmm = XHMMDecoder(template_file=str(tpl))
        tpl_path = str(tpl)
    truth = hmm.decode_to_chordlab(entry_full, avg, False)

    t0, t1 = TARGET

    def chord_series(labels, a, b, step=0.02):
        """返回 [a,b) 上每 step 秒的和弦标签"""
        grid = np.arange(a, b, step)
        out = []
        for t in grid:
            c = None
            for s, e, ch in labels:
                if s - 1e-9 <= t < e - 1e-9:
                    c = ch
                    break
            out.append(c)
        return grid, out

    hr(f"1. 目标区间 [{t0}, {t1}] 在不同 pad 下的误差分布")

    grid_t, truth_s = chord_series(truth, t0, t1)

    print(f"  {'pad':>5s}  {'不一致帧':>9s} {'不一致率':>9s}  {'错误距左端':>22s}  {'错误距右端':>22s}")
    for pad in PADS:
        a = max(0.0, t0 - pad)
        b = min(dur, t1 + pad)
        f0, f1 = int(round(a * FPS)), min(int(round(b * FPS)), cqt.shape[0])
        e = DataEntry()
        e.prop.set("sr", SR)
        e.prop.set("hop_length", HOP)
        e.cqt = cqt[f0:f1]
        e.append_file(str(AUDIO), io.MusicIO, "music")
        e.cqt = cqt[f0:f1]
        with importlib.resources.path("lv_chordia.data", "submission_chord_list.txt") as tp:
            h = XHMMDecoder(template_file=str(tp))
        lab = [(s + f0 / FPS, en + f0 / FPS, ch) for (s, en, ch) in
               h.decode_to_chordlab(e, [p[f0:f1] for p in avg], False)]

        _, got_s = chord_series(lab, t0, t1)
        bad = [i for i, (x, y_) in enumerate(zip(truth_s, got_s)) if x != y_]
        if bad:
            d_left = grid_t[bad[0]] - t0
            d_right = t1 - grid_t[bad[-1]]
            # 连续错误块
            print(f"  {pad:5.1f}  {len(bad):9d} {len(bad)/len(grid_t)*100:8.1f}%  "
                  f"最近 {d_left:6.2f}s 最远 {grid_t[bad[-1]]-t0:6.2f}s  "
                  f"最近 {d_right:6.2f}s")
        else:
            print(f"  {pad:5.1f}  {0:9d} {0.0:8.1f}%  {'—':>22s}  {'—':>22s}")

    hr("2. 关键：错误是否随 pad 增长而单调收敛？")
    print("  理论：Viterbi 的起手状态错误会按转移代价向外衰减。")
    print("  若 pad 增大错误只减不增，说明是「边界修复」；")
    print("  若出现反复，说明存在多个近等价的解码路径（歧义），需要更长上下文。")

    hr("3. 建议")
    print("  见 ADR-0002")


if __name__ == "__main__":
    main()
