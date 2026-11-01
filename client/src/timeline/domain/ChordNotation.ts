/**
 * 和弦记号的**严格校验**（对齐 lv-chordia 的表述）。
 *
 * ## 为什么必须校验
 *
 * 让用户自由输入和弦名，脏数据会传染到整条链路：
 *   - `chordToNumber` 解析失败 → 级数解释轨那几个块直接消失（不报错）
 *   - `inferKey` 用脏和弦打分 → 调性推断偏掉
 *   - 导出 Markdown / 后续重分析 → 下游全要处理非法值
 *
 * 所以只接受 lv-chordia 词表里存在的写法，其余一律拒绝并提示。
 *
 * ## 词表来源
 *
 * `neural/lv-chordia/lv_chordia/data/{submission,ismir2017,full}_chord_list.txt`
 *
 * 三个档位的关系：
 *   - `submission`（25 个）：常用和弦，最实用  ← 校验用这个当"推荐集"
 *   - `ismir2017`（14 个）：MIREX 基础集
 *   - `full`（382 个）：全量，含 `maj(*3,*5)` 这类组合变体
 *
 * 校验规则 = **根音 12 名 + 后缀（来自 full 档全集）+ 转位（来自全集的 22 个）**。
 * 这样既挡住乱输（`H:foo`、`abc`、`Cmaj7` 缺冒号），又不会把
 * 模型可能输出的合法和弦判成非法。
 *
 * ## 与常见写法的差异（要提示用户）
 *
 * lv-chordia 用 `C:maj` 而不是 `Cmaj`，用 `C:min7` 而不是 `Cm7`。
 * 这是它 XHMM 解码器的输出格式，改了就没法和模型结果混用。
 * 所以校验器会**尝试纠正**常见写法（`Cmaj7` → `C:maj7`、`Cm7` → `C:min7`），
 * 纠正成功就直接采用，而不是让用户猜。
 */

/** 根音（12 个音，升号/降号两种写法都收） */
const ROOT_NAMES = [
  'C',
  'C#',
  'Db',
  'D',
  'D#',
  'Eb',
  'E',
  'F',
  'F#',
  'Gb',
  'G',
  'G#',
  'Ab',
  'A',
  'A#',
  'Bb',
  'B',
] as const;

/**
 * 合法后缀（来自 `full_chord_list.txt` 的实测提取）。
 *
 * 粗略分层：基础（submission 档那些）在前，组合变体在后。
 * 校验时全收，但输入提示优先推荐基础的。
 */
const QUALITIES = new Set<string>([
  // ---- 基础（submission / ismir2017 档）
  'maj', 'min', 'dim', 'aug',
  'sus2', 'sus4',
  'maj6', 'min6',
  'maj7', 'min7', '7', 'dim7', 'hdim7', 'minmaj7',
  'maj9', 'min9', '9',
  '11', '13',
  'min11', 'min13', 'maj13',
  // ---- full 档里常见但少见的
  '5',
  'sus4(b7)', 'sus2(b7)', 'maj(b5)', 'maj(#11)', 'maj(b9)',
  '7(b5)', '7(b9)', '7(#9)', '7(#11)', '7(b13)', '7(9)', '7(11)', '7(13)',
  '9(b5)', '9(#11)', '9(b13)',
  'min7(b5)', 'min7(9)', 'min7(11)', 'min7(b13)',
  'maj7(#11)', 'maj7(#5)', 'maj7(9)',
  'maj9(#11)',
  'aug(7)', 'aug(b7)',
  '(1,5)', '(1)', '(3)', '(5)', '(6)', '(7)', '(b3)', '(b7)', '(11)', '(13)',
  '(1,4)', '(1,b3)', '(1,b7)',
]);

/**
 * 合法转位 / 低音。
 *
 * lv-chordia 的写法是音阶级数（`/3`、`/5`、`/b7`）或绝对音级（`/2`、`/b3`），
 * 集合来自词表实测的 22 个。
 */
const INVERSIONS = new Set<string>([
  '1', '2', '3', '4', '5', '6', '7', '9', '11',
  'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9',
  '#1', '#4', '#5',
  'bb6', 'bb7',
]);

export interface ChordValidation {
  ok: boolean;
  /** 校验通过后的规范写法（可能是纠正过的） */
  normalized: string;
  /** 被拒绝时的原因（给用户看） */
  error?: string;
  /** 做了纠正时的提示 */
  hint?: string;
}

