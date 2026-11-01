"""探测两个模型的真实结构 / 输入输出 / 前处理参数。

这一步不做推理，只把「ONNX 转换需要知道的事实」全部打印出来。

用法：
    conda activate harmonize
    python neural/probe_models.py
"""

import sys
from pathlib import Path

NEURAL = Path(__file__).parent.resolve()


def hr(title):
    print()
    print("=" * 78)
    print(f"  {title}")
    print("=" * 78)


# ---------------------------------------------------------------- chordia
def probe_chordia():
    hr("1. lv-chordia (和弦识别)")
    sys.path.insert(0, str(NEURAL / "lv-chordia"))

    from lv_chordia.chordnet_ismir_naive import (
        ChordNet,
        CNNFeatureExtractor,
        SPEC_DIM,
        SHIFT_HIGH,
        SHIFT_STEP,
    )
    from lv_chordia.complex_chord import ChordTypeLimit

    print(f"SPEC_DIM        = {SPEC_DIM}")
    print(f"SHIFT_HIGH      = {SHIFT_HIGH}")
    print(f"SHIFT_STEP      = {SHIFT_STEP}")
    print(f"切片起点(帧)     = {SHIFT_HIGH * SHIFT_STEP}")
    print(f"切片区间         = [{SHIFT_HIGH*SHIFT_STEP}, {SHIFT_HIGH*SHIFT_STEP+SPEC_DIM})")

    lim = ChordTypeLimit(
        triad_limit=6, seventh_limit=3, ninth_limit=3,
        eleventh_limit=2, thirteenth_limit=2,
    )
    print()
    print("--- 六个概率头 (ChordTypeLimit) ---")
    for attr in dir(lim):
        if attr.endswith("_limit") or attr in (
            "bass_slice_begin", "bass_slice_end", "triad_slice_begin", "triad_slice_end",
        ):
            print(f"  {attr} = {getattr(lim, attr)}")

    # 前处理参数（来自 extractors/cqt.py::CQTV2）
    print()
    print("--- 前处理 (CQTV2 -> librosa.hybrid_cqt) ---")
    print("  bins_per_octave = 36")
    print("  n_bins          = 288")
    print("  fmin            = librosa.note_to_hz('F#0')  <- 需要精确核对数值")
    print("  hop_length      = 512")
    print("  -> 时间分辨率 = 512 / sr 秒/帧（sr 待确认，通常 22050）")
    print("  -> abs() 取模，转 float32")

    # 模型结构
    print()
    print("--- CNNFeatureExtractor ---")
    fe = CNNFeatureExtractor()
    print(f"  output_size = {fe.output_size}")
    n_params_fe = sum(p.numel() for p in fe.parameters())
    print(f"  params      = {n_params_fe:,}")

    print()
    print("--- ChordNet (CNN + BiLSTM) vs ChordNetCNN (纯 CNN) ---")
    # NetworkBehavior 需要 device 参数，这里只看结构不实例化完整模型
    import torch

    cnn = ChordNetCNN_like = None
    try:
        from lv_chordia.chordnet_ismir_naive import ChordNetCNN
        cnn_only = ChordNetCNN(cross_subpart_counter=None, use_gpu=False)
        n = sum(p.numel() for p in cnn_only.parameters())
        print(f"  ChordNetCNN params = {n:,}")
        print(f"  output_dim1 = {cnn_only.output_dim1}, output_dim2 = {cnn_only.output_dim2}")
        print(f"  -> 无 LSTM，[B, T, 288] -> [B*T, {cnn_only.output_dim1 + cnn_only.output_dim2}] 每帧独立")
        cnn = cnn_only
    except Exception as e:
        print(f"  ChordNetCNN 实例化失败: {e}")

    try:
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        n = sum(p.numel() for p in net.parameters())
        print(f"  ChordNet    params = {n:,}")
    except Exception as e:
        print(f"  ChordNet 实例化失败: {e}")

    # 权重文件
    print()
    print("--- 权重文件 ---")
    for w in sorted((NEURAL / "lv-chordia" / "weights").glob("*.sdict")):
        print(f"  {w.name}  ({w.stat().st_size/1e6:.1f} MB)")

    # 关键 ONNX 判断
    print()
    print("--- ONNX 转换可行性预判 ---")
    print("  [OK] InstanceNorm2d  -> ONNX 原生支持")
    print("  [OK] Conv2d / MaxPool2d / SELU -> 原生支持")
    print("  [OK] transpose+view -> Reshape/Transpose 支持")
    print("  [!!] LSTM(bidirectional) -> ONNX 支持，但动态 T 下有已知的 shape 推理坑")
    print("       => 预判：ChordNetCNN(纯 CNN) 转换风险低；ChordNet(含 LSTM) 建议固定 T 或改滑窗")
    print("  [!!] 输入切片 x[:, 96:96+288] 发生在 inference() 里")
    print("       => 导出时要包一层 wrapper，把「取中间 288 维」放进图内，或前处理时直接切")
    print("  [XX] hybrid_cqt 前处理不在图内，必须 Rust 重写")


