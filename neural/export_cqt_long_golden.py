"""导出「长音频」的 CQT golden，用来查 Rust 移植是否随音频变长而漂移。

## 为什么需要这个

现有的 CQT golden（`golden_cqt.f32`）只有 **12 秒、517 帧**，验证下来的
最大相对误差 0.56%，于是认为 `hybrid_cqt` 移植正确。

但整首歌跑出来和弦结果和 Python 对不上（108 段 vs 101 段，且 Rust 判出
明显更多 ``N``）。12 秒的验收覆盖不到：

  - `vqt` 的多级降采样在**长**信号上是否累积误差；
  - `estimate_tuning` 在整首歌上的值与 12 秒片段是否一致
    （tuning 差 0.17 就会改变约 5% 帧的和弦判定）；
  - 帧数在长信号上是否还对得上。

导出 60 秒（2585 帧，覆盖 vqt 的全部 7 个八度、且长度足够让降采样
各阶段都跑到稳态），Rust 侧按同一段算完逐值比。

用法：
    conda activate harmonize
    python neural/export_cqt_long_golden.py
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
ROOT = NEURAL.parent
ASSETS = ROOT / "client/src-tauri/assets"
SONG = ROOT / "testdata/songs/03-tokuni-nai/audio.flac"
SECONDS = 60.0
SR = 22050
HOP = 512
BPO = 36
N_BINS = 288


def load_mono_22k(path: Path, seconds: float) -> np.ndarray:
    """用 ffmpeg 截前 N 秒并转成 22050 单声道 f32 —— 与 Rust 侧 decode 等价。"""
    import subprocess

    raw = subprocess.run(
        [
            "ffmpeg", "-v", "quiet", "-i", str(path),
            "-t", str(seconds),
            "-ac", "1", "-ar", str(SR), "-f", "f32le", "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def main() -> None:
    import librosa

    y = load_mono_22k(SONG, SECONDS)
    print(f"wave: {y.shape[0]} samples ({y.shape[0] / SR:.3f}s)")

    tuning = float(librosa.estimate_tuning(y=y, sr=SR, bins_per_octave=BPO))
    cqt = np.abs(
        librosa.core.hybrid_cqt(
            y,
            sr=SR,
            bins_per_octave=BPO,
            n_bins=N_BINS,
            fmin=librosa.note_to_hz("F#0"),
            tuning=None,
            hop_length=HOP,
        )
    ).T.astype(np.float32)

    print(f"frames={cqt.shape[0]} bins={cqt.shape[1]}")
    print(f"cqt mean={cqt.mean():.6f} max={cqt.max():.6f}")
    print(f"tuning(bpo=36)={tuning:.6f} → {tuning * 1200 / BPO:+.2f} cents")

    ASSETS.mkdir(parents=True, exist_ok=True)
    (ASSETS / "golden_cqt60.f32").write_bytes(cqt.tobytes(order="C"))
    (ASSETS / "golden_cqt60.json").write_text(
        json.dumps(
            {
                "seconds": SECONDS,
                "sr": SR,
                "hop": HOP,
                "frames": int(cqt.shape[0]),
                "bins": int(cqt.shape[1]),
                "tuning": tuning,
                "tuning_cents": tuning * 1200 / BPO,
                "src": str(SONG.relative_to(ROOT)),
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print("wrote assets/golden_cqt60.f32")


if __name__ == "__main__":
    sys.exit(main())
