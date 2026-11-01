"""探测和弦概率矩阵的规模与可解释性（为「备选和弦」功能做可行性验证）。"""
import sys, json
from pathlib import Path
import numpy as np

NEURAL = Path(__file__).parent.resolve()
LV = NEURAL / "lv-chordia"
sys.path.insert(0, str(LV))
sys.path.insert(0, str(NEURAL))

from compare_chord_weights import load_cqt  # noqa
import importlib.resources
from lv_chordia.chordnet_ismir_naive import ChordNet
from lv_chordia.extractors.xhmm_ismir import XHMMDecoder
from lv_chordia.mir import DataEntry, io
from lv_chordia.mir.nn.network import NetworkInterface
from lv_chordia.config import model_names

audio = Path(sys.argv[1])
cqt = load_cqt(audio)
print("CQT", cqt.shape)

probs = []
for n in model_names():
    net = ChordNet(cross_subpart_counter=None, use_gpu=False)
    ni = NetworkInterface(net, n)
    probs.append(ni.inference(cqt))
merged = [np.median([p[k] for p in probs], axis=0) for k in range(6)]
merged = [m / np.clip(m.sum(axis=1, keepdims=True), 1e-12, None) for m in merged]
print("每帧形状:", [m.shape for m in merged])

entry = DataEntry()
entry.prop.set("sr", 22050)
entry.prop.set("hop_length", 512)
entry.append_file(str(audio), io.MusicIO, "music")
entry.cqt = cqt

tpl = str(importlib.resources.files("lv_chordia.data").joinpath("submission_chord_list.txt"))
hmm = XHMMDecoder(template_file=tpl)
names, logprob = hmm.get_chord_tag_obs(merged)
print(f"和弦类别数: {len(names)}   帧数: {logprob.shape[0]}   节点数: {logprob.size:,}")
print(f"内存: logprob {logprob.nbytes/1e6:.1f} MB")
print("前 10 个和弦名:", names[:10])

# 取几个时刻看 top-5
delta = 512 / 22050
for sec in [33.0, 224.0, 100.0]:
    fi = min(int(sec / delta), logprob.shape[0] - 1)
    p = np.exp(logprob[fi])
    p = p / p.sum()
    top = np.argsort(-p)[:5]
    print(f"\n{sec:.0f}s 处 top5:", ", ".join(f"{names[i]}={p[i]:.3f}" for i in top))
