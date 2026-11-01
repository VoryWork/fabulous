/**
 * 截图工具：用无头浏览器抓编辑器首页。
 *
 * 用途：
 *   1. 自查视觉效果（不用每次都开窗口）
 *   2. 检查控制台错误
 *   3. 验证 Canvas 与 DOM 片段的对齐（PRD A09）
 *
 * 用法：
 *   bun run dev            # 先起 vite
 *   bun scripts/shot.ts    # 另开一个终端
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const PAGE_URL = process.env.SHOT_URL ?? 'http://localhost:1420/';
// 注意：不能把变量命名为 URL，会遮蔽全局 URL 构造器
const OUT_DIR = new globalThis.URL('../shots/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 940 },
    deviceScaleFactor: 1,
  });

  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  // 等 Canvas 首帧
  await page.waitForTimeout(900);

  await page.screenshot({ path: `${OUT_DIR}home.png` });

  // 检查关键元素是否渲染
  const report = await page.evaluate(() => {
    const q = (s: string) => document.querySelectorAll(s).length;
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({
      w: c.width,
      h: c.height,
      clientW: c.clientWidth,
      clientH: c.clientHeight,
    }));
    // 找出所有片段的 left/width，用于检查是否越界
    const clips = Array.from(document.querySelectorAll('.clip')).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width) };
    });
    return {
      counts: {
        '.toolbar': q('.toolbar'),
        '.sidebar': q('.sidebar'),
        '.inspector': q('.inspector'),
        '.player': q('.player'),
        '.track-row': q('.track-row'),
        '.clip': clips.length,
        '.beat-mark': q('.beat-mark'),
      },
      canvases,
      clipSample: clips.slice(0, 8),
      docHeight: document.documentElement.scrollHeight,
      winHeight: window.innerHeight,
    };
  });

  console.log('=== 元素统计 ===');
  console.log(JSON.stringify(report.counts, null, 2));
  console.log('\n=== Canvas ===');
  console.log(JSON.stringify(report.canvases, null, 2));
  console.log('\n=== 片段样本 (left/width) ===');
  console.log(JSON.stringify(report.clipSample));
  console.log(`\n=== 高度: doc ${report.docHeight} / win ${report.winHeight} ===`);

  if (errors.length) {
    console.log('\n=== 控制台错误 ===');
    errors.forEach((e) => console.log('  ✗', e));
  } else {
    console.log('\n✓ 无控制台错误');
  }

  await browser.close();
  console.log(`\n截图: ${OUT_DIR}home.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
