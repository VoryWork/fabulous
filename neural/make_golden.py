"""生成黄金测试数据 —— 供 Rust 侧前处理做逐元素数值断言。

Rust 重写 CQT / Mel 时，唯一的验收手段是：
  "同一段音频，Rust 算出的张量必须与 librosa/torchaudio 的结果逐元素接近"

本脚本为短音频片段（默认 10 秒）导出：
  1. 输入波形（重采样到 22050 的 float32）
  2. lv-chordia 的 hybrid_cqt 输出 (T, 288)
  3. beat_this 的 LogMelSpect 输出 (T, 128)
  4. 上游源码里的关键常量（mel filterbank 矩阵等）

输出为 .npy + 一个 manifest.json，便于 Rust 侧用 ndarray 读取。

用法：
    conda activate harmonize
    python neural/make_golden.py "E:\\音乐\\Aimer - Refrain.flac" 60 10
      参数：音频路径  起始秒  时长秒
"""

import json
import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
GOLD = NEURAL / "exported" / "golden"
GOLD.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(NEURAL / "beat_this"))

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - Refrain.flac")
START = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
DUR = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0

SR = 22050
SAVE_CQT_FILTERS = False   # 滤波器组本体 111 MB，默认不落盘


def hr(t):
    print()
    print("=" * 70)
    print(f"  {t}")
    print("=" * 70)


