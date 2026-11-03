"""把 lv-chordia 的 5 折 ChordNet 全部导出成 ONNX，并落 golden 数据给 Rust 测试用。

和 `export_lv_chordia.py` 的分工：
  - 那个脚本是**可行性论证**（Q1~Q3：LSTM 能否导出 / 动态 T / 数值一致性），只导 s0
  - 这个脚本是**生产产物生成**：5 折全导，输出到 `client/src-tauri/assets/`

产物：
  client/src-tauri/assets/chord_fold0..4.onnx   每折 1.89 MB
  client/src-tauri/assets/golden_chord_median.f32
      5 折 median 聚合 + 列归一化后的概率，(517, 100) float32
      —— 这是 Rust 侧 ChordsStage 的验收基准（逐值对比）

输入基准沿用 `assets/golden_cqt.f32`（517×288，tuning=0.0 固定）。

用法：
    conda activate harmonize
    python neural/export_chord_folds.py
"""

import sys
from pathlib import Path

import numpy as np
import torch

NEURAL = Path(__file__).parent.resolve()
ASSETS = NEURAL.parent / "client" / "src-tauri" / "assets"
sys.path.insert(0, str(NEURAL))
sys.path.insert(0, str(NEURAL / "lv-chordia"))

from export_lv_chordia import ChordNetExport  # noqa: E402

# 6 个头的维度（见 chord_limit：triad 73 = 6*12+1，bass 13 = 12+1，其余 3 音上限 +1）
HEAD_SIZES = [73, 13, 4, 4, 3, 3]
HEAD_NAMES = ["triad", "bass", "seventh", "ninth", "eleventh", "thirteenth"]


def main():
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.config import model_names
    from lv_chordia.mir.nn.network import NetworkInterface

    ASSETS.mkdir(parents=True, exist_ok=True)

    cqt = np.fromfile(ASSETS / "golden_cqt.f32", dtype="<f4").reshape(-1, 288)
    print(f"输入 CQT {cqt.shape}")

    probs = []
    for i, name in enumerate(model_names()):
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        NetworkInterface(net, name)
        net.eval()
        model = ChordNetExport(net).eval()

        out = ASSETS / f"chord_fold{i}.onnx"
        dummy = torch.zeros(64, 288)
        with torch.no_grad():
            torch.onnx.export(
                model, (dummy,), str(out),
                input_names=["cqt"],
                output_names=HEAD_NAMES,
                dynamic_axes={"cqt": {0: "time"},
                              **{n: {0: "time"} for n in HEAD_NAMES}},
                opset_version=17,
                do_constant_folding=True,
                dynamo=False,
            )

        # 用 torch 算参考概率（ONNX 与 torch 的差异已在 export_lv_chordia 里验证过 1e-5）
        with torch.no_grad():
            heads = model(torch.from_numpy(cqt))
        p = np.concatenate([h[0].numpy() for h in heads], axis=1)
        assert p.shape == (len(cqt), 100), p.shape
        probs.append(p)
        print(f"  fold{i}: {out.name}  {out.stat().st_size/1e6:.2f} MB  "
              f"参数 {sum(x.numel() for x in net.parameters()):,}")

    # ---------------------------------------------------------------- 聚合
    #
    # 与 analyze_song.py 的 run_chords 完全一致：先按**每个头**取 median，
    # 再**每个头各自**按行归一化。
    #
    # ⚠️ 曾经写成「整行 100 列一起 median 再一起归一化」——注释还写着
    # 「与 run_chords 完全一致」，其实是错的。那样每个头被压到 1/6，
    # 而 `get_chord_tag_obs` 是按头求和 log 概率的，于是「用 6 个头的和弦」
    # 比「只用 1 个头的 N」多吃 5×ln6 ≈ 9 nat 惩罚，整首歌退化成 N。
    # 实测：Rust 侧 108 段 vs Python 101 段，前 3 秒全是 N。
    # 按头分组归一化（HEAD_SIZES 累加得到每组边界）
    starts = np.cumsum([0] + HEAD_SIZES[:-1])
    med = np.median(np.stack(probs), axis=0)
    for h, (lo, size) in enumerate(zip(starts, HEAD_SIZES)):
        seg = med[:, lo:lo + size]
        s = np.clip(seg.sum(axis=1, keepdims=True), 1e-12, None)
        med[:, lo:lo + size] = seg / s
        assert abs(float(med[0, lo:lo + size].sum()) - 1.0) < 1e-5, f"head {h} 归一化失败"
    path = ASSETS / "golden_chord_median.f32"
    med.astype("<f4").tofile(path)
    print(f"golden_chord_median.f32 {med.shape} {path.stat().st_size/1024:.0f} KB")

    # 顺带报告 N（无和弦）的占比，方便以后回归时对比
    tri = med[:, :73]
    n_idx = 72
    print(f"triad 头 argmax=N 的帧占比 {np.mean(tri.argmax(1) == n_idx)*100:.1f}%")


if __name__ == "__main__":
    main()
