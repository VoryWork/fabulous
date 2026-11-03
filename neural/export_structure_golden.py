"""生成段落结构分析的 golden 数据。

## 分两层验收，因为两层的依赖不同

**第一层：特征提取**（`chroma_cqt` + `rms`）
用 `golden_wave22k.f32` 这份**已经对齐过**的 12 秒波形，所以能逐值比较。
不做这一步就没法确认 Rust 的 chroma 和 librosa 是同一个东西。

**第二层：结构推断**（按小节聚合 → SSM → Foote novelty → 切边界 → 分组 → 命名）
这一层的输入是**特征矩阵**，不需要音频。所以直接把 Python 算好的 `feats` 导出来
当 golden 输入，Rust 只要从同一份 feats 出发能走到同一组段落就算对齐。

## 为什么第二层用《特にない》

它 85 小节、7 个段落，`k = 2 if n <= 9`，能覆盖「多段 + 分组」的真实情况。
段数太少的歌只能测到 k=2 的一半路径。

用法：
    conda activate harmonize
    python neural/export_structure_golden.py
"""

import json
import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
ROOT = NEURAL.parent
ASSETS = ROOT / "client" / "src-tauri" / "assets"
sys.path.insert(0, str(NEURAL))

import structure_ssm  # noqa: E402

SONG = ROOT / "testdata" / "songs" / "03-tokuni-nai"


def dump(name, arr, dtype="<f4"):
    arr = np.ascontiguousarray(np.asarray(arr, dtype=dtype))
    path = ASSETS / name
    arr.tofile(path)
    print(f"  {name:32s} {arr.shape}  {path.stat().st_size/1024:.1f} KB")


def main():
    import librosa

    # ---- 第一层：12 秒已对齐波形 ----
    wave = np.fromfile(ASSETS / "golden_wave22k.f32", dtype="<f4")
    print(f"波形 {len(wave)} 采样 = {len(wave)/22050:.3f}s")

    chroma = librosa.feature.chroma_cqt(y=wave, sr=22050, hop_length=512)
    rms = librosa.feature.rms(y=wave, hop_length=512)
    print(f"chroma {chroma.shape}  rms {rms.shape}")
    dump("golden_chroma.f32", chroma.T)  # (T, 12)
    dump("golden_rms.f32", rms[0])  # (T,)

    # ---- 第二层：真实歌曲的完整结构链 ----
    analysis = json.loads((SONG / "analysis.json").read_text(encoding="utf-8"))
    downs = np.asarray(analysis["downbeatsSec"], dtype=float)
    print(f"\n{analysis['song']['title']}: {len(downs)} 小节")

    feats, rms_db, dur = structure_ssm.bar_features(str(SONG / "audio.flac"), downs)
    print(f"feats {feats.shape}  duration {dur:.2f}s")

    ssm = structure_ssm.build_ssm(feats, 2)
    nov = structure_ssm.foote_novelty(ssm)
    bounds = structure_ssm.pick_boundaries(nov, len(downs))
    letters = structure_ssm.group_segments(feats, bounds)

    segs = []
    for i, start in enumerate(bounds):
        end = bounds[i + 1] if i + 1 < len(bounds) else len(downs)
        segs.append({
            "startBar": int(start),
            "endBar": int(end),
            "group": letters[i],
            "t0": round(float(downs[start]), 2),
            "t1": round(float(downs[end]) if end < len(downs) else dur, 2),
            "peak": round(float(nov[start]), 2),
        })
    segs = structure_ssm.assign_labels(segs, rms_db)

    dump("golden_struct_feats.f32", feats)
    dump("golden_struct_rmsdb.f32", rms_db)
    dump("golden_struct_downbeats.f32", downs)
    dump("golden_struct_novelty.f32", nov)

    lines = []
    for s in segs:
        lines.append(
            f"{s['startBar']}\t{s['endBar']}\t{s['group']}\t{s['label']}\t{s['peak']:.4f}\t"
            f"{s['t0']:.2f}\t{s['t1']:.2f}"
        )
    (ASSETS / "golden_struct_segments.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  golden_struct_segments.tsv       {len(segs)} 段")
    print("\n边界（小节）:", bounds)
    print("字母:", "".join(letters))
    for i, s in enumerate(segs, 1):
        print(f"  {i} {s['startBar']+1:>3}-{s['endBar']:<3} {s['bars'] if 'bars' in s else s['endBar']-s['startBar']:>3} "
              f"{s['group']:2s} {s['label']}")


if __name__ == "__main__":
    main()
