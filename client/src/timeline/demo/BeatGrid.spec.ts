/**
 * 拍网格对齐回归测试。
 *
 * ## 这个 bug 长什么样
 *
 * 和弦块起点大致对，但**右边界越过小节线越来越多**，越往后偏得越厉害，
 * 到后半段能偏 1~4 拍（严重时 44 拍）。
 *
 * ## 根因（不是"静音没补偿"也不是"变速"）
 *
 * `beatsSec` 和 `downbeatsSec` 是两个独立数组：
 *   - 画小节线用 `downbeatsSec`
 *   - 「秒 → tick」用 `beatsSec` 的**下标**（第 i 个拍点 = tick i×960）
 *
 * 两者必须是同一个网格：`downbeats[k]` 必须恰好等于 `beats[4k]`。
 *
 * 但 beat_this 在**小节交界处会多检出拍点**。实测《満ちてゆく》有 88 处
 * 0.20~0.22s 的假拍（真实拍间隔 0.42s），beats 从应有的 740 个变成 781 个。
 * 多出来的 41 个把下标撑大了，于是 `beats[10]` 才是第 3 小节起点（应为 [8]）。
 * 误差随歌曲推进累积。
 *
 * ## 修法
 *
 * 以 `downbeatsSec` 为骨架重建拍位（`_rebuild_beats_from_downbeats` /
 * `makeBeatSnapper` 的自愈分支）。判据用「拍数 vs 小节数×4」是否对得上，
 * 而不是去猜哪个拍点是假的 —— 0.20s 和 0.42s 的界限在变速歌里不牢靠。
 */
import { describe, expect, it } from 'vitest';
import { fixDownbeats, makeBeatSnapper, padLeadingBar } from './realData';

/** 造一个理想网格：bpm 固定，小节长度 = 4 拍 */
function idealGrid(bars: number, beatSec = 0.42, start = 0.5) {
  const beats: number[] = [];
  const downs: number[] = [];
  for (let i = 0; i < bars * 4; i++) beats.push(start + i * beatSec);
  for (let i = 0; i < bars; i++) downs.push(start + i * 4 * beatSec);
  return { beats, downs };
}

/**
 * 在每两个小节交界处插入一个假拍点（模拟 beat_this 的多检）。
 * 假拍点落在小节起点前 0.2s —— 正是实测数据的形态。
 */
function withFakeBeats(g: { beats: number[]; downs: number[] }, everyBars = 2) {
  const out: number[] = [];
  for (let i = 0; i < g.beats.length; i++) {
    // 在每个小节起点（i % 4 === 0 且非第 0 个）前插一个假拍
    if (i > 0 && i % 4 === 0 && (i / 4) % everyBars === 0) {
      out.push(g.beats[i] - 0.2);
    }
    out.push(g.beats[i]);
  }
  return out;
}

const PPQ = 960;

