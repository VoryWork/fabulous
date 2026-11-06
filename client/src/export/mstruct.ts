// SPDX-License-Identifier: MIT
// Copyright (c) 2026 VoryWork

/**
 * 导出 **MStruct 分析文件**（严格对齐官方编辑器实现）。
 *
 * 规范来源：
 *   - 语法文档：https://mstruct-archive.com/docs/mstruct-syntax
 *   - 技术手册：https://doi.org/10.5281/zenodo.23637500
 *   - 官方序列化器：https://github.com/Polymath9/mstruct-editor
 *     `src/core/mstruct-document.js` → `serializeMstructDocument()`
 *
 * ## 这份实现为什么以「官方序列化器」为准
 *
 * 文档给的是**语法规则**，没说清文件骨架的具体排版和键名。
 * 官方编辑器的序列化器才是**唯一能真正编译通过**的参照 ——
 * 它产出的文件能直接被 mstruct-archive.com 接受。
 *
 * ## 文件骨架（照抄官方 `serializeMstructDocument`）
 *
 * ```
 * METADATA:
 *                       <- 空行（官方固定输出）
 * {TAG}value             <- 注意：是 {TAG} 紧接值，不是 TAG:value
 * ...
 * {COMMENTS}
 * {COMMENTS_END}
 *                       <- 空行
 * END_METADATA
 *                       <- 空行
 * MAIN:
 *                       <- 空行
 * {BN:1}...;
 * END_MAIN
 *                       <- 空行
 * COMMENT:
 *                       <- 空行
 * END_COMMENT
 * ```
 *
 * ⚠️ 元数据行格式是 `{TAG}value`（`function metadataLine(tag, value) { return \`{${tag}}${value}\`; }`）。
 * 我第一版写成 `TITLE:xxx` 是错的 —— 那种写法编辑器会当未知语法。
 *
 * ## MAIN 的三层结构
 *
 * | 层级 | 分隔符 | 说明 |
 * |---|---|---|
 * | 事件 | （无） | 一个槽位内可多个事件，如 `{TC:C}Cm\|i` |
 * | 槽位 | `,` | 时值由 `{D:}` 或简写 `{1/4}` 定义 |
 * | 小节 | `;` | 时值累加到一整小节后必须关闭 |
 *
 * `{1/4}` 与 `{D:1/4}` **完全等价**（官方 `parseSetting` 把纯分数当 `D` 处理）。
 * 官方示例（`examples/k545.mstruct`）用的是简写 `{1/4}`，本导出跟随它。
 *
 * ## 槽位时值的核心规则
 *
 * 官方文档：
 *   > 每个槽位都有其时值的长度，由 `{D:}` 定义。**空的槽位的长度会累加到上一个槽位。**
 *
 * 例：`{1/4}C|I,,,;` 与 `{1}C|I;` 等价（后三个空槽把长度并给第一个）。
 *
 * 本导出**每个槽位都写明确时值**，不依赖空槽合并 —— 显式值不会因为
 * 多写一个逗号就让后面整段时值错位，也便于人眼核对。
 */
import { barLengthAt, barStartTick, meterAt, type MeterMapData } from '../timeline/domain/MeterMap';

/** 一个小节内的一个槽位 */
export interface MStructSlot {
  startTick: number;
  endTick: number;
  /** 该槽位的事件（和弦 + 罗马数字），按出现顺序 */
  events: string[];
}

/** 一个小节 */
export interface MStructBar {
  number: number;
  meter: { numerator: number; denominator: number };
  slots: MStructSlot[];
  /**
   * 在本小节**开头**要写出的开始标签（`<Pop_Form:Chorus>`）。
   *
   * 结构段从这一小节开始时非空。
   */
  formOpens?: string[];
  /** 在本小节**开头**要写出的结束标签（`</Pop_Form:Chorus>`）。结构段到这里结束时非空。 */
  formCloses?: string[];
}

export interface MStructDocument {
  /** 元数据区块（`METADATA:` 与 `END_METADATA` 之间），已含 `{COMMENTS}` 等固定尾 */
  metadata: string[];
  /** 主体区（`MAIN:` 与 `END_MAIN` 之间） */
  main: string;
  /** 注释区（`COMMENT:` 与 `END_COMMENT` 之间）；没有就是空 */
  comment: string;
  /** 导出过程的告警（不影响文件合法性） */
  warnings: string[];
}

/* ------------------------------------------------------------ 和弦写法转换 */

/** 根音 → 半音数（含同音异名） */
const ROOT_PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/** 半音 → 音名（降号优先，和项目 KEY_TONICS 归一方向一致） */
const PITCH_NAME = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** 音级 → 相对根音的半音数（用于把 `/3` 换算成音名） */
const DEGREE_SEMITONES: Record<string, number> = {
  '1': 0,
  b2: 1,
  '2': 2,
  b3: 3,
  '3': 4,
  '4': 5,
  '#4': 6,
  b5: 6,
  '5': 7,
  '#5': 8,
  b6: 8,
  '6': 9,
  b7: 10,
  '7': 11,
  b9: 13,
  '9': 14,
  '11': 17,
  '13': 21,
};

/**
 * 性质 → MStruct 后缀。
 *
 * 规范（官方文档「三和弦性质」「七和弦与大七音」各节）：
 *   - 大三和弦**省略**性质 → `C`
 *   - 小三 `m`、减 `dim`、增 `aug`
 *   - 七音：`7` 是 b7；`M7` 是大七；`m7`、`mM7`、`dim7`
 *   - 扩展：`9` / `11` / `13`，大七音写 `M9` / `M11` / `M13`
 *   - 六和弦：`6` / `m6`
 *   - 规范明确：「别名 maj/min 为无效输入」→ 绝不能写 `Cmaj`
 */