def main():
    import librosa
    import soundfile as sf
    import soxr
    import torch
    from beat_this.preprocessing import LogMelSpect

    hr("1. 读取音频片段")
    info = sf.info(str(AUDIO))
    print(f"{AUDIO.name}: {info.samplerate} Hz, {info.channels} ch, {info.duration:.2f}s")

    # 按原始采样率 seek 读取，再重采样（与生产路径一致）
    with sf.SoundFile(str(AUDIO)) as f:
        f.seek(int(START * f.samplerate))
        seg = f.read(int(DUR * f.samplerate), dtype="float32", always_2d=True)
    mono = seg.mean(axis=1) if seg.shape[1] > 1 else seg[:, 0]
    print(f"原始片段 {len(mono)} 采样 @ {info.samplerate} Hz")

    y = soxr.resample(mono, info.samplerate, SR) if info.samplerate != SR else mono
    y = y.astype(np.float32)
    print(f"重采样后 {len(y)} 采样 @ {SR} Hz ({len(y)/SR:.3f}s)")

    np.save(GOLD / "wave_22050.npy", y)
    print(f"  -> wave_22050.npy  ({y.nbytes/1024:.0f} KB)")

    # ---------------------------------------------------------------- CQT
    hr("2. lv-chordia CQT (hybrid_cqt)")
    cqt = librosa.core.hybrid_cqt(
        y, sr=SR, bins_per_octave=36, n_bins=288,
        fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=512,
    ).T
    cqt = np.abs(cqt).astype(np.float32)
    np.save(GOLD / "cqt_288.npy", cqt)
    print(f"  shape {cqt.shape}  (期望 T={len(y)/512:.2f})")
    print(f"  范围 [{cqt.min():.4f}, {cqt.max():.4f}]  均值 {cqt.mean():.4f}")
    print(f"  -> cqt_288.npy  ({cqt.nbytes/1024:.0f} KB)")

    # 顺便导出 CQT 用到的关键参数值
    fmin_hz = float(librosa.note_to_hz("F#0"))
    print(f"  fmin = F#0 = {fmin_hz:.6f} Hz")
    # 导出 CQT 的常数表（Rust 侧重写 CQT 时的关键输入）
    print(f"  ---- CQT 常数表 ----")
    freqs = librosa.cqt_frequencies(n_bins=288, fmin=fmin_hz, bins_per_octave=36)
    np.save(GOLD / "cqt_freqs_288.npy", freqs)
    print(f"    cqt_freqs_288.npy: {freqs.shape}, {freqs[0]:.4f} ~ {freqs[-1]:.2f} Hz")

    filters, lengths = librosa.filters.constant_q(
        sr=SR, fmin=fmin_hz, n_bins=288, bins_per_octave=36,
        window="hann", filter_scale=1, norm=1, pad_fft=False, dtype=np.complex64,
    )
    np.save(GOLD / "cqt_lengths_288.npy", np.asarray(lengths, dtype=np.int32))
    print(f"    cqt_lengths_288.npy: 每个 bin 的滤波器长度 {lengths.min():.0f} ~ {lengths.max():.0f}")

    f2, l2 = librosa.filters.constant_q(
        sr=SR, fmin=fmin_hz, n_bins=36, bins_per_octave=36,
        window="hann", filter_scale=1, norm=1, pad_fft=False, dtype=np.complex64)
    np.save(GOLD / "cqt_lengths_36.npy", np.asarray(l2, dtype=np.int32))
    print(f"    cqt_lengths_36.npy: 低频段(hybrid 用) 长度")

    # 滤波器组本体太大（288 x 49530 complex64 = 111 MB），默认不存。
    # 需要时把 SAVE_CQT_FILTERS 设为 True。
    if SAVE_CQT_FILTERS:
        np.save(GOLD / "cqt_filters_padded288.npy", filters)
        print(f"    cqt_filters_padded288.npy: {filters.shape} "
              f"({filters.nbytes/1024/1024:.1f} MB)")
    else:
        print(f"    滤波器组本体 {filters.shape} "
              f"({filters.nbytes/1024/1024:.1f} MB) — 默认跳过，"
              f"如需请设 SAVE_CQT_FILTERS=True")

    # ---------------------------------------------------------------- Mel
    hr("3. beat_this LogMelSpect")
    spect = LogMelSpect()          # sr=22050, n_fft=1024, hop=441, n_mels=128
    with torch.no_grad():
        mel = spect(torch.tensor(y, dtype=torch.float32)).numpy()
    np.save(GOLD / "mel_128.npy", mel)
    print(f"  shape {mel.shape}  (期望 T={len(y)/441:.2f})")
    print(f"  范围 [{mel.min():.4f}, {mel.max():.4f}]  均值 {mel.mean():.4f}")
    print(f"  -> mel_128.npy  ({mel.nbytes/1024:.0f} KB)")

    # 导出 mel filterbank 矩阵本身（Rust 侧最需要这个）
    import torchaudio
    ms = torchaudio.transforms.MelSpectrogram(
        sample_rate=22050, n_fft=1024, hop_length=441,
        f_min=30, f_max=11000, n_mels=128,
        mel_scale="slaney", normalized="frame_length", power=1,
    )
    fb = ms.mel_scale.fb.numpy()        # (n_freq_bins, n_mels) = (513, 128)
    np.save(GOLD / "mel_filterbank_513x128.npy", fb)
    print(f"  filterbank shape {fb.shape}")
    print(f"  -> mel_filterbank_513x128.npy  ({fb.nbytes/1024:.0f} KB)")

    # 同时导出窗函数（periodic=False 的 hann）
    window = torch.hann_window(1024, periodic=False).numpy()
    np.save(GOLD / "hann_1024.npy", window)
    print(f"  hann_window(1024, periodic=False) -> hann_1024.npy")

    # ---------------------------------------------------------------- manifest
    hr("4. manifest")
    manifest = {
        "source_audio": str(AUDIO),
        "start_sec": START,
        "duration_sec": DUR,
        "orig_sr": info.samplerate,
        "sr": SR,
        "n_samples": int(len(y)),
        "cqt": {
            "file": "cqt_288.npy",
            "shape": list(cqt.shape),
            "method": "librosa.core.hybrid_cqt",
            "params": {
                "sr": SR, "bins_per_octave": 36, "n_bins": 288,
                "fmin": "F#0", "fmin_hz": fmin_hz,
                "hop_length": 512, "tuning": None,
            },
            "post": "np.abs(...).T  -> (T, 288) float32",
            "fps": SR / 512,
        },
        "mel": {
            "file": "mel_128.npy",
            "shape": list(mel.shape),
            "method": "beat_this.preprocessing.LogMelSpect",
            "params": {
                "sample_rate": 22050, "n_fft": 1024, "hop_length": 441,
                "f_min": 30, "f_max": 11000, "n_mels": 128,
                "mel_scale": "slaney", "normalized": "frame_length",
                "power": 1, "log": "log1p(1000 * x)",
            },
            "fps": SR / 441,
        },
        "aux": {
            "mel_filterbank": {"file": "mel_filterbank_513x128.npy",
                               "shape": list(fb.shape),
                               "note": "shape (n_fft//2+1, n_mels)"},
            "hann_window": {"file": "hann_1024.npy", "shape": [1024],
                            "note": "torch.hann_window(1024, periodic=False)"},
            "cqt_freqs": {"file": "cqt_freqs_288.npy", "shape": [288],
                          "note": "librosa.cqt_frequencies(n_bins=288, fmin=F#0, bins_per_octave=36)"},
            "cqt_lengths": {"file": "cqt_lengths_288.npy", "shape": [288],
                            "note": "每个 bin 的滤波器时域长度（采样点数）"},
            "cqt_lengths_low": {"file": "cqt_lengths_36.npy", "shape": [36],
                                "note": "hybrid_cqt 的低频段（前 36 bin 用更长的窗）"},
        },
        "assert_notes": [
            "Rust 侧 CQT 与 cqt_288.npy 逐元素 max|diff| 建议 < 1e-3（float32 累积误差）",
            "Rust 侧 STFT 中间结果（complex64）建议 < 1e-4",
            "mel 用 hann_1024 + mel_filterbank 自己算，或直接对比 mel_128.npy",
            "hybrid_cqt 实际生效参数: tuning=0.0, filter_scale=1, norm=1, sparsity=0.01, scale=True, pad_mode='constant', res_type='soxr_hq'",
        ],
    }
    with open(GOLD / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"  -> manifest.json")

    hr("5. 文件清单")
    total = 0
    for p in sorted(GOLD.iterdir()):
        total += p.stat().st_size
        print(f"  {p.name:32s} {p.stat().st_size/1024:8.1f} KB")
    print(f"  {'合计':32s} {total/1024/1024:8.2f} MB")

    print("\n验证：读回检查")
    for name in ("cqt_288.npy", "mel_128.npy", "wave_22050.npy"):
        a = np.load(GOLD / name)
        print(f"  {name:20s} {a.shape} {a.dtype}  contiguous={a.flags['C_CONTIGUOUS']}")


if __name__ == "__main__":
    main()
