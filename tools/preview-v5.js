// v5 previews: day / night look, dock with the inputs row (labelled mock ports), picks screensaver.
// usage: node tools/preview-v5.js [root (pass a dist built by make-dist for live picks)] [out prefix]
// The screensaver only runs on real picks with TMDB backdrops, so that frame needs a root with API keys.
const path = require('path');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const pre = process.argv[3] || path.join(__dirname, '..', 'preview-v5-');
(async () => {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  const open = async (q) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto('file://' + path.join(root, 'index.html') + q);
    await page.waitForFunction(() => document.body.classList.contains('wp-ready'), null, { timeout: 10000 }).catch(() => console.log('wp not ready'));
    return page;
  };
  const shot = async (page, n) => { const f = pre + n + '.png'; await page.screenshot({ path: f }); console.log('saved', f); };

  // 1-2) the same home, day and night (forced; on the TV it follows today's sunrise/sunset)
  for (const tod of ['day', 'night']) {
    const p = await open('?still=1&discover=0&tod=' + tod);
    await p.waitForTimeout(2500);
    console.log(tod, JSON.stringify(await p.evaluate(() => ({ body: document.body.className, info: window.RH_DayNight && RH_DayNight.info(), wp: (RH_Wallpaper.current || {}).id }))));
    await shot(p, tod); await p.close();
  }
  // 3) dock revealed with the inputs row: ?inputs=mock shows labelled fake ports (desktop only; the TV lists real ones)
  {
    const p = await open('?still=1&discover=0&tod=day&inputs=mock');
    await p.waitForFunction(() => RH_debug.inputs().length > 0, null, { timeout: 8000 }).catch(() => console.log('no inputs'));
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(500);                       // reveal the dock
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(700);                       // onto the inputs row
    console.log('inputs', JSON.stringify(await p.evaluate(() => ({ row: RH_debug.rows[RH_debug.focus.r].kind, items: RH_debug.inputs().map(d => d.type === 'port' ? d.port.title : d.type) }))));
    await shot(p, 'dock-inputs'); await p.close();
  }
  // 4) screensaver on the current real picks
  {
    const p = await open('?still=1');
    const ok = await p.waitForFunction(() => RH_debug.saverItems() > 0, null, { timeout: 60000 }).then(() => true, () => false);
    if (!ok) console.log('screensaver: no real picks with backdrops here (needs a dist with keys); skipped');
    else {
      await p.evaluate(() => RH_debug.saver(true));
      await p.waitForFunction(() => RH_debug.saverOn, null, { timeout: 20000 }).catch(() => console.log('saver did not start'));
      await p.waitForTimeout(4500);
      console.log('saver', JSON.stringify(await p.evaluate(() => ({ on: RH_debug.saverOn, n: RH_Saver.count, title: RH_Saver.current && RH_Saver.current.title,
        src: document.querySelector('.sv-img.on') && document.querySelector('.sv-img.on').src.replace(/\/[^/]+$/, '/…') }))));
      await shot(p, 'screensaver');
      await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(600);
      console.log('after Left', JSON.stringify(await p.evaluate(() => ({ saver: RH_debug.saverOn, discover: RH_debug.discoverOn, dock: RH_debug.dockOn }))));
    }
    await p.close();
  }
  console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
  await browser.close();
})();