/** 常见错误写法 → lv-chordia 写法 */
const ALIASES: Array<[RegExp, string]> = [
  // Cm7 → C:min7，CM7/maj7 → C:maj7
  [/^([A-G][#b]?)m7$/, 'min7'],
  [/^([A-G][#b]?)m9$/, 'min9'],
  [/^([A-G][#b]?)m11$/, 'min11'],
  [/^([A-G][#b]?)m6$/, 'min6'],
  [/^([A-G][#b]?)m$/, 'min'],
  [/^([A-G][#b]?)(maj|M)7$/, 'maj7'],
  [/^([A-G][#b]?)(maj|M)9$/, 'maj9'],
  [/^([A-G][#b]?)(maj|M)$/, 'maj'],
  [/^([A-G][#b]?)7$/, '7'],
  [/^([A-G][#b]?)dim7$/, 'dim7'],
  [/^([A-G][#b]?)dim$/, 'dim'],
  [/^([A-G][#b]?)aug$/, 'aug'],
  [/^([A-G][#b]?)sus2$/, 'sus2'],
  [/^([A-G][#b]?)sus4$/, 'sus4'],
];

/**
 * 校验并规范化一个和弦记号。
 *
 * 接受的形式（与 lv-chordia 一致）：
 *   - `N`                        无和弦
 *   - `C:maj`                    根音:性质
 *   - `C:min7`
 *   - `C:maj/3`                  根音:性质/转位
 *   - `C/5`                      只有转位没有性质（少见但词表里有 `C:5`）
 */
export function validateChord(raw: string): ChordValidation {
  const input = raw.trim();
  if (!input) return { ok: false, normalized: '', error: '不能为空' };

  // 无和弦
  if (input.toUpperCase() === 'N') return { ok: true, normalized: 'N' };

  // 先试别名纠正
  let text = input;
  let hint: string | undefined;
  for (const [re, quality] of ALIASES) {
    const m = text.match(re);
    if (m) {
      const fixed = `${m[1]}:${quality}`;
      if (fixed !== input) {
        text = fixed;
        hint = `已按 lv-chordia 写法规范为 ${fixed}`;
      }
      break;
    }
  }

  // 根音
  const rootMatch = text.match(/^([A-G][#b]?)/);
  if (!rootMatch) {
    return {
      ok: false,
      normalized: '',
      error: '必须以音名开头（A–G，可带 # 或 b），例如 C、Ab、F#',
    };
  }
  const root = rootMatch[1];
  if (!(ROOT_NAMES as readonly string[]).includes(root)) {
    return { ok: false, normalized: '', error: `不认识的音名「${root}」` };
  }

  let rest = text.slice(root.length);

  // 允许省略冒号：C maj7 / Cmaj7 已被别名处理；这里容忍 "C:xxx" 或 "C/xxx"
  let quality = '';
  let inversion = '';

  if (rest.startsWith(':')) {
    rest = rest.slice(1);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      quality = rest.slice(0, slash);
      inversion = rest.slice(slash + 1);
    } else {
      quality = rest;
    }
  } else if (rest.startsWith('/')) {
    inversion = rest.slice(1);
  } else if (rest === '') {
    // `Ab` 单独出现 → 按大三和弦处理（lv-chordia 里是 `Ab:maj`）
    quality = 'maj';
    hint = hint ?? `已补全为 ${root}:maj（大三和弦）`;
  } else {
    return {
      ok: false,
      normalized: '',
      error: `「${rest}」前面要加冒号，例如 ${root}:${rest.replace(/^:/, '')}`,
    };
  }

  // 性质
  if (quality && !QUALITIES.has(quality)) {
    return {
      ok: false,
      normalized: '',
      error: `不支持的和弦性质「${quality}」`,
    };
  }
  if (!quality && !inversion) {
    return { ok: false, normalized: '', error: '缺少和弦性质，例如 :maj' };
  }

  // 转位
  if (inversion && !INVERSIONS.has(inversion)) {
    return {
      ok: false,
      normalized: '',
      error: `不支持的转位「${inversion}」，可用：3、5、b7 等音级`,
    };
  }

  const normalized = `${root}${quality ? ':' + quality : ''}${inversion ? '/' + inversion : ''}`;
  return { ok: true, normalized, hint };
}

/** 给输入框用的推荐写法（基础常用和弦） */
/**
 * 12 个调性主音（只保留降号体系的那 12 个）。
 *
 * ## 为什么这里用 12 个而不是 17 个
 *
 * `ROOT_NAMES` 是 17 个（含 C#/Db、D#/Eb 这类同音异名），因为和弦名要
 * 兼容模型输出的两种写法。但**调性**只需要 12 个 —— 用户选的是
 * 「这首歌的主音是哪个音」，同音异名在这里只会让人困惑
 * （A 大调和 Bbb 大调是同一件事）。
 *
 * 选降号体系（Bb/ Eb/ Ab）是因为流行/爵士谱面惯用降号，
 * 而且和项目里 `FLAT_NAMES` 的归一方向一致。
 */
export const KEY_TONICS = [
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B',
] as const;

/**
 * 关系小调主音（大调主音下移小三度 = 3 个半音）。
 *
 * C → A、A → F#、G → E。
 *
 * ## 为什么默认追加这条轨
 *
 * 关系大小调**和弦完全重合**，光看和弦名无法区分。
 * 用户要判断「这首歌真是 A 大调还是 F# 小调」时，最需要的正是这个对照。
 *
 * 注意这条轨只改变**解释方式**，不改任何和弦数据 ——
 * A 大调下 `F#:min` 是 vi，F# 小调下是 i，音符都是那些音符。
 */
export function relatedMinor(tonic: string): string {
  const idx = (KEY_TONICS as readonly string[]).indexOf(tonic);
  if (idx < 0) return tonic;
  // 下移 3 个半音（小三度）
  return KEY_TONICS[(idx + 9) % 12];
}
export const COMMON_QUALITIES = [
  'maj', 'min', '7', 'maj7', 'min7',
  'dim', 'aug', 'sus2', 'sus4', 'dim7', 'hdim7',
] as const;

export const COMMON_INVERSIONS = ['3', '5', 'b7', '7'] as const;
