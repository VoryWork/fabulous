/**
 * 导出：**讲解稿（Markdown）** 与 **工程文件（.fbsong）**。
 *
 * ## 两种导出的定位完全不同
 *
 * | 格式 | 给谁 | 牺牲什么 |
 * |---|---|---|
 * | 讲解 Markdown | 人看（笔记、分享、教学） | 丢掉几乎所有精度（tick、概率、备选） |
 * | `.fbsong` | 程序看（备份、迁移、再导入） | 完全不牺牲 —— 就是完整 JSON |
 *
 * 所以**不能合并成一种**：讲解稿要可读，工程文件要无损。
 *
 * ## `.fbsong` 为什么是纯文本 JSON
 *
 * 用户明确要求「纯文本记录即可」。JSON 的好处是：出问题能用记事本打开看、
 * 能被别的脚本处理、git diff 也读得懂。压缩二进制省的那点体积不值得。
 */
import type { AnalysisFile, RealTrack } from '../timeline/demo/realData';
import type { SongEdits } from '../api/backend';
import { chordToNumber } from '../timeline/demo/realData';
import { normalizeSections } from '../timeline/demo/realData';

/* ------------------------------------------------------------------ 讲解稿 */

/** 小节号格式化：区间用 `3-5`，单节用 `3` */
function barRange(a: number, b: number): string {
  return b > a + 1 ? `${a}-${b - 1}` : `${a}`;
}

