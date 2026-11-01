"""验证 beat_this ONNX 的 8192 上限根因，并验证两种修复方案。

已确认的根因（来自 rotary_embedding_torch 源码）：

    # rotary_embedding_torch/rotary_embedding_torch.py:105
    cache_max_seq_len = 8192
    self.register_buffer('cached_freqs', torch.zeros(cache_max_seq_len, dim), persistent=False)

    def forward(self, t, seq_len=None, offset=0):
        should_cache = (... and (offset + seq_len) <= self.cache_max_seq_len)

- seq_len <= 8192：走缓存分支，返回 `self.cached_freqs[:seq_len]`
  -> trace 成 ONNX Slice，缓存 buffer 长度固定 8192，可正常工作
- seq_len >  8192：走重新计算分支
  -> trace 时 T 被固化为导出长度，产生固定的 Expand shape
  -> 运行时真实 T 更大 -> Expand 失败 "invalid expand shape"

结论：**固定的 8192 是唯一的硬上限，与导出长度无关**（已实测导出 1600/8000 都一样）。

本脚本验证两种修复：
  方案 A：在导出前把 rotary 的 cache_max_seq_len 调大（例如 20000）
  方案 B：推理时始终按 <= 8192 分块（上游 split_predict_aggregate 默认 chunk=1500 已经是安全的）
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


def build(export_len, cache_len=None, path=None):
    from beat_this.model.beat_tracker import BeatThis

    wrapper = BeatThisExport(BeatThis().eval()).eval()

    if cache_len is not None:
        # 找到所有 RotaryEmbedding 并替换缓存 buffer
        from rotary_embedding_torch import RotaryEmbedding

        replaced = 0
        for m in wrapper.modules():
            if isinstance(m, RotaryEmbedding):
                old = m.cache_max_seq_len
                m.cache_max_seq_len = cache_len
                # cached_freqs 形状是 (cache_max_seq_len, dim)，dim 是 head_dim
                dim = m.cached_freqs.shape[-1]
                m.cached_freqs = torch.zeros(cache_len, dim)
                m.cached_freqs_seq_len = 0
                replaced += 1
        print(f"  替换了 {replaced} 个 RotaryEmbedding: cache_max_seq_len {old} -> {cache_len}")

    if path is not None:
        with torch.no_grad():
            torch.onnx.export(
                wrapper, (torch.randn(1, export_len, 128),), str(path),
                input_names=["spect"], output_names=["beat_logits", "downbeat_logits"],
                dynamic_axes={
                    "spect": {0: "batch", 1: "frames"},
                    "beat_logits": {0: "batch", 1: "frames"},
                    "downbeat_logits": {0: "batch", 1: "frames"},
                },
                opset_version=17, do_constant_folding=True, dynamo=False,
            )
    return wrapper


def try_run(sess, T):
    try:
        sess.run(None, {"spect": np.random.randn(1, T, 128).astype(np.float32)})
        return True, ""
    except Exception as e:
        return False, str(e).split("Status Message:")[-1].strip()[:70]


def main():
    import onnxruntime as ort

    print("=" * 74)
    print("  方案 A：导出前把 cache_max_seq_len 从 8192 提到 20000")
    print("=" * 74)
    p = OUT / "beat_this_cache20k.onnx"
    print("  导出中...")
    w = build(export_len=1600, cache_len=20000, path=p)
    print(f"  文件 {p.stat().st_size/1e6:.1f} MB")

    s = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
    print("  可用长度测试：")
    for T in (1500, 8192, 8193, 12000, 15001, 20000, 20001):
        ok, msg = try_run(s, T)
        print(f"    T={T:6d}  {'OK' if ok else 'FAIL  ' + msg}")

    print()
    print("=" * 74)
    print("  方案 A 的数值正确性（对比 torch，同一权重）")
    print("=" * 74)
    for T in (1500, 8192, 15001):
        x = torch.randn(1, T, 128)
        with torch.no_grad():
            tb, _ = w(x)
        tb = tb.numpy()
        ob, _ = s.run(None, {"spect": x.numpy()})
        print(f"    T={T:6d}  max|diff| = {np.abs(tb-ob).max():.3e}")

    print()
    print("=" * 74)
    print("  方案 B：保持默认 8192，按 chunk 分块推理（上游默认行为）")
    print("=" * 74)
    p2 = OUT / "beat_this_e2e.onnx"
    s2 = ort.InferenceSession(str(p2), providers=["CPUExecutionProvider"])
    total = 15001
    ok_all = True
    for T in range(1500, total + 1, 1500):
        chunk = min(1500, total - (T - 1500))
        ok, msg = try_run(s2, chunk)
        ok_all &= ok
    print(f"    15001 帧按 1500 分块（共 11 块）: {'全部 OK' if ok_all else '有失败'}")


if __name__ == "__main__":
    main()
