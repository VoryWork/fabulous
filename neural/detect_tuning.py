"""检测并报告音频的调音偏差（tuning deviation），用于判断是否需要重采样到 A=440。

## 为什么要做这件事

实测《満ちてゆく》lv-chordia 和 madmom 两个引擎报的调性**整体差一个半音**
（lv 报 Ab，madmom 报 A；105 个时刻里 50.5% 是「lv+1半音 = madmom」）。
librosa 测出这首歌稳定偏低 **-33 音分**，这不是噪声（5 个时段都是 -31~-35）。

于是两个引擎按各自的判断把 -33 音分归到不同的音级 —— **数据本身没对齐**。
不先归一音分，两个引擎的输出没法交叉验证。

## 三种检测方法（交叉验证，避免单一方法的系统偏差）

1. **librosa.estimate_tuning** —— 谱峰抛物线插值，最常用的基线
2. **CQT 直方图** —— 对整曲 CQT 求 12 个半音的能量分布，用圆均值找偏移
   （圆均值是关键：-33 音分和 +27 音分是同一个物理量，不能用普通平均）
3. **HPSS 谐波 + 峰值** —— 只取谐波成分的谱峰，抑制打击乐干扰

三者若一致（差异 < 5 音分）就可信；不一致说明这首歌有转调或拍频干扰，
需要人工确认。

用法：
    python -u neural/detect_tuning.py <audio_path> [--apply out.wav]
"""

import sys
from pathlib import Path

import numpy as np


def cents_to_ratio(cents: float) -> float:
    """音分 → 频率比。"""
    return 2.0 ** (cents / 1200.0)


def method_librosa(y, sr) -> float:
    """librosa 内置估计（谱峰抛物线插值）。

    返回音分值（正 = 偏高）。
    """
    import librosa

    t = librosa.estimate_tuning(y=y, sr=sr, resolution=1e-4)
    return float(t) * 100.0


def method_cqt_peaks(y, sr, bins_per_octave: int = 36) -> float | None:
    """CQT 谱峰法：每个半音分 3 格，找峰相对最近半音中心的偏移。

    ## 为什么不是「按音级折叠求圆均值」

    最初写的是把 CQT 按 12 个音级折叠、求能量加权圆均值。实测**完全不准**：
    折叠后的能量分布很平（各格 0.014~0.038），圆均值被相邻音级的能量
    拉扯，算出 +432 音分这种明显错误的值，而且换段就跳。

    根因是 CQT 的每个 bin 覆盖多个半音、相邻音级互相串扰，折叠会把
    它们混在一起 —— 折叠后你已经分不清「这个能量属于 C 还是 C#」。

    ## 现在的做法

    不做折叠，直接在**连续的** CQT 频谱上找峰：
      1. 每个八度单独看（36 格）
      2. 找能量峰（循环 pad 处理音级环绕）
      3. 每个峰相对最近的半音中心（第 0/3/6/.../33 格）的偏移
      4. 取所有峰偏移的中位数

    用中位数而不是平均：个别泛音/串扰的峰不会污染结果。
    每格 = 100/3 ≈ 33.3 音分。
    """
    import librosa
    from scipy.signal import find_peaks

    cqt = np.abs(librosa.cqt(y=y, sr=sr, bins_per_octave=bins_per_octave,
                             n_bins=bins_per_octave * 7, fmin=librosa.note_to_hz('C1')))
    # 跨时间取中位数：抗瞬时打击乐干扰
    energy = np.median(cqt, axis=1)

    cents_per_bin = 100.0 / (bins_per_octave / 12.0)
    offsets = []
    n_oct = len(energy) // bins_per_octave
    for oct_i in range(n_oct):
        seg = energy[oct_i * bins_per_octave:(oct_i + 1) * bins_per_octave]
        if seg.sum() <= 0:
            continue
        seg = seg - seg.min()
        if not np.isfinite(seg).all() or seg.max() <= 0:
            continue
        # 循环 pad：音级是首尾相接的，边缘的峰不能漏
        padded = np.concatenate([seg, seg, seg])
        peaks, _ = find_peaks(padded, height=seg.max() * 0.3)
        for pk in peaks:
            if bins_per_octave <= pk < 2 * bins_per_octave:  # 只取中间那份
                local = pk - bins_per_octave
                per_semitone = bins_per_octave // 12  # = 3
                center = round(local / per_semitone) * per_semitone
                offsets.append((local - center) * cents_per_bin)

    # 一个峰都没找到 = 这段音频没有可用的音高信息（纯打击乐、静音、或
    # 噪声型素材）。返回 None 而不是 0.0 —— 0.0 会被下游当成
    # 「检测过，很准」，从而掩盖掉「这个文件根本没法测」的事实。
    if not offsets:
        return None
    return float(np.median(offsets))