const QUALITY_TO_MSTRUCT: Record<string, string> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  '5': '5',
  sus2: 'sus2',
  sus4: 'sus4',
  maj6: '6',
  min6: 'm6',
  '7': '7',
  maj7: 'M7',
  min7: 'm7',
  dim7: 'dim7',
  hdim7: 'm7b5',
  minmaj7: 'mM7',
  '9': '9',
  maj9: 'M9',
  min9: 'm9',
  '11': '11',
  min11: 'm11',
  '13': '13',
  min13: 'm13',
  maj13: 'M13',
  /**
   * `maj(b5)` → `(b5)`：变化五音直接写括号。
   *
   * 规范：变化 tension 必须跟在 7/9/11/13 后（官方
   * `alteredTensions` 的 `enabled = highest.extended`）。
   * 但 `b5` / `#11` 这类在大三和弦上也常用，
   * MStruct 允许把它们当“替换五音”直接写括号 —— 但 `b9` 不行（它是九音，
   * 必须有七音才能存在）。所以 `maj(b9)` 不放进表里。
   */
  'maj(b5)': '(b5)',
  'maj(#11)': '(#11)',
  'aug(7)': 'aug7',
};

/**
 * 这些性质**无法用 MStruct 表达**，转换时必须降级。
 *
 * ## 为什么“无法”而不是“写得难看”
 *
 * | 性质 | 问题 | 官方报错 |
 * |---|---|---|
 * | `sus4(b7)` / `sus2(b7)` | sus 的括号只接受 `b2 2 4 #4` | 「语素顺序不合法」 |
 * | `maj(b9)` | `b9` 需要七音作为前提 | 「变化 tension 只能跟在 7、9、11 或 13 后」 |
 *
 * 这些写法在我们的词表里存在（模型能输出），但 MStruct 语法不接受。
 * 宁可降级成三和弦也不能写进去—— 不然整份文件编译失败。
 */
const UNREPRESENTABLE = new Set(['sus4(b7)', 'sus2(b7)', 'maj(b9)']);

/**
 * 音级（`3` / `5` / `b7`）→ 相对根音的绝对音名。
 *
 * MStruct 的斜杠低音只接受音名（`C/E`），不接受音级（`C/3`）。
 * 返回 `''` 表示认不出该音级。
 */
function degreeToBassName(root: string, degree: string): string {
  const semis = DEGREE_SEMITONES[degree];
  const r = ROOT_PITCH[root];
  if (semis == null || r == null) return '';
  return PITCH_NAME[(r + semis) % 12] ?? '';
}

/**
 * 我们的 `X:model` → MStruct 和弦记号。
 *
 * ## 主要差别
 *
 * | 我们 | MStruct | 依据 |
 * |---|---|---|
 * | `C:maj` | `C` | 大三和弦省略性质（`Cmaj` 非法） |
 * | `C:min7` | `Cm7` | `min` → `m` |
 * | `C:maj7` | `CM7` | 大七音用 `M` |
 * | `C:7(b9)` | `C7(b9)` | 变化音括号语法一致，只差冒号 |
 * | `C:maj/3` | `C/E` | 斜杠后**必须是音名**，不能是音级 |
 *
 * @returns MStruct 写法；空 / `N` / 认不出时返回 `null`
 */
