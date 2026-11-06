// SPDX-License-Identifier: MIT
// Copyright (c) 2026 VoryWork

/**
 * MStruct 导出的测试。
 *
 * 规范：https://mstruct-archive.com/docs/mstruct-syntax
 *
 * ## 这组测试在验什么
 *
 * 不是「函数能跑通」，而是「**产出的文本符不符合 MStruct 语法**」。
 * 因为导出的东西要能贴进官方编辑器直接编译，一个标点错了整份文件就废。
 *
 * 重点锁三件事（都是规范里最容易踩的）：
 *
 *   1. **槽位时值累加必须等于一整小节** —— 否则编译器报错
 *   2. **首个槽位必须有 `{BN:}` + `{TS:}`** —— 规范强制
 *   3. **和弦写法必须是 MStruct 的**（`Cm7` 不是 `C:min7`）——
 *      我们的 `X:model` 直接塞进去会被判非法（`maj`/`min` 是无效别名）
 */
import { describe, expect, it } from 'vitest';
import {
  buildMStructDocument,
  chordEventToMstruct,
  degreeToRoman,
  mstructTonalCenter,
  sectionToFormTag,
  serializeMStruct,
  ticksToDuration,
  xmodelToMstruct,
} from './mstruct';
import { createMeterMap, createMeterMap4_4 } from '../timeline/domain/MeterMap';

/** 造和弦块（4/4 一小节 = 3840 tick） */
function chord(startBar: number, lenBars: number, label: string) {
  const BAR = 3840;
  return { startTick: startBar * BAR, endTick: (startBar + lenBars) * BAR, label };
}

describe('ticksToDuration（{D:} 的分数）', () => {
  it('四分音符 = 1/4，八分 = 1/8，全音符 = 1', () => {
    expect(ticksToDuration(960)).toBe('1/4');
    expect(ticksToDuration(480)).toBe('1/8');
    // 全音符写 `1` 而不是 `1/1`（和官方示例的写法一致）
    expect(ticksToDuration(3840)).toBe('1');
    expect(ticksToDuration(1920)).toBe('1/2');
  });

  it('约分到最简（2/8 这种写法虽然合法但难读）', () => {
    expect(ticksToDuration(1920)).toBe('1/2'); // 不是 2/4
    expect(ticksToDuration(2880)).toBe('3/4');
  });

  it('三连音等不规整时值也能表示', () => {
    // 四分三连音的一颗 = 1/3 个四分音符 = 320 tick
    expect(ticksToDuration(320)).toBe('1/12');
  });
});

describe('xmodelToMstruct（我们的写法 → MStruct）', () => {
  it('大三和弦省略性质（Cmaj 在 MStruct 里非法）', () => {
    expect(xmodelToMstruct('C:maj')).toBe('C');
    expect(xmodelToMstruct('C:min')).toBe('Cm');
  });

  it('七和弦 / 扩展音', () => {
    expect(xmodelToMstruct('C:maj7')).toBe('CM7');
    expect(xmodelToMstruct('C:min7')).toBe('Cm7');
    expect(xmodelToMstruct('C:7')).toBe('C7');
    expect(xmodelToMstruct('C:dim7')).toBe('Cdim7');
    expect(xmodelToMstruct('C:hdim7')).toBe('Cm7b5');
    expect(xmodelToMstruct('C:minmaj7')).toBe('CmM7');
    expect(xmodelToMstruct('C:9')).toBe('C9');
    expect(xmodelToMstruct('C:maj9')).toBe('CM9');
    expect(xmodelToMstruct('C:13')).toBe('C13');
  });

  it('变化音括号原样保留（我们的写法和 MStruct 结构一致）', () => {
    expect(xmodelToMstruct('C:7(b9)')).toBe('C7(b9)');
    expect(xmodelToMstruct('C:7(#9)')).toBe('C7(#9)');
    expect(xmodelToMstruct('C:7(b9,b13)')).toBe('C7(b9,b13)');
    expect(xmodelToMstruct('C:sus4(b7,9,13)')).toBe('Csus4(b7,9,13)');
    expect(xmodelToMstruct('C:11(b9,b13)')).toBe('C11(b9,b13)');
  });

  it('转位：音级换算成绝对音名（MStruct 的斜杠后面只能是音名）', () => {
    // C 的三音是 E，五音是 G
    expect(xmodelToMstruct('C:maj/3')).toBe('C/E');
    expect(xmodelToMstruct('C:maj/5')).toBe('C/G');
    // D 的三音是 F#
    expect(xmodelToMstruct('D:maj/3')).toBe('D/F#');
  });

  it('根音带升降号', () => {
    expect(xmodelToMstruct('Bb:min7')).toBe('Bbm7');
    expect(xmodelToMstruct('F#:maj')).toBe('F#');
    expect(xmodelToMstruct('Ab:maj7')).toBe('AbM7');
  });

  it('N / 空 返回 null（由调用方决定映射成 N.C. 还是 X）', () => {
    expect(xmodelToMstruct('N')).toBeNull();
    expect(xmodelToMstruct('')).toBeNull();
  });
});