describe('拍网格对齐', () => {
  it('理想数据：downbeats[k] 落在 tick k*4*PPQ', () => {
    const g = idealGrid(20);
    const snap = makeBeatSnapper(g.beats, g.downs);
    for (let k = 0; k < g.downs.length; k++) {
      expect(snap(g.downs[k])).toBe(k * 4 * PPQ);
    }
  });

  it('含假拍点的旧数据：不修就会累积漂移（这是 bug 的复现）', () => {
    const g = idealGrid(40);
    const dirty = withFakeBeats(g, 2);
    // 不传 downbeats → 走原始逻辑，暴露问题
    const snap = makeBeatSnapper(dirty);

    const errs: number[] = [];
    for (let k = 0; k < g.downs.length; k++) {
      errs.push((snap(g.downs[k]) - k * 4 * PPQ) / PPQ);
    }
    const maxErr = Math.max(...errs.map(Math.abs));
    // 假拍点让后面的小节全部错位，且越往后越多
    expect(maxErr).toBeGreaterThan(1);
    // 确认是**累积**的：最后一个错得比中间多
    expect(Math.abs(errs[errs.length - 1])).toBeGreaterThanOrEqual(Math.abs(errs[5]));
  });

  it('含假拍点的旧数据 + downbeats：自愈后恢复对齐', () => {
    const g = idealGrid(40);
    const dirty = withFakeBeats(g, 2);
    const snap = makeBeatSnapper(dirty, g.downs);

    for (let k = 0; k < g.downs.length; k++) {
      const err = Math.abs(snap(g.downs[k]) - k * 4 * PPQ) / PPQ;
      expect(err).toBeLessThan(0.01);
    }
  });

  it('拍数只差 1 个时不重建（首尾边界抖动属正常）', () => {
    const g = idealGrid(20);
    // 去掉最后一个拍点 → 差 1
    const short = g.beats.slice(0, -1);
    const snap = makeBeatSnapper(short, g.downs);
    // 不重建的话，中间小节仍然对齐
    expect(snap(g.downs[5])).toBe(5 * 4 * PPQ);
  });

  it('没有 downbeats 时保持原行为（向后兼容）', () => {
    const g = idealGrid(10);
    const snap = makeBeatSnapper(g.beats);
    expect(snap(g.downs[3])).toBe(3 * 4 * PPQ);
  });

  it('变速歌：每小节内部均分，但小节线严格对齐', () => {
    // 小节长度从 1.6s 渐变到 2.0s
    const downs: number[] = [0.5];
    for (let i = 1; i < 20; i++) {
      downs.push(downs[i - 1] + 1.6 + i * 0.02);
    }
    const beats: number[] = [];
    for (let i = 0; i < downs.length - 1; i++) {
      const step = (downs[i + 1] - downs[i]) / 4;
      for (let k = 0; k < 4; k++) beats.push(downs[i] + k * step);
    }
    // 故意多塞 3 个假拍触发重建
    const dirty = [...beats.slice(0, 8), beats[7] + 0.1, ...beats.slice(8)];

    const snap = makeBeatSnapper(dirty, downs);
    for (let k = 0; k < downs.length; k++) {
      expect(Math.abs(snap(downs[k]) - k * 4 * PPQ) / PPQ).toBeLessThan(0.01);
    }
  });
});

/**
 * 倍速/半速检出的异常小节边界。
 *
 * ## 症状
 *
 * 「强拍和小节线偏移」，而且**只在开头/结尾**。
 *
 * ## 根因
 *
 * beat_this 在开头/结尾会倍速/半速地检出拍点。实测《何なんw》：
 *
 *   beat[0] 2.760  gap=0.340  <-DOWNBEAT
 *   beat[1] 3.100  gap=0.340     ← 正常是 0.665，这里全是一半
 *   beat[4] 4.120  gap=0.835  <-DOWNBEAT
 *
 * 于是 downbeat[0]=2.760 到 downbeat[1]=4.120 只差 1.36s（约 2 拍），
 * 而正常一小节 2.66s。按 4 拍均分重建时这一小节被压成 1.36s，
 * 后面所有小节线前移。
 */
