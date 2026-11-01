"""把拍点画到波形图上，肉眼验证结果是否正确。

这一步是「人眼验收」——数值一致只证明 ONNX 复现了 torch，
但只有看图才能确认模型真的抓到了节拍。

输出 PNG 到 neural/exported/。
"""

import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - 六等星の夜.flac")
START = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
DUR = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0


def main():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import soundfile as sf

    beats = np.load(OUT / "beats_final.npy")
    downs = np.load(OUT / "downbeats_final.npy")

    sr = 22050
    with sf.SoundFile(str(AUDIO)) as f:
        orig_sr = f.samplerate
        # 只读需要的那一段（用 seek 避开尾部损坏区）
        f.seek(int(START * orig_sr))
        data = f.read(int(DUR * orig_sr), dtype="float32", always_2d=True)
    if data.shape[1] > 1:
        data = data.mean(axis=1)
    else:
        data = data[:, 0]

    t = START + np.arange(len(data)) / orig_sr

    fig, axes = plt.subplots(2, 1, figsize=(20, 7), sharex=True)

    # 上：波形 + 拍点
    ax = axes[0]
    ax.plot(t, data, color="#8899aa", linewidth=0.4, alpha=0.8)
    sel = (beats >= START) & (beats <= START + DUR)
    for b in beats[sel]:
        ax.axvline(b, color="#e33f3f", linewidth=1.0, alpha=0.85)
    seld = (downs >= START) & (downs <= START + DUR)
    for d in downs[seld]:
        ax.axvline(d, color="#1f6feb", linewidth=2.2, alpha=0.95)
    ax.set_title(
        f"beat_this (final0) — {AUDIO.name}\n"
        f"红线 = beat ({sel.sum()} in window)   蓝粗线 = downbeat ({seld.sum()})",
        fontsize=12,
    )
    ax.set_ylabel("amplitude")
    ax.set_xlim(START, START + DUR)
    ax.grid(True, alpha=0.15)

    # 下：节拍间隔
    ax2 = axes[1]
    ax2.plot(beats, np.r_[np.nan, np.diff(beats)], "o-", ms=2, lw=0.6, color="#2a9d8f")
    ax2.axhline(np.median(np.diff(beats)), color="#e76f51", ls="--", lw=1,
                label=f"median {np.median(np.diff(beats)):.3f}s")
    ax2.set_ylabel("IOI (s)")
    ax2.set_xlabel("time (s)")
    ax2.set_xlim(START, START + DUR)
    ax2.grid(True, alpha=0.15)
    ax2.legend(fontsize=9)

    plt.tight_layout()
    p = OUT / f"beats_verify_{int(START)}_{int(START+DUR)}.png"
    plt.savefig(p, dpi=110, bbox_inches="tight")
    print(f"saved {p}")

    # 再存一张全曲的 IOI 概览
    fig2, ax = plt.subplots(figsize=(20, 4))
    ax.plot(beats, np.r_[np.nan, np.diff(beats)], "o-", ms=1.5, lw=0.5, color="#2a9d8f")
    ax.axhline(np.median(np.diff(beats)), color="#e76f51", ls="--", lw=1)
    ax.set_title(f"Full track IOI — {len(beats)} beats / {len(downs)} bars / "
                 f"median BPM {60/np.median(np.diff(beats)):.1f}")
    ax.set_xlabel("time (s)")
    ax.set_ylabel("IOI (s)")
    ax.grid(True, alpha=0.15)
    plt.tight_layout()
    p2 = OUT / "beats_ioi_full.png"
    plt.savefig(p2, dpi=110, bbox_inches="tight")
    print(f"saved {p2}")


if __name__ == "__main__":
    main()