describe('chordEventToMstruct（事件语义映射）', () => {
  const opt = { unrecognizedLabel: '未识别' };

  it('N → N.C.（不构成和弦但有音）', () => {
    expect(chordEventToMstruct('N', opt)).toBe('N.C.');
  });

  it('未识别 → X（分析者暂不便指定）', () => {
    expect(chordEventToMstruct('未识别', opt)).toBe('X');
    expect(chordEventToMstruct('', opt)).toBe('X');
  });

  it('正常和弦走转换（仍带 |）', () => {
    expect(chordEventToMstruct('C:min7', opt)).toBe('Cm7|');
  });
});

describe('mstructTonalCenter（{TC:} 大小写约定）', () => {
  it('大调大写、小调小写', () => {
    expect(mstructTonalCenter('C', 'major')).toBe('C');
    expect(mstructTonalCenter('C', 'minor')).toBe('c');
    expect(mstructTonalCenter('Bb', 'major')).toBe('Bb');
    expect(mstructTonalCenter('Bb', 'minor')).toBe('bb');
    expect(mstructTonalCenter('F#', 'minor')).toBe('f#');
  });
});

describe('buildMStructDocument（整份主体）', () => {
  it('首个槽位带 {BN:} 与 {BPM:}，每小节以 ; 结束', () => {
    const doc = buildMStructDocument({
      title: 'T',
      artist: 'A',
      chords: [chord(0, 1, 'C:maj'), chord(1, 1, 'F:maj')],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    expect(doc.main.startsWith('{BN:1}{BPM:1/4=120}')).toBe(true);
    // 两小节 → 两个分号
    expect(doc.main.split(';').filter(Boolean).length).toBe(2);
    // 第一小节出现拍号和调性
    expect(doc.main).toContain('{TS:4/4}');
    expect(doc.main).toContain('{TC:C}');
  });

  it('同一小节内的同名和弦用 - 延续', () => {
    /**
     * 规范：`-` 是「延续上一个事件」。
     * 同一小节内被切成两段的同名和弦，写 `C,C` 是「换了两次」，
     * 写 `C,-` 才是「一直在延续」。
     */
    const doc = buildMStructDocument({
      title: 'T', artist: '',
      // 一小节内切成两半，都是 C
      chords: [
        { startTick: 0, endTick: 1920, label: 'C:maj' },
        { startTick: 1920, endTick: 3840, label: 'C:maj' },
      ],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    /** 每个槽位都有自己的时值（官方简写 `{1/2}` = `{D:1/2}`）。
     *  注意 `-` 是**独立事件**，不带 `|`。 */
    expect(doc.main).toContain('{1/2}C|,{1/2}-;');
  });

  it('跨小节时首槽位写和弦名（不用 - ）', () => {
    /**
     * ❌ 不能写成「与上一小节同名就改 `-`」。
     *
     * 第一版就是这么写的，实测 156 个小节里 114 个的首槽位变成
     * `{D:1}-;` —— 小节一开头就是「延续」，而延续的对象在上一小节，
     * 读者要跨过分号才能知道是什么，搜索也命中不到。
     */
    const doc = buildMStructDocument({
      title: 'T', artist: '',
      chords: [chord(0, 2, 'C:maj')],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    const bars = doc.main.split(';').filter((b) => b.trim());
    expect(bars).toHaveLength(2);
    // 两小节首槽位都必须是 C，不能是 -
    expect(bars[0]).toMatch(/\}C\|$/);
    expect(bars[1]).toMatch(/\}C\|$/);
  });

  it('没有和弦的空隙填 X', () => {
    const doc = buildMStructDocument({
      title: 'T',
      artist: '',
      // 只有第 0 小节前半个小节有和弦
      chords: [{ startTick: 0, endTick: 1920, label: 'C:maj' }],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    expect(doc.main).toContain('X');
  });

  it('每小节的槽位时值之和必须等于一整小节（规范硬要求）', () => {
    /**
     * 这条是整个导出最关键的约束：
     *   「普通有拍小节必须恰好累计为 p/q 个全音符」
     * 累加不对，官方编辑器直接编译失败。
     */
    const doc = buildMStructDocument({
      title: 'T',
      artist: '',
      chords: [chord(0, 1, 'C:maj'), chord(1, 2, 'F:maj'), chord(3, 1, 'G:maj')],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });

    const bars = doc.main.split(';').filter((b) => b.trim());
    for (const bar of bars) {
      /**
       * 认两种写法：官方简写 `{1/4}` 与显式 `{D:1/4}`。
       * 官方 `parseSetting` 把纯分数当 `D` 处理，两者等价。
       */
      const durations = [...bar.matchAll(/\{(?:D:)?(\d+)(?:\/(\d+))?\}/g)]
        .map((m) => Number(m[1]) / Number(m[2] ?? 1));
      const sum = durations.reduce((a, b) => a + b, 0);
      // 4/4 = 1 个全音符
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('拍号变化时写出新的 {TS:}，且只写一次', () => {
    /**
     * 规范：「TS 在小节边界改变」「设置会一直持续到下一次变化为止」。
     * 所以变化点写一次就够，不需要每小节重复。
     */
    const meterMap = createMeterMap([
      { startTick: 0, numerator: 4, denominator: 4 },
      { startTick: 3840, numerator: 3, denominator: 4 },
    ]);
    const doc = buildMStructDocument({
      title: 'T',
      artist: '',
      chords: [chord(0, 1, 'C:maj'), chord(1, 1, 'F:maj'), chord(2, 1, 'G:maj')],
      key: { tonic: 'C', mode: 'major' },
      meterMap,
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    const tsCount = (doc.main.match(/\{TS:4\/4\}/g) ?? []).length;
    const ts34 = (doc.main.match(/\{TS:3\/4\}/g) ?? []).length;
    expect(tsCount).toBe(1); // 只在开头
    expect(ts34).toBe(1); // 只在变化点
  });
});

describe('serializeMStruct（三段式）', () => {
  it('包含 METADATA / MAIN / COMMENT 三段与各自的 END_ 标记', () => {
    const doc = buildMStructDocument({
      title: 'Refrain',
      artist: 'Aimer',
      chords: [chord(0, 1, 'C:maj')],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    const text = serializeMStruct(doc);

    expect(text).toContain('METADATA:');
    expect(text).toContain('END_METADATA');
    expect(text).toContain('MAIN:');
    expect(text).toContain('END_MAIN');
    expect(text).toContain('COMMENT:');
    expect(text).toContain('END_COMMENT');

    // 顺序必须是 METADATA → MAIN → COMMENT
    const iMeta = text.indexOf('METADATA:');
    const iMain = text.indexOf('MAIN:');
    const iComment = text.indexOf('COMMENT:');
    expect(iMeta).toBeLessThan(iMain);
    expect(iMain).toBeLessThan(iComment);
  });

  it('文件以换行结尾（贴进编辑器不会吃掉最后一个分号）', () => {
    const doc = buildMStructDocument({
      title: 'T', artist: '',
      chords: [chord(0, 1, 'C:maj')],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    expect(serializeMStruct(doc).endsWith('\n')).toBe(true);
    // 最后的 MAIN 内容以分号结束
    const mainSection = serializeMStruct(doc).split('END_MAIN')[0];
    expect(mainSection.trimEnd().endsWith(';')).toBe(true);
  });
});

/**
 * 罗马数字 —— **逐行对照官方 `src/config/roman-basic.csv`**。
 *
 * ## 为什么必须对着 CSV 写而不是按音阶推
 *
 * 官方不是「按音阶算就行」，而是一张查表。典型差异：
 *
 *   | 级数 | 大调 | 小调 | 注 |
 *   |---|---|---|---|
 *   | 3 | `III` | `nIII` | 小调用 `n`（自然），不是 `b`（降） |
 *   | b3 | `bIII` | `bIII` | 降三级两边都是 b |
 *   | 7 | `nVII` | `nVII` | 导音上的和弦统一用 n |
 *
 * d 小调的 3 级是 F，它相对大调确实降了半音，但官方写 `nIII` 不是 `bIII`。
 * 这种细微差别只能查表。
 */
describe('degreeToRoman（对照官方 roman-basic.csv）', () => {
  it('自然音级的大三 / 小三', () => {
    expect(degreeToRoman('1', 'major', 'maj')).toBe('I');
    expect(degreeToRoman('1', 'major', 'min')).toBe('i');
    expect(degreeToRoman('2', 'major', 'min')).toBe('ii');
    expect(degreeToRoman('4', 'major', 'maj')).toBe('IV');
    expect(degreeToRoman('4', 'major', 'min')).toBe('iv');
    expect(degreeToRoman('5', 'major', 'maj')).toBe('V');
  });

  it('大调 3 / 6 级用大写罗马，小调用 n 前缀', () => {
    expect(degreeToRoman('3', 'major', 'maj')).toBe('III');
    expect(degreeToRoman('3', 'major', 'min')).toBe('iii');
    expect(degreeToRoman('3', 'minor', 'maj')).toBe('nIII');
    expect(degreeToRoman('3', 'minor', 'min')).toBe('niii');
    expect(degreeToRoman('6', 'major', 'maj')).toBe('VI');
    expect(degreeToRoman('6', 'minor', 'maj')).toBe('nVI');
  });

  it('降级（b 前缀）大小调通用', () => {
    expect(degreeToRoman('b2', 'major', 'maj')).toBe('bII');
    expect(degreeToRoman('b3', 'major', 'maj')).toBe('bIII');
    expect(degreeToRoman('b3', 'minor', 'maj')).toBe('bIII');
    expect(degreeToRoman('b6', 'major', 'maj')).toBe('bVI');
    expect(degreeToRoman('b7', 'major', 'maj')).toBe('bVII');
    expect(degreeToRoman('b7', 'minor', 'maj')).toBe('bVII');
  });

  it('升级', () => {
    expect(degreeToRoman('#4', 'major', 'maj')).toBe('#IV');
    expect(degreeToRoman('#4', 'major', 'min')).toBe('#iv');
  });

  it('性质修饰符（官方 roman-advanced.csv）', () => {
    expect(degreeToRoman('2', 'major', 'dim')).toBe('iio');
    // 7 级基表是 `nVII`，减和弦小写 + o → `nviio`
    expect(degreeToRoman('7', 'major', 'dim')).toBe('nviio');
    expect(degreeToRoman('4', 'major', 'aug')).toBe('IV+');
    // 半减七属 `requires_seventh: True`，官方要求**必须带数字低音** → `ho7`
    expect(degreeToRoman('2', 'major', 'hdim7')).toBe('iiho7');
    // 官方：大写罗马数字已隐含大七度，`M` 属于重复标记 → 删 M 保留 7
    expect(degreeToRoman('2', 'major', 'maj7')).toBe('II7');
  });

  it('V 级的属七不加 DM，但仍要数字低音 7', () => {
    /**
     * 官方：`DM` 是「属七，但用于 V 级以外的级数」。
     * 但 V 级仍需 `7` 来表示七音 —— `V` 是三和弦，`V7` 才是属七。
     */
    expect(degreeToRoman('5', 'major', '7')).toBe('V7');
    // 其他级数上的属七才加 DM
    expect(degreeToRoman('2', 'major', '7')).toBe('IIDM7');
  });

  it('认不出的级数返回 null（不猜）', () => {
    expect(degreeToRoman('8', 'major', 'maj')).toBeNull();
    expect(degreeToRoman('', 'major', 'maj')).toBeNull();
    expect(degreeToRoman('x', 'major', 'maj')).toBeNull();
  });
});

describe('事件里带罗马数字（C|I 形式）', () => {
  const opt = { unrecognizedLabel: '未识别' };

  it('有罗马数字时写 C|I', () => {
    expect(chordEventToMstruct('C:maj', { ...opt, roman: 'I' })).toBe('C|I');
    expect(chordEventToMstruct('A:min', { ...opt, roman: 'vi' })).toBe('Am|vi');
  });

  it('没有罗马数字时仍必须带 |（规范：`Cm|` 合法，裸 `Cm` 不合法）', () => {
    /**
     * ❌ 不能写殖和弦名 `C`。
     *
     * 规范：「和弦记号和罗马数字在必要时可以留空一侧，如 `Cm|`」。
     * 官方编译器报：「未加方括号的和弦事件必须使用 C|R 形式」。
     */
    expect(chordEventToMstruct('C:maj', { ...opt, roman: null })).toBe('C|');
    expect(chordEventToMstruct('C:maj', opt)).toBe('C|');
    // 变化音 / 转位也一样
    expect(chordEventToMstruct('C:7(b9)', { ...opt, roman: null })).toBe('C7(b9)|');
  });

  it('特殊事件（N.C. / X）不带 |', () => {
    expect(chordEventToMstruct('N', { ...opt, roman: 'I' })).toBe('N.C.');
    expect(chordEventToMstruct('未识别', { ...opt, roman: 'I' })).toBe('X');
  });
});

/**
 * 曲式标签 —— **对照官方 `src/config/form-tags.csv`**。
 *
 * 官方把流行曲归在 `Pop_Form`（Verse-Chorus Form）下，子标签就是
 * `Pop_Form:Verse`、`Pop_Form:Chorus` 这种。自造标签名会被编译器拒绝
 * （`unknown-form-tag`），所以必须查表。
 */
describe('sectionToFormTag（对照官方 form-tags.csv）', () => {
  it('流行曲常见段', () => {
    expect(sectionToFormTag('Intro')).toBe('<Pop_Form:Intro>');
    expect(sectionToFormTag('Verse')).toBe('<Pop_Form:Verse>');
    expect(sectionToFormTag('Chorus')).toBe('<Pop_Form:Chorus>');
    expect(sectionToFormTag('Bridge')).toBe('<Pop_Form:Bridge>');
    expect(sectionToFormTag('Outro')).toBe('<Pop_Form:Outro>');
    expect(sectionToFormTag('Pre-Chorus')).toBe('<Pop_Form:Prechorus>');
    expect(sectionToFormTag('Post-Chorus')).toBe('<Pop_Form:PostChorus>');
  });

  it('容忍大小写与尾部序号（模型实测会输出 `verse` / `Verse 1`）', () => {
    expect(sectionToFormTag('verse')).toBe('<Pop_Form:Verse>');
    expect(sectionToFormTag('CHORUS')).toBe('<Pop_Form:Chorus>');
    expect(sectionToFormTag('Verse 1')).toBe('<Pop_Form:Verse>');
    expect(sectionToFormTag('Chorus2')).toBe('<Pop_Form:Chorus>');
    expect(sectionToFormTag('  Bridge  ')).toBe('<Pop_Form:Bridge>');
  });

  it('器乐段用官方的 InstBreak', () => {
    expect(sectionToFormTag('Instrumental')).toBe('<Pop_Form:InstBreak>');
    expect(sectionToFormTag('Interlude')).toBe('<Pop_Form:InstBreak>');
  });

  it('官方表里没有的名字返回 null（不猜、不造）', () => {
    expect(sectionToFormTag('奇怪段落')).toBeNull();
    expect(sectionToFormTag('Whatever')).toBeNull();
    expect(sectionToFormTag('')).toBeNull();
  });
});

describe('标签在 MAIN 中的位置', () => {
  it('开始标签写在小节开头，结束标签也在开头（对照官方示例）', () => {
    /**
     * 官方 `examples/k545.mstruct`：
     *   `</Sonata_Form:E_Sub1>C|I,,,;`
     *   `</Sonata_Form:E_Transition>F|IV,,,;`
     * 两个标签都在**小节开头**，不在末尾。
     */
    const doc = buildMStructDocument({
      title: 'T', artist: '',
      chords: [chord(0, 1, 'C:maj'), chord(1, 1, 'F:maj'), chord(2, 1, 'G:maj')],
      sections: [
        { startTick: 0, endTick: 3840, label: 'Verse' },
        { startTick: 3840, endTick: 7680, label: 'Chorus' },
      ],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });

    const bars = doc.main.split(';').filter((b) => b.trim());
    /**
     * 官方报错学到的：`duration_mode = 1` 的标签是**一次性事件**，
     * 只能用闭合形式 `</Pop_Form:Verse>`，不能写 `<Pop_Form:Verse>`（会报
     * `tag-start-not-allowed`）。
     */
    expect(bars[0]).toContain('</Pop_Form:Verse>');
    expect(bars[0]).not.toContain('<Pop_Form:Verse>');
    // 下一个变化点标一次就行
    expect(bars[1]).toContain('</Pop_Form:Chorus>');
  });

  it('映射不上的段不写标签（不让整份文件编译失败）', () => {
    const doc = buildMStructDocument({
      title: 'T', artist: '',
      chords: [chord(0, 1, 'C:maj')],
      sections: [{ startTick: 0, endTick: 3840, label: '未知段落' }],
      key: { tonic: 'C', mode: 'major' },
      meterMap: createMeterMap4_4(),
      bpm: 120,
      unrecognizedLabel: '未识别',
    });
    expect(doc.main).not.toContain('<');
    expect(doc.main).not.toContain('</');
  });
});
