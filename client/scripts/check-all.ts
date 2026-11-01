/**
 * E2E 交互验证 —— 覆盖 M1 的核心交互。
 *
 * 用语义选择器（data-track-kind / data-clip-id / data-start）而不是索引，
 * 这样轨道增删不会让测试失效。
 *
 * 用法：
 *   bun run dev            # 先起服务
 *   bun scripts/check-all.ts
 */
import { chromium } from 'playwright';

const PAGE_URL = process.env.SHOT_URL ?? 'http://localhost:1420/';
const PPQ = 960;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });

  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // ---------------------------------------------------------------- 工具
  /** 量化粒度：八分音符 */
  const EIGHTH = PPQ / 2;
  const CHORD = '.track-row[data-track-kind="chord"]';
  const DEGREE = '.track-row[data-track-kind="degree"]';

  const readRow = (sel: string) =>
    page.evaluate((s) => {
      const row = document.querySelector(s);
      if (!row) return [];
      return Array.from(row.querySelectorAll('.clip')).map((e) => ({
        s: Number(e.getAttribute('data-start')),
        e: Number(e.getAttribute('data-end')),
      }));
    }, sel);

  const trackY = async (sel: string) => {
    const bb = await page.locator(sel).boundingBox();
    return bb!.y + bb!.height / 2;
  };

  const contentLeft = () =>
    page.evaluate(() => document.querySelector('.content')!.getBoundingClientRect().left);
  const ppt = () =>
    page.evaluate(() => Number(document.querySelector('.grid-canvas')!.getAttribute('data-ppt')));

  // ---------------------------------------------------------------- 1. 数据真实性
  console.log('\n=== 1. 数据来自真实分析 ===');
  const meta = await page.evaluate(() => {
    const t = document.querySelector('.song-meta')?.textContent ?? '';
    return t;
  });
  console.log(`  ${meta.replace(/\s+/g, ' ').trim()}`);
  ok(/G major/.test(meta), '调性 = G major（I–V–vi–IV 推断）');
  ok(/4\/4/.test(meta), '拍号 4/4');
  // 不硬编码小节数：换一首歌就变了。只验证"有真实数量的小节"
  const barsMatch = meta.match(/(\d+) 小节/);
  const bars = barsMatch ? Number(barsMatch[1]) : 0;
  ok(bars >= 50, `小节数来自真实 downbeat（${bars} 小节）`);

  const tracks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.track-row')).map((e) => e.getAttribute('data-track-kind')),
  );
  console.log(`  轨道: ${tracks.join(', ')}`);
  ok(!tracks.includes('lyric'), '没有假歌词轨');
  ok(tracks.includes('section'), '有结构轨（all-in-one-infer 自动分析）');
  ok(tracks.includes('chord'), '有真实和弦轨');

  // ---------------------------------------------------------------- 2. 级数跟随
  console.log('\n=== 2. 级数与和弦对齐 ===');
  let ch = await readRow(CHORD);
  let dg = await readRow(DEGREE);
  console.log(`  和弦 ${ch.length} 块 / 级数 ${dg.length} 块`);
  ok(ch.length >= 5, `可见范围渲染 ${ch.length} 块（虚拟化裁剪，正常）`);
  ok(ch[0].s === dg[0].s && ch[0].e === dg[0].e, '首个块边界一致（级数投影自和弦）');

  // ---------------------------------------------------------------- 3. 量化
  console.log('\n=== 3. 最小量化 1 拍 ===');
  const badLen = ch.filter((c) => (c.e - c.s) < PPQ);
  ok(badLen.length === 0, `所有和弦块 ≥ 1 拍（${ch.length} 块）`);
  // 量化单位是八分音符（480），不是整拍 —— 切分和弦需要半拍精度
  const badAlign = ch.filter((c) => c.s % EIGHTH !== 0 || c.e % EIGHTH !== 0);
  ok(badAlign.length === 0, '所有边界都在八分音符网格上');
  const offBeat = ch.filter((c) => c.s % PPQ !== 0 || c.e % PPQ !== 0);
  if (offBeat.length > 0) {
    console.log(`    （其中 ${offBeat.length} 个边界在切分位置，正常）`);
  }

  // ---------------------------------------------------------------- 4. 拖动
  console.log('\n=== 4. 拖动和弦 ===');
  const cl = await contentLeft();
  const pp = await ppt();
  const cy = await trackY(CHORD);

  const c0 = ch[1];
  const midX = cl + ((c0.s + c0.e) / 2) * pp;
  await page.mouse.move(midX, cy);
  await page.mouse.down();
  await page.mouse.move(midX + 2 * PPQ * pp, cy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  ch = await readRow(CHORD);
  dg = await readRow(DEGREE);
  console.log(`  和弦[1]: ${c0.s}→${c0.e} 变为 ${ch[1].s}→${ch[1].e}`);
  ok(ch[1].s > c0.s, '和弦被移动');
  ok(dg[1].s === ch[1].s && dg[1].e === ch[1].e, '级数跟随移动');
  ok((ch[1].e - ch[1].s) % EIGHTH === 0, '拖动后仍在八分音符网格');

  // ---------------------------------------------------------------- 5. 接缝
  console.log('\n=== 5. 接缝拖动（左长右短）===');
  ch = await readRow(CHORD);

  /**
   * 选一个**右块足够长**的接缝来测。
   *
   * 踩过的坑：一开始固定用 ch[2]/ch[3]，但那对里右块只有 1.5 拍，
   * 拖 2 拍会触发「最小和弦长度 1 拍」的保护（拒绝并回退），
   * 看起来像"接缝没生效"，其实是边界保护在工作。
   */
  let seamIdx = -1;
  for (let i = 0; i < ch.length - 1; i++) {
    const sameEdge = ch[i].e === ch[i + 1].s;
    const rightLen = ch[i + 1].e - ch[i + 1].s;
    if (sameEdge && rightLen >= PPQ * 3) {
      seamIdx = i;
      break;
    }
  }
  ok(seamIdx >= 0, '找到可测的接缝（右块 ≥ 3 拍）');

  if (seamIdx >= 0) {
    const L = ch[seamIdx];
    const R = ch[seamIdx + 1];
    const seamX = cl + L.e * pp;
    await page.mouse.move(seamX, cy);
    await page.mouse.down();
    await page.mouse.move(seamX + PPQ * pp, cy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const ch2 = await readRow(CHORD);
    const leftLen = ch2[seamIdx].e - ch2[seamIdx].s;
    const rightLen = ch2[seamIdx + 1].e - ch2[seamIdx + 1].s;
    console.log(`  左 ${L.e - L.s} → ${leftLen}；右 ${R.e - R.s} → ${rightLen}`);
    ok(leftLen > L.e - L.s, '左块变长');
    ok(rightLen < R.e - R.s, '右块变短');
    ok(ch2[seamIdx].e === ch2[seamIdx + 1].s, '两块边界仍重合');

    // 撤销
    console.log('\n=== 6. Ctrl+Z 撤销 ===');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const ch3 = await readRow(CHORD);
    ok(ch3[seamIdx].e - ch3[seamIdx].s === L.e - L.s, '接缝拖动已撤销');
  }

  // ---------------------------------------------------------------- 7. 右键菜单
  console.log('\n=== 7. 右键菜单 ===');
  await page.mouse.click(cl + 20, cy, { button: 'right' });
  await page.waitForTimeout(300);
  ok(await page.locator('.ctx-menu').isVisible(), '菜单弹出');
  const items = await page.locator('.ctx-item').allTextContents();
  ok(
    items.some((t) => t.includes('编辑和弦名')),
    '有「编辑和弦名」',
  );
  ok(
    items.some((t) => t.includes('重新分析')),
    '有「档位重新分析」',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 8. 播放
  console.log('\n=== 8. 播放 ===');
  const tickOf = () =>
    page.evaluate(() => {
      const t = document.querySelector('.dev-badge')?.textContent ?? '';
      const m = t.match(/tick (\d+)/);
      return m ? Number(m[1]) : -1;
    });
  const t0 = await tickOf();
  await page.locator('.play-btn').click();
  await page.waitForTimeout(1000);
  await page.locator('.play-btn').click();
  await page.waitForTimeout(200);
  const t1 = await tickOf();
  console.log(`  tick ${t0} → ${t1}`);
  ok(t1 > t0, '播放头前进');

  console.log('\n=== 9. 空格播放 ===');
  const t2 = await tickOf();
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  ok((await tickOf()) > t2, '空格控制播放');

  // ---------------------------------------------------------------- 9.5 标尺定位
  console.log('\n=== 9.5 点击标尺定位 ===');
  const tickOfRuler = () =>
    page.evaluate(() => {
      const t = document.querySelector('.dev-badge')?.textContent ?? '';
      const m = t.match(/tick (\d+)/);
      return m ? Number(m[1]) : -1;
    });

  const rulerBox = await page.locator('.ruler').boundingBox();
  const scrollTick = await page.evaluate(() =>
    Number(document.querySelector('.grid-canvas')!.getAttribute('data-scroll')),
  );
  const ptPerTick = await ppt();

  const tickAt = (frac: number) => {
    const x = rulerBox!.width * frac;
    return Math.round(x / ptPerTick + scrollTick);
  };

  for (const frac of [0.2, 0.5, 0.7]) {
    await page.mouse.click(rulerBox!.x + rulerBox!.width * frac, rulerBox!.y + 12);
    await page.waitForTimeout(200);
    const got = await tickOfRuler();
    const want = tickAt(frac);
    console.log(`  点 ${(frac * 100).toFixed(0)}% → tick ${got}（期望 ≈${want}）`);
    ok(Math.abs(got - want) < 1500, `标尺 ${(frac * 100).toFixed(0)}% 定位准确`);
  }

  // 拖拽 scrub
  const startX = rulerBox!.x + rulerBox!.width * 0.1;
  await page.mouse.move(startX, rulerBox!.y + 12);
  await page.mouse.down();
  await page.mouse.move(rulerBox!.x + rulerBox!.width * 0.4, rulerBox!.y + 12, { steps: 6 });
  const midTick = await tickOfRuler();
  await page.mouse.move(rulerBox!.x + rulerBox!.width * 0.6, rulerBox!.y + 12, { steps: 6 });
  await page.mouse.up();
  const endTick = await tickOfRuler();
  console.log(`  拖拽 scrub: ${midTick} → ${endTick}`);
  ok(endTick > midTick, '拖拽标尺可连续定位');

  // ---------------------------------------------------------------- 9.8 自动滚动开关
  console.log('\n=== 9.8 自动滚动开关 ===');

  const followState = () =>
    page.evaluate(() => {
      const c = document.querySelector('.grid-canvas') as HTMLCanvasElement;
      const t = document.querySelector('.dev-badge')?.textContent ?? '';
      const m = t.match(/tick (\d+)/);
      const tick = m ? Number(m[1]) : 0;
      const ppt = Number(c.getAttribute('data-ppt'));
      const scroll = Number(c.getAttribute('data-scroll'));
      const width = Number(c.getAttribute('data-width'));
      const x = (tick - scroll) * ppt;
      return { tick, scroll, width, x, inView: x >= 0 && x <= width };
    });

  const followBtn = page.locator('.follow-btn');
  ok(await followBtn.isVisible(), '工具栏有自动滚动开关');

  // 缩小到视口只显示约 1 小节，这样几秒播放就会越过右边缘
  const cbox = await page.locator('.content').boundingBox();
  await page.mouse.move(cbox!.x + 400, cbox!.y + 200);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await page.waitForTimeout(80);
  }
  const hs = await page.locator('.h-scroll').boundingBox();
  await page.mouse.click(hs!.x + 3, hs!.y + hs!.height / 2);
  await page.waitForTimeout(300);

  // --- 开启 ---
  const onNow = await followBtn.evaluate((e) => e.classList.contains('on'));
  if (!onNow) {
    await followBtn.click();
    await page.waitForTimeout(150);
  }
  const before = await followState();
  await page.locator('.play-btn').click();
  await page.waitForTimeout(11000);
  await page.locator('.play-btn').click();
  await page.waitForTimeout(200);
  const after = await followState();
  console.log(`  开启: scroll ${before.scroll.toFixed(0)} → ${after.scroll.toFixed(0)}, 播放头 x=${after.x.toFixed(0)}`);
  ok(Math.abs(after.scroll - before.scroll) > 500, '开启时播放会滚动');
  ok(after.inView, '开启时播放头保持在视口内');

  // --- 关闭 ---
  await followBtn.click();
  await page.waitForTimeout(150);
  const hs2 = await page.locator('.h-scroll').boundingBox();
  await page.mouse.click(hs2!.x + 3, hs2!.y + hs2!.height / 2);
  await page.waitForTimeout(200);
  const waveBox = await page.locator('.wave').boundingBox();
  await page.mouse.click(waveBox!.x + 5, waveBox!.y + 15);
  await page.waitForTimeout(200);

  const b2 = await followState();
  await page.locator('.play-btn').click();
  await page.waitForTimeout(11000);
  await page.locator('.play-btn').click();
  await page.waitForTimeout(200);
  const a2 = await followState();
  console.log(`  关闭: scroll ${b2.scroll.toFixed(0)} → ${a2.scroll.toFixed(0)}, 播放头 x=${a2.x.toFixed(0)}`);
  ok(Math.abs(a2.scroll - b2.scroll) < 100, '关闭时播放不滚动');

  // 恢复开关（默认开）
  await followBtn.click();
  await page.waitForTimeout(150);

  // ---------------------------------------------------------------- 10. 布局
  console.log('\n=== 10. 布局可调 ===');
  const w0 = await page.evaluate(() => document.querySelector('.sidebar')!.getBoundingClientRect().width);
  const h0 = await page.locator('.resize-handle').first().boundingBox();
  await page.mouse.move(h0!.x + 2, 400);
  await page.mouse.down();
  await page.mouse.move(h0!.x + 2 - 60, 400, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const w1 = await page.evaluate(() => document.querySelector('.sidebar')!.getBoundingClientRect().width);
  console.log(`  左栏 ${Math.round(w0)} → ${Math.round(w1)}px`);
  ok(w1 < w0 - 30, '侧栏可拖拽调宽');

  // ---------------------------------------------------------------- 结果
  if (errs.length) {
    console.log('\n运行时错误:');
    errs.slice(0, 5).forEach((e) => console.log('  ✗', e));
  } else {
    console.log('\n✓ 无运行时错误');
  }

  console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}  (${pass}/${pass + fail})`);
  if (failures.length) {
    console.log('\n失败项:');
    failures.forEach((f) => console.log('  -', f));
  }

  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
