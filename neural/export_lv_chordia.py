"""lv-chordia 的 ONNX 导出实验（M0-V2）。

三个必须回答的问题：
  Q1. ChordNet（含 Bidirectional LSTM）能否导出 ONNX？
  Q2. 动态 T 是否可用？（LSTM 在动态序列长度上有已知的 shape 推断问题）
  Q3. 数值是否一致？性能如何？

输入：CQT 特征 (T, 288) float32
      —— 注意模型内部会用 x[:, 18:270] 取中间 252 维，这在 forward 之外
输出：6 个头，原始 logits（未 softmax）
      triad (T,73) / bass (T,13) / seventh (T,4) / ninth (T,4)
      eleventh (T,3) / thirteenth (T,3)

用法：
    conda activate harmonize
    python neural/export_lv_chordia.py
"""

import sys
import time
from pathlib import Path

import numpy as np
import torch

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"
OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(NEURAL / "lv-chordia"))


class ChordNetExport(torch.nn.Module):
    """把 ChordNet.inference 的逻辑搬进 forward，以便导出。

    inference() 做了三件 forward 之外的事：
      1. 从 288 维 CQT 里切 [18:270] 取 252 维
      2. 加 batch 维 (1, T, 288)
      3. 对六个头做 softmax

    ONNX 里保留 1 和 2（切在模型内更安全，前处理只需给 288 维 CQT），
    softmax 保留在图内（省掉 Rust 侧重复实现）。
    """

    SHIFT_HIGH = 6
    SHIFT_STEP = 3
    SPEC_DIM = 252

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, cqt):
        # cqt: (T, 288) 或 (B, T, 288)
        if cqt.dim() == 2:
            cqt = cqt.unsqueeze(0)
        seq_len = cqt.shape[1]
        lo = self.SHIFT_HIGH * self.SHIFT_STEP
        x = cqt[:, :, lo:lo + self.SPEC_DIM]

        # 复制 ChordNet.forward 的主体（不含 softmax）
        h = self.net.audio_feature_block(x)                      # (B, T, 240)
        # 注意：ChordNet.init_hidden 用的是 self.device（构造时固定），
        # 输入在别的设备上会报 "Input and hidden tensors are not at the same device"。
        # 这里显式按输入设备构造 hidden，避免这个上游隐患。
        hd = self.net.hidden_dim1 // 2
        z = torch.zeros(2, h.shape[0], hd, dtype=h.dtype, device=h.device)
        h1 = self.net.lstm1(h, (z, z.clone()))[0]
        y = self.net.final_fc1(h1).reshape(h.shape[0] * h.shape[1],
                                           self.net.output_dim1 + self.net.output_dim2)

        lim = __import__(
            "lv_chordia.chordnet_ismir_naive", fromlist=["chord_limit"]
        ).chord_limit
        bass_del = lim.bass_slice_begin + 12 + 1
        seventh_del = bass_del + lim.seventh_limit + 1
        ninth_del = seventh_del + lim.ninth_limit + 1
        eleventh_del = ninth_del + lim.eleventh_limit + 1
        thirteenth_del = eleventh_del + lim.thirteenth_limit + 1

        heads = (
            y[:, :lim.bass_slice_begin],
            y[:, lim.bass_slice_begin:bass_del],
            y[:, bass_del:seventh_del],
            y[:, seventh_del:ninth_del],
            y[:, ninth_del:eleventh_del],
            y[:, eleventh_del:thirteenth_del],
        )
        # reshape 回 (B, T, C) 并 softmax —— 与 ChordNet.inference 等价
        return tuple(
            torch.softmax(hh.reshape(cqt.shape[0], seq_len, -1), dim=-1)
            for hh in heads
        )


def hr(t):
    print()
    print("=" * 74)
    print(f"  {t}")
    print("=" * 74)


