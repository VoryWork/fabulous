/**
 * LRC 歌词解析。
 *
 * ## 为什么自己写而不装库
 *
 * LRC 只有一条核心语法（`[mm:ss.xx]文本`），但真实文件里有一堆变体：
 * 一行多个时间戳、毫秒 2 位/3 位、`offset` 元标签、同一秒多个标签
 * （逐字歌词）、BOM。装一个库还得处理它不覆盖的那些情况 —— 自己写
 * 80 行，行为可控，也能写测试钉死。
 *
 * ## offset 的方向（容易搞反）
 *
 * LRC 规范里 `[offset:+500]` 的单位是**毫秒**，正值表示歌词**提前**显示。
 * 所以实际时间 = 时间戳 − offset/1000。主流播放器（foobar2000、网易云）
 * 都是这个方向；反过来的实现会整体偏 1 秒以上，用户一眼能看出来。
 *
 * ## 支持的形式
 *
 * ```text
 * [ti:指纹] [ar:胡歌] [al:…] [by:…] [offset:+120]   ← 元标签，不产出歌词
 * [00:12.34]第一句
 * [00:15.00][01:20.00]副歌（重复段，两个时间戳各产一条）
 * [00:18.5]毫秒只有一位
 * [00:21]整秒
 * ```
 *
 * ## 还要兼容网易云下载的「JSON 行」
 *
 * 从网易云客户端下载的 `.lrc` 开头常常混着这种行（逐字时间轴格式）：
 *
 * ```text
 * {"t":0,"c":[{"tx":"作词: "},{"tx":"胡歌"}]}
 * {"t":1000,"c":[{"tx":"作曲: "},{"tx":"谭旋"}]}
 * ```
 *
 * `t` 是毫秒，`c[].tx` 是同一时刻的文本片段（拼起来才是一整句）。
 * 有些文件整份都是这种格式。所以两种格式都要认；`t < 5s` 且文本以
 * 「作词/作曲/编曲…」开头的，归到 `meta` 而不是歌词 —— 否则用户会在
 * 时间轴最左边看到两块「作词: 胡歌」。
 */

/** 一行歌词（时间已经应用过 offset） */
export interface LrcLine {
  /** 起始秒（已应用 offset，且不小于 0） */
  startSec: number;
  /** 歌词文本（已 trim，不会是空串） */
  text: string;
}

export interface LrcParseResult {
  lines: LrcLine[];
  /** 文件里解析出的元标签（ti/ar/al/by…），给 UI 显示用 */
  meta: Record<string, string>;
  /** 应用到的 offset（毫秒，正值 = 提前） */
  offsetMs: number;
  /**
   * 文件里出现过时间戳但文本全为空 —— 说明是「纯时间轴的伴奏段落」。
   * 此时 lines 为空但不是解析失败。
   */
  timedOnly: boolean;
}

/** `[数字:数字.数字]` / `[数字:数字]`，冒号两侧不限定 2 位（有 `[1:03.20]` 这种） */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** `[ti:...]` 这类元标签（冒号后不是时间格式） */
const META_TAG = /^\[([a-zA-Z]+):(.*)\]$/;

/**
 * 制作人员信息行：`标签: 内容`。
 *
 * ## 为什么用「通用格式」而不是关键词白名单
 *
 * 一开始我列了「作词|作曲|编曲|混音|母带…」的白名单，结果实测一首歌的
 * 片头有 20 多条：和声、第一小提琴、第二小提琴、中提琴、大提琴、二胡、
 * 钢琴、长笛、录音、混音、母带、OP、SP…**专辑是列举不完的**。
 *
 * 改成只看**格式**（短标签 + 冒号），再只看**位置**（连续的片头区），
 * 和标签本身是什么无关。
 *
 * ## 为什么不是「开头 N 秒」
 *
 * 实测《月儿弯弯》的片头制作信息排到了 12 秒（作词/作曲/编曲/和声/
 * 第一小提琴…/长笛/录音/混音/母带/OP），秒数阈值给小了漏一堆，
 * 给大了会误伤真正开唱的第一句。
 *
 * 改成「**从头开始连续匹配**，遇到第一条不匹配的就结束片头」：
 *   - 制作信息天然是连续排列的 → 全部吃掉
 *   - 第一句真歌词（通常没有冒号）立刻结束片头 → 不会越界
 *
 * 上限 40 行是兜底：万一某个文件整篇都是「xx：yy」格式，
 * 也不会把整首歌都当元信息吞掉（那样用户会看到一条空轨）。
 *
 * ⚠️ 这仍然是启发式。所以歌词块**必须可编辑**（右键删除/拖动/改文本），
 * 漏网的（比如没有冒号的版权声明）由用户手动删。
 */
const CREDIT_LINE = /^[^\s:：]{1,8}\s*[:：]\s*\S/;

/** 片头区最多吃掉多少行（防止整篇「xx：yy」被误判） */
const MAX_CREDIT_LINES = 40;

