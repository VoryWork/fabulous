/**
 * 歌曲结构（人工校对数据）。
 *
 * ⚠️ 数据来源与状态：
 *   - 参考 **Song Master Pro** 的自动分析结果 + 用户人工校对
 *   - 目前只录入了前 21 小节（截图可见范围），其余待补
 *   - 这是**人工数据**，不是模型输出，所以单独放一个文件
 *
 * 小节号从 0 开始（内部表示）；UI 显示时 +1。
 *
 * 补全方式：直接编辑本文件，或后续接入 all-in-one-infer 的自动分段。
 */

export interface StructureSegment {
  /** 显示名 */
  label: string;
  /** 起始小节（0 起） */
  startBar: number;
  /** 结束小节（不含） */
  endBar: number;
  /** 来源标记 */
  source?: 'manual' | 'model';
}

/**
 * 已校对的结构。
 *
 * 来自 Song Master Pro 截图的 Structure 轨：
 *   Intro | Verse | B | A | B | C | B
 * 对应用户手动校对后的分段边界。
 */
export const STRUCTURE_SEGMENTS: StructureSegment[] = [
  { label: 'Intro', startBar: 0, endBar: 2, source: 'manual' },
  { label: 'Verse', startBar: 2, endBar: 7, source: 'manual' },
  { label: 'B', startBar: 7, endBar: 11, source: 'manual' },
  { label: 'A', startBar: 11, endBar: 14, source: 'manual' },
  { label: 'B', startBar: 14, endBar: 16, source: 'manual' },
  { label: 'C', startBar: 16, endBar: 17, source: 'manual' },
  { label: 'B', startBar: 17, endBar: 21, source: 'manual' },
];

/** 已校对到的最后一个小节 */
export const STRUCTURE_COVERED_BARS = 21;
