/**
 * 量化测试 —— 最小量化单位是**八分音符**（480 tick）。
 *
 * 演进（两版用户反馈）：
 *   1. 「不能无限细分，最少按一拍量化」 → 960
 *   2. 「和声量化以八分音符会好一些，因为有些歌会抢拍」 → 480
 *
 * 验收标准：
 *   1. 边界落在八分音符网格上（480 的倍数）
 *   2. 即使关闭吸附（Alt），也量化到 480
 *   3. 切分位置（半拍）能被保留，不会被抹成整拍
 *   4. 导入时最小和弦长度仍为 1 拍（960）
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_SNAP_CONFIG,
  MIN_QUANTUM_TICKS,
  quantizeToQuantum,
  snap,
  snapRange,
} from './SnapEngine';
import { PPQ } from './Tick';

const EIGHTH = PPQ / 2; // 480

describe('MIN_QUANTUM_TICKS：最小量化单位是八分音符', () => {
  it('等于半拍（480 tick）', () => {
    expect(MIN_QUANTUM_TICKS).toBe(EIGHTH);
    expect(MIN_QUANTUM_TICKS).toBe(480);
  });

  it('quantizeToQuantum 对齐到 480', () => {
    expect(quantizeToQuantum(0)).toBe(0);
    expect(quantizeToQuantum(240)).toBe(480); // 1/4 拍 → 向上
    expect(quantizeToQuantum(239)).toBe(0);
    expect(quantizeToQuantum(480)).toBe(480); // 半拍保持
    expect(quantizeToQuantum(720)).toBe(960); // 3/4 拍 → 1 拍
    expect(quantizeToQuantum(960)).toBe(960); // 整拍保持
  });

  it('结果总是 480 的整数倍', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100000, max: 100000 }), (t) => {
        return quantizeToQuantum(t) % EIGHTH === 0;
      }),
    );
  });

  it('-0 被归一化为 0', () => {
    expect(quantizeToQuantum(-100)).toBe(0);
    expect(Object.is(quantizeToQuantum(-100), -0)).toBe(false);
  });
});

describe('切分（抢拍）能被保留', () => {
  const cfg = { ...DEFAULT_SNAP_CONFIG, enabled: false };

  it('半拍位置不会被抹成整拍', () => {
    // 480 = 半拍，量化后必须还是 480，不能变成 0 或 960
    expect(snap(480, cfg, 0.02).tick).toBe(480);
    expect(snap(1440, cfg, 0.02).tick).toBe(1440); // 1.5 拍
    expect(snap(2400, cfg, 0.02).tick).toBe(2400); // 2.5 拍
  });

  it('八分音符位置保持不动', () => {
    for (let beat = 0; beat <= 8; beat += 0.5) {
      const tick = beat * PPQ;
      const r = snap(tick, cfg, 0.02);
      expect(r.tick).toBe(tick);
    }
  });

  it('比八分音符更细的位置会被吸收', () => {
    // 240 = 1/4 拍，应量化到 0 或 480
    const r = snap(240, cfg, 0.02);
    expect(r.tick % EIGHTH).toBe(0);
    expect([0, 480]).toContain(r.tick);
  });
});

describe('关闭吸附时仍量化到八分音符', () => {
  const cfg = { ...DEFAULT_SNAP_CONFIG, enabled: false };

  it('Alt 关闭吸附后，结果仍对齐 480', () => {
    for (const raw of [100, 500, 960, 1000, 1450, 2000]) {
      const r = snap(raw, cfg, 0.02);
      expect(r.tick % EIGHTH).toBe(0);
      expect(r.source).toBe('none');
    }
  });
});

describe('吸附到整拍网格（gridDivision=1）时仍可能落在整拍', () => {
  it('默认网格是 1 拍', () => {
    expect(DEFAULT_SNAP_CONFIG.gridDivision).toBe(1);
  });

  it('靠近整拍时吸附到整拍', () => {
    const r = snap(1200, DEFAULT_SNAP_CONFIG, 0.02);
    expect(r.tick).toBe(960);
    expect(r.source).toBe('grid');
  });
});

describe('snapRange 保持两端都在八分音符网格', () => {
  it('拖左边界', () => {
    const cfg = { ...DEFAULT_SNAP_CONFIG, enabled: false };
    const r = snapRange(1000, 5000, 'start', cfg, 0.02);
    expect(r.start % EIGHTH).toBe(0);
    expect(r.end % EIGHTH).toBe(0);
  });

  it('拖右边界', () => {
    const cfg = { ...DEFAULT_SNAP_CONFIG, enabled: false };
    const r = snapRange(1000, 5000, 'end', cfg, 0.02);
    expect(r.start % EIGHTH).toBe(0);
    expect(r.end % EIGHTH).toBe(0);
  });

  it('拖整块', () => {
    const cfg = { ...DEFAULT_SNAP_CONFIG, enabled: false };
    const r = snapRange(1000, 5000, 'both', cfg, 0.02);
    expect(r.start % EIGHTH).toBe(0);
    expect(r.end % EIGHTH).toBe(0);
  });

  it('Property: 任意输入都产出八分音符网格上的区间', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200000 }),
        fc.integer({ min: 1, max: 50000 }),
        fc.constantFrom<'start' | 'end' | 'both'>('start', 'end', 'both'),
        fc.boolean(),
        (start, len, grab, enabled) => {
          const cfg = { ...DEFAULT_SNAP_CONFIG, enabled };
          const r = snapRange(start, start + len, grab, cfg, 0.02);
          return r.start % EIGHTH === 0 && r.end % EIGHTH === 0;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('像素取整的容差', () => {
  it('整数像素渲染引入的 tick 误差 < 1/10 拍', () => {
    const ppt = 0.01484375;
    const maxTickErr = 0.5 / ppt; // ≈ 33.7 tick
    expect(maxTickErr / PPQ).toBeLessThan(0.1);
  });

  it('但半拍间隔（480 tick ≈ 7px）足够分辨', () => {
    const ppt = 0.01484375;
    const eighthPx = EIGHTH * ppt;
    // 半拍在 100% 缩放下约 7px，肉眼与整数像素取整（±0.5px）可区分
    expect(eighthPx).toBeGreaterThan(5);
  });
});