def method_harmonic_peaks(y, sr) -> float:
    """只取谐波成分，找谱峰，统计各峰相对最近半音中心的偏移。

    打击乐（噪声型频谱）对音高检测是干扰，HPSS 先把它分出去。
    """
    import librosa

    y_h, _ = librosa.effects.hpss(y)
    freqs, mags = librosa.piptrack(y=y_h, sr=sr, fmin=60, fmax=2000)
    offsets = []
    for t in range(mags.shape[1]):
        col = mags[:, t]
        # 只取该帧能量前 5 的峰
        top = np.argsort(-col)[:5]
        for b in top:
            f = freqs[b, t]
            if f <= 0 or col[b] < 1e-4:
                continue
            midi = 69 + 12 * np.log2(f / 440.0)
            # 相对最近半音的偏移（-50 .. +50 音分）
            off = (midi - round(midi)) * 100
            offsets.append((off, col[b]))
    if not offsets:
        return 0.0
    offs = np.array([o for o, _ in offsets])
    w = np.array([c for _, c in offsets])
    # 同样用圆均值（-50 和 +50 是相邻的）
    ang = offs / 100.0 * 2 * np.pi
    z = (w * np.exp(1j * ang)).sum()
    return float(np.angle(z) / (2 * np.pi) * 100.0)


def detect(audio_path: Path) -> dict:
    import librosa

    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)

    # 分段测多次看稳定性（稳定 = 整体调音问题；抖动 = 转调或检测不可靠）
    seg_devs = []
    dur = len(y) / sr
    for frac in (0.1, 0.3, 0.5, 0.7, 0.9):
        off = max(0, min(dur - 15, dur * frac))
        seg = y[int(off * sr):int((off + 15) * sr)]
        if len(seg) < sr * 2:
            continue
        seg_devs.append(method_librosa(seg, sr))

    m1 = method_librosa(y, sr)
    m2 = method_cqt_peaks(y, sr)
    m3 = method_harmonic_peaks(y, sr)

    seg_arr = np.array(seg_devs) if seg_devs else np.array([m1])
    return {
        'librosa': round(m1, 1),
        # 可能为 None（该素材没有可用音高，见 method_cqt_peaks）
        'cqt_hist': None if m2 is None else round(m2, 1),
        'harmonic_peaks': round(m3, 1),
        'segment_median': round(float(np.median(seg_arr)), 1),
        'segment_spread': round(float(seg_arr.max() - seg_arr.min()), 1),
        'segments': [round(v, 1) for v in seg_devs],
        # 校正量：把偏差拉回 0 所需的移调。
        # 注意方向：测出 -34.7（偏低）→ 需要 **升高** 34.7 音分。
        'correct_cents': round(-m1, 1),
        # 是否大到值得整半音移调（|偏差| > 50 音分时）
        'semitone_shift': int(round(-m1 / 100.0)),
    }


def resample_to_440(y, sr, cents: float):
    """把整体音高平移 -cents 音分，使调音回到 A=440。

    返回新的采样率（配合 `librosa.resample` 使用，即"变速不变调"的反面：
    改采样率 → 整体音高和速度一起变，对分析是想要的，因为分析只看音高关系）。
    """
    # 若音频偏低 -33 音分（即实际 A=436 左右），要"升高"33 音分
    # 提高音高 = 加快播放 = 等效采样率提高
    ratio = cents_to_ratio(-cents)
    return int(round(sr * ratio))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    p = Path(sys.argv[1])
    print(f"音频: {p.name}")
    r = detect(p)
    print()
    print("=== 三种方法 ===")
    print(f"  librosa 谱峰      : {r['librosa']:+.1f} 音分")
    cqt = r['cqt_hist']
    print(f"  CQT 谱峰          : {'测量失败（无可用谱峰）' if cqt is None else f'{cqt:+.1f} 音分'}")
    print(f"  HPSS 谐波峰       : {r['harmonic_peaks']:+.1f} 音分")
    print()
    print("=== 分段稳定性 ===")
    print(f"  各段: {r['segments']}")
    print(f"  中位 {r['segment_median']:+.1f} 音分，极差 {r['segment_spread']:.1f} 音分")
    print()
    print("=== 结论 ===")
    dev = r['librosa']
    print(f"  实测偏差: {dev:+.1f} 音分（相对 A=440）")
    print(f"  校正量  : {r['correct_cents']:+.1f} 音分"
          f"{'，约 1 个半音' if abs(r['semitone_shift']) >= 1 else ''}")
    if r['segment_spread'] < 8:
        print("  分段稳定 → 整体调音问题，可统一校正")
    else:
        print("  ⚠️ 分段抖动大 → 可能有转调，或检测不可靠，需人工确认")
    print()
    print("  三种方法一致性:")
    vals = [r['librosa'], r['cqt_hist'], r['harmonic_peaks']]
    print(f"    极差 {max(vals) - min(vals):.1f} 音分 "
          f"{'（一致，可信）' if max(vals) - min(vals) < 8 else '（不一致，建议人工核对）'}")


if __name__ == '__main__':
    main()
