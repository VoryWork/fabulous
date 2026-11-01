"""探测 beat_this ONNX 的最大可用序列长度。

现象：T=15001 时报
    Non-zero status code returned while running Expand node
    '/model/frontend/blocks/blocks.0/partial/attnT/Expand_1'
    Status Message: invalid expand shape

怀疑：RoPE（rotary_embedding_torch）在 trace 时把某个长度相关的形状固化，
      运行长度超过导出长度的某个倍数时 Expand 的 shape 不匹配。

本脚本用二分法找出实际可用的最大 T，并区分：
  - 受「导出长度」影响的区间
  - 受「某个固有上限」影响的区间
"""

import sys
from pathlib import Path

import numpy as np
import torch

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"
sys.path.insert(0, str(NEURAL / "beat_this"))


class BeatThisExport(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        out = self.model(spect)
        return out["beat"], out["downbeat"]


def export_model(export_len, path):
    from beat_this.model.beat_tracker import BeatThis

    w = BeatThisExport(BeatThis().eval()).eval()
    with torch.no_grad():
        torch.onnx.export(
            w, (torch.randn(1, export_len, 128),), str(path),
            input_names=["spect"], output_names=["beat_logits", "downbeat_logits"],
            dynamic_axes={
                "spect": {0: "batch", 1: "frames"},
                "beat_logits": {0: "batch", 1: "frames"},
                "downbeat_logits": {0: "batch", 1: "frames"},
            },
            opset_version=17, do_constant_folding=True, dynamo=False,
        )
    return w


def try_run(sess, T):
    try:
        sess.run(None, {"spect": np.random.randn(1, T, 128).astype(np.float32)})
        return True, ""
    except Exception as e:
        return False, str(e).split("Status Message:")[-1].strip()[:90]


def main():
    import onnxruntime as ort

    print("=" * 74)
    print("  探测 1：导出长度 1600 的模型，能跑多长？")
    print("=" * 74)
    p = OUT / "beat_this_e2e.onnx"
    if not p.exists():
        p = OUT / "beat_this_len1600.onnx"
    s = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
    print(f"使用 {p.name}")

    for T in (1600, 3000, 6000, 8000, 12000, 15001):
        ok, msg = try_run(s, T)
        print(f"  T={T:6d}  {'OK' if ok else 'FAIL  ' + msg}")

    print()
    print("=" * 74)
    print("  探测 2：用更长的导出长度（8000）重新导出，看能否突破")
    print("=" * 74)
    p8 = OUT / "beat_this_len8000.onnx"
    if not p8.exists():
        print("  导出中（T=8000，可能需要几分钟）...")
        export_model(8000, p8)
    s8 = ort.InferenceSession(str(p8), providers=["CPUExecutionProvider"])
    print(f"  文件 {p8.stat().st_size/1e6:.1f} MB")
    for T in (1600, 6000, 8000, 12000, 15001):
        ok, msg = try_run(s8, T)
        print(f"  T={T:6d}  {'OK' if ok else 'FAIL  ' + msg}")

    print()
    print("=" * 74)
    print("  探测 3：定位失败点的精确边界（导出 1600）")
    print("=" * 74)
    lo, hi = 1600, 15001
    if try_run(s, hi)[0]:
        print(f"  T={hi} 也 OK，上限更高")
    else:
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if try_run(s, mid)[0]:
                lo = mid
            else:
                hi = mid
        print(f"  导出 1600 时：T={lo} OK，T={hi} 失败")
        ok, msg = try_run(s, hi)
        print(f"  失败信息: {msg}")


if __name__ == "__main__":
    main()
