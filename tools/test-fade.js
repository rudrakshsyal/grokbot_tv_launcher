// Crossfade integrity, sampled every frame in the page: during each wallpaper change there must always be a fully
// opaque layer under the fading one, for the photo AND for every baked-glass panel (no dip to black / no flash).
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); } })();
const base = 'file://' + require('path').resolve(__dirname, '..', 'index.html');
(async () => { const b = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(base + '?wpint=3'); await p.waitForTimeout(2000);
  const r = await p.evaluate(() => new Promise(res => {
    let frames = 0, bad = [], fades = 0, wasFading = false; const t0 = performance.now();
    function cover(layers) {        // max opacity among visible (src/background set) layers
      let m = 0; layers.forEach(l => { const o = +getComputedStyle(l).opacity; if (o > m) m = o; }); return m; }
    function f(t) {
      frames++;
      const wp = [].filter.call(document.querySelectorAll('.wp'), x => x.getAttribute('src'));
      const fading = wp.some(x => { const o = +getComputedStyle(x).opacity; return o > 0.01 && o < 0.99; });
      if (fading && !wasFading) fades++; wasFading = fading;
      if (cover(wp) < 0.99) bad.push(['photo', Math.round(t - t0)]);
      document.querySelectorAll('.has-wp .bk').forEach(bk => { if (getComputedStyle(bk).display !== 'none' && cover([].slice.call(bk.querySelectorAll('i'))) < 0.99) bad.push(['glass', Math.round(t - t0)]); });
      if (t - t0 < 8000) requestAnimationFrame(f); else res({ frames, fades, bad: bad.slice(0, 5), nbad: bad.length });
    } requestAnimationFrame(f); }));
  await b.close();
  console.log('frames', r.frames, '| crossfades seen', r.fades, '| frames without an opaque base layer', r.nbad, r.bad);
  const ok = r.fades >= 2 && r.nbad === 0; console.log(ok ? 'ALL PASSED' : 'FAILED'); process.exit(ok ? 0 : 1); })();