export function xmodelToMstruct(chord: string): string | null {
  if (!chord || chord === 'N') return null;

  /** 拆根音 / 性质 / 转位（转位可能出现在冒号前后，与 chordToNumber 一致） */
  const [rootPart, qualityPart] = chord.split(':');
  const [rootOnly, rootInv] = rootPart.split('/');
  let quality = qualityPart ?? '';
  let inversion: string | undefined = rootInv;
  const slash = quality.indexOf('/');
  if (slash >= 0) {
    inversion = quality.slice(slash + 1);
    quality = quality.slice(0, slash);
  }
  if (!/^[A-G][#b]?$/.test(rootOnly)) return null;

  /**
   * MStruct 表达不了的性质 → 降级成三和弦。
   *
   * 不能硬写：写了就是整份文件编译失败（用户实测遇到的报错）。
   * 降级保留根音与三和弦性质 —— 级数计算只依赖根音，所以级数不会错。
   */
  if (UNREPRESENTABLE.has(quality)) {
    /** 保留原来的 sus2 / sus4 类型，不能统一降成 sus4 */
    const base = quality.startsWith('sus2') ? 'sus2' : quality.startsWith('sus') ? 'sus4' : 'maj';
    return `${rootOnly}${QUALITY_TO_MSTRUCT[base]}${inversion ? '/' + degreeToBassName(rootOnly, inversion) : ''}`;
  }

  let suffix: string;
  if (quality in QUALITY_TO_MSTRUCT) {
    suffix = QUALITY_TO_MSTRUCT[quality];
  } else {
    /**
     * 词表外的组合（`7(b9,b13)`、`sus4(b7,9,13)` 等）。
     *
     * 我们的写法和 MStruct 的变化音括号语法**结构一致**：
     * 都是「基础性质 + `(变化音列表)`」。差别只在冒号。
     * 所以拆出基础性质单独映射，括号部分原样保留。
     */
    const m = /^(.+?)(\([^)]*\))$/.exec(quality);
    if (!m) return null;
    const base = QUALITY_TO_MSTRUCT[m[1]];
    if (base === undefined) return null;
    suffix = base + m[2];
  }

  /** 转位：音级 → 音名（MStruct 斜杠后只能跟音名） */
  if (inversion) {
    const semis = DEGREE_SEMITONES[inversion];
    const r = ROOT_PITCH[rootOnly];
    if (semis == null || r == null) return null;
    return `${rootOnly}${suffix}/${PITCH_NAME[(r + semis) % 12]}`;
  }

  return `${rootOnly}${suffix}`;
}

/* -------------------------------------------------------------- 事件语义 */

/**
 * 我们的和弦标签 → MStruct 事件。
 *
 * | 我们 | MStruct | 依据 |
 * |---|---|---|
 * | `N` | `N.C.` | 规范区分：`N.C.` = 不构成和弦但有音 |
 * | `未识别` | `X` | `X` = 分析者暂不便指定 |
 * | 空 | `X` | 同上 |
 * | `C:maj` | `C` | 和弦记号 |
 */
export function chordEventToMstruct(
  label: string,
  options: {
    unrecognizedLabel: string;
    /**
     * 罗马数字（可选）。传入后输出 `C|I` 而不是 `C`。
     *
     * `null` / 未传 表示这一块算不出罗马数字（调性未知 / 楼上不认识的和弦），
     * 此时只写和弦。规范允许留空一侧。
     */
    roman?: string | null;
  },
): string {
  if (!label) return 'X';
  if (label === options.unrecognizedLabel) return 'X';
  if (label === 'N') return 'N.C.';
  const chord = xmodelToMstruct(label);
  if (!chord) return 'X';

  /**
   * **有和弦就必须带 `|`**，罗马数字可以留空。
   *
   * ## 规范原文
   *
   *   > 和弦记号事件的完整形式是 `[C:和弦记号|R:罗马数字]`，
   *   > 可以简写为 `和弦记号|罗马数字` 的形式……
   *   > 和弦记号和罗马数字在必要时可以留空一侧，如 `Cm|`，或 `|i`，
   *   > 都是符合语法的，但不能两边都留空。
   *
   * 所以 `Ab7` 不合语法，`Ab7|` 才合法。
   *
   * ## 踩过的坑
   *
   * 我第一版写成 `options.roman ? `${chord}|${options.roman}` : chord` ——
   * 没罗马数字时直接输出裸和弦名。一份 6/8 的曲子里有 40 处这种槽位
   * （模型没给出可换算级数的和弦），官方逐条报
   * 「未加方括号的和弦事件必须使用 C|R 形式」。
   *
   * 留空这一侧不是「省略」，而是**显式声明我没有罗马数字**。
   */
  return `${chord}|${options.roman ?? ''}`;
}

/* -------------------------------------------------------------- 罗马数字 */

/**
 * 罗马数字基表 —— **逐行对照官方 `src/config/roman-basic.csv`**。
 *
 * ## 为什么不能自己推导
 *
 * 官方的规则不是「按音阶算就行」，而是一张**查表**。
 * 同一个 3 级在不同调式下写法完全不同：
 *
 *   | 大调 | 小调 |备注 |
 *   |---|---|---|
 *   | `III` | `nIII` | 同一个大三和弦，小调要加还原号 `n` |
 *   | `iii` | `niii` | 同理 |
 *   | `bIII` | `bIII` | 降三级两边都是 `b` |
 *
 * 如果按音阶算：d 小调的 3 级是 F（自然小调三级），
 * 它相对大调是**降**三级，但官方表里写的是 `nIII`
 * （因为小调里它是「自然的」三级，用 n 标记），不是 `bIII`。
 * 这种细微差别只能查表。
 *
 * 键 = 级数数字（带变音前缀，如 `3` / `b3` / `b7`） + 调式。
 * 值 = 该情况下合法的罗马基底（大写 = 大三和弦，小写 = 小三和弦）。
 */
const ROMAN_BASE: Record<string, { M: string; m: string }> = {
  // 自然音级
  '1': { M: 'I', m: 'i' },
  '2': { M: 'II', m: 'ii' },
  '3': { M: 'III', m: 'nIII' },
  '4': { M: 'IV', m: 'iv' },
  '5': { M: 'V', m: 'v' },
  '6': { M: 'VI', m: 'nVI' },
  '7': { M: 'nVII', m: 'nVII' },
  // 降级（大小调通用）
  b2: { M: 'bII', m: 'bII' },
  b3: { M: 'bIII', m: 'bIII' },
  b5: { M: 'bV', m: 'bV' },
  b6: { M: 'bVI', m: 'bVI' },
  b7: { M: 'bVII', m: 'bVII' },
  // 升级
  '#4': { M: '#IV', m: '#IV' },
};

/** 官方 `roman-advanced.csv` 里的性质修饰符（第 1 列 token） */
const ROMAN_QUALITY_SUFFIX: Record<string, string> = {
  maj: '',
  min: '',
  '5': '',
  sus2: '',
  sus4: '',
  dim: 'o',
  aug: '+',
  hdim7: 'ho',
  dim7: 'o',
  minmaj7: 'oM',
  '7': 'DM',
  maj7: 'M',
};

/**
 * 哪些级数**本身就是**属七和弦，不需要 `DM` 后缀。
 *
 * 官方 `roman-advanced.csv` 对 `DM` 的说明是「属七，但用于 **V 级以外**的级数」。
 * 也就是说：V 级写 `V7`（无需 DM），而 `II` 上建属七弦才写 `IIDM`。
 *
 * 官方基表里 `V` 的 quality 就是 `D`（属），本身就是属和弦，
 * 所以 `C:7` 在 C 大调下应输出 `V`（而不是 `VDM`）。
 * 七音本身由和弦记号 `C7` 表达，罗马数字不需要重复声明。
 */
const ROMAN_NATURAL_DOMINANT = new Set(['5']);

/**
 * 级数 + 调式 + 和弦性质 → MStruct 罗马数字。
 *
 * ## 大小写语义
 *
 * 官方基表里大写 = 大三和弦（质量 `M`），小写 = 小三和弦（`m`）。
 * 所以同一个级数要先看和弦性质再决定取哪个字母大写。
 *
 * 例：C 大调里 `Am` 是 vi（小写），`C` 是 I（大写）。
 *
 * ## 为什么只输出到三和弦 / 七和弦级别
 *
 * 规范明确：「MStruct 的罗马数字不记录 9 及以上的扩展音」，
 * 扩展音交给和弦记号。所以 9/11/13 类和弦只输出基础三和弦层次。
 *
 * @returns 罗马数字；认不出的级数返回 `null`（调用方留空该字段）
 */
export function degreeToRoman(
  degree: string,
  mode: 'major' | 'minor',
  quality: string,
): string | null {
  const base = ROMAN_BASE[degree];
  if (!base) return null;

  /**
   * 基表给的是「该级数在该调式下的默认写法」，已经包含了 `n` / `b` 前缀。
   *
   * 例：大调 3 级 = `III`；小调 3 级 = `nIII`（不是 `bIII`）。
   * 这一点必须查表，不能按音阶推：
   *   d 小调的 3 级是 F，它相对大调确实降了一个半音，
   *   但官方给小调用的是 `n`（自然）而不是 `b`（降）。
   */
  const column = mode === 'minor' ? base.m : base.M;

  /**
   * 大小写跟和弦质量走：小三和弦用小写字母。
   *
   * 官方基表就是这么分的：`III` 是大三，`iii` 是小三。
   * 前缀（`n` / `b` / `#`）不参与大小写变换，只换罗马字符体部分。
   */
  const PREFIX = /^(?:n|b|#)?/;
  const prefixMatch = PREFIX.exec(column);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const body = column.slice(prefix.length);
  /**
   * 哪些性质属于「小三度基底」→ 罗马数字写小写。
   *
   * ❌ 不能只看名字里有没有 `min`：
   *    - `dim` / `dim7` 的三音也是小三度，官方基表里就是 `iio`
   *    - `hdim7`（半减七）同理 `iiho`
   *    - `minmaj7` 也是小三度底
   * 漏了 `dim` 会输出 `IIo`，而官方是 `iio` —— 大小写错了就是性质错了。
   */
  const isMinorQuality = /^(min|dim|hdim)/.test(quality);
  const roman = prefix + (isMinorQuality ? body.toLowerCase() : body.toUpperCase());

  /**
   * 七音低音（figured bass）—— **先算**，因为后面的性质表是给三和弦用的。
   *
   * ## 官方规则
   *
   * `roman-advanced.csv` 里每一行的 `allowed_figured_bass` 都含 `7`（含空 token
   * 那行 —— 即默认三和弦性质）：
   *
   *   | token | requires_seventh | figures |
   *   |---|---|---|
   *   | (空) | — | 6,64,**7**,65,43,42,… |
   *   | `ho` | True | 6,64,**7**,65,43,42 |
   *   | `DM` | True | 6,64,**7**,65,43,42,… |
   *   | `M`  | True | **7**,sus,7sus,7b5sus,65,43,42 |
   *   | `o`  | — | 6,64,**7**,65,43,42 |
   *
   * `requires_seventh: True` 的行官方会报「这个高级性质必须用
   * figured bass 加入七音」。而普通七和弦不写 `7` 虽不报错，
   * 但信息丢了 —— 写 `i` 和写 `i7` 是两个不同的和弦。
   *
   * 所以只要是七和弦级别以上，**一律补 `7`**。
   */
  let seventh = '';
  switch (quality) {
    case 'maj7':
      /**
       * 大七：基底已隐含自然七音时，`M` 是重复标记。
       *
       * 官方检查：`advanced.token === "M" && basic.roman !== "V" && /[IV]$/.test(basic.roman)`
       * 就报 `advanced-redundant-major-seventh`。
       * 注意它看的是**基底罗马字符串的末尾是否为大写 I/V**，
       * 所以只有 `I`/`II`/…/`VI` 这类大写底（小写底如 `ii` 不在内）需要删 `M`。
       */
      /**
       * 判断「底是大写还是小写」时，**必须先剥掉变音前缀**。
       *
       * ❌ 我第一版写的 `/![a-z]/.test(roman)` 把 `bIII` 当成了小写底 ——
       *    因为它里面有一个小写的 `b`（降号），导致 `bIIIM7` 输出，
       *    官方报「bIII 的七和弦默认使用大七度，M 属于重复标记」。
       * 变音前缀只是降/升号，不影响罗马字母的大小写语义。
       */
      const romanBody = roman.replace(/^(?:n|b|#)*/, '');
      if (romanBody === romanBody.toUpperCase()) {
        /** 大写底（隐含大三度 + 自然七度）→ 只写 `7` */
        seventh = '7';
      } else {
        /** 小写底（小三度），`M` 不重复（小写默认小七）→ 保留 `M` + `7` */
        seventh = 'M7';
      }
      break;
    case 'min7':
      /** 小七：小写底默认小三度，加 `7` 表示七音 */
      seventh = '7';
      break;
    case '7':
      /** 属七：V 级本身就是属 → 只写 `7`；其他级用 `DM7` */
      seventh = ROMAN_NATURAL_DOMINANT.has(degree) ? '7' : 'DM7';
      break;
    case 'hdim7':
      seventh = 'ho7';
      break;
    case 'minmaj7':
      seventh = 'oM7';
      break;
    case 'dim7':
      /** 减七：`o` + `7` */
      seventh = 'o7';
      break;
    default:
      break;
  }

  /**
   * 七和弦的后缀已经在 `seventh` 里完整写出（`7` / `M7` / `ho7` / `DM7` …），
   * **不能再查三和弦的性质表** —— 否则 `dim7` 会变成 `io7` + `o` = `io7o`。
   */
  if (seventh) return roman + seventh;

  /** 三和弦级别的性质（`dim` / `aug` 等）走这个表 */
  return roman + (ROMAN_QUALITY_SUFFIX[quality] ?? '');
}

/**
 * 把一个级数数字对应回来的罗马数字字符串里，
 * 取出它的“核心层”—— 用于判断是否需要补充级数。
 */
export function romanLevelOf(degree: string): number {
  const m = /^[b#]{0,2}([1-7])$/.exec(degree);
  return m ? Number(m[1]) : 0;
}

/* -------------------------------------------------------------- 曲式标签 */

/**
 * 我们的结构段名 → MStruct 曲式标签。
 *
 * ## 来源：官方 `src/config/form-tags.csv`
 *
 * 官方把流行曲归在 `Pop_Form`（Verse-Chorus Form）下，子标签就是
 * `Pop_Form:Verse`、`Pop_Form:Chorus` 这种。我们的 `SECTION_LABELS`
 * 和它几乎一一对应，所以映射直接查表。
 *
 * ## 为什么用子标签而不是自己造名字
 *
 * 官方编译器会拒绝 `unknown-form-tag`。所有可用的标签
 * 在 `form-tags.csv` 里列得明明白白，自造必失败。
 *
 * 映射不上的段（比如模型给了个奇怪名字）→ 不写标签。
 * 宁可少一个标签，也不能写错导致整份文件编译失败。
 */
const FORM_TAG: Record<string, string> = {
  // ---- 流行曲（Pop_Form = Verse-Chorus Form）
  Intro: 'Pop_Form:Intro',
  Verse: 'Pop_Form:Verse',
  'Pre-Chorus': 'Pop_Form:Prechorus',
  Chorus: 'Pop_Form:Chorus',
  'Post-Chorus': 'Pop_Form:PostChorus',
  Bridge: 'Pop_Form:Bridge',
  Outro: 'Pop_Form:Outro',
  // ---- 器乐段（官方没有对应子标签，用流行曲的器乐段）
  Instrumental: 'Pop_Form:InstBreak',
  Inst: 'Pop_Form:InstBreak',
  Interlude: 'Pop_Form:InstBreak',
  // ---- 其他常见写法
  Refrain: 'Strophic_Form:Refrain',
  Coda: 'Sonata_Form:Coda',
  Ending: 'Pop_Form:Outro',
};

/**
 * 结构段名 → 曲式标签（`<Pop_Form:Verse>` 这种形式）。
 *
 * 返回 `null` 表示这个名字官方表里没有，调用方应跳过。
 *
 * 名字兼容大小写与多余空格（模型实测会输出 `verse` 小写）。
 */
export function sectionToFormTag(name: string): string | null {
  const raw = (name || '').trim();
  if (!raw) return null;
  /** 先直接命中，再忽略大小写 */
  if (raw in FORM_TAG) return `<${FORM_TAG[raw]}>`;
  const lower = raw.toLowerCase();
  for (const [k, v] of Object.entries(FORM_TAG)) {
    if (k.toLowerCase() === lower) return `<${v}>`;
  }
  /** 去掉尾部序号：`Verse 1` / `Verse2` → `Verse` */
  const stripped = raw.replace(/\s*[（(]?\d+[）)]?$/, '').trim();
  if (stripped && stripped !== raw) {
    for (const [k, v] of Object.entries(FORM_TAG)) {
      if (k.toLowerCase() === stripped.toLowerCase()) return `<${v}>`;
    }
  }
  return null;
}

/* -------------------------------------------------------------- 时值计算 */

/** 一拍多少 tick */
const PPQ = 960;

/**
 * tick 时长 → `{D:}` 的分数（以**全音符**为单位）。
 *
 * 规范：`D` 的分母接受任意正整数，含义是「占几分之一个全音符」。
 * 四分音符 = `1/4`，全音符 = `1`（官方写 `{1}`，不是 `{1/1}`）。
 */
export function ticksToDuration(tickLen: number, ppq = PPQ): string {
  const whole = ppq * 4;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const num = Math.round(tickLen);
  if (num <= 0) return '0';
  const g = gcd(num, whole) || 1;
  const n = num / g;
  const d = whole / g;
  return d === 1 ? String(n) : `${n}/${d}`;
}

/* -------------------------------------------------------------- 小节构建 */

/**
 * 生成一个事件文本（和弦 + 可选罗马数字）。
 *
 * 规范：完整形式是 `[C:和弦记号|R:罗马数字]`，可简写为 `和弦|罗马`。
 * 官方示例（`examples/k545.mstruct`）用的都是简写，本导出跟随。
 *
 * 留空规则：
 *   - 算不出罗马数字 → 只写和弦（如 `C`）
 *   - 特殊事件（`N.C.` / `X`）→ 不带罗马数字（它们不是和弦）
 */
function makeEvent(
  label: string,
  args: {
    unrecognizedLabel: string;
    key?: { tonic: string; mode: 'major' | 'minor' };
    degreeOf?: (label: string, tonic: string, mode: 'major' | 'minor') => string | null;
  },
): string {
  let roman: string | null = null;

  /**
   * 罗马数字需要两个前提：
   *   1. 有调性（规范：使用罗马字段的槽位必须处于已定义的 TC 区域）
   *   2. 能算出级数（`chordToNumber` 可解析这个和弦）
   */
  if (args.key?.tonic && args.degreeOf) {
    const degree = args.degreeOf(label, args.key.tonic, args.key.mode);
    if (degree) {
      /** 级数可能带后缀（`5:maj/7` 的前半段才是级数） */
      const bare = degree.split(':')[0].split('/')[0];
      const quality = extractQuality(label);
      roman = degreeToRoman(bare, args.key.mode, quality);
    }
  }

  return chordEventToMstruct(label, {
    unrecognizedLabel: args.unrecognizedLabel,
    roman,
  });
}

/**
 * 从 `X:model` 写法里取出和弦性质（供罗马数字判大小写用）。
 *
 * `C:min7/3` → `min7`；`D:maj` → `maj`；`N` / 空 → `''`。
 */
function extractQuality(chord: string): string {
  const q = chord.split(':')[1];
  if (!q) return 'maj';
  return q.split('/')[0];
}

/**
 * 按 `MeterMap` 切小节。
 *
 * 小节边界全部向 `MeterMap` 要 —— 它已经处理了拍号变化与弱起，
 * 自己算只会和时间轴上看到的小节线不一致。
 */
export function buildBars(args: {
  chords: ReadonlyArray<{ startTick: number; endTick: number; label: string }>;
  meterMap: MeterMapData;
  unrecognizedLabel: string;
  /** 调性（罗马数字需要）；不传则不写罗马数字 */
  key?: { tonic: string; mode: 'major' | 'minor' };
  /**
   * 级数计算器：和弦名 → 级数数字（`1` / `b7` / `5`）。
   *
   * 由调用方注入（App 传 `chordToNumber`），避免这个纯导出模块
   * 反向依赖时间轴域层。签名和 `realData.chordToNumber` 一致。
   */
  degreeOf?: (label: string, tonic: string, mode: 'major' | 'minor') => string | null;
  /** 结构段（用于曲式标签）；不传则不写标签 */
  sections?: ReadonlyArray<{ startTick: number; endTick: number; label: string }>;
}): MStructBar[] {
  const { chords, meterMap } = args;

  const maxTick = Math.max(...chords.map((c) => c.endTick), 0);
  if (maxTick <= 0) return [];

  const bars: MStructBar[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let tick = 0;
  let guard = 0;
  while (tick < maxTick && guard++ < 20000) {
    const start = barStartTick(meterMap, tick);
    const len = barLengthAt(meterMap, start);
    if (len <= 0) break;
    const meter = meterAt(meterMap, start);
    bars.push({
      number: bars.length + 1,
      meter: { numerator: meter.numerator, denominator: meter.denominator },
      slots: [],
    });
    spans.push({ start, end: start + len });
    tick = start + len;
  }

  bars.forEach((bar, idx) => {
    const { start: barStart, end: barEnd } = spans[idx];

    const slots: MStructSlot[] = [];
    for (const c of chords) {
      const s = Math.max(c.startTick, barStart);
      const e = Math.min(c.endTick, barEnd);
      if (e <= s) continue;
      slots.push({
        startTick: s,
        endTick: e,
        events: [makeEvent(c.label, args)],
      });
    }

    /** 没有和弦覆盖的空隙填 `X`（规范：不确定就放 X） */
    slots.sort((a, b) => a.startTick - b.startTick);
    const filled: MStructSlot[] = [];
    let cursor = barStart;
    for (const slot of slots) {
      if (slot.startTick > cursor) {
        filled.push({ startTick: cursor, endTick: slot.startTick, events: ['X'] });
      }
      filled.push(slot);
      cursor = slot.endTick;
    }
    if (cursor < barEnd) {
      filled.push({ startTick: cursor, endTick: barEnd, events: ['X'] });
    }

    bar.slots = filled.length ? filled : [{ startTick: barStart, endTick: barEnd, events: ['X'] }];
  });

  /**
   * 同一小节内的同名和弦改写成 `-`（延续上一个事件）。
   *
   * ## 为什么只在同小节内
   *
   * 规范说 `-` 是「延续上一个事件」，并说它「常被用来延续上一个小节的事件」。
   * 但官方示例（`examples/k545.mstruct`）里所有 `-` 都是**同小节内**用的，
   * 跨小节时官方写法是每个小节首槽位重新写出事件（否则搜索命中不到）。
   *
   * 我第一版做成跨小节合并，实测 156 小节里 114 个首槽位变成 `{1}-;` ——
   * 小节一开头就是「延续前面」，读者跨过分号才知道延的是什么。
   */
  for (const bar of bars) {
    let prev: string | null = null;
    for (const slot of bar.slots) {
      const cur = slot.events[0];
      if (prev !== null && cur === prev && cur !== 'X') {
        slot.events[0] = '-';
      }
      prev = cur;
    }
  }

  /**
   * 曲式标签：把结构段的起止 tick 对到小节。
   *
   * 标签写在小节**开头**（见 `buildMStructDocument` 里的注释），
   * 所以只需知道「这个段从第几小节开始、到第几小节结束」。
   */
  if (args.sections?.length) {
    for (const sec of args.sections) {
      const tag = sectionToFormTag(sec.label);
      /** 映射不上的名字直接跳过，不猜 */
      if (!tag) continue;

      /**
       * 开始小节：第一个 `end > sec.startTick` 的小节。
       * 结束小节：第一个 `start >= sec.endTick` 的小节。
       *
       * 用半开区间意跚避免边界重复：
       * 段 [10, 20) 在第 10 小节开始，第 20 小节开头写结束标签。
       */
      const openBar = spans.findIndex((sp) => sp.end > sec.startTick);
      const closeBar = spans.findIndex((sp) => sp.start >= sec.endTick);

      /**
       * 写成**闭合形式**（`</Pop_Form:Verse>`），不是开启形式。
       *
       * ## 为什么（官方编译器报错学到的）
       *
       * `form-tags.csv` 里这些标签的 `duration_mode = 1`，官方定义是
       * **一次性事件**（one-shot），只能用闭合形式写。
       *
       * 官方 `mstruct-tags.js` 的判定：
       *   ```js
       *   if (!closing) {
       *     if (definition.durationMode === 1) {
       *       makeError(..., "tag-start-not-allowed", ...);   // ← 我们碰到的错
       *       return;
       *     }
       *   }
       *   ...
       *   slot.tags.push(occurrence("oneshot", definition, lane, token));  // 闭合形式才走这里
       *   ```
       *
       * 我第一版写成 `<Pop_Form:Verse>` + `</Pop_Form:Verse>` 包围，直接被报
       * 「只能使用正斜杠形式作为一次性事件」。
       *
       * 含义上也更合理：变化点不需要「开启 / 结束」两次，
       * 只要在变化的那一小节标一次就行 —— 紧接着的后面那个标签自然表示「上一段已结束」。
       */
      void closeBar;
      if (openBar >= 0) {
        bars[openBar].formOpens = [...(bars[openBar].formOpens ?? []), `</${tag.slice(1)}`];
      }
    }
  }

  return bars;
}

/* -------------------------------------------------------------- 文档生成 */

/**
 * 调性 → `{TC:}` 值。
 *
 * 规范：「大调大写，小调小写。升降号在音名后面。」
 * C 大调 = `C`，c 小调 = `c`，Bb 大调 = `Bb`，f# 小调 = `f#`。
 */
export function mstructTonalCenter(tonic: string, mode: 'major' | 'minor'): string {
  const name = tonic || 'C';
  return mode === 'major' ? name : name.toLowerCase();
}

/** BPM 格式化：120 → `120`，129.73 → `129.73` */
function formatBpm(bpm: number): string {
  if (!Number.isFinite(bpm) || bpm <= 0) return '120';
  return String(Math.round(bpm * 100) / 100);
}

/**
 * 生成完整文档。
 *
 * ## 元数据字段从哪来
 *
 * 官方 `PROFILE_METADATA_FIELDS` + `serializeMstructDocument` 定义了完整字段表，
 * 本导出只填**有把握的**几个，其余留空 —— 空值在官方实现里会被
 * `.filter(([, field]) => normalized[field])` 跳过，不会输出空行。
 *
 * 必须填的（官方示例都有）：
 *   - `{MSTRUCT_FORMAT_VERSION}1`
 *   - `{MSTRUCT_PROFILE_ID}org.mstruct.official/rulesets/1.0.0`
 *   - `{MSTRUCT_PROFILE_HASH}sha256:...`
 *   - `{AUTHORING_APP_VERSION}`
 *   - `{SONG_NAME}`、`{IS_STABLE_TEMPO}`、`{OFFSET}`
 *
 * profile hash 是官方 ruleset 的固定指纹（见 `examples/k545.mstruct`）。
 * 写错会导致 `MstructProfileError("profile-hash-invalid")`。
 */
export const MSTRUCT_PROFILE = {
  formatVersion: '1',
  profileId: 'org.mstruct.official/rulesets/1.0.0',
  profileHash: 'sha256:4cc19eaa4d4b5f9e0674ee66b048482a2025c996f6c35e71f57d3c768b893881',
} as const;

export function buildMStructDocument(args: {
  title: string;
  artist: string;
  chords: ReadonlyArray<{ startTick: number; endTick: number; label: string }>;
  key: { tonic: string; mode: 'major' | 'minor' };
  meterMap: MeterMapData;
  bpm: number;
  unrecognizedLabel: string;
  /**
   * 级数计算器：和弦名 → 级数数字。传入后才写罗马数字。
   *
   * 由调用方注入（App 传 `chordToNumber`）。不传时输出的是
   * 只有和弦、没有罗马数字的合法文件。
   */
  degreeOf?: (label: string, tonic: string, mode: 'major' | 'minor') => string | null;
  /** 结构段（已含用户编辑），用于曲式标签 */
  sections?: ReadonlyArray<{ startTick: number; endTick: number; label: string }>;
  /** 总时长（毫秒），写进 `{SONG_LENGTH}`；不传则留空 */
  songLengthMs?: number;
  /** 应用名与版本，写进 `{AUTHORING_APP_VERSION}` */
  authoringApp?: string;
}): MStructDocument {
  const warnings: string[] = [];
  const { chords, key, meterMap, bpm } = args;

  if (!chords.length) warnings.push('没有和弦数据，导出的主体为空');

  const bars = buildBars({
    chords,
    meterMap,
    unrecognizedLabel: args.unrecognizedLabel,
    key,
    degreeOf: args.degreeOf,
    sections: args.sections,
  });

  /** ---- MAIN 区 ---- */
  const lines: string[] = [];
  let prevMeter = '';
  let prevKey = '';

  for (const bar of bars) {
    const head: string[] = [];

    /**
     * 首小节写 `{BN:}` 与 `{BPM:}`。
     *
     * 官方示例把 BN/BPM/TS/TC/D 全堆在第一小节首槽位，
     * 后续小节只在变化时写 TS/TC。这符合「设置持续到下次变化」。
     */
    if (bar.number === 1) {
      head.push(`{BN:1}`);
      head.push(`{BPM:1/4=${formatBpm(bpm)}}`);
    }

    const meterText = `${bar.meter.numerator}/${bar.meter.denominator}`;
    if (meterText !== prevMeter) {
      head.push(`{TS:${meterText}}`);
      prevMeter = meterText;
    }

    const keyText = mstructTonalCenter(key.tonic, key.mode);
    if (keyText !== prevKey) {
      head.push(`{TC:${keyText}}`);
      prevKey = keyText;
    }

    /**
     * 槽位用简写 `{1/4}`（等价于 `{D:1/4}`），跟官方示例一致。
     */
    const parts = bar.slots.map(
      (slot) => `{${ticksToDuration(slot.endTick - slot.startTick)}}${slot.events.join('')}`,
    );

    /**
     * 曲式标签插在小节两端。
     *
     * ## 位置规则（对照官方 `examples/k545.mstruct`）
     *
     *   ```
     *   </Sonata_Form:E_Sub1>C|I,,,;          ← 结束标签在行首
     *   </Sonata_Form:E_Transition>F|IV,,,;   ← 开始标签跟在同一位置
     *   ```
     *
     * 官方把开始与结束都写在**小节开头**（紧贴第一个槽位前），
     * 而不是小节末尾。原因：标签描述的是「从这里开始 / 到这里结束」，
     * 写在小节头则含义不歧义。开始与结束同时发生时，
     * 结束在前（先关上一个再开新的）。
     */
    const opens = bar.formOpens ?? [];
    const closes = bar.formCloses ?? [];
    const tags = [...closes, ...opens].join('');
    lines.push(`${tags}${head.join('')}${parts.join(',')};`);
  }

  /** ---- METADATA 区（严格按官方 serializeMstructDocument 的顺序） ---- */
  const meta: string[] = [];
  meta.push(`{MSTRUCT_FORMAT_VERSION}${MSTRUCT_PROFILE.formatVersion}`);
  meta.push(`{MSTRUCT_PROFILE_ID}${MSTRUCT_PROFILE.profileId}`);
  meta.push(`{MSTRUCT_PROFILE_HASH}${MSTRUCT_PROFILE.profileHash}`);
  meta.push(`{AUTHORING_APP_VERSION}${args.authoringApp ?? 'Fabulous'}`);
  meta.push(`{REPOSTED}FALSE`);
  meta.push(`{CREATOR}`);
  meta.push(`{EDITORS}`);
  meta.push(`{VERSION_NAME}`);
  meta.push('');
  meta.push(`{SONG_NAME}${args.title || ''}`);
  meta.push(`{SONG_NAME_ROMANIZED}`);
  meta.push('');
  meta.push(`{COMPOSER_NAME_1}${args.artist || ''}`);
  meta.push(`{COMPOSER_NAME_1_ROMANIZED}`);
  meta.push(`{COMPOSER_NAME_1_ALIAS}`);
  meta.push(`{COMPOSER_NAME_1_ID}`);
  meta.push('');
  meta.push(`{ALBUM_NAME}`);
  meta.push(`{ALBUM_NAME_ROMANIZED}`);
  meta.push('');
  meta.push(`{GROUP_NAME}`);
  meta.push(`{GROUP_NAME_ROMANIZED}`);
  meta.push('');
  meta.push(`{SOURCE_NAME}`);
  meta.push(`{SOURCE_NAME_ROMANIZED}`);
  meta.push('');
  meta.push(`{TAG}`);
  meta.push(`{GLOBAL_TAGS}`);
  meta.push('');
  meta.push(`{SCORE_URL_1}`);
  meta.push('');
  meta.push(`{SONG_LENGTH}${args.songLengthMs ?? ''}`);
  /**
   * `IS_STABLE_TEMPO`：官方要求 True 时全曲每个事件槽位都必须有 BPM 覆盖。
   * 我们每个小节只有首槽位之前写了 BPM（持续生效），且 BPM 是单一值 ——
   * 满足「全曲覆盖」，所以可以安全写 True。
   */
  meta.push(`{IS_STABLE_TEMPO}True`);
  meta.push(`{OFFSET}0`);
  meta.push('');
  meta.push(`{URL_NETEASE}`);
  meta.push(`{URL_TME}`);
  meta.push(`{URL_YOUTUBE}`);
  meta.push(`{URL_BILIBILI}`);
  meta.push(`{URL_SPOTIFY}`);
  meta.push(`{URL_APPLE_MUSIC}`);
  meta.push('');
  meta.push(`{COMMENTS}`);
  meta.push(`{COMMENTS_END}`);

  return {
    metadata: meta,
    main: lines.join('\n'),
    comment: '',
    warnings,
  };
}

/* ---------------------------------------------------------------- 序列化 */

/**
 * 序列化成完整的 MStruct 文件。
 *
 * 排版**逐行对照**官方 `serializeMstructDocument()`：
 * 段落之间的空行位置会影响 diff 和人工核对，所以照抄。
 */
export function serializeMStruct(doc: MStructDocument): string {
  const lines: string[] = [];
  lines.push('METADATA:');
  lines.push('');
  lines.push(...doc.metadata);
  lines.push('');
  lines.push('END_METADATA');
  lines.push('');
  lines.push('MAIN:');
  lines.push('');
  lines.push(doc.main.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
  lines.push('');
  lines.push('END_MAIN');
  lines.push('');
  lines.push('COMMENT:');
  lines.push('');
  if (doc.comment) lines.push(doc.comment);
  lines.push('END_COMMENT');
  return lines.join('\n') + '\n';
}

/** 建议的文件扩展名 */
export const MSTRUCT_EXT = 'mstruct';
