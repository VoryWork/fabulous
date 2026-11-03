"""生成和弦词表与 XHMM 解码的 golden 数据。

## 为什么要预计算词表

`XHMMDecoder.__init_known_chord_names` 的做法是：读模板 txt（如 `full_chord_list.txt`
382 行）→ 对每行 `Chord(name).to_numpy()` 得到 6 元组 → 再对 12 个移调各生成一份
→ 用元组去重。最终得到 submission 301 / ismir2017 169 / full 3145 个状态。

那套逻辑依赖 `complex_chord.py` 里近 300 行的和弦后缀解析表。Rust 侧没必要重写：
**词表是静态数据**，模板不变就不需要重算。所以这里把结果导出成 TSV，
Rust 直接读，保证与 Python 逐状态一致。

## 产物

  client/src-tauri/assets/chord_vocab_submission.tsv
  client/src-tauri/assets/chord_vocab_ismir2017.tsv
  client/src-tauri/assets/chord_vocab_full.tsv
      每行：`a0,a1,a2,a3,a4,a5<TAB>和弦名`
      （6 元组含义：triad 类索引, bass 索引, 7th, 9th, 11th, 13th；-1 表示该位不用）

  client/src-tauri/assets/golden_chord_lab_<vocab>.tsv
      12 秒 golden 片段跑完 Viterbi 的结果，每行：
      `start<TAB>end<TAB>和弦名<TAB>confidence<TAB>name=prob;name=prob;...`
      —— Rust 侧 XhmmDecoder 的验收基准（时间、和弦名、置信度、备选全都比）

用法：
    conda activate harmonize
    python neural/export_chord_vocab.py
"""

import sys
from pathlib import Path

import numpy as np

NEURAL = Path(__file__).parent.resolve()
ASSETS = NEURAL.parent / "client" / "src-tauri" / "assets"
sys.path.insert(0, str(NEURAL / "lv-chordia"))

VOCABS = ("submission", "ismir2017", "full")
# 6 个概率头的切分点（= 累积和 [73,13,4,4,3,3]）
HEAD_SPLITS = [73, 86, 90, 94, 97]
HOP = 512
SR = 22050


def dump_vocab(hmm, name: str):
    lines = []
    for array, chord_name in hmm.known_chord_array:
        lines.append(",".join(str(int(v)) for v in array) + "\t" + chord_name)
    path = ASSETS / f"chord_vocab_{name}.tsv"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  chord_vocab_{name}.tsv  {len(lines)} 个状态  {path.stat().st_size/1024:.0f} KB")


def segments_of(tags, delta):
    """复刻 decode_to_chordlab 的分段：相邻标签相同就合并。"""
    out = []
    last = 0
    n = len(tags)
    for i in range(n):
        if i + 1 == n or tags[i + 1] != tags[i]:
            out.append((last * delta, (i + 1) * delta, tags[i]))
            last = i + 1
    return out


def alternatives(logprob, names, start, end, delta, chosen, top_k=4):
    """复刻 analyze_song._segment_alternatives：段内逐帧概率取平均 → top-k。"""
    i0 = max(0, int(round(start / delta)))
    i1 = min(logprob.shape[0], max(i0 + 1, int(round(end / delta))))
    if i1 <= i0:
        return 0.0, []
    mean_p = np.exp(logprob[i0:i1]).mean(axis=0)
    total = float(mean_p.sum())
    if total <= 0:
        return 0.0, []
    mean_p = mean_p / total
    order = np.argsort(-mean_p)[:top_k]
    alts = [(names[i], round(float(mean_p[i]), 4)) for i in order if mean_p[i] > 1e-4]
    idx = names.index(chosen) if chosen in names else -1
    conf = round(float(mean_p[idx]), 4) if idx >= 0 else 0.0
    return conf, alts


def main():
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder

    probs = np.fromfile(ASSETS / "golden_chord_median.f32", dtype="<f4").reshape(-1, 100)
    frames = len(probs)
    heads = np.split(probs.astype(np.float64), HEAD_SPLITS, axis=1)
    # analyze_song 调 decode_to_chordlab 时 use_beats=False → beat_arr 全 1
    beat_arr = np.ones(frames, dtype=np.int8)
    delta = HOP / SR
    print(f"输入概率 {probs.shape}，delta={delta:.6f}s")

    data = NEURAL / "lv-chordia" / "lv_chordia" / "data"
    for name in VOCABS:
        tpl = data / f"{name}_chord_list.txt"
        hmm = XHMMDecoder(template_file=str(tpl))
        dump_vocab(hmm, name)

        tag_names, tag_logprob = hmm.get_chord_tag_obs(heads)
        tags = hmm.decode(heads, beat_arr)
        segs = segments_of(tags, delta)

        lines = []
        for (s, e, ch) in segs:
            conf, alts = alternatives(tag_logprob, tag_names, s, e, delta, ch)
            alt_str = ";".join(f"{n}={p}" for n, p in alts)
            lines.append(f"{s:.3f}\t{e:.3f}\t{ch}\t{conf:.4f}\t{alt_str}")
        path = ASSETS / f"golden_chord_lab_{name}.tsv"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"  golden_chord_lab_{name}.tsv  {len(segs)} 段")


if __name__ == "__main__":
    main()
