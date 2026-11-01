/**
 * 设计令牌 —— 单一来源，取自设计稿（和声研究工作台）。
 *
 * 从设计稿实测采样的色值：
 *   主色橙       #FD651A
 *   主色深橙     #FF2100（Logo 渐变端）
 *   页面底色     #F2F3F3
 *   工具栏/面板  #F5F3F3 / #FFFFFF
 *   轨道区底     #F6F6F6
 *   段落 Verse   #FDDDCC
 *   段落 Pre     #FCDAC8
 *   段落 Chorus  #FDB08B
 *   段落 Bridge  #D9C9FC（淡紫）
 *   和弦块默认   #F7F7F7
 *   和弦块选中   #FDD8BD
 *   级数块       #F4F4F4
 *   波形/网格    #B1B1B3
 *   正文         #000000
 *   次要文字     #6B6B6E
 *   弱化文字     #9A9A9D
 *
 * Canvas 读不到 CSS 变量，所以这里必须有一份 TS 副本。
 * styles/global.css 的 CSS 变量与之对应，改一处要同步另一处。
 */

export const COLORS = {
  // ---- 背景层次（浅色）
  bgApp: '#F2F3F3',
  bgPanel: '#FFFFFF',
  bgPanelAlt: '#F5F3F3',
  bgTrack: '#F6F6F6',
  bgTrackAlt: '#F4F4F4',
  bgRuler: '#FFFFFF',
  bgHover: '#F0F1F1',
  bgActive: '#FDECE3',

  // ---- 边框
  border: '#E5E5E5',
  borderStrong: '#D4D4D4',

  // ---- 文本
  textPrimary: '#1A1A1A',
  textSecondary: '#6B6B6E',
  textMuted: '#9A9A9D',
  textInverse: '#FFFFFF',

  // ---- 品牌（橙）
  accent: '#FD651A',
  accentHover: '#FF7A33',
  accentDeep: '#FF2100',
  accentDim: '#FDD8BD',
  accentSoft: '#FDECE3',

  // ---- 语义
  success: '#22A06B',
  warning: '#E8A33D',
  danger: '#E5484D',

  // ---- 时间轴网格
  gridBar: '#E0E0E0',
  gridBarStrong: '#C8C8C8',
  gridBeat: '#EDEDED',
  gridSubBeat: '#F2F2F2',

  // ---- 播放头 / 选区
  playhead: '#FD651A',
  selection: 'rgba(253, 101, 26, 0.10)',
  selectionBorder: 'rgba(253, 101, 26, 0.45)',

  // ---- 轨道类型（片段块）
  // 设计稿里和弦/级数块是中性灰白，靠橙色选中态区分；
  // 段落块用不同深浅的暖橙 + 一个淡紫表示 Bridge。
  trackChord: '#3A3A3C',
  trackChordBg: '#F7F7F7',
  trackChordBgActive: '#FDD8BD',
  trackSection: '#C4703F',
  trackSectionBg: '#FDDDCC',
  trackKey: '#5B7A9E',
  trackKeyBg: '#F1F4F8',
  trackDegree: '#7A6B58',
  trackDegreeBg: '#F4F4F4',
  trackLyric: '#4A4A4C',
  trackLyricBg: '#FAFAFA',
  trackBeat: '#B1B1B3',

  // 段落专用（按设计稿：Verse/Pre 淡橙、Chorus 深橙、Bridge 淡紫）
  sectionVerse: '#FDDDCC',
  sectionPre: '#FCDAC8',
  sectionChorus: '#FDB08B',
  sectionBridge: '#D9C9FC',
  sectionText: '#6B3A22',

  // ---- 状态色
  stateDraft: '#E8A33D',
  stateConfirmed: '#22A06B',
  stateRejected: '#B0B0B3',
} as const;

/** 尺寸令牌 */
export const SIZES = {
  /** 左侧轨名列宽（设计稿约 145px，稍放宽给中文轨名） */
  trackHeaderWidth: 148,
  /** 顶部标尺高 */
  /**
   * 标尺高：**两行**。
   *
   *   上行 = 小节号（`25`、`26`）
   *   下行 = 拍号（`1 2 3 4`）
   *
   * 只有小节号时 30px 够用，但「拍是一个时刻」这件事必须能看见 ——
   * 光有刻度线，用户没法一眼判断某个和弦落在第几拍。
   */
  rulerHeight: 44,
  /** 一般轨道行高 */
  trackHeight: 42,
  /** 和弦/级数轨行高 */
  chordTrackHeight: 52,
  rulerFont: '11px',
  clipFont: '12px',
  clipRadius: 0,
  clipPaddingX: 8,
} as const;

export type TrackKind = 'chord' | 'section' | 'key' | 'degree' | 'lyric' | 'beat';

/** 轨道类型的视觉配置 */
export function trackStyle(kind: TrackKind) {
  switch (kind) {
    case 'chord':
      return { fg: COLORS.trackChord, bg: COLORS.trackChordBg, active: COLORS.trackChordBgActive };
    case 'section':
      return { fg: COLORS.trackSection, bg: COLORS.trackSectionBg, active: COLORS.sectionChorus };
    case 'key':
      return { fg: COLORS.trackKey, bg: COLORS.trackKeyBg, active: COLORS.accentDim };
    case 'degree':
      return { fg: COLORS.trackDegree, bg: COLORS.trackDegreeBg, active: COLORS.accentDim };
    case 'lyric':
      return { fg: COLORS.trackLyric, bg: COLORS.trackLyricBg, active: COLORS.accentSoft };
    case 'beat':
      return { fg: COLORS.trackBeat, bg: COLORS.bgTrack, active: COLORS.accentDim };
  }
}

/**
 * 段落块按名称取色（设计稿里不同的段落用不同深浅的橙）。
 */
export function sectionColor(label: string): { bg: string; fg: string } {
  const l = label.toLowerCase();

  // 有明确含义的名字优先
  if (l.includes('intro')) return { bg: '#FDE8D0', fg: '#7A4A18' };
  if (l.includes('outro')) return { bg: '#F5E3D8', fg: '#6B3A22' };
  if (l.includes('bridge')) return { bg: COLORS.sectionBridge, fg: '#3F2D70' };
  if (l.includes('chorus')) return { bg: COLORS.sectionChorus, fg: '#5C2A12' };
  if (l.includes('verse')) return { bg: '#FBE3A8', fg: '#6B5410' };
  if (l.includes('pre')) return { bg: COLORS.sectionPre, fg: '#6B3A22' };
  if (l.includes('待标注') || l.includes('pending')) return { bg: '#EFEFEF', fg: '#9A9A9D' };

  /**
   * A/B/C 这类标记（用户校对的结构常用）——
   * 必须给不同色相，否则同色连成一片，看不出块的边界在哪。
   * 参考 Song Master Pro：它的 B/A/C 也是不同颜色。
   */
  if (l === 'a') return { bg: '#FFD9B0', fg: '#7A3F10' };
  if (l === 'b') return { bg: '#D6E4F7', fg: '#284B7A' };
  if (l === 'c') return { bg: '#CFE8DC', fg: '#1F5B42' };
  if (l === 'd') return { bg: '#E6D9F5', fg: '#4A2F70' };

  return { bg: COLORS.sectionVerse, fg: COLORS.sectionText };
}
