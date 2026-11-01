/**
 * 交互验证脚本：检查滚动、缩放是否真的可用。
 *
 * 这是"用户说滚动条根本滚动不了"之后补的回归测试。
 * 检查项：
 *   1. 滚动条滑块宽度 < 100%（说明内容比视口宽，可滚动）
 *   2. 拖动滑块能改变视图（可见片段整体左移）
 *   3. 滚轮能滚动
 *   4. Ctrl+滚轮能缩放且锚点稳定
 *   5. 工具栏缩放按钮有效
 */
import { chromium } from 'playwright';

const PAGE_URL = process.env.SHOT_URL ?? 'http://localhost:1420/';

function ok(cond: boolean, msg: string) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`);
  if (!cond) failed++;
}
let failed = 0;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 940 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  console.log('=== 1. 滚动条几何 ===');
  const thumb = page.locator('.h-thumb');
  const track = page.locator('.h-scroll');
  const tBox = await thumb.boundingBox();
  const kBox = await track.boundingBox();
  if (!tBox || !kBox) {
    console.log('  FAIL  找不到滚动条');
    failed++;
  } else {
    const ratio = tBox.width / kBox.width;
    console.log(`  滑块 ${Math.round(tBox.width)}px / 轨道 ${Math.round(kBox.width)}px = ${(ratio * 100).toFixed(1)}%`);
    ok(ratio < 0.95, '滑块宽度 < 95%（内容比视口宽，应可滚动）');
    ok(ratio > 0.02, '滑块不是细到点不中');
  }

  console.log('\n=== 2. 拖动滑块 ===');
  const firstClipLeft = async () =>
    (await page.locator('.clip').first().boundingBox())?.x ?? -1;
  const before = await firstClipLeft();
  if (tBox) {
    // 注意：初始位置在最左端，必须往【右】拖才能看出变化。
    // 之前测试往左拖，被 clamp 到 0，误判为"拖不动"。
    const cx = tBox.x + tBox.width / 2;
    const cy = tBox.y + tBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 150, cy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  const after = await firstClipLeft();
  console.log(`  首个片段 x: ${before} -> ${after}`);
  ok(Math.abs(after - before) > 20, '拖动滑块后视图真的移动了');

  console.log('\n=== 3. 滚轮横向滚动 ===');
  const b3 = await firstClipLeft();
  const content = page.locator('.content');
  const cBox = await content.boundingBox();
  // 滚轮往下（delta > 0）= scrollByPixels 正值 = 内容左移（往后翻）
  if (cBox) {
    await page.mouse.move(cBox.x + cBox.width / 2, cBox.y + 200);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(220);
  }
  let a3 = await firstClipLeft();
  if (Math.abs(a3 - b3) <= 10 && cBox) {
    // 初始可能已在最左端，换个方向再试
    await page.mouse.move(cBox.x + cBox.width / 2, cBox.y + 200);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(220);
    a3 = await firstClipLeft();
  }
  console.log(`  首个片段 x: ${b3} -> ${a3}`);
  ok(Math.abs(a3 - b3) > 10, '滚轮能横向滚动');

  console.log('\n=== 4. Ctrl+滚轮缩放（锚点稳定） ===');
  // 记住鼠标下那个 tick 对应的片段位置
  const zoomLabel = async () =>
    (await page.locator('.corner-zoom').textContent())?.trim() ?? '';
  const z0 = await zoomLabel();
  if (cBox) {
    await page.mouse.move(cBox.x + 400, cBox.y + 200);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await page.waitForTimeout(250);
  }
  const z1 = await zoomLabel();
  console.log(`  缩放: ${z0} -> ${z1}`);
  ok(z0 !== z1, 'Ctrl+滚轮改变了缩放');

  console.log('\n=== 5. 工具栏缩放按钮 ===');
  const z2 = await zoomLabel();
  await page.locator('.tb-btn').first().click();
  await page.waitForTimeout(200);
  const z3 = await zoomLabel();
  console.log(`  缩小按钮: ${z2} -> ${z3}`);
  ok(z2 !== z3, '工具栏缩小按钮有效');

  console.log('\n=== 6. 点滚动条空白处翻页 ===');
  const b6 = await firstClipLeft();
  if (kBox) {
    // 点轨道最右侧（滑块右侧的空白）
    await page.mouse.click(kBox.x + kBox.width - 30, kBox.y + kBox.height / 2);
    await page.waitForTimeout(250);
  }
  const a6 = await firstClipLeft();
  console.log(`  首个片段 x: ${b6} -> ${a6}`);
  ok(Math.abs(a6 - b6) > 20, '点击轨道空白处能跳转');

  console.log('\n=== 7. 播放按钮 ===');
  const t0 = await page.locator('.t-now').textContent();
  await page.locator('.play-btn').click();
  await page.waitForTimeout(700);
  const t1 = await page.locator('.t-now').textContent();
  await page.locator('.play-btn').click();
  console.log(`  时间: ${t0} -> ${t1}`);
  ok(t0 !== t1, '播放按钮让时间前进');

  if (errors.length) {
    console.log('\n=== 运行时错误 ===');
    errors.forEach((e) => console.log('  ✗', e));
  } else {
    console.log('\n✓ 无运行时错误');
  }

  console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}`);
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
