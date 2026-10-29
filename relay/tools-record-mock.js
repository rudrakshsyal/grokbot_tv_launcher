// node relay/tools-record-mock.js "question"  -> runs a real request (needs TMDB/OMDb keys) and saves mock-session.json
const fs = require('fs'), path = require('path');
process.env.LOG = '0';
const S = require('./server'), http = require('http');
const q = process.argv[2] || 'Something funny under 2 hours on Netflix tonight';
S.server.listen(0, () => {
  const port = S.server.address().port, evs = [];
  http.get('http://127.0.0.1:' + port + '/events', res => {
    let buf = ''; res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2);
      const m = /^data: (.*)$/m.exec(blk); if (m) { const ev = JSON.parse(m[1]); evs.push(ev);
        if (ev.type === 'answer' || ev.type === 'error') {
          let prev = evs[0].ts;
          const out = { query: q, recordedAt: new Date().toISOString(), events: evs.filter(e => e.type !== 'start').map(e => { const c = Object.assign({}, e); c.dt = e.ts - prev; prev = e.ts; delete c.ts; delete c.session; return c; }) };
          // a little pacing so the replay reads like speech (listening + interim words before the real steps)
          const words = q.split(' '), pre = [{ type: 'listening', dt: 300 }].concat(words.map((w, i) => ({ type: 'transcript', text: words.slice(0, i + 1).join(' '), final: false, dt: 180 })));
          out.events = pre.concat(out.events);
          fs.writeFileSync(path.join(__dirname, 'mock-session.json'), JSON.stringify(out, null, 1));
          console.log(JSON.stringify(ev, null, 1).slice(0, 1500)); process.exit(0);
        } } } });
    setTimeout(() => { const r = http.request({ port, path: '/ask', method: 'POST', headers: { 'Content-Type': 'application/json' } }); r.end(JSON.stringify({ text: q, sttMs: 2400 })); }, 100);
  });
});