/** 秒 → `m:ss` */
function mmss(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** 小节号 → 该小节起点秒数 */
function barSec(downs: readonly number[], bar: number): number {
  if (bar <= 0) return downs[0] ?? 0;
  if (bar < downs.length) return downs[bar];
  // 超出末尾：按最后一小节的时长外推
  const last = downs[downs.length - 1] ?? 0;
  const prev = downs[downs.length - 2] ?? last - 2;
  return last + (bar - (downs.length - 1)) * (last - prev);
}

export interface LectureInput {
  analysis: AnalysisFile;
  /** 实际渲染用的轨道（已含用户编辑） */
  tracks: readonly RealTrack[];
  /** 全局调性（可能是用户手动指定的） */
  key: { tonic: string; mode: 'major' | 'minor' };
  /** 调性是不是用户手动指定的（关系到措辞） */
  keyIsManual: boolean;
  bpm: number;
}

/**
 * 生成**讲解稿**（Markdown）。
 *
 * ## 为什么不直接把 analysis.json 排版成表格
 *
 * 那是「数据导出」，不是「讲解」。用户要的是能读懂的东西：
 * 这首歌什么调、分几段、每段在和声上做了什么。
 *
 * 所以这里的组织顺序是**先结论后明细**：
 *   概览 → 调性 → 结构 → 逐段和弦 → 统计
 */
export function buildLectureMarkdown(input: LectureInput): string {
  const { analysis, tracks, key, keyIsManual, bpm } = input;
  const downs = analysis.downbeatsSec ?? [];
  const bars = downs.length;
  const dur = analysis.song.durationSec ?? 0;
  const sections = normalizeSections(analysis);

  const chordTrack = tracks.find((t) => t.kind === 'chord');
  const chordClips = chordTrack?.clips ?? [];
  const keyLabel = `${key.tonic} ${key.mode === 'major' ? '大调' : '小调'}`;

  const out: string[] = [];
  const p = (s = '') => out.push(s);

  /* ---- 标题与概览 ---- */
  p(`# ${analysis.song.title || '未命名'}`);
  p();
  const metaLine = [
    analysis.song.artist || null,
    `${bpm.toFixed(1)} BPM`,
    keyLabel,
    '4/4',
    `${bars} 小节 / ${analysis.beatsSec?.length ?? 0} 拍`,
    `${chordClips.length} 个和弦段`,
    mmss(dur),
  ].filter(Boolean);
  p(`> ${metaLine.join(' · ')}`);
  p();

  /* ---- 调性 ---- */
  p('## 调性');
  p();
  p(`**${keyLabel}**${keyIsManual ? '（手动指定）' : '（自动推断）'}`);
  p();
  const tuning = (analysis as { tuning?: { deviationCents?: number; corrected?: boolean } }).tuning;
  if (tuning?.corrected && typeof tuning.deviationCents === 'number') {
    p(
      `> 录音相对标准音高偏离 ${tuning.deviationCents.toFixed(0)} 音分，` +
        `分析前已移调校正。若按原调演奏，和弦名需整体移调。`,
    );
    p();
  }
  const groove = (analysis.meta as { groove?: { offset: number; confidence: number; note: string } })
    .groove;
  if (groove) {
    const flag = groove.offset === 0 ? '✅' : '⚠️';
    p(
      `${flag} 鼓组相位体检：${groove.note}（置信度 ${Math.round(groove.confidence * 100)}%）`,
    );
    p();
  }

  /* ---- 结构 ---- */
  if (sections.length > 0) {
    p('## 结构');
    p();
    p('| 段落 | 小节 | 时间 | 调性 |');
    p('| --- | --- | --- | --- |');
    for (const s of sections) {
      const t0 = barSec(downs, s.startBar);
      const t1 = barSec(downs, s.endBar);
      p(
        `| ${s.label} | ${barRange(s.startBar + 1, s.endBar + 1)} | ` +
          `${mmss(t0)}–${mmss(t1)} | — |`,
      );
    }
    p();
  }

  /* ---- 逐段和弦 ---- */
  p('## 和声进行');
  p();
  if (chordClips.length === 0) {
    p('_（这首歌还没有和弦数据）_');
    p();
  } else {
    // 按结构段分组；没有结构数据就整首一组
    const groups =
      sections.length > 0
        ? sections.map((s) => ({
            label: s.label,
            from: s.startBar * 3840,
            to: s.endBar * 3840,
          }))
        : [{ label: '全曲', from: 0, to: Number.POSITIVE_INFINITY }];

    for (const g of groups) {
      const inGroup = chordClips.filter(
        (c) => c.startTick >= g.from && c.startTick < g.to,
      );
      if (inGroup.length === 0) continue;

      // 同一和弦连续出现就合并显示（`G:maj ×4` 比列 4 行好读）
      const cells: { chord: string; beats: number }[] = [];
      for (const c of inGroup) {
        const beats = Math.max(1, Math.round((c.endTick - c.startTick) / 960));
        const last = cells[cells.length - 1];
        if (last && last.chord === c.label) last.beats += beats;
        else cells.push({ chord: c.label, beats });
      }

      p(`### ${g.label}`);
      p();
      p(
        cells
          .map((c) => {
            const deg = chordToNumber(c.chord, key.tonic);
            const tail = deg && deg !== c.chord ? ` (${deg})` : '';
            return c.beats > 1 ? `${c.chord}${tail} ×${c.beats}` : `${c.chord}${tail}`;
          })
          .join(' | '),
      );
      p();
    }
  }

  /* ---- 统计 ---- */
  p('## 统计');
  p();
  const roots = new Map<string, number>();
  for (const c of chordClips) {
    const root = (c.label.split(':')[0] ?? '').trim();
    if (root && root !== 'N') roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  const top = [...roots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  p(`- 和弦段：${chordClips.length} 个`);
  p(`- 出现的和弦根音：${roots.size} 个`);
  if (top.length > 0) {
    p(`- 出现最多的根音：${top.map(([r, n]) => `${r}(${n})`).join('、')}`);
  }
  p(`- 曲长：${mmss(dur)}`);
  p();
  if (analysis.meta?.bpmMedian) {
    p(`- 全曲中位 BPM：${(analysis.meta.bpmMedian as number).toFixed(2)}`);
    p();
  }

  return out.join('\n');
}

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
