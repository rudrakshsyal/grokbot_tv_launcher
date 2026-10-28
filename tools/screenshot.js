// Render the launcher at 1920x1080 with headless Chrome via playwright-core.
// usage: node tools/screenshot.js [out.png] [query]   (query e.g. "focus=2,0&wp=bled")
const path = require('path');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
(async () => {
  const out = process.argv[2] || path.join(__dirname, '..', 'preview.png');
  const q = process.argv[3] || '';
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--force-color-profile=srgb', '--enable-gpu-rasterization'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const url = 'file://' + path.resolve(__dirname, '..', 'index.html') + '?blur=full&still=1' + (q ? '&' + q : '');
  await page.goto(url);
  await page.waitForFunction(() => document.body.classList.contains('wp-ready'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(3800);   // crossfade + caption fade-in
  await page.screenshot({ path: out });
  console.log('saved', out, errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no errors');
  await browser.close();
})();
