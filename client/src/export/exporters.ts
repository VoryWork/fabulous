/**
 * 导出：**工程文件（.fbsong）**。
 *
 * 曾经还有一个「导出讲解稿（Markdown）」，定位是给人读（笔记 / 分享 / 教学）。
 * 用户明确要求去掉 —— 实际用不上，反而多一个需要维护的输出格式。
 *
 * ## `.fbsong` 为什么是纯文本 JSON
 *
 * 用户明确要求「纯文本记录即可」。JSON 的好处是：出问题能用记事本打开看、
 * 能被别的脚本处理、git diff 也读得懂。压缩二进制省的那点体积不值得。
 */
import type { AnalysisFile } from '../timeline/demo/realData';
import type { SongEdits } from '../api/backend';


/* ------------------------------------------------------------------ .fbsong */

/** `.fbsong` 的格式标识与版本 —— 将来改结构要能识别旧文件 */
export const FBSONG_FORMAT = 'fbsong';
export const FBSONG_VERSION = 1;

export interface FbsongBundle {
  format: typeof FBSONG_FORMAT;
  version: number;
  exportedAt: string;
  /** 完整分析结果（就是 analysis.json 的内容，一字段不删） */
  analysis: AnalysisFile;
  /** 用户编辑层（调性覆盖 / 级数轨 / 和弦编辑 / 结构编辑）；没有就是空对象 */
  edits: SongEdits;
  /** 导出时的界面状态，纯参考，导入时可以忽略 */
  view?: {
    key: { tonic: string; mode: 'major' | 'minor' };
    bpm: number;
  };
}

/**
 * 打包成 `.fbsong`（完整 JSON 文本）。
 *
 * **什么都不裁**：分析结果原样、用户编辑原样。这是工程文件，
 * 不是报告 —— 目标是「拿到这份文件就能完整还原一首歌」。
 */
export function buildFbsongBundle(args: {
  analysis: AnalysisFile;
  edits: SongEdits;
  key: { tonic: string; mode: 'major' | 'minor' };
  bpm: number;
}): FbsongBundle {
  return {
    format: FBSONG_FORMAT,
    version: FBSONG_VERSION,
    exportedAt: new Date().toISOString(),
    analysis: args.analysis,
    edits: args.edits,
    view: { key: args.key, bpm: args.bpm },
  };
}

/** 序列化成便于 diff 的文本（2 空格缩进，不压成一行） */
export function serializeFbsong(bundle: FbsongBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** 建议文件名：去掉 Windows 不允许的字符 */
export function suggestFileName(title: string, ext: string): string {
  const safe = (title || '未命名')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe || '未命名'}.${ext}`;
}
