"""beat_this 完整闭环（修正版）：真实音频 -> ONNX 分块推理 -> 拍点。

上一版的两个错误已修正：
  1. 分块逻辑：上游 split_piece 的步长是 chunk_size - 2*border_size，
     且首尾用「零填充」对齐到 chunk_size，而不是补尾。
  2. Postprocessor 输入应为 1D tensor + 全 True 的 padding_mask。

上游语义（beat_this/inference.py）：
  split_piece:
      starts = arange(-border, len-border, chunk - 2*border)
      首块左零填充 border，末块右零填充 border 对齐
      avoid_short_end=True 时把最后一块起点左移，使其恰好覆盖到结尾
  aggregate_prediction:
      每块预测切掉前后各 border 帧
      keep_first = 按 start 逆序写入（早的覆盖晚的）
"""

import sys
import time
from pathlib import Path

import numpy as np
import torch

NEURAL = Path(__file__).parent.resolve()
OUT = NEURAL / "exported"
OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(NEURAL / "beat_this"))

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - 六等星の夜.flac")
SR = 22050
FPS = 50
CHUNK = 1500
BORDER = 6


def hr(t):
    print()
    print("=" * 74)
    print(f"  {t}")
    print("=" * 74)


def load_audio_robust(path, dtype="float32"):
    """分块读取，容忍尾部损坏。

    实测 libsndfile 遇损坏块会丢弃整块，块越小能抢救越多：
      5s 块 -> 335s | 10s 块 -> 330s | 60s 块 -> 300s | 600s 块 -> 0s
    -> 生产实现必须用小块 + 容错，返回「完好前缀 + 警告」。
    """
    import soundfile as sf

    with sf.SoundFile(str(path)) as f:
        sr, n_ch, declared = f.samplerate, f.channels, f.frames
        chunks, warn = [], None
        block = sr * 5
        while True:
            try:
                d = f.read(block, dtype=dtype, always_2d=True)
            except Exception as e:  # noqa: BLE001
                warn = f"{type(e).__name__}: {e}"
                break
            if len(d) == 0:
                break
            chunks.append(d)

    if not chunks:
        raise RuntimeError(f"完全无法解码: {path}")
    data = np.concatenate(chunks, axis=0)
    data = data.mean(axis=1) if n_ch > 1 else data[:, 0]
    return data.astype(np.float32), {
        "sr": sr, "channels": n_ch,
        "declared_sec": declared / sr,
        "decoded_sec": len(data) / sr,
        "warning": warn,
    }


