import { describe, expect, it } from 'vitest';
import { lrcSpans, parseLrc } from './Lrc';

describe('parseLrc', () => {
  it('解析标准 [mm:ss.xx] 行，保持时间顺序', () => {
    const r = parseLrc(`
[00:18.539]我们 变成一对 差点
[00:23.999]差点 交出一切
[00:27.729]竟然不是每个 人都会
`);
    expect(r.lines.map((l) => l.text)).toEqual(['我们 变成一对 差点', '差点 交出一切', '竟然不是每个 人都会']);
    expect(r.lines[0].startSec).toBeCloseTo(18.539, 3);
    expect(r.lines[2].startSec).toBeCloseTo(27.729, 3);
  });

  it('一行多个时间戳 → 每个时间戳各产出一条（重复段）', () => {
    const r = parseLrc('[00:15.00][01:20.00]副歌第一句');
    expect(r.lines).toHaveLength(2);
    expect(r.lines.map((l) => l.startSec)).toEqual([15, 80]);
    expect(r.lines.every((l) => l.text === '副歌第一句')).toBe(true);
  });

  it('毫秒位数 1/2/3 位都按正确比例换算', () => {
    const r = parseLrc('[00:01.5]A\n[00:02.25]B\n[00:03.125]C');
    expect(r.lines[0].startSec).toBeCloseTo(1.5, 4);
    expect(r.lines[1].startSec).toBeCloseTo(2.25, 4);
    expect(r.lines[2].startSec).toBeCloseTo(3.125, 4);
  });

  it('offset 正值 = 歌词提前（时间戳减 offset 秒）', () => {
    const r = parseLrc('[offset:+500]\n[00:10.00]一句');
    expect(r.offsetMs).toBe(500);
    expect(r.lines[0].startSec).toBeCloseTo(9.5, 4);
  });

  it('offset 负值 = 延后，且不会把时间推到负数', () => {
    const r = parseLrc('[offset:-750]\n[00:10.00]A\n[00:00.20]B');
    // 负 offset 把两句都往后推 0.75s；排序后顺序也跟着变
    expect(r.lines.map((l) => l.startSec)).toEqual([0.95, 10.75]);
    const r2 = parseLrc('[offset:2000]\n[00:01.00]C');
    expect(r2.lines[0].startSec).toBe(0);
  });

  it('纯时间戳行（间奏）不产出生歌词块', () => {
    const r = parseLrc('[01:04.229]\n[01:05.900]说话了');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].text).toBe('说话了');
  });

  it('元标签进 meta，不产歌词', () => {
    const r = parseLrc('[ti:指纹]\n[ar:胡歌]\n[00:05.00]一句');
    expect(r.meta.ti).toBe('指纹');
    expect(r.meta.ar).toBe('胡歌');
    expect(r.lines).toHaveLength(1);
  });

  it('网易云 JSON 行：前两行的「作词/作曲」归 meta，不当歌词', () => {
    // 真实文件（胡歌 - 指纹.lrc）的开头
    const r = parseLrc(
      [
        '{"t":0,"c":[{"tx":"作词: "},{"tx":"胡歌"}]}',
        '{"t":1000,"c":[{"tx":"作曲: "},{"tx":"谭旋"}]}',
        '[00:18.539]我们 变成一对 差点',
      ].join('\n'),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].startSec).toBeCloseTo(18.539, 3);
    expect(r.meta['作词']).toBe('胡歌');
    expect(r.meta['作曲']).toBe('谭旋');
  });

  it('标准 LRC 开头的「作词/编曲」也归 meta（不留成歌词块）', () => {
    // 实测《月儿弯弯》的 lrc 就是这种写法，之前会导成两块「作词/编曲」
    const r = parseLrc(
      [
        '[00:00.00]作词：BigPerry',
        '[00:01.44]编曲：BigPerry/某某',
        '[00:06.00]月儿弯弯照九州',
      ].join('\n'),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].text).toBe('月儿弯弯照九州');
    expect(r.meta['作词']).toBe('BigPerry');
    expect(r.meta['编曲']).toBe('BigPerry/某某');
  });

  it('通用规则：开头几秒内任何「标签：内容」都归 meta（不再依赖关键词白名单）', () => {
    // 实测《月儿弯弯》的片头有 20 多条，白名单永远列举不完
    const r = parseLrc(
      [
        '[00:00.00]作词：BigPerry',
        '[00:00.50]作曲：BigPerry',
        '[00:01.00]编曲：BigPerry/某某',
        '[00:01.50]和声：某某',
        '[00:02.00]第一小提琴：张三',
        '[00:02.50]二胡：李四',
        '[00:03.00]混音：王五',
        '[00:03.50]OP：某唱片',
        '[00:06.00]月儿弯弯照九州',
      ].join('\n'),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].text).toBe('月儿弯弯照九州');
    expect(Object.keys(r.meta)).toContain('第一小提琴');
    expect(r.meta['op']).toBe('某唱片');
  });

  it('没有冒号的版权声明不会被误删（留给用户自己删）', () => {
    const r = parseLrc(
      ['[00:04.00]未经授权，本作品禁止用于人工智能', '[00:10.00]第一句歌词'].join('\n'),
    );
    expect(r.lines.map((l) => l.text)).toEqual([
      '未经授权，本作品禁止用于人工智能',
      '第一句歌词',
    ]);
  });

  it('正文里（8 秒之后）出现「作曲」二字不会被当成元信息', () => {
    const r = parseLrc('[00:30.00]我为你作曲一首');
    expect(r.lines).toHaveLength(1);
    expect(r.meta['作词']).toBeUndefined();
  });

  it('整份都是 JSON 行（逐字歌词格式）也能解析', () => {
    const r = parseLrc(
      [
        '{"t":12000,"c":[{"tx":"第一"},{"tx":"句"}]}',
        '{"t":15000,"c":[{"tx":"第二句"}]}',
      ].join('\n'),
    );
    expect(r.lines.map((l) => l.text)).toEqual(['第一句', '第二句']);
    expect(r.lines[0].startSec).toBeCloseTo(12, 4);
  });

  it('没有时间戳的纯文本 → 空结果（调用方据此提示用户）', () => {
    const r = parseLrc('第一句\n第二句\n第三句');
    expect(r.lines).toHaveLength(0);
    expect(r.timedOnly).toBe(false);
  });

  it('BOM 与 CRLF 都能处理', () => {
    const r = parseLrc('\uFEFF[00:01.00]一句\r\n[00:02.00]两句\r\n');
    expect(r.lines).toHaveLength(2);
  });

  it('坏行跳过而不是整份失败', () => {
    const r = parseLrc('[00:01.00]好\n这是没有时间戳的说明文字\n[坏行\n[00:02.00]也好');
    expect(r.lines.map((l) => l.text)).toEqual(['好', '也好']);
  });
});

describe('lrcSpans', () => {
  it('用下一行起点当终点，最后一行用调用方给的曲末', () => {
    const spans = lrcSpans(
      [
        { startSec: 10, text: 'A' },
        { startSec: 14, text: 'B' },
      ],
      20,
    );
    expect(spans).toEqual([
      { startSec: 10, endSec: 14, text: 'A' },
      { startSec: 14, endSec: 20, text: 'B' },
    ]);
  });

  it('同一时间点的两行（逐字歌词）不会得到 0 长度', () => {
    const spans = lrcSpans(
      [
        { startSec: 5, text: 'A' },
        { startSec: 5, text: 'B' },
      ],
      9,
    );
    expect(spans[0].endSec).toBeGreaterThan(spans[0].startSec);
    expect(spans[1].endSec).toBe(9);
  });

  it('最后一行超过曲末时不截断（截断交给上层按 totalTicks 处理）', () => {
    const spans = lrcSpans([{ startSec: 100, text: 'A' }], 120);
    expect(spans[0].endSec).toBe(120);
  });
});
