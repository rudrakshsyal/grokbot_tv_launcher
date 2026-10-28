// v3 previews: Discover platform carousel. usage: node tools/preview-v3.js [root (pass dist for live data)] [out prefix]
// Writes <prefix>netflix.png, <prefix>hbo.png and <prefix>transition.png (mid-slide frame).
const path = require('path');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require('/workspace/pwtool/node_modules/playwright-core'); }
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const pre = process.argv[3] || path.join(__dirname, '..', 'preview-v3-');
(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR/.test(m.text())) errors.push(m.text()); });
  const key = async (k, wait) => { await page.keyboard.press(k); await page.waitForTimeout(wait || 450); };
  const shot = async (n) => { const f = pre + n + '.png'; await page.screenshot({ path: f }); console.log('saved', f); };
  const info = () => page.evaluate(() => ({ plat: RH_debug.platform, tab: RH_debug.tab, mode: RH_debug.picks().mode,
    picks: RH_debug.picks().picks.map(p => p.item.title + ' [IMDb ' + p.item.rating + (p.item.rt != null ? ', RT ' + p.item.rt + '%' : '') + ']') }));
  await page.goto('file://' + path.join(root, 'index.html') + '?still=1&tab=movie&plat=netflix');
  await page.waitForFunction(() => document.body.classList.contains('wp-ready'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => RH_debug.picks().picks.length === 3, null, { timeout: 45000 }).catch(() => console.log('netflix: picks not ready'));
  await page.waitForTimeout(1500);
  for (let n = 0; n < 6 && !(await page.$('#plat.is-focused')); n++) await key('ArrowUp', 450);   // dock reveal -> picks -> tabs -> platform header
  await page.waitForTimeout(800);
  console.log(JSON.stringify(await info())); await shot('netflix');
  await key('ArrowDown', 300); await key('ArrowDown', 900);                          // back onto the cards
  await page.waitForFunction(() => { const k = RH_debug.platforms()[1]; return !!localStorage.getItem('rh.dsc.plat.' + k); }, null, { timeout: 45000 }).catch(() => {});
  await page.keyboard.press('PageDown'); await page.waitForTimeout(130); await shot('transition');
  await page.waitForTimeout(1500);
  await key('ArrowUp', 400); await key('ArrowRight', 2500); await key('ArrowDown', 900);   // HBO Max: Movies tab -> Shows
  await page.waitForFunction(() => RH_debug.picks().picks.length === 3, null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(800);
  console.log(JSON.stringify(await info())); await shot('hbo');
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
  await browser.close();
})();
