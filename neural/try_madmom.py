"""试跑 madmom 和弦识别（作为 lv-chordia 之外的第二个独立引擎）。"""
import sys
sys.path.insert(0, 'neural/madmom-infer')
import numpy as np
import librosa
from madmom_infer import api

audio = r"E:\音乐\藤井風 - 満ちてゆく.flac"
print("解码音频…", flush=True)
# madmom 默认 44100，librosa 读成 float32 单声道
y, sr = librosa.load(audio, sr=44100, mono=True)
print(f"采样 {sr}Hz, {len(y)/sr:.1f}s", flush=True)

print("识别和弦（madmom DCCRF）…", flush=True)
res = api.recognize_chords(y, sample_rate=sr, backend="numpy")
print("段数:", len(res))
for seg in list(res)[:12]:
    print("  ", seg)

# 两个可疑区间
print("\n=== 可疑区间 ===", flush=True)
for lo, hi in [(31.0, 38.68), (215.46, 233.94)]:
    inside = [s for s in res if s[1] > lo and s[0] < hi]
    print(f"{lo:.1f}~{hi:.1f}s -> {len(inside)} 段")
    for s in inside[:10]:
        print(f"    {s[0]:.2f}~{s[1]:.2f}  {s[2]}")

import json, pathlib
pathlib.Path('neural/madmom_chords.json').write_text(
    json.dumps([[float(a), float(b), str(c)] for a, b, c in res], ensure_ascii=False, indent=1),
    encoding='utf-8')
print("\n写入 neural/madmom_chords.json")
