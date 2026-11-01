"""验证：三档 chord dictionary 是「同一套网络输出 + 三套 HMM 解码」，
而不是三套模型。

如果是这样，产品里"切换档位重新分析"的成本极低：
  - 不需要重跑 CQT（最贵，3.2s）
  - 不需要重跑 5 模型 ensemble（2.4s）
  - 只需要重跑 HMM 解码（毫秒级）

本脚本用真实音频验证这个假设，并输出三档的结果对比。
"""

import sys
import time
from pathlib import Path

import numpy as np
import torch

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"
sys.path.insert(0, str(NEURAL / "lv-chordia"))

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - Refrain.flac")
DICTS = ["submission", "ismir2017", "full"]


def hr(t):
    print()
    print("=" * 74)
    print(f"  {t}")
    print("=" * 74)


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

    hr("1. 加载音频 + CQT（只做一次）")
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
    y = soxr.resample(sig, sr0, 22050) if sr0 != 22050 else sig

    t0 = time.perf_counter()
    cqt = np.abs(librosa.core.hybrid_cqt(
        y, sr=22050, bins_per_octave=36, n_bins=288,
        fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=512,
    )).T.astype(np.float32)
    t_cqt = time.perf_counter() - t0
    print(f"音频 {len(y)/22050:.2f}s  cqt {cqt.shape}  耗时 {t_cqt*1000:.0f} ms")

    hr("2. 5 模型 ensemble 推理（只做一次）")
    t0 = time.perf_counter()
    probs = []
    for n in model_names():
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        ni = NetworkInterface(net, n)
        probs.append(ni.inference(cqt))
    t_net = time.perf_counter() - t0
    avg = [np.mean([p[k] for p in probs], axis=0) for k in range(6)]
    print(f"5 模型合计 {t_net*1000:.0f} ms")

    entry = DataEntry()
    entry.prop.set("sr", 22050)
    entry.prop.set("hop_length", 512)
    entry.append_file(str(AUDIO), io.MusicIO, "music")
    entry.cqt = cqt

    hr("3. 三档 HMM 解码（复用同一份模型输出）")
    results = {}
    for name in DICTS:
        with importlib.resources.path("lv_chordia.data", f"{name}_chord_list.txt") as tpl:
            hmm = XHMMDecoder(template_file=str(tpl))
        t0 = time.perf_counter()
        lab = hmm.decode_to_chordlab(entry, avg, False)
        dt = time.perf_counter() - t0
        results[name] = lab

        n_tpl = sum(1 for _ in open(tpl, encoding="utf-8")) - 1  # 去掉首行
        vocab = sorted(set(s[2] for s in lab))
        print(f"  {name:12s} 模板 {n_tpl:4d} 行 -> {len(lab):4d} 段, "
              f"{len(vocab):3d} 种和弦, HMM 耗时 {dt*1000:6.1f} ms")

    hr("4. 三档的词汇表大小 vs 实际用到的和弦")
    for name in DICTS:
        vocab = sorted(set(s[2] for s in results[name]))
        print(f"\n  【{name}】实际用到 {len(vocab)} 种:")
        print("    " + ", ".join(vocab[:30]) + ("..." if len(vocab) > 30 else ""))

    hr("5. 和弦数（区分度的直接指标）")
    print(f"  {'档位':14s} {'段数':>6s} {'和弦种类':>8s} {'平均段长':>10s} {'最短':>8s}")
    dur_total = len(y) / 22050
    for name in DICTS:
        lab = results[name]
        vocab = set(s[2] for s in lab)
        lens = [s[1] - s[0] for s in lab]
        print(f"  {name:14s} {len(lab):6d} {len(vocab):8d} "
              f"{np.mean(lens):9.2f}s {np.min(lens):7.2f}s")

    hr("6. 采样对比：前 20 秒三档各给什么")
    t_end = 20.0
    for name in DICTS:
        segs = [s for s in results[name] if s[0] < t_end]
        print(f"\n  【{name}】")
        for s in segs:
            print(f"    {s[0]:6.2f} ~ {s[1]:6.2f}  {s[2]}")

    hr("7. 保存")
    import json
    for name in DICTS:
        p = OUT / f"chords_{name}.json"
        with open(p, "w", encoding="utf-8") as f:
            json.dump([{"start": round(float(s[0]), 3), "end": round(float(s[1]), 3),
                        "chord": str(s[2])} for s in results[name]],
                      f, ensure_ascii=False, indent=1)
        print(f"  {p.name}")

    hr("8. 结论")
    print("  若三档的 HMM 耗时都在毫秒级，且模型/CQT 只跑一次，")


if __name__ == "__main__":
    main()