# ---------------------------------------------------------------- beat_this
def probe_beat_this():
    hr("2. beat_this (拍点识别)")
    sys.path.insert(0, str(NEURAL / "beat_this"))

    import torch
    from beat_this.preprocessing import LogMelSpect
    from beat_this.model.beat_tracker import BeatThis

    print("--- 前处理 (LogMelSpect) ---")
    print("  sample_rate     = 22050")
    print("  n_fft           = 1024")
    print("  hop_length      = 441   -> 帧率 = 22050/441 = 50 FPS")
    print("  f_min / f_max   = 30 / 11000")
    print("  n_mels          = 128")
    print("  mel_scale       = slaney")
    print("  normalized      = frame_length")
    print("  power           = 1 (幅度谱，不是能量谱)")
    print("  log             = log1p(1000 * mel)")
    print()
    print("  => 关键：[OK] 全部由 torchaudio.MelSpectrogram + log1p 组成")
    print("     MelScale 预计算矩阵后就是 MatMul，可整个前处理进 ONNX 图！")

    print()
    print("--- 模型结构 ---")
    m = BeatThis()
    n = sum(p.numel() for p in m.parameters())
    print(f"  params = {n:,}  ({n*4/1e6:.1f} MB fp32)")
    print("  组件：stem(Conv2d) -> frontend 卷积/池化块 -> Linear -> Transformer(RoPE) -> task_heads")
    print("  spect_dim=128, transformer_dim=512, head_dim=32, stem_dim=32")

    print()
    print("--- 前向形状探测 ---")
    m.eval()
    # spect 输入形状: (B, T, 128)? 看 spect2frames
    import inspect
    from beat_this.inference import Spect2Frames
    print("  Spect2Frames.spect2frames 源码:")
    print("   ", inspect.getsource(Spect2Frames.spect2frames).strip().replace("\n", "\n    "))

    try:
        with torch.no_grad():
            spect = torch.randn(1, 200, 128)
            out = m(spect)
            print(f"  input  {tuple(spect.shape)}")
            if isinstance(out, (tuple, list)):
                for i, o in enumerate(out):
                    print(f"  out[{i}] {tuple(o.shape)}")
            else:
                print(f"  output {tuple(out.shape)}")
    except Exception as e:
        print(f"  前向失败: {type(e).__name__}: {e}")

    print()
    print("--- ONNX 转换可行性预判 ---")
    print("  [OK] MelSpectrogram -> STFT + MatMul，ONNX 可导出")
    print("  [?] rotary_embedding_torch -> 可能含自定义 op，需实测")
    print("  [?] einops rearrange -> 导出时 trace 会展开为 view/transpose，通常 OK")
    print("  [!!] 动态 T：Transformer 通常支持，但 RoPE 的缓存可能绑定 T")
    print("  [XX] Postprocessor(peak picking / DBN) 必须 Rust 重写（含 while 循环）")


# ---------------------------------------------------------------- all-in-one
def probe_aio():
    hr("3. all-in-one-infer (段落/节拍，待评估)")
    p = NEURAL / "all-in-one-infer"
    if not p.exists():
        print("  未找到目录")
        return
    print("--- 顶层 ---")
    for f in sorted(p.iterdir()):
        print(f"  {f.name}")
    for req in ("requirements.txt", "pyproject.toml", "setup.py", "README.md"):
        f = p / req
        if f.exists():
            print(f"\n--- {req} (前 40 行) ---")
            print("\n".join(f.read_text(encoding="utf-8", errors="replace").splitlines()[:40]))


def main():
    print(f"python {sys.version}")
    try:
        import torch
        print(f"torch  {torch.__version__}  cuda={torch.cuda.is_available()}")
    except Exception as e:
        print(f"torch 不可用: {e}")

    probe_chordia()
    probe_beat_this()
    probe_aio()


if __name__ == "__main__":
    main()