def main():
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.mir.nn.network import NetworkInterface
    from lv_chordia.config import model_names

    hr("1. 加载权重 + 导出 ONNX")
    names = model_names()
    net = ChordNet(cross_subpart_counter=None, use_gpu=False)
    ni = NetworkInterface(net, names[0])          # s0
    print(f"权重 {names[0]}")
    print(f"参数 {sum(p.numel() for p in net.parameters()):,}")

    model = ChordNetExport(net).eval()
    onnx_path = OUT / "lv_chordia_s0.onnx"

    T_export = 512
    dummy = torch.randn(T_export, 288)

    hr("2. 尝试导出（含 Bidirectional LSTM）")
    try:
        with torch.no_grad():
            torch.onnx.export(
                model, (dummy,), str(onnx_path),
                input_names=["cqt"],
                output_names=["triad", "bass", "seventh", "ninth", "eleventh", "thirteenth"],
                dynamic_axes={
                    "cqt": {0: "time"},
                    "triad": {0: "time"}, "bass": {0: "time"},
                    "seventh": {0: "time"}, "ninth": {0: "time"},
                    "eleventh": {0: "time"}, "thirteenth": {0: "time"},
                },
                opset_version=17,
                do_constant_folding=True,
                dynamo=False,
            )
        print(f"✅ 导出成功  {onnx_path.name}  ({onnx_path.stat().st_size/1e6:.2f} MB)")
    except Exception as e:
        print(f"❌ 导出失败: {type(e).__name__}: {e}")
        return

    hr("3. 数值一致性（torch vs onnxruntime）")
    import onnxruntime as ort

    print(f"可用 EP: {ort.get_available_providers()}")
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    head_names = ["triad", "bass", "7th", "9th", "11th", "13th"]
    for T in (100, 512, 2000):
        x = torch.randn(T, 288)
        with torch.no_grad():
            torch_out = model(x)
        ort_out = sess.run(None, {"cqt": x.numpy()})

        diffs = []
        for i, name in enumerate(head_names):
            t_arr = torch_out[i][0].numpy()
            o_arr = ort_out[i][0]
            diffs.append(np.abs(t_arr - o_arr).max())
        print(f"  T={T:5d}  " + "  ".join(
            f"{n}={d:.2e}" for n, d in zip(head_names, diffs)))
        print(f"          shapes: {[tuple(o.shape) for o in ort_out]}")

    hr("4. 性能对比（T=2000 ≈ 46 秒音频）")
    x_np = np.random.randn(1, 2000, 288).astype(np.float32)
    x_2d = x_np[0]

    # torch
    t0 = time.perf_counter()
    with torch.no_grad():
        model(torch.from_numpy(x_2d))
    t_torch = (time.perf_counter() - t0) * 1000
    print(f"  torch CPU  {t_torch:8.1f} ms")

    for ep in ("CPUExecutionProvider", "CUDAExecutionProvider"):
        if ep not in ort.get_available_providers():
            continue
        s = ort.InferenceSession(str(onnx_path), providers=[ep])
        s.run(None, {"cqt": x_2d})       # warmup（2D 输入，与动态轴声明一致）
        times = []
        for _ in range(3):
            t0 = time.perf_counter()
            s.run(None, {"cqt": x_2d})
            times.append((time.perf_counter() - t0) * 1000)
        times.sort()
        print(f"  ORT {ep.replace('ExecutionProvider',''):5s} {times[1]:8.1f} ms (median)")

    # torch cuda
    if torch.cuda.is_available():
        mc = ChordNetExport(ChordNet(cross_subpart_counter=None, use_gpu=False)).cuda().eval()
        # 注意：新实例是随机权重，仅测速
        xc = torch.from_numpy(x_2d).cuda()
        with torch.no_grad():
            mc(xc)
            torch.cuda.synchronize()
            times = []
            for _ in range(3):
                t0 = time.perf_counter()
                mc(xc)
                torch.cuda.synchronize()
                times.append((time.perf_counter() - t0) * 1000)
        times.sort()
        print(f"  torch CUDA  {times[1]:8.1f} ms (median, 随机权重仅测速)")

    hr("5. 结论")
    print("  见 docs/adr/0001-neural-onnx-feasibility.md")


if __name__ == "__main__":
    main()
