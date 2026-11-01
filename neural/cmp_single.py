"""逐折对比：五折 ensemble vs 单个模型。

ensemble 会平均 5 个模型的概率，可能把某一折"敢说话"的判断抹平。
这个脚本看单折在可疑区间上的表现。

用法: python -u neural/cmp_single.py <audio_path>
"""
import sys, json
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


def decode(cqt, audio, names):
    probs = []
    for n in names:
        net = ChordNet(cross_subpart_counter=None, use_gpu=False)
        ni = NetworkInterface(net, n)
        probs.append(ni.inference(cqt))
    avg = [np.mean([p[k] for p in probs], axis=0) for k in range(6)]
    entry = DataEntry()
    entry.prop.set("sr", 22050)
    entry.prop.set("hop_length", 512)
    entry.append_file(str(audio), io.MusicIO, "music")
    entry.cqt = cqt
    with importlib.resources.files("lv_chordia.data").joinpath("submission_chord_list.txt") as f:
        pass
    tpl = str(importlib.resources.files("lv_chordia.data").joinpath("submission_chord_list.txt"))
    hmm = XHMMDecoder(template_file=tpl)
    lab = hmm.decode_to_chordlab(entry, avg, False)
    return [
        {"start": round(float(s), 3), "end": round(float(e), 3), "chord": str(c)}
        for s, e, c in lab
    ]


def report(segs, tag):
    ns = [c for c in segs if c["chord"] == "N"]
    dur = sum(c["end"] - c["start"] for c in ns)
    line = f"  {tag:<8} {len(segs):>4} 段  N={len(ns):>2} / {dur:>6.1f}s"
    extra = []
    for lo, hi in [(31.0, 38.68), (215.46, 233.94)]:
        mid = (lo + hi) / 2
        hit = [c for c in segs if c["start"] <= mid < c["end"]]
        inside = [c for c in segs if c["end"] > lo and c["start"] < hi]
        extra.append(f"{hit[0]['chord'] if hit else '?'}({len(inside)}段)")
    print(line + "   " + "  ".join(extra))
    return segs


def main():
    audio = Path(sys.argv[1])
    print(f"音频: {audio.name}")
    cqt = load_cqt(audio)
    print(f"CQT {cqt.shape}\n")
    print("  模型       段数       N 段              31~39s          215~234s")
    all_segs = {}
    for i in range(5):
        name = f"joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s{i}.best"
        segs = decode(cqt, audio, [name])
        all_segs[f"s{i}"] = report(segs, f"s{i}")
    names = [f"joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s{i}.best" for i in range(5)]
    all_segs["ens"] = report(decode(cqt, audio, names), "ensemble")
    out = NEURAL / "chords_single_folds.json"
    out.write_text(json.dumps(all_segs, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n结果已写入 {out}")


if __name__ == "__main__":
    main()
