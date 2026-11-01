"""lv-chordia 端到端：真实音频 -> CQT -> 5 模型 ensemble -> HMM -> 和弦段。

关键要回答的问题：
  Q4. 官方 torch 链路在真实音频上跑出什么结果？
  Q5. ONNX 单模型能否逐帧复现 torch 单模型？（CQT 用同一份，隔离模型差异）
  Q6. 5 模型 ensemble 的 ONNX 版能否复现最终 HMM 解码结果？

用法：
    conda activate harmonize
    python neural/e2e_lv_chordia.py "E:\\音乐\\Aimer - Refrain.flac"
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

AUDIO = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"E:\音乐\Aimer - Refrain.flac")
SR = 22050
HOP = 512


def hr(t):
    print()
    print("=" * 74)
    print(f"  {t}")
    print("=" * 74)


def load_audio_robust(path, dtype="float32"):
    """5 秒小块读取，容忍尾部损坏（同 beat_this 的经验）。"""
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

    data = np.concatenate(chunks, axis=0)
    data = data.mean(axis=1) if n_ch > 1 else data[:, 0]
    return data.astype(np.float32), {"sr": sr, "declared": declared / sr,
                                     "decoded": len(data) / sr, "warn": warn}


class ChordNetExport(torch.nn.Module):
    SHIFT_HIGH, SHIFT_STEP, SPEC_DIM = 6, 3, 252

    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, cqt):
        if cqt.dim() == 2:
            cqt = cqt.unsqueeze(0)
        seq_len = cqt.shape[1]
        lo = self.SHIFT_HIGH * self.SHIFT_STEP
        x = cqt[:, :, lo:lo + self.SPEC_DIM]

        h = self.net.audio_feature_block(x)
        hd = self.net.hidden_dim1 // 2
        z = torch.zeros(2, h.shape[0], hd, dtype=h.dtype, device=h.device)
        h1 = self.net.lstm1(h, (z, z.clone()))[0]
        y = self.net.final_fc1(h1).reshape(
            h.shape[0] * h.shape[1], self.net.output_dim1 + self.net.output_dim2)

        from lv_chordia.chordnet_ismir_naive import chord_limit as lim
        bd = lim.bass_slice_begin + 12 + 1
        s7 = bd + lim.seventh_limit + 1
        n9 = s7 + lim.ninth_limit + 1
        e11 = n9 + lim.eleventh_limit + 1
        e13 = e11 + lim.thirteenth_limit + 1
        heads = (y[:, :lim.bass_slice_begin], y[:, lim.bass_slice_begin:bd],
                 y[:, bd:s7], y[:, s7:n9], y[:, n9:e11], y[:, e11:e13])
        return tuple(torch.softmax(hh.reshape(cqt.shape[0], seq_len, -1), dim=-1)
                     for hh in heads)


def main():
    import librosa
    import soxr
    from lv_chordia.chordnet_ismir_naive import ChordNet
    from lv_chordia.mir.nn.network import NetworkInterface
    from lv_chordia.extractors.cqt import CQTV2
    from lv_chordia.mir import DataEntry, io
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
    from lv_chordia.config import model_names
    import importlib.resources

    hr("1. 加载音频")
    sig, info = load_audio_robust(AUDIO)
    print(f"原始 {info['sr']} Hz / {info['decoded']:.2f}s")
    if info["warn"]:
        print(f"  ⚠️ {info['warn']}")
    y = soxr.resample(sig, info["sr"], SR) if info["sr"] != SR else sig
    dur = len(y) / SR
    print(f"重采样 -> {dur:.2f}s @ {SR} Hz")

    hr("2. CQT 前处理（librosa.hybrid_cqt, bins_per_octave=36, n_bins=288）")
    t0 = time.perf_counter()
    # 直接对齐 CQTV2 的参数
    cqt = librosa.core.hybrid_cqt(
        y, sr=SR, bins_per_octave=36, n_bins=288,
        fmin=librosa.note_to_hz("F#0"), tuning=None, hop_length=HOP,
    ).T
    cqt = np.abs(cqt).astype(np.float32)
    t_cqt = time.perf_counter() - t0
    T = cqt.shape[0]
    print(f"cqt shape = {cqt.shape}  耗时 {t_cqt*1000:.1f} ms")
    print(f"期望帧数 = {len(y)/HOP:.1f}")
    print(f"数值范围 [{cqt.min():.4f}, {cqt.max():.4f}]  均值 {cqt.mean():.4f}")

    hr("3. 加载 5 模型 ensemble")
    names = model_names()
    t0 = time.perf_counter()
    nets, nis = [], []
    for n in names:
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        ni = NetworkInterface(net, n)
        nets.append(net)
        nis.append(ni)
    print(f"{len(nis)} 个模型加载完成 {(time.perf_counter()-t0)*1000:.0f} ms")

    hr("4. 导出 5 个 ONNX")
    import onnxruntime as ort

    onnx_paths = []
    for i, net in enumerate(nets):
        p = OUT / f"lv_chordia_s{i}.onnx"
        m = ChordNetExport(net).eval()
        with torch.no_grad():
            torch.onnx.export(
                m, (torch.randn(512, 288),), str(p),
                input_names=["cqt"],
                output_names=["triad", "bass", "seventh", "ninth", "eleventh", "thirteenth"],
                dynamic_axes={"cqt": {0: "time"}, **{
                    k: {0: "time"} for k in
                    ["triad", "bass", "seventh", "ninth", "eleventh", "thirteenth"]}},
                opset_version=17, do_constant_folding=True, dynamo=False,
            )
        onnx_paths.append(p)
        print(f"  s{i}: {p.stat().st_size/1e6:.2f} MB")

    hr("5. torch ensemble 推理")
    t0 = time.perf_counter()
    torch_probs = []
    for i, ni in enumerate(nis):
        torch_probs.append(ni.inference(cqt))
        print(f"  s{i} done")
    t_torch = time.perf_counter() - t0
    torch_avg = [np.mean([p[k] for p in torch_probs], axis=0) for k in range(6)]
    print(f"torch 5 模型合计 {t_torch*1000:.0f} ms")

    hr("6. ONNX ensemble 推理 + 逐帧对比")
    for ep in ("CPUExecutionProvider", "CUDAExecutionProvider"):
        sess = [ort.InferenceSession(str(p), providers=[ep]) for p in onnx_paths]
        t0 = time.perf_counter()
        ort_probs = [s.run(None, {"cqt": cqt}) for s in sess]
        t_ort = time.perf_counter() - t0
        ort_avg = [np.mean([p[k][0] for p in ort_probs], axis=0) for k in range(6)]

        # 单模型对比
        # torch 侧 NetworkInterface.inference 返回 (T, C)（已去 batch 维）
        # ORT 侧是 (1, T, C) -> 取 [0] 得 (T, C)
        # 注意：不是 [0:1]（那是 1 行），也不要对 torch 侧取 [0]（那是第 0 帧）
        d1 = max(np.abs(np.asarray(torch_probs[0][k]) - ort_probs[0][k][0]).max()
                 for k in range(6))
        d2 = max(np.abs(np.asarray(torch_avg[k]) - ort_avg[k]).max()
                 for k in range(6))
        print(f"  ORT {ep.replace('ExecutionProvider',''):5s} {t_ort*1000:7.0f} ms   "
              f"单模型(s0) max|diff|={d1:.2e}   ensemble 平均 max|diff|={d2:.2e}")

    hr("7. HMM 解码")
    with importlib.resources.path("lv_chordia.data", "submission_chord_list.txt") as tpl:
        hmm = XHMMDecoder(template_file=str(tpl))

    entry = DataEntry()
    entry.prop.set("sr", SR)
    entry.prop.set("hop_length", HOP)
    entry.append_file(str(AUDIO), io.MusicIO, "music")
    # 复用已算好的 cqt
    entry.cqt = cqt

    lab_torch = hmm.decode_to_chordlab(entry, torch_avg, False)
    lab_onnx = hmm.decode_to_chordlab(entry, ort_avg, False)

    print(f"torch: {len(lab_torch)} 个和弦段")
    print(f"ONNX : {len(lab_onnx)} 个和弦段")

    if len(lab_torch) == len(lab_onnx):
        same = sum(1 for a, b in zip(lab_torch, lab_onnx)
                   if abs(a[0] - b[0]) < 0.02 and a[2] == b[2])
        print(f"段级完全一致: {same}/{len(lab_torch)} ({same/len(lab_torch)*100:.1f}%)")
        # 若不一致，打印首个差异
        for a, b in zip(lab_torch, lab_onnx):
            if a[2] != b[2] or abs(a[0] - b[0]) >= 0.02:
                print(f"  首个差异: torch={a}  onnx={b}")
                break
    else:
        print("⚠️ 段数不同")

    hr("8. 和弦结果（前 25 段）")
    for seg in lab_torch[:25]:
        print(f"  {seg[0]:7.2f} ~ {seg[1]:7.2f}  {seg[2]}")

    # 和弦词汇统计
    from collections import Counter
    c = Counter(s[2] for s in lab_torch)
    print(f"\n  共 {len(c)} 种和弦，Top 15:")
    for ch, n in c.most_common(15):
        print(f"    {ch:12s} {n:4d} 段")

    hr("9. 保存")
    import json
    with open(OUT / "chords_torch.json", "w", encoding="utf-8") as f:
        json.dump([{"start": round(float(s[0]), 3), "end": round(float(s[1]), 3),
                    "chord": str(s[2])} for s in lab_torch], f, ensure_ascii=False, indent=1)
    print(f"  {OUT/'chords_torch.json'}")


if __name__ == "__main__":
    main()
