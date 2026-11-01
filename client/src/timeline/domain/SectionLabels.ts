/**
 * 歌曲结构用语字典。
 *
 * ## 为什么要有字典，而不是让用户随便打字
 *
 * 结构段的名字是**分析用语**，不是自由文本。同一首歌里出现
 * `Chorus` / `chorus` / `副歌` / `高潮` 四种写法，等于没有结构信息 ——
 * 后续想按结构做统计（比如"副歌平均多长"）就完全没法算。
 *
 * 所以结构段名只能从这份表里选（和和弦名只能从 ChordPicker 选是同一个道理）。
 *
 * ## 分组依据
 *
 * 不是按"常见程度"，而是按**在歌里的功能**，因为用户找词时的思路是
 * 「我要找的是个过渡段」而不是「我要找第 7 个词」：
 *
 *   core         主体骨架，几乎每首歌都有
 *   transition   连接/重复，位置上依附于别的主体段
 *   instrumental 器乐，没有人声或人声退居次要
 *   electronic   电子乐特有（build / drop / breakdown 是结构单位，不是风格）
 *   ending       收尾
 *
 * ## 中英对照只做 hint
 *
 * 中文翻译在业界不统一（`Pre-Chorus` 有译"预副歌/导歌/副歌前段"），
 * 拿它当显示名会让两个人对同一份谱面产生不同叫法。
 * 所以显示名一律用英文原词，中文只放在悬停提示里帮助认词。
 */

export type SectionGroupId = 'core' | 'transition' | 'instrumental' | 'electronic' | 'ending';

export interface SectionLabelDef {
  /** 稳定 id（存盘用，改显示名不影响已有数据） */
  id: string;
  /** 显示名（英文原词） */
  label: string;
  /** 中文提示（仅悬停显示） */
  hint: string;
}

export interface SectionGroup {
  id: SectionGroupId;
  /** 分组标题 */
  title: string;
  items: SectionLabelDef[];
}

export const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    id: 'core',
    title: '主体',
    items: [
      { id: 'intro', label: 'Intro', hint: '前奏' },
      { id: 'verse', label: 'Verse', hint: '主歌' },
      { id: 'pre-chorus', label: 'Pre-Chorus', hint: '预副歌 / 导歌' },
      { id: 'chorus', label: 'Chorus', hint: '副歌' },
      { id: 'post-chorus', label: 'Post-Chorus', hint: '副歌后段' },
      { id: 'bridge', label: 'Bridge', hint: '桥段' },
      { id: 'outro', label: 'Outro', hint: '尾奏' },
    ],
  },
  {
    id: 'transition',
    title: '过渡 / 变体',
    items: [
      { id: 'pre-verse', label: 'Pre-Verse', hint: '主歌前段' },
      { id: 'refrain', label: 'Refrain', hint: '叠句' },
      { id: 'hook', label: 'Hook', hint: '记忆点' },
      { id: 'tag', label: 'Tag', hint: '尾句重复' },
      { id: 'turnaround', label: 'Turnaround', hint: '回转句' },
      { id: 'coda', label: 'Coda', hint: '尾声' },
    ],
  },
  {
    id: 'instrumental',
    title: '器乐',
    items: [
      { id: 'riff', label: 'Riff', hint: '重复短句' },
      { id: 'solo', label: 'Solo', hint: '独奏' },
      { id: 'guitar-solo', label: 'Guitar Solo', hint: '吉他独奏' },
      { id: 'keyboard-solo', label: 'Keyboard Solo', hint: '键盘独奏' },
      { id: 'instrumental', label: 'Instrumental', hint: '器乐段' },
      { id: 'interlude', label: 'Interlude', hint: '间奏' },
      { id: 'vamp', label: 'Vamp', hint: '循环短句' },
    ],
  },
  {
    id: 'electronic',
    title: '电子乐',
    items: [
      { id: 'build-up', label: 'Build-up', hint: '铺垫 / 渐强' },
      { id: 'pre-drop', label: 'Pre-drop', hint: '下落前' },
      { id: 'drop', label: 'Drop', hint: '下落（全曲爆点）' },
      { id: 'breakdown', label: 'Breakdown', hint: '骤停段' },
      { id: 'main', label: 'Main', hint: '主段' },
      { id: 'groove', label: 'Groove', hint: '律动段' },
      { id: 'break', label: 'Break', hint: '停顿 / 鼓点段' },
      { id: 'fill', label: 'Fill', hint: '过门加花' },
      { id: 'vocal-chop', label: 'Vocal Chop', hint: '人声切片' },
    ],
  },
  {
    id: 'ending',
    title: '收尾',
    items: [
      { id: 'ending', label: 'Ending', hint: '结束' },
      { id: 'fade-in', label: 'Fade in', hint: '淡入' },
      { id: 'fade-out', label: 'Fade out', hint: '淡出' },
    ],
  },
];

const BY_LABEL = new Map<string, SectionLabelDef>();
const BY_ID = new Map<string, SectionLabelDef>();
for (const g of SECTION_GROUPS) {
  for (const it of g.items) {
    BY_LABEL.set(it.label.toLowerCase(), it);
    BY_ID.set(it.id, it);
  }
}

/** 所有标准名（英文显示名） */
export const SECTION_LABELS: readonly string[] = SECTION_GROUPS.flatMap((g) =>
  g.items.map((i) => i.label),
);

/**
 * 把任意写法归一成字典里的标准名。
 *
 * 模型（all-in-one-infer）输出的标签不一定是我们的写法：实测有
 * `verse`（小写）、`Verse 1`（带序号）、`chorus`、`Chorus `（尾空格）。
 * 归一化后再匹配，匹配不上的原样保留 —— 宁可显示一个陌生标签，
 * 也不要把它悄悄改成别的段落。
 */
export function normalizeSectionLabel(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  // 直接命中
  const direct = BY_LABEL.get(t.toLowerCase());
  if (direct) return direct.label;
  // 去掉尾部序号：`Verse 1` / `Verse1` / `Verse (1)`
  const stripped = t.replace(/\s*[（(]?\d+[）)]?$/, '').trim();
  const byStripped = BY_LABEL.get(stripped.toLowerCase());
  if (byStripped) return byStripped.label;
  return t;
}

/** 取某个标准名的中文提示（没有则返回空串） */
export function sectionLabelHint(label: string): string {
  return BY_LABEL.get(label.trim().toLowerCase())?.hint ?? '';
}

/**
 * 结构段的**底色分组**。
 *
 * 颜色按功能分组而不是按具体名字，原因：结构段有 30+ 个名字，
 * 一名字一色必然分不清。按功能分 5 组，用户扫一眼就知道
 * 「这块是主体段 / 这块是过渡」。
 */
export function sectionGroupOf(label: string): SectionGroupId {
  const t = label.trim().toLowerCase();
  for (const g of SECTION_GROUPS) {
    for (const it of g.items) {
      if (it.label.toLowerCase() === t || it.id === t) return g.id;
    }
  }
  // 未收录的标签按「主体」处理，至少不显得突兀
  return 'core';
}
