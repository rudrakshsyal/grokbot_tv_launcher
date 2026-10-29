// v5: day/night classes, inputs row (hidden without data, labelled mock nav), picks screensaver rules and keys.
// Offline: the screensaver is fed real-shaped picks whose TMDB image requests are answered with a local photo.
const path = require('path'), fs = require('fs');
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); } })();
const base = 'file://' + path.resolve(__dirname, '..', 'index.html');
const photoDir = path.resolve(__dirname, '..', 'images', 'wallpapers');
const photo = path.join(photoDir, fs.readdirSync(photoDir).filter(f => /\.jpe?g$/i.test(f))[0]);
(async () => {
  const b = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' }); let fails = 0;
  const check = (l, ok, x) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + l + (ok ? '' : '  ' + JSON.stringify(x))); };
  const errs = [];
  const open = async (q) => {
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    p.on('pageerror', x => errs.push(String(x)));
    await p.route('https://api.open-meteo.com/**', r => r.abort());
    await p.route('https://image.tmdb.org/**', r => r.fulfill({ path: photo, contentType: 'image/jpeg' }));
    await p.goto(base + q); await p.waitForTimeout(1200); return p;
  };
  // day / night
  let p = await open('?tod=night&still=1&discover=0');
  check('?tod=night -> body.night + tint layer visible', await p.evaluate(() => document.body.classList.contains('night') && getComputedStyle(document.querySelector('.tod-night')).opacity === '1'));
  check('night picks a night-tagged (or untagged) photo', await p.evaluate(() => { const c = RH_Wallpaper.current; return !!c && RH_Wallpaper.fits(c.id, 'night'); }));
  await p.close();
  p = await open('?tod=day&still=1&discover=0');
  check('?tod=day -> body.day, tint hidden', await p.evaluate(() => document.body.classList.contains('day') && getComputedStyle(document.querySelector('.tod-night')).opacity === '0'));
  check('no inputs row in the desktop preview without ?inputs=mock', await p.evaluate(() => RH_debug.inputs().length === 0 && !document.body.classList.contains('has-inputs')));
  await p.close();
  // inputs (labelled mock)
  p = await open('?tod=day&still=1&discover=0&inputs=mock');
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(300); await p.keyboard.press('ArrowDown'); await p.waitForTimeout(300);
  const ir = await p.evaluate(() => ({ row: RH_debug.rows[RH_debug.focus.r].kind, mock: !!document.querySelector('.in-mock'), n: RH_debug.inputs().length }));
  check('Down from the dock lands on the inputs row (mock is labelled)', ir.row === 'inputs' && ir.mock && ir.n === 3, ir);
  await p.keyboard.press('Enter'); await p.waitForTimeout(200);
  check('mock input says it is a mock', await p.evaluate(() => /mock/i.test(document.getElementById('toast').textContent)));
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(200);
  check('Up returns to the apps', await p.evaluate(() => RH_debug.rows[RH_debug.focus.r].kind === 'apps'));
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(200); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  check('Back on the inputs row hides the dock, focus back on apps', await p.evaluate(() => !RH_debug.dockOn && RH_debug.rows[RH_debug.focus.r].kind === 'apps'));
  await p.close();
  // screensaver
  p = await open('?still=1&discover=0&idlescale=0.3');
  const feed = (mode) => p.evaluate((mode) => { const s = RH_debug.picks(); s.mode = mode; s.picks = [0, 1].map(i => ({ item: { id: 't' + i, title: 'Title ' + i, app: 'netflix', backdrop: 'https://image.tmdb.org/t/p/w780/x' + i + '.jpg', rating: 7.5, ratingSource: 'IMDb', rt: 91 }, acts: [['open', 'Open in Netflix']] })); }, mode);
  await feed('mock'); await p.waitForTimeout(2200);
  check('mock picks never start the screensaver', await p.evaluate(() => !RH_debug.saverOn));
  await feed('live');
  await p.waitForFunction(() => RH_debug.saverOn, null, { timeout: 4000 }).catch(() => {});
  const sv = await p.evaluate(() => ({ on: RH_debug.saverOn, src: (document.querySelector('.sv-img.on') || {}).src, badges: document.querySelectorAll('#svBadges .rate').length }));
  check('starts after N idle minutes on the ambient home, original-size art, IMDb + RT badges', sv.on && /\/t\/p\/original\//.test(sv.src) && sv.badges === 2, sv);
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(300);
  check('any other key only closes it (no dock reveal, no Discover)', await p.evaluate(() => !RH_debug.saverOn && !RH_debug.dockOn && !RH_debug.discoverOn));
  await p.evaluate(() => RH_debug.saver(true)); await p.waitForFunction(() => RH_debug.saverOn, null, { timeout: 4000 }).catch(() => {});
  await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  check('OK opens the title in its app', await p.evaluate(() => !RH_debug.saverOn && /Netflix/i.test(document.getElementById('toast').textContent)), await p.evaluate(() => document.getElementById('toast').textContent));
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(200);                                  // dock open: the saver must wait
  await p.waitForTimeout(2200);
  check('never while the dock is open', await p.evaluate(() => RH_debug.dockOn && !RH_debug.saverOn));
  await p.close();
  check('no page errors', errs.length === 0, errs);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); await b.close(); process.exit(fails ? 1 : 0);
})();