describe('fixDownbeats', () => {
  it('正常网格原样返回（不能误伤真实的节奏变化）', () => {
    // 中位 2.66s，其中第 2 小节 2.04s 是真实的引子变化（0.77x）
    const d = [2.76, 5.42, 8.08, 10.74, 13.4];
    const out = fixDownbeats(d);
    expect(out).toEqual(d);
  });

  it('半速小节（0.5x）被拉到中位时长', () => {
    // 第 2 小节只有 1.36s（约半小节），应被拉成 2.66s
    const d = [2.76, 4.12, 7.46, 10.1, 12.78, 15.44, 18.1];
    const out = fixDownbeats(d);
    const spans = out.slice(1).map((v, i) => +(v - out[i]).toFixed(2));
    // 修完后第一个间隔应该是中位量级，而不是 1.36
    expect(spans[0]).toBeGreaterThan(2.5);
    expect(spans[0]).toBeLessThan(2.8);
  });

  it('修正后小节数不变（不丢弃，只挪位置）', () => {
    const d = [0, 1.36, 6.7, 9.36, 12.02, 14.68];
    expect(fixDownbeats(d)).toHaveLength(d.length);
  });

  it('修正后间隔连续（不会出现负跨度或零跨度）', () => {
    const d = [0, 1.36, 6.7, 9.36, 12.02];
    const out = fixDownbeats(d);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
  });

  it('只有 1~2 个小节时不做处理（样本不足以估中位）', () => {
    expect(fixDownbeats([1])).toEqual([1]);
    expect(fixDownbeats([1, 3])).toEqual([1, 3]);
  });

  it('空输入返回空', () => {
    expect(fixDownbeats([])).toEqual([]);
  });

  it('修正后配合 makeBeatSnapper 仍严格对齐', () => {
    const broken = [2.76, 4.12, 7.46, 10.1, 12.78, 15.44, 18.1];
    const fixed = fixDownbeats(broken);
    const beats = fixed.flatMap((t, i) =>
      i < fixed.length - 1
        ? [0, 1, 2, 3].map((k) => t + (fixed[i + 1] - t) * k / 4)
        : [],
    );
    const snap = makeBeatSnapper(beats, fixed);
    for (let k = 0; k < fixed.length; k++) {
      expect(Math.abs(snap(fixed[k]) - k * 4 * PPQ) / PPQ).toBeLessThan(0.01);
    }
  });
});

/**
 * 开头补一个虚拟小节（`padLeadingBar`）。
 *
 * ## 用户报的问题
 *
 * 「《何なんw》小节第一拍仍然会挪到第二拍」「歌曲从头播放时，光标会先往前跑
 * 一阵，然后又跳回开头」「如果开头有静音段，是不是可以加一个小节给他放出来」
 *
 * ## 根因
 *
 * 模型的第一个 downbeat 是「音乐真正进入」的位置（2.76s），而音频 0.28s 起
 * 就有前奏了。于是 tick 0 = 2.76s —— 前奏那 2.76 秒**完全不在网格里**：
 * 谱面左边空白、播放时光标卡在最左端不动，看起来就像「第一拍跑到第二拍去了」。
 */
describe('padLeadingBar', () => {
  /* 注意：padLeadingBar 与 fixDownbeats 都是幂等的，
     后端补过的数据走一遍不会再补。 */

  it('第一个 downbeat 离 0 超过半小节时，补一个虚拟小节', () => {
    const d = [2.76, 5.42, 8.08, 10.74];
    const out = padLeadingBar(d);
    expect(out).toHaveLength(5);
    expect(out[0]).toBeCloseTo(0.1, 5); // 2.76 - 2.66
    expect(out[1]).toBe(2.76);
  });

  it('第一个 downbeat 太靠后时，虚拟小节起点取 0（不产出负数）', () => {
    // 1.5 已超过半个小节（1.33）但要补的小节起点会是负数 → 取 0
    const d = [1.5, 4.16, 6.82];
    const out = padLeadingBar(d);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(0);
  });

  it('已经贴近 0 就不补（幂等）', () => {
    const d = [0.1, 2.76, 5.42];
    expect(padLeadingBar(d)).toEqual(d);
  });

  it('补出来的数据再补一次不会变（后端已补过）', () => {
    const once = padLeadingBar([2.76, 5.42, 8.08, 10.74]);
    const twice = padLeadingBar(once);
    expect(twice).toEqual(once);
  });

  it('补完之后，beats 重建的小节数对得上', () => {
    const fixed = padLeadingBar([2.76, 5.42, 8.08, 10.74]);
    const beats = [2.76, 3.42, 4.09, 4.75];
    const snap = makeBeatSnapper(beats, fixed);
    // 第一个虚拟小节起点应映射到 tick 0
    expect(snap(0.1)).toBe(0);
    // 原来的第一个 downbeat 现在是第 2 小节起点
    expect(snap(2.76)).toBe(3840);
  });

  it('数据太短时原样返回（不崩）', () => {
    expect(padLeadingBar([])).toEqual([]);
    expect(padLeadingBar([1])).toEqual([1]);
    expect(padLeadingBar([1, 3])).toEqual([1, 3]);
  });
});