class BeatThisExport(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        o = self.model(spect)
        return o["beat"], o["downbeat"]


def split_piece_np(spect, chunk_size, border_size=6, avoid_short_end=True):
    """复刻上游 split_piece，返回 (chunks, starts)。spect: (T, 128)"""
    T = spect.shape[0]
    starts = np.arange(-border_size, T - border_size, chunk_size - 2 * border_size)
    if avoid_short_end and T > chunk_size - 2 * border_size:
        starts[-1] = T - (chunk_size - border_size)

    chunks = []
    for s in starts:
        seg = spect[max(s, 0): min(s + chunk_size, T)]
        left = max(0, -s)
        right = max(0, min(border_size, s + chunk_size - T))
        if left or right:
            seg = np.pad(seg, ((left, right), (0, 0)), mode="constant")
        chunks.append(seg)
    return chunks, starts


def aggregate_np(pred_chunks, starts, full_size, chunk_size, border_size, overlap_mode="keep_first"):
    """复刻上游 aggregate_prediction。"""
    if border_size > 0:
        pred_chunks = [
            (p[0][border_size:-border_size], p[1][border_size:-border_size])
            for p in pred_chunks
        ]

    beat = np.full(full_size, -1000.0, dtype=np.float32)
    down = np.full(full_size, -1000.0, dtype=np.float32)

    items = list(zip(starts, pred_chunks))
    if overlap_mode == "keep_first":
        items = list(reversed(items))

    for s, (b, d) in items:
        lo = s + border_size
        hi = s + chunk_size - border_size
        # 与上游一致：直接切片写回（超出部分 numpy 会自动截断）
        lo_c, hi_c = max(lo, 0), min(hi, full_size)
        bl = b[lo_c - lo: hi_c - lo]
        dl = d[lo_c - lo: hi_c - lo]
        beat[lo_c:hi_c] = bl
        down[lo_c:hi_c] = dl

    return beat, down


def split_predict_onnx(sess, spect_np, chunk=CHUNK, border=BORDER):
    chunks, starts = split_piece_np(spect_np, chunk, border, avoid_short_end=True)
    preds = []
    for c in chunks:
        b, d = sess.run(None, {"spect": c[None, ...].astype(np.float32)})
        preds.append((b[0], d[0]))
    return aggregate_np(preds, starts, spect_np.shape[0], chunk, border)


def main():
    # 注意：必须用 load_model 加载真实权重。BeatThis() 是随机初始化，输出全是噪声。
    from beat_this.inference import load_model, split_predict_aggregate
    from beat_this.preprocessing import LogMelSpect
    from beat_this.model.postprocessor import Postprocessor
    from beat_this.inference import split_predict_aggregate

    hr("1. 加载音频")
    signal, info = load_audio_robust(AUDIO)
    print(f"声道 {info['channels']} / {info['sr']} Hz")
    print(f"header 声明 {info['declared_sec']:.2f}s, 实际解码 {info['decoded_sec']:.2f}s")
    if info["warning"]:
        print(f"  ⚠️ 在 {info['decoded_sec']:.2f}s 处中断: {info['warning']}")

    import soxr

    y = soxr.resample(signal, info["sr"], SR) if info["sr"] != SR else signal
    dur = len(y) / SR
    print(f"重采样 -> {dur:.2f}s @ {SR} Hz")

    hr("2. 前处理")
    spect = LogMelSpect()
    with torch.no_grad():
        sp = spect(torch.tensor(y, dtype=torch.float32))
    T = sp.shape[0]
    print(f"spect {tuple(sp.shape)}  (期望 {dur*FPS:.0f} 帧)")

    hr("3. 加载真实权重 + 导出 ONNX（同一实例）")
    model = load_model("final0", device="cpu")
    n_params = sum(p.numel() for p in model.parameters())
    print(f"权重 final0 已加载，{n_params:,} 参数")
    wrapper = BeatThisExport(model).eval()
    onnx_path = OUT / "beat_this_final.onnx"
    with torch.no_grad():
        torch.onnx.export(
            wrapper, (torch.randn(1, CHUNK, 128),), str(onnx_path),
            input_names=["spect"], output_names=["beat_logits", "downbeat_logits"],
            dynamic_axes={
                "spect": {0: "batch", 1: "frames"},
                "beat_logits": {0: "batch", 1: "frames"},
                "downbeat_logits": {0: "batch", 1: "frames"},
            },
            opset_version=17, do_constant_folding=True, dynamo=False,
        )
    print(f"{onnx_path.name} ({onnx_path.stat().st_size/1e6:.1f} MB)  导出长度 T={CHUNK}")

    hr("4. 推理：torch 上游实现 vs ONNX 复刻实现")
    import onnxruntime as ort

    t0 = time.perf_counter()
    with torch.no_grad():
        pred = split_predict_aggregate(
            spect=sp, chunk_size=CHUNK, overlap_mode="keep_first",
            border_size=BORDER, model=model,
        )
    t_torch = time.perf_counter() - t0
    tb = pred["beat"].float().numpy()
    td = pred["downbeat"].float().numpy()
    n_chunks = len(split_piece_np(sp.numpy(), CHUNK, BORDER)[0])
    print(f"torch  分块 {t_torch*1000:8.1f} ms  （{n_chunks} 块）")

    results = {}
    for ep in ("CPUExecutionProvider", "CUDAExecutionProvider"):
        sess = ort.InferenceSession(str(onnx_path), providers=[ep])
        t0 = time.perf_counter()
        ob, od = split_predict_onnx(sess, sp.numpy())
        dt = time.perf_counter() - t0
        results[ep] = (ob, od)
        print(f"ORT {ep.replace('ExecutionProvider',''):5s} 分块 {dt*1000:8.1f} ms  "
              f"beat max|diff|={np.abs(tb-ob).max():.3e}  downbeat={np.abs(td-od).max():.3e}")

    hr("5. 后处理 -> 拍点")
    pp = Postprocessor(type="minimal", fps=FPS)
    mask = torch.ones(T, dtype=torch.bool)

    with torch.no_grad():
        bt, bd = pp(torch.from_numpy(tb), torch.from_numpy(td), mask)
        obt, obd = pp(torch.from_numpy(results["CPUExecutionProvider"][0]),
                      torch.from_numpy(results["CPUExecutionProvider"][1]), mask)

    print(f"torch: {len(bt)} beats, {len(bd)} downbeats")
    print(f"ONNX : {len(obt)} beats, {len(obd)} downbeats")
    if len(bt) == len(obt) and len(bt) > 0:
        d = np.abs(np.asarray(bt) - np.asarray(obt))
        print(f"拍点位置差异 max={d.max():.6f}s mean={d.mean():.6f}s  "
              f"-> {'一致 ✅' if d.max() < 1e-4 else '有差异'}")

    hr("6. 音乐信息")
    bt_a = np.asarray(bt, dtype=np.float64)
    bd_a = np.asarray(bd, dtype=np.float64)
    print(f"曲长 {dur:.2f}s | {len(bt_a)} 拍 | {len(bd_a)} 小节")
    if len(bt_a) > 2:
        ioi = np.diff(bt_a)
        bpm = 60 / ioi
        print(f"BPM: 中位 {np.median(bpm):.1f}  范围 [{bpm.min():.1f}, {bpm.max():.1f}]")
        if len(bd_a) > 1:
            bar = np.diff(bd_a)
            print(f"小节长度中位 {np.median(bar):.3f}s ≈ {np.median(bar)/np.median(ioi):.2f} 拍/小节")

    print("\n前 16 拍（★ = 小节起点）:")
    bd_set = set(np.round(bd_a, 6))
    for i, b in enumerate(bt_a[:16]):
        star = "★" if round(b, 6) in bd_set else " "
        print(f"  {i:3d}  {star} {b:9.3f}s")

    hr("7. 保存")
    np.save(OUT / "beats_final.npy", bt_a)
    np.save(OUT / "downbeats_final.npy", bd_a)
    with open(OUT / "beats_final.tsv", "w", encoding="utf-8") as f:
        f.write("# time_sec\ttype\n")
        for b in bt_a:
            f.write(f"{b:.6f}\tbeat\n")
        for d in bd_a:
            f.write(f"{d:.6f}\tdownbeat\n")
    print(f"  beats_final.tsv ({len(bt_a)} 行)")


if __name__ == "__main__":
    main()
