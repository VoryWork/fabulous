#!/usr/bin/env python
"""检查 testdata 里的参考音频是否就位、版本对不对。

## 为什么需要「版本」校验

仓库只带分析结果（`analysis.json`），音频因版权不入库，由各人自己准备。
但**必须是同一版录音**：

    満ちてゆく 专辑版   315.387s
    満ちてゆく 现场/重制 314.8s / 316.2s  ← 差 0.5s 就足以让拍点整体错位

`analysis.json` 里的 barCount / 拍点全是按原版音频算的，换成别的版本再用它当
期望值比较，会得到一堆莫名其妙的差异，还以为是代码改坏了。

这个脚本读 `meta.json` 里记录的 `durationSec` 和音频实测时长比，**差超过 0.05s
就报警**（flac 解码是精确的，同一版本的时长应该是毫秒级一致）。

## 用法

```bash
python neural/check_testdata.py
```

依赖 `soundfile`（`pip install soundfile`）。不想装也行 —— 那就用播放器看一眼
时长，和 `meta.json` 里的 `durationSec` 对一下。

输出刻意只用 ASCII 标记（`[OK]` / `[--]` / `[!!]`）：中文 Windows 的控制台是
GBK，打印 `✓` 这类字符会直接 UnicodeEncodeError 把脚本崩掉。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SONGS = ROOT / "testdata" / "songs"

# 同一版录音的时长应该毫秒级一致；跨版本通常差 0.1s 以上
TOLERANCE_SEC = 0.05


def fmt_dur(sec: float) -> str:
    m, s = divmod(sec, 60)
    return f"{int(m)}:{s:06.3f}"


def main() -> int:
    try:
        import soundfile as sf
    except ImportError:
        print("[!!] 需要 soundfile: pip install soundfile")
        print("  （或者手动核对：用播放器看时长，和 meta.json 的 durationSec 比）")
        return 2

    if not SONGS.is_dir():
        print(f"[!!] 找不到 {SONGS}")
        return 2

    missing = 0
    mismatch = 0
    ok = 0

    for song_dir in sorted(p for p in SONGS.iterdir() if p.is_dir()):
        meta_path = song_dir / "meta.json"
        if not meta_path.is_file():
            print(f"[??] {song_dir.name}: 没有 meta.json，跳过")
            continue

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        rel = f"testdata/songs/{song_dir.name}/{meta.get('audioFile', 'audio.flac')}"
        audio = ROOT / rel
        expect = float(meta.get("durationSec") or 0)
        label = f"{meta.get('artist', '?')} — {meta.get('title', '?')}"

        if not audio.is_file():
            missing += 1
            print(f"[--] {song_dir.name}  缺音频（{label}）")
            print(f"    放到：{rel}")
            print(f"    期望时长：{fmt_dur(expect)}")
            continue

        try:
            info = sf.info(str(audio))
        except Exception as e:  # noqa: BLE001
            missing += 1
            print(f"[!!] {song_dir.name}  读不了音频：{e}")
            continue

        got = float(info.duration)
        diff = abs(got - expect)
        if diff <= TOLERANCE_SEC:
            ok += 1
            print(f"[OK] {song_dir.name}  {fmt_dur(got)}  {info.samplerate} Hz  {label}")
        else:
            mismatch += 1
            print(f"[!!] {song_dir.name}  时长对不上（{label}）")
            print(f"    期望 {fmt_dur(expect)} / 实测 {fmt_dur(got)} / 差 {diff:+.3f}s")
            print("    → 大概率是**另一个版本**（现场、重制、不同母带）。")
            print("      这个目录下的 analysis.json 是按原版算的，用它当期望值会误报。")

    print()
    if missing == 0 and mismatch == 0:
        print(f"全部就位（{ok} 首）。可以跑需要音频的测试了：")
        print("  cd client/src-tauri")
        print("  cargo test --lib analysis::tests::rust_pipeline_matches_python -- --ignored --nocapture")
        return 0

    print(f"就位 {ok} / 缺失 {missing} / 版本不符 {mismatch}")
    if mismatch:
        print("版本不符的那几个目录**不要**拿 analysis.json 当期望值 —— 换回原版录音，")
        print("或者把该目录先挪走（测试里只是对比数值，换个样本就等于换了题）。")
    elif missing:
        print("只跑不需要音频的测试的话可以忽略缺失 —— 那些测试会自动跳过。")
    return 1 if mismatch else 0


if __name__ == "__main__":
    sys.exit(main())
