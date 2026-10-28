// v2 previews: ambient, dock revealed, Discover Movies, Discover Shows.
// usage: node tools/preview-v2.js [root dir (default: repo; pass dist for live data)] [out prefix]
const path = require('path');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const pre = process.argv[3] || path.join(__dirname, '..', 'preview-v2-');
(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR/.test(m.text())) errors.push(m.text()); });
  const key = async (k, wait) => { await page.keyboard.press(k); await page.waitForTimeout(wait || 450); };
  const shot = async (n) => { const f = pre + n + '.png'; await page.screenshot({ path: f }); console.log('saved', f); };
  await page.goto('file://' + path.join(root, 'index.html') + '?blur=full&still=1&tab=movie');
  await page.waitForFunction(() => document.body.classList.contains('wp-ready'), null, { timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#wx.on'), null, { timeout: 12000 }).catch(() => console.log('weather: none'));
  await page.waitForTimeout(3500);
  await shot('ambient');
  await key('ArrowDown', 700); await shot('dock');
  await page.waitForTimeout(9000);   // live data / auto-hide
  await key('ArrowUp'); await key('ArrowUp', 900);
  console.log('tab', await page.evaluate(() => RH_debug.tab), 'focus', JSON.stringify(await page.evaluate(() => RH_debug.focus)));
  await page.waitForTimeout(1500); await shot('discover-movies');
  await key('ArrowUp'); await key('ArrowRight', 2500); await key('ArrowDown', 1400);   // Up lands on the Movies tab; Right = Shows
  console.log('tab', await page.evaluate(() => RH_debug.tab));
  await shot('discover-shows');
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
  await browser.close();
})();
