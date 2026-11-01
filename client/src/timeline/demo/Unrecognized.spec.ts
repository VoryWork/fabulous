/**
 * 「未识别」段的判定规则。
 *
 * ## 背景
 *
 * `N` 在音乐语义上是「无可识别和弦」。实测《満ちてゆく》5 个 `N`：
 *
 *   0.00~0.51s    (0.5s)   ← 起音前，判 N 正确
 *   31.00~38.68s  (7.7s)   ← 可疑：跨 intro→verse 边界，音频有声音
 *   215.46~233.94s (18.5s) ← 可疑：跨 bridge→verse 边界
 *   238.68~240.37s (1.7s)  ← 短促停顿，判 N 正确
 *   295.85~315.40s (19.6s) ← 淡出尾巴，判 N 正确
 *
 * 中间那两个长的：三个词典档位一致判 N，音频 RMS 与前后段落一致
 * （不是静音），说明是**模型识别失效**，不是「这里没有和弦」。
 *
 * 所以长 `N` 要单独标成「未识别」——不猜内容，也不假装模型是对的。
 * 但**延伸到曲末**的长 `N` 要保留（那是淡出，判 N 没错）。
 */
import { describe, it, expect } from 'vitest';

const UNRECOGNIZED_MIN_BARS = 2;

/**
 * 与 `makeRealTracks` 里一致的判定。
 *
 * @param isN      原始标签是否为 N
 * @param bars     该块长度（小节）
 * @param reachesEnd 是否延伸到曲末
 */
function shouldMarkUnrecognized(isN: boolean, bars: number, reachesEnd: boolean): boolean {
  return isN && bars > UNRECOGNIZED_MIN_BARS && !reachesEnd;
}

describe('未识别段判定', () => {
  it('长 N 且不在曲末 → 未识别', () => {
    expect(shouldMarkUnrecognized(true, 5, false)).toBe(true); // 18~23 小节
    expect(shouldMarkUnrecognized(true, 11, false)).toBe(true); // 129~140 小节
  });

  it('短 N 保留（真实的短促停顿）', () => {
    expect(shouldMarkUnrecognized(true, 1, false)).toBe(false);
    expect(shouldMarkUnrecognized(true, 2, false)).toBe(false);
    // 刚好 2 小节仍算正常（边界值是「大于」）
    expect(UNRECOGNIZED_MIN_BARS).toBe(2);
  });

  it('延伸到曲末的长 N 保留（淡出尾巴）', () => {
    expect(shouldMarkUnrecognized(true, 12, true)).toBe(false);
  });

  it('真有和弦的段永远不标未识别', () => {
    expect(shouldMarkUnrecognized(false, 20, false)).toBe(false);
    expect(shouldMarkUnrecognized(false, 1, false)).toBe(false);
  });

  it('阈值大于 2 小节才触发，避免把 2 小节的真实停顿误标', () => {
    expect(shouldMarkUnrecognized(true, 2.5, false)).toBe(true);
    expect(shouldMarkUnrecognized(true, 2.0, false)).toBe(false);
  });
});
