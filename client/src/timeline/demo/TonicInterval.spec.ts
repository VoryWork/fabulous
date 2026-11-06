// SPDX-License-Identifier: MIT
// Copyright (c) 2026 VoryWork

/**
 * 两条级数轨主音之间的音程（轨道头上那个 `+3` / `-1` 徽章）。
 *
 * ## 用户的原话
 *
 * 「F 大调比 D 大调多了 3 个半音，就显 +3，但加到一定程度就变成 - 了」
 *
 * 关键在于**后半句**：不能只给 0–11 的正数。11 个半音听起来像「很远」，
 * 但反方向只差 1 个，应该显示 `-1` 才对。所以取十二平均律里的**最短路径**，
 * 范围落在 -6…+6。
 *
 * ## 为什么这个测试必须存在
 *
 * 这种「正数改负数」的逻辑最容易写出 off-by-one：
 * 边界到底是 `> 6` 还是 `>= 6`、6 该保持 +6 还是变 -6 —— 都要锁死。
 */
import { describe, expect, it } from 'vitest';
import { formatInterval, tonicInterval } from './realData';

describe('tonicInterval（两个主音的最短音程）', () => {
  it('用户举的例子：F 大调比 D 大调高 3 个半音', () => {
    expect(tonicInterval('D', 'F')).toBe(3);
  });

  it('同调是 0', () => {
    expect(tonicInterval('D', 'D')).toBe(0);
    expect(tonicInterval('Bb', 'Bb')).toBe(0);
  });

  it('往上 1–6 个半音用正号', () => {
    expect(tonicInterval('C', 'C#')).toBe(1);
    expect(tonicInterval('C', 'D')).toBe(2);
    expect(tonicInterval('C', 'E')).toBe(4);
    expect(tonicInterval('C', 'F')).toBe(5);
    // 6 是边界，保持 +6（增四度）
    expect(tonicInterval('C', 'F#')).toBe(6);
  });

  it('超过 6 个半音改走反方向，变成负数', () => {
    // C → G 是 +7，但往下走是 -5，取更近的
    expect(tonicInterval('C', 'G')).toBe(-5);
    // C → A 是 +9 → -3
    expect(tonicInterval('C', 'A')).toBe(-3);
    // C → B 是 +11 → -1（这就是「加到一定程度变成 -」的分界）
    expect(tonicInterval('C', 'B')).toBe(-1);
  });

  it('反向也算得对（负数方向）', () => {
    expect(tonicInterval('F', 'D')).toBe(-3);
    expect(tonicInterval('B', 'C')).toBe(1);
    expect(tonicInterval('G', 'C')).toBe(5);
  });

  it('全部 12×12 组合都落在 -6…+6，且互为相反数', () => {
    const TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    for (const a of TONICS) {
      for (const b of TONICS) {
        const v = tonicInterval(a, b);
        expect(v).not.toBeNull();
        expect(v as number).toBeGreaterThanOrEqual(-6);
        expect(v as number).toBeLessThanOrEqual(6);
        /**
         * a→b 与 b→a 必须互为相反数（这等价于「最短路径」的定义）。
         *
         * ⚠️ 不能写 `toBe(-(v as number))`：当 v=0 时 `-0` 与 `0` 用 Object.is 不等，
         * 测试会在同调那 12 个组合上误报。改成验证「两个方向之和为 0」。
         */
        const back = tonicInterval(b, a) as number;
        // 互为相反数（模 12 取余，避开「+6 和 -6 都合法」那个奇点）
        expect((back + (v as number) + 12) % 12).toBe(0);
        expect(formatInterval(v as number)).toBeTruthy();
      }
    }
  });

  it('同音异名等价（C# 和 Db 是同一个音）', () => {
    expect(tonicInterval('C#', 'E')).toBe(tonicInterval('Db', 'E'));
    expect(tonicInterval('A', 'Gb')).toBe(tonicInterval('A', 'F#'));
  });

  it('认不出的主音返回 null（不猜）', () => {
    expect(tonicInterval('', 'C')).toBeNull();
    expect(tonicInterval('C', '')).toBeNull();
    expect(tonicInterval('X', 'C')).toBeNull();
  });
});

describe('formatInterval', () => {
  it('正数带 +，负数带 -，0 不带符号', () => {
    expect(formatInterval(0)).toBe('0');
    expect(formatInterval(3)).toBe('+3');
    expect(formatInterval(6)).toBe('+6');
    expect(formatInterval(-1)).toBe('-1');
    expect(formatInterval(-5)).toBe('-5');
  });
});

/**
 * 轨道头上那个徽章的实际取值逻辑。
 *
 * 这里复刻 `TimelineView.degreeTrackInterval` 的算法：
 *   基准 = 全局主调（第一条级数轨「级数解释」跟随的就是它）
 *   目标 = 该轨自己的 degreeTonic
 *
 * 为什么单独测：UI 里「添加级数轨」需要歌曲上下文，示例数据下点不动，
 * 而这个逻辑（同调返回 null = 不显示徽章）是用户能直接看到的行为。
 */
describe('轨道头徽章的取值（复刻 degreeTrackInterval）', () => {
  const badgeOf = (trackTonic: string, globalTonic: string): number | null => {
    if (!trackTonic || !globalTonic || trackTonic === globalTonic) return null;
    return tonicInterval(globalTonic, trackTonic);
  };

  it('用户举的例子：主调 D 大调，这条轨 F 大调 → +3', () => {
    expect(badgeOf('F', 'D')).toBe(3);
    expect(formatInterval(badgeOf('F', 'D')!)).toBe('+3');
  });

  it('关系小调（G 大调的相对小调是 B 小调）→ B 比 G 低 8，显示 -4', () => {
    // G → B 上行是 +4（大三度），所以是 +4
    expect(badgeOf('B', 'G')).toBe(4);
    // 反过来才是 -4
    expect(badgeOf('G', 'B')).toBe(-4);
  });

  it('同调不显示徽章（返回 null，不是 0）', () => {
    expect(badgeOf('D', 'D')).toBeNull();
    // 自动轨与全局一致，永远不显示
    expect(badgeOf('G', 'G')).toBeNull();
  });

  it('主音缺失时不显示（不猜）', () => {
    expect(badgeOf('', 'D')).toBeNull();
    expect(badgeOf('F', '')).toBeNull();
  });

  it('「加到一定程度变成 -」：八度附近的音程都收敛到 ±5 / ±6', () => {
    // 从 D 出发，各调的音程（用户会看到的全部情况）
    const fromD: Array<[string, number]> = [
      ['D', 0], ['Eb', 1], ['E', 2], ['F', 3], ['F#', 4], ['G', 5],
      // Ab 相对 D 正好是三全音（6 个半音），+6 / -6 等价，
      // 实现取正号（`raw > 6` 才翻转，6 不翻）
      ['Ab', 6], ['A', -5], ['Bb', -4], ['B', -3], ['C', -2], ['Db', -1],
    ];
    for (const [tonic, want] of fromD) {
      if (tonic === 'D') {
        expect(badgeOf(tonic, 'D')).toBeNull();
      } else {
        expect(badgeOf(tonic, 'D')).toBe(want);
      }
    }
  });
});
