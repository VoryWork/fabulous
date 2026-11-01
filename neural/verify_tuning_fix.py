"""把音频整体移调到 A=440 后重新分析，验证调性是否对齐。

## 背景

《満ちてゆく》实测调音偏差 -34.7 音分（三种方法一致）。而 lv-chordia 和
madmom 两个引擎在这首歌上**报的调性整体差一个半音**（lv 报 Ab，madmom 报 A）。

猜测：两个模型对「-34.7 音分该归到哪个音级」判断不同。若把音频先校正到
A=440，两者应该收敛到同一套音名。

## 做法

不改音色的前提下移调：**用 time-stretch 的 pitch shift**（librosa.effects.pitch_shift），
保持时长不变（和弦时间戳仍然有效）。

然后对校正后的音频跑 lv-chordia，和原结果比分：

- 根音是否变了（期望：整体 +1 半音的区块应该"归位"）
- N 的时长有没有变化
- 和弦种类有没有变化

用法：
    python -u neural/verify_tuning_fix.py <audio_path> <target_chords.json>
"""

import sys
import json
import tempfile
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
LV = NEURAL / "lv-chordia"
sys.path.insert(0, str(LV))
sys.path.insert(0, str(NEURAL))

from detect_tuning import detect  # noqa: E402


def make_corrected(audio: Path, cents: float) -> Path:
    """用 librosa.pitch_shift 把音高整体偏移 -cents（拉回 0 偏差）。

    用 pitch_shift 而不是改采样率：改采样率会同时改变时长，
    所有时间戳（拍点、和弦边界）都要跟着换算，容易引入新问题。
    pitch_shift 保持时长，下游代码完全不用改。
    """
    import librosa
    import soundfile as sf

    y, sr = librosa.load(str(audio), sr=22050, mono=True)
    # 偏差 -34.7 音分 → 需要 +34.7 音分
    shifted = librosa.effects.pitch_shift(y, sr=sr, n_steps=-cents / 100.0)
    out = Path(tempfile.gettempdir()) / f"tuned_{audio.stem}.wav"
    sf.write(str(out), shifted, sr)
    return out


def run_lv(audio: Path) -> list:
    """对给定音频跑 lv-chordia（submission 档）。"""
    import importlib.resources
    import librosa
    import soxr
    import soundfile as sf
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.config import model_names
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
    from lv_chordia.mir import DataEntry, io
    from lv_chordia.mir.nn.network import NetworkInterface

    with sf.SoundFile(str(audio)) as f:
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
        librosa.core.hybrid_cqt(y, sr=22050, bins_per_octave=36, n_bins=288,
                                fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=512)
    ).T.astype(np.float32)

    probs = []
    for n in model_names():
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        ni = NetworkInterface(net, n)
        probs.append(ni.inference(cqt))
    merged = [np.median([p[k] for p in probs], axis=0) for k in range(6)]
    merged = [m / np.clip(m.sum(axis=1, keepdims=True), 1e-12, None) for m in merged]

    entry = DataEntry()
    entry.prop.set("sr", 22050)
    entry.prop.set("hop_length", 512)
    entry.append_file(str(audio), io.MusicIO, "music")
    entry.cqt = cqt

    tpl = str(importlib.resources.files("lv_chordia.data").joinpath("submission_chord_list.txt"))
    hmm = XHMMDecoder(template_file=tpl)
    lab = hmm.decode_to_chordlab(entry, merged, False)
    return [{"start": round(float(s), 3), "end": round(float(e), 3), "chord": str(c)}
            for s, e, c in lab]


def stats(segs, tag):
    ns = [c for c in segs if c["chord"] == "N"]
    dur = sum(c["end"] - c["start"] for c in ns)
    total = segs[-1]["end"] - segs[0]["start"] if segs else 1
    from collections import Counter
    roots = Counter()
    for c in segs:
        if c["chord"] == "N":
            continue
        roots[c["chord"].split(":")[0].split("/")[0]] += 1
    print(f"\n--- {tag} ---")
    print(f"  {len(segs)} 段, N={len(ns)}/{dur:.1f}s ({dur / total * 100:.1f}%)")
    print(f"  根音分布: {roots.most_common(6)}")
    return segs


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    audio = Path(sys.argv[1])
    print(f"音频: {audio.name}")

    t = detect(audio)
    cents = t["librosa"]
    print(f"调音偏差 {cents:+.1f} 音分 → 校正 {t['correct_cents']:+.1f}")
    print(f"三种方法: {t['librosa']}, {t['cqt_hist']}, {t['harmonic_peaks']}")

    print("\n生成校正后的音频…", flush=True)
    fixed = make_corrected(audio, cents)
    print(f"  → {fixed}")

    print("\n原始音频跑 lv-chordia…", flush=True)
    orig = stats(run_lv(audio), "原始")
    print("\n校正后跑 lv-chordia…", flush=True)
    fixed_segs = stats(run_lv(fixed), "已校正")

    # 对比：同一时刻的根音
    print("\n=== 同一时刻对比 ===")
    changed = 0
    for tt in [10, 50, 100, 150, 200, 224, 260, 290]:
        a = [s for s in orig if s["start"] <= tt < s["end"]]
        b = [s for s in fixed_segs if s["start"] <= tt < s["end"]]
        ca = a[0]["chord"] if a else "?"
        cb = b[0]["chord"] if b else "?"
        mark = "  ← 变了" if ca != cb else ""
        if ca != cb:
            changed += 1
        print(f"  {tt:3d}s  {ca:12s} → {cb:12s}{mark}")
    print(f"\n变了的时刻: {changed}/8")

    out = NEURAL / "chords_tuning_fixed.json"
    out.write_text(json.dumps(fixed_segs, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"校正后结果写入 {out}")


if __name__ == "__main__":
    main()
