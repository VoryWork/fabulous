"""对比 lv-chordia 五折 ensemble 的**概率聚合策略**。

## 背景

《満ちてゆく》有两段大长 `N`（31~38.68s、215.46~233.94s）。音频 RMS 正常，
三个词典档位一致判 N —— 是模型识别失效。

换 label-reweighting 权重没用（加权重反而让 N 从 5 段涨到 15 段）。
但逐折检查发现**关键线索**：

    区间 215~234s：
      s0 → F:min7 (10 段)   s1 → C#:min (6 段)
      s3 → F:min/5 (8 段)   s4 → Ab:maj/5 (9 段)
      ensemble(mean) → N

五折分歧极大，但每一折都给出了**有音乐意义的具体和弦**。平均概率
把少数派的峰值抹平了，HMM 拿到的分布接近均匀，于是退化成一串 N。

## 试的策略

1. `mean`        现状（基线）
2. `median`      逐元素中位数，不被少数极端值拉低
3. `trimmed`     去掉每帧最高最低各一折再平均
4. `max`         逐元素取最大（最"敢"的那一折说话）
5. `geo`         几何平均，惩罚"只有一折自信"的类别

## 判据

主指标是两段可疑区间的 `N` 是否消失，且**总 N 时长不能暴涨**
（否则只是拿别的段落换来的）。

用法：
    python -u neural/compare_ensemble.py <audio_path>
"""

import sys
import json
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
LV = NEURAL / "lv-chordia"
sys.path.insert(0, str(LV))
sys.path.insert(0, str(NEURAL))

from compare_chord_weights import load_cqt  # noqa: E402

import importlib.resources  # noqa: E402
from lv_chordia.chordnet_ismir_naive import ChordNet  # noqa: E402
from lv_chordia.extractors.xhmm_ismir import XHMMDecoder  # noqa: E402
from lv_chordia.mir import DataEntry, io  # noqa: E402
from lv_chordia.mir.nn.network import NetworkInterface  # noqa: E402

CHECK = [(31.0, 38.68), (215.46, 233.94)]


def aggregate(stack: np.ndarray, how: str) -> np.ndarray:
    """stack 形状 (n_folds, n_frames, n_classes) → (n_frames, n_classes)。"""
    if how == "mean":
        return stack.mean(axis=0)
    if how == "median":
        return np.median(stack, axis=0)
    if how == "max":
        return stack.max(axis=0)
    if how == "trimmed":
        # 去掉每帧最大和最小的那一折
        s = np.sort(stack, axis=0)
        return s[1:-1].mean(axis=0)
    if how == "geo":
        # 几何平均：对"只有一折自信"的类别更保守
        eps = 1e-12
        return np.exp(np.log(stack + eps).mean(axis=0))
    raise ValueError(how)


def decode(cqt, audio, weights_dir: Path, reweight: str, how: str):
    import lv_chordia.mir.common as common

    names = [
        f"joint_chord_net_ismir_naive_v1.0_reweight({reweight})_s{i}.best"
        for i in range(5)
    ]
    orig = common.WEIGHTS_PATH
    common.WEIGHTS_PATH = str(weights_dir)
    try:
        per_fold = []
        for n in names:
            net = ChordNet(cross_subpart_counter=None, use_gpu=False)
            ni = NetworkInterface(net, n)
            per_fold.append(ni.inference(cqt))
    finally:
        common.WEIGHTS_PATH = orig

    # 6 个输出头：triad / bass / 7 / 9 / 11 / 13，各自聚合
    merged = [
        aggregate(np.stack([f[k] for f in per_fold], axis=0), how) for k in range(6)
    ]
    # 归一化，保证是概率分布（median/max 之后不一定和为 1）
    merged = [m / np.clip(m.sum(axis=1, keepdims=True), 1e-12, None) for m in merged]

    entry = DataEntry()
    entry.prop.set("sr", 22050)
    entry.prop.set("hop_length", 512)
    entry.append_file(str(audio), io.MusicIO, "music")
    entry.cqt = cqt

    tpl = str(importlib.resources.files("lv_chordia.data").joinpath("submission_chord_list.txt"))
    hmm = XHMMDecoder(template_file=tpl)
    lab = hmm.decode_to_chordlab(entry, merged, False)
    return [
        {"start": round(float(s), 3), "end": round(float(e), 3), "chord": str(c)}
        for s, e, c in lab
    ]


def report(segs, tag):
    ns = [c for c in segs if c["chord"] == "N"]
    dur = sum(c["end"] - c["start"] for c in ns)
    total = segs[-1]["end"] - segs[0]["start"] if segs else 1
    cells = []
    for lo, hi in CHECK:
        mid = (lo + hi) / 2
        hit = [c for c in segs if c["start"] <= mid < c["end"]]
        inside = [c for c in segs if c["end"] > lo and c["start"] < hi]
        got = hit[0]["chord"] if hit else "?"
        cells.append(f"{got}({len(inside)}段)")
    print(
        f"  {tag:<10} {len(segs):>4} 段   N={len(ns):>2}/{dur:>6.1f}s "
        f"({dur / total * 100:>4.1f}%)   {cells[0]:<14} {cells[1]}"
    )
    return {
        "segs": segs, "count": len(segs), "n_count": len(ns),
        "n_dur": round(dur, 1), "n_pct": round(dur / total * 100, 1),
    }


def main():
    audio = Path(sys.argv[1])
    print(f"音频: {audio.name}")
    cqt = load_cqt(audio)
    print(f"CQT {cqt.shape}\n")

    builtin = LV / "weights"
    alt = builtin / "alt"
    print("  权重/策略              段数           N 段占比              31~39s        215~234s")
    results = {}
    combos = [
        ("0.0,10.0", builtin, "mean"),
        ("0.0,10.0", builtin, "median"),
        ("0.0,10.0", builtin, "trimmed"),
        ("0.3,10.0", alt, "median"),
        ("0.3,10.0", alt, "trimmed"),
        ("1.0,20.0", alt, "median"),
        ("1.0,20.0", alt, "trimmed"),
    ]
    for rw, wdir, how in combos:
        tag = f"{rw}/{how}"
        try:
            segs = decode(cqt, audio, wdir, rw, how)
        except Exception as e:  # noqa: BLE001
            print(f"  {tag:<22} 失败: {type(e).__name__}: {e}")
            continue
        results[tag] = report(segs, tag)

    out = NEURAL / "ensemble_strategies.json"
    out.write_text(
        json.dumps(
            {k: {"count": v["count"], "n_count": v["n_count"],
                 "n_dur": v["n_dur"], "n_pct": v["n_pct"],
                 "segs": v["segs"]} for k, v in results.items()},
            ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n明细已写入 {out}")


if __name__ == "__main__":
    main()
