'use strict';
// Dock apps for the phone remote, read from the TV app's own js/config.js (dock.main + dock.extra) and js/apps.js
// (name, colour, storeIds[0] = the numeric Samsung app id that the TV's REST API (:8001) launches; tizenIds[0] only
// when an app has no store id). The deployed relay has no ../js, so
// `node dock-apps.js --write` saves a snapshot to dock-apps.json that is used when ../js isn't there.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SNAP = path.join(__dirname, 'dock-apps.json');
const LAUNCHER = { key: 'launcher', name: 'Home', appId: 'GlassHome1.launcher', color: '#8fa2ff' };

function fromTvApp(dir) {
  dir = dir || path.join(__dirname, '..', 'js');
  const win = {}, ctx = vm.createContext({ window: win, location: { search: '' }, navigator: { userAgent: '' } });
  ['config.js', 'apps.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f, timeout: 1000 }));
  const C = win.RH_CONFIG || {}, A = win.RH_APPS || {}, dock = C.dock || {}, over = C.appIdOverrides || {};
  const list = [].concat(dock.main || [], dock.extra || []).filter((k, i, a) => A[k] && a.indexOf(k) === i);
  return { source: 'js/config.js dock + js/apps.js', launcher: LAUNCHER,
    apps: list.map(k => ({ key: k, name: A[k].name, color: A[k].color, appId: (A[k].storeIds || [])[0] || ((over[k] || [])[0]) || A[k].tizenIds[0], main: (dock.main || []).indexOf(k) >= 0 })) };
}
function load() {
  try { return fromTvApp(); } catch (e) {}
  try { return Object.assign(JSON.parse(fs.readFileSync(SNAP, 'utf8')), { source: 'dock-apps.json (snapshot)' }); } catch (e) {}
  return { source: 'none', launcher: LAUNCHER, apps: [] };
}
if (require.main === module && process.argv[2] === '--write') {
  const d = fromTvApp(); fs.writeFileSync(SNAP, JSON.stringify(d, null, 2) + '\n'); console.log('wrote', SNAP, d.apps.map(a => a.key).join(', '));
}
module.exports = { load, fromTvApp, LAUNCHER };
