"""跑通歌曲结构分析（all-in-one-infer）。

输出：段落边界、拍点、BPM、调性。
结果写入 neural/exported/structure_allin1.json，供前端使用。

用法：
    conda activate harmonize
    python neural/run_structure.py "E:\\音乐\\Aimer - Refrain.flac"
"""

import json
import os
import sys
import time
from pathlib import Path

# 模型下载走本机代理
os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:7995")
os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:7995")

NEURAL = Path(__file__).parent.resolve()
EXPORTED = NEURAL / "exported"
OUT = EXPORTED / "structure_allin1.json"

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - Refrain.flac")


def main():
    print("=" * 70)
    print("  all-in-one-infer 结构分析")
    print("=" * 70)
    print(f"音频: {AUDIO}")

    import torch
    import allin1_infer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"设备: {device}")

    t0 = time.time()
    print("\n开始分析（首次会下载模型权重）...")

    result = allin1_infer.analyze(
        str(AUDIO),
        model="harmonix-all",
        device=device,
        # 必须做源分离：模型是基于 demucs 分离后的 4 条 stem（bass/drums/other/vocals）
        # 训练的。skip_separation=True 只适用于"stems 已存在"的情况，
        # 首次运行会因为没有 bass.wav 而报错。
        skip_separation=False,
        multiprocess=False,  # Windows 上多进程容易出问题
        include_activations=False,
    )

    dt = time.time() - t0
    print(f"\n✅ 分析完成，耗时 {dt:.1f}s")

    # ---- 提取结果
    print("\n" + "=" * 70)
    print("  结果")
    print("=" * 70)

    print(f"\nBPM: {result.bpm}")
    print(f"拍号: {getattr(result, 'time_signature', '?')}")
    print(f"调性: {getattr(result, 'key', '?')}")
    print(f"拍数: {len(result.beats)}")
    print(f"小节数: {len(result.downbeats)}")

    print(f"\n段落（{len(result.segments)} 个）:")
    for i, seg in enumerate(result.segments):
        print(f"  [{i}] {seg.start:8.2f} ~ {seg.end:8.2f}  {seg.label}")

    # 段落去重统计
    from collections import Counter

    labels = Counter(s.label for s in result.segments)
    print(f"\n段落类型分布: {dict(labels)}")

    # ---- 保存
    # all-in-one 的 result 没有 duration 属性，用 soundfile 读真实时长
    import soundfile as sf

    try:
        duration = float(sf.info(str(AUDIO)).duration)
    except Exception:
        duration = float(result.beats[-1]) if len(result.beats) else 0.0

    payload = {
        "song": AUDIO.name,
        "source": "all-in-one-infer 3.1.0 (harmonix-all, skip_separation=True)",
        "analyzedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "bpm": float(result.bpm) if result.bpm else None,
        "timeSignature": getattr(result, "time_signature", None),
        "key": getattr(result, "key", None),
        "durationSec": duration,
        "beats": [float(b) for b in result.beats],
        "downbeats": [float(d) for d in result.downbeats],
        "segments": [
            {
                "start": float(s.start),
                "end": float(s.end),
                "label": s.label,
            }
            for s in result.segments
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n💾 已保存 {OUT}")


if __name__ == "__main__":
    main()
