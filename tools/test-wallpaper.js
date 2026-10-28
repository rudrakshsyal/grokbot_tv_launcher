// Wallpaper rotation + baked-glass sync: photo and its pre-blurred copy crossfade together (600 ms); 'n' skips; broken images fall back.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); } })();
const base = 'file://' + require('path').resolve(__dirname, '..', 'index.html');
(async () => { const b = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome' }); let fails = 0;
  const check = (l, ok, x) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + l + (ok ? '' : '  ' + JSON.stringify(x))); };
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } }); const e = []; p.on('pageerror', x => e.push(String(x)));
  p.on('console', m => { if (m.type() === 'error') e.push(m.text()); });
  await p.goto(base + '?wpint=3');
  const snap = () => p.evaluate(() => { const on = document.querySelector('.wp.on'), g = document.querySelector('#dockBg .bk i.on') || document.querySelector('.bk i.on');
    return { cur: RH_Wallpaper.current && RH_Wallpaper.current.id, photo: on && on.getAttribute('src').split('/').pop(), glass: g && (g.style.backgroundImage.match(/blur\/([^."]+)/) || [])[1],
      fade: getComputedStyle(on).transitionDuration }; });
  await p.waitForTimeout(1500); const a = await snap();
  check('first wallpaper + matching baked glass', a.cur && a.glass === a.cur, a);
  check('crossfade is 600 ms', /0\.6s/.test(a.fade), a.fade);
  await p.waitForTimeout(4200); const c = await snap();
  check('rotates and glass follows', c.cur !== a.cur && c.glass === c.cur, c);
  await p.keyboard.press('n'); await p.waitForTimeout(900); const d = await snap();
  check("'n' skips to the next wallpaper", d.cur !== c.cur && d.glass === d.cur, d);
  const p2 = await b.newPage(); await p2.addInitScript(() => { Object.defineProperty(window, 'RH_WALLPAPERS', { configurable: true, set(v) {}, get() { return [{ id: 'x', src: 'images/nope1.jpg' }, { id: 'y', src: 'images/nope2.jpg' }]; } }); });
  await p2.goto(base); await p2.waitForTimeout(1500);
  check('broken images -> gradient fallback, no has-wp', await p2.evaluate(() => !document.body.classList.contains('has-wp')));
  check('no page errors', e.length === 0, e);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); await b.close(); process.exit(fails ? 1 : 0); })();