/** `{"t":毫秒,"c":[{"tx":"片段"},…]}` */
function parseJsonLine(line: string): { ms: number; text: string } | null {
  if (!line.startsWith('{')) return null;
  try {
    const v = JSON.parse(line) as { t?: unknown; c?: unknown };
    if (typeof v.t !== 'number' || !Array.isArray(v.c)) return null;
    const text = (v.c as Array<{ tx?: unknown }>)
      .map((seg) => (typeof seg?.tx === 'string' ? seg.tx : ''))
      .join('')
      .trim();
    if (!text) return null;
    return { ms: v.t, text };
  } catch {
    // 不是合法 JSON（或以 { 开头的普通歌词）→ 交给后面的流程
    return null;
  }
}

/**
 * 解析 LRC 文本。
 *
 * 容错原则：**坏行跳过，不整份失败**。歌词文件常带 BOM、末尾空行、
 * 各种编码声明，因为一行格式不对就让用户「导入失败」是很差的体验。
 */
export function parseLrc(raw: string): LrcParseResult {
  const meta: Record<string, string> = {};
  let offsetMs = 0;
  const timed: Array<{ sec: number; text: string }> = [];
  let sawTimestamp = false;
  /** 是否还在「片头制作信息」区（遇到第一条真歌词就永久关闭） */
  let inCreditHead = true;
  let creditCount = 0;

  /** 片头区命中？命中则记进 meta 并返回 true */
  const takeAsCredit = (text: string): boolean => {
    if (!inCreditHead || creditCount >= MAX_CREDIT_LINES) return false;
    if (!CREDIT_LINE.test(text)) {
      inCreditHead = false; // 第一句真歌词 → 片头结束
      return false;
    }
    const sep = text.search(/[:：]/);
    meta[text.slice(0, sep).toLowerCase()] = text.slice(sep + 1).trim();
    creditCount += 1;
    return true;
  };

  // BOM + 换行统一处理
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // ---- 网易云 JSON 行（有些文件整份都是这个格式）----
    const asJson = parseJsonLine(line);
    if (asJson) {
      sawTimestamp = true;
      // 「作词: 胡歌」这类 → 归 meta，不占歌词轨
      if (!takeAsCredit(asJson.text)) {
        // 时间可能为负（网易云用 -1000ms 表示"第一屏"），clamp 到 0
        timed.push({ sec: Math.max(0, asJson.ms / 1000), text: asJson.text });
      }
      continue;
    }

    // ---- 先扫这一行里所有 [mm:ss.xx]，剩下的部分才是歌词文本 ----
    TIME_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const fracRaw = m[3] ?? '';
      // 1 位 = 十分之一秒，2 位 = 百分之一秒，3 位 = 毫秒
      const frac = fracRaw ? Number(fracRaw) / Math.pow(10, fracRaw.length) : 0;
      const total = min * 60 + sec + frac;
      if (Number.isFinite(total)) stamps.push(total);
      sawTimestamp = true;
    }

    // 这一行没有时间戳 → 可能是元标签或纯文本
    if (stamps.length === 0) {
      const mm = META_TAG.exec(line);
      if (mm) {
        const key = mm[1].toLowerCase();
        const val = mm[2].trim();
        meta[key] = val;
        // offset 可能写成 "+120" / "-120"
        if (key === 'offset') {
          const n = Number(val.replace(/^\+/, ''));
          if (Number.isFinite(n)) offsetMs = n;
        }
      }
      // 没有时间戳的普通文本（如 .txt 的纯歌词、或文件头注释）直接跳过；
      // 是否「完全没有时间轴」由调用方根据 lines 判断。
      continue;
    }

    // 去掉所有时间标签后的剩余文本
    const body = line.replace(TIME_TAG, '').trim();
    if (!body) continue; // 纯时间戳（间奏/清屏）→ 不产出歌词行

    // 片头连续的制作信息（作词/编曲/和声/第一小提琴/OP…）不进歌词轨。
    // 标准 LRC 和网易云 JSON 两种写法都要挡，否则时间轴最左边会挂一整排
    // 「作词…/编曲…/二胡…」的小块。
    if (takeAsCredit(body)) continue;

    for (const sec of stamps) timed.push({ sec, text: body });
  }

  const lines: LrcLine[] = timed
    .map(({ sec, text: body }) => ({
      // offset 正值 = 提前
      startSec: Math.max(0, sec - offsetMs / 1000),
      text: body,
    }))
    // 同一时间点可能有多条（逐字歌词），稳定排序保证原有顺序
    .sort((a, b) => a.startSec - b.startSec);

  return {
    lines,
    meta,
    offsetMs,
    timedOnly: lines.length === 0 && sawTimestamp,
  };
}

/**
 * 把相邻两行的间隔也算出来的版本。
 *
 * 歌词块需要 `[start, end)`，而 LRC 只给起点。用「下一行的起点」当终点
 * 是最贴近实际的（唱完这一句才换下一句）。
 *
 * `lastEndSec` 用于最后一行 —— 调用方通常传「曲末」或「最后一行 + N 秒」。
 */
export function lrcSpans(
  lines: readonly LrcLine[],
  lastEndSec: number,
): Array<{ startSec: number; endSec: number; text: string }> {
  const out: Array<{ startSec: number; endSec: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    const end = next ? next.startSec : lastEndSec;
    // 同一起点上的两行（逐字歌词）不允许 end <= start
    const safeEnd = end > cur.startSec ? end : cur.startSec + 0.5;
    out.push({ startSec: cur.startSec, endSec: safeEnd, text: cur.text });
  }
  return out;
}
