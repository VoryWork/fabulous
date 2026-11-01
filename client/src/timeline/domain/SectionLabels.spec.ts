/**
 * 结构用语字典的测试。
 *
 * ## 为什么值得单独测
 *
 * 这份字典是**存盘数据的键**：结构段的 `label` 会原样写进 `edits_json`。
 * 如果 `normalizeSectionLabel` 哪天把 `Verse 1` 归一成 `verse`（小写），
 * 老数据和新数据就会变成两个名字，按结构做统计就永久错位。
 *
 * 所以这里锁住三件事：
 *   1. 归一化结果必须是字典里的**标准写法**
 *   2. 认不出来的标签必须**原样保留**（不能悄悄改成别的段落）
 *   3. 每个标签都能查到分组（颜色靠它）
 */
import { describe, expect, it } from 'vitest';
import {
  SECTION_GROUPS,
  SECTION_LABELS,
  normalizeSectionLabel,
  sectionGroupOf,
  sectionLabelHint,
} from './SectionLabels';

describe('SectionLabels 字典', () => {
  it('至少有用户要求的那些常用段名', () => {
    for (const name of [
      'Intro', 'Pre-Verse', 'Verse', 'Pre-Chorus', 'Chorus', 'Post-Chorus',
      'Riff', 'Bridge', 'Interlude', 'Break', 'Solo', 'Guitar Solo',
      'Outro', 'Fade out',
    ]) {
      expect(SECTION_LABELS).toContain(name);
    }
  });

  it('电子乐的结构单位也在（build / drop / breakdown 不是风格，是结构）', () => {
    for (const name of ['Build-up', 'Pre-drop', 'Drop', 'Breakdown', 'Main', 'Groove', 'Fill']) {
      expect(SECTION_LABELS).toContain(name);
    }
  });

  it('没有重名（重名会让 groupOf 只能取到第一个）', () => {
    expect(new Set(SECTION_LABELS).size).toBe(SECTION_LABELS.length);
  });

  it('每个分组都非空', () => {
    for (const g of SECTION_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeSectionLabel', () => {
  it('模型输出的小写也能归到标准写法', () => {
    expect(normalizeSectionLabel('verse')).toBe('Verse');
    expect(normalizeSectionLabel('CHORUS')).toBe('Chorus');
    expect(normalizeSectionLabel('bridge')).toBe('Bridge');
  });

  it('去掉尾部的序号', () => {
    expect(normalizeSectionLabel('Verse 1')).toBe('Verse');
    expect(normalizeSectionLabel('Chorus2')).toBe('Chorus');
    expect(normalizeSectionLabel('Verse (3)')).toBe('Verse');
  });

  it('去掉首尾空格', () => {
    expect(normalizeSectionLabel('  Chorus  ')).toBe('Chorus');
  });

  it('认不出来的标签原样保留（不能悄悄改成别的段落）', () => {
    expect(normalizeSectionLabel('Guided Improvisation')).toBe('Guided Improvisation');
    expect(normalizeSectionLabel('A段')).toBe('A段');
  });

  it('空串 / 纯空白原样返回', () => {
    expect(normalizeSectionLabel('')).toBe('');
    expect(normalizeSectionLabel('   ')).toBe('');
  });
});

describe('sectionGroupOf', () => {
  it('按功能分组（颜色靠它）', () => {
    expect(sectionGroupOf('Chorus')).toBe('core');
    // Pre-Chorus 归「主体」：它是副歌的固定前段，几乎每首都有
    expect(sectionGroupOf('Pre-Chorus')).toBe('core');
    // 「过渡 / 变体」放的是可选构件
    expect(sectionGroupOf('Pre-Verse')).toBe('transition');
    expect(sectionGroupOf('Refrain')).toBe('transition');
    expect(sectionGroupOf('Guitar Solo')).toBe('instrumental');
    expect(sectionGroupOf('Drop')).toBe('electronic');
    expect(sectionGroupOf('Fade out')).toBe('ending');
  });

  it('大小写不敏感', () => {
    expect(sectionGroupOf('chorus')).toBe('core');
    expect(sectionGroupOf('DROP')).toBe('electronic');
  });

  it('未知标签兜底到 core（至少不崩）', () => {
    expect(sectionGroupOf('???')).toBe('core');
  });
});

describe('sectionLabelHint', () => {
  it('能查到中文提示', () => {
    expect(sectionLabelHint('Chorus')).toBe('副歌');
    expect(sectionLabelHint('Bridge')).toBe('桥段');
  });

  it('未知标签返回空串而不是抛错', () => {
    expect(sectionLabelHint('???')).toBe('');
  });
});
