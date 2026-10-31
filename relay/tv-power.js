'use strict';
// Watches the TV's power state through its local REST API and opens the launcher when the TV turns on.
// Samsung opens its own home screen on power-on and sideloaded Tizen apps can't autostart, so the relay does it:
//   GET  http://TV:8001/api/v2/                          -> { device: { PowerState: 'on' | 'standby', TokenAuthSupport, modelName, ... } }
//   GET  http://TV:8001/api/v2/applications/<appId>      -> { running: true|false, visible, ... }
//   POST http://TV:8001/api/v2/applications/<appId>      -> launches it (no pairing needed); WebSocket ed.apps.launch only if paired.
// "On" = reachable AND PowerState === 'on' (older firmware without PowerState: reachable = on). "Off" = PowerState other than
// 'on' right away, or unreachable for `offConfirm` polls in a row (so one Wi-Fi blip doesn't look like a power cycle).
// Auto-launch happens only on an off -> on transition (and once at relay start if the TV is already on and the launcher
// isn't running) - never while the TV stays on, so switching to Netflix etc. is left alone.
const EventEmitter = require('events');
const normMac = m => { const h = String(m || '').replace(/[^0-9a-f]/gi, ''); return h.length === 12 && !/^0+$/.test(h) ? h.toLowerCase().match(/../g).join(':') : null; };

class TvPower extends EventEmitter {
  constructor(tv, o) {
    super(); o = o || {};
    this.tv = tv;
    this.pollMs = o.pollMs || 5000;
    this.timeout = o.timeout || 1500;
    this.settleMs = o.settleMs == null ? 4000 : o.settleMs;
    this.offConfirm = o.offConfirm || 3;
    this.appId = o.appId || 'GlassHome1.launcher';
    this.autoLaunch = o.autoLaunch !== false;
    this.log = o.log || (() => {});
    this.power = 'unknown';          // unknown | on | off   (confirmed state)
    this.misses = 0; this.info = null; this.timer = null; this.busy = false; this.startupDone = false; this.launches = 0;
    this.lastLaunch = null; this.launchT = null; this.stopped = true; this.halted = false;
    this.burstUntil = 0; this.burstMs = o.burstMs || 1000; this.noLaunchUntil = 0;
  }
  // after a Wake-on-LAN: poll every second for a while so the TV is seen (and the launcher opened) quickly
  burst(ms) { this.burstUntil = Date.now() + (ms || 45000); if (!this.stopped) { clearTimeout(this.timer); if (!this.busy) this.tick(); } }
  // a play request woke the TV: don't open the launcher over the video
  suppressLaunch(ms) { this.noLaunchUntil = Date.now() + (ms || 60000); }
  // resolves true once the TV is seen on (or false after ms)
  waitOn(ms) {
    if (this.power === 'on') return Promise.resolve(true);
    return new Promise(res => {
      const on = p => { if (p === 'on') { clearTimeout(t); this.removeListener('power', on); res(true); } };
      const t = setTimeout(() => { this.removeListener('power', on); res(false); }, ms || 30000);
      this.on('power', on);
    });
  }
  start() { if (!this.stopped) return; this.stopped = false; this.halted = false; this.tick(); }
  stop() { this.stopped = true; this.halted = true; clearTimeout(this.timer); clearTimeout(this.launchT); }
  status() { return { power: this.power, model: this.info && this.info.model, autoLaunch: this.autoLaunch, lastLaunch: this.lastLaunch, waking: Date.now() < this.burstUntil }; }
  async probe() {
    try {
      const j = await this.tv.restGet('/api/v2/', this.timeout), d = (j && j.device) || {};
      this.info = { model: d.modelName || d.ModelName || null, tokenAuth: d.TokenAuthSupport == null ? null : String(d.TokenAuthSupport) === 'true', powerState: d.PowerState || null, wifiMac: d.wifiMac || null };
      if (this.info.tokenAuth != null) this.tv.tokenAuth = this.info.tokenAuth;
      // v6: learn the TV's Wi-Fi MAC (for Wake-on-LAN) when TV_MAC isn't set
      const mac = normMac(d.wifiMac);
      if (mac && !this.tv.mac) { this.tv.mac = mac; this.emit('mac', mac, this.info.model); this.log('learned TV Wi-Fi MAC for Wake-on-LAN'); }
      return d.PowerState == null ? 'on' : (String(d.PowerState).toLowerCase() === 'on' ? 'on' : 'off');
    } catch (e) { return null; }                 // unreachable: quiet
  }
  async tick() {
    if (this.stopped) return;
    if (!this.busy) {
      this.busy = true;
      try { await this.observe(await this.probe()); } catch (e) {}
      this.busy = false;
    }
    if (!this.stopped) { this.timer = setTimeout(() => this.tick(), Date.now() < this.burstUntil ? this.burstMs : this.pollMs); if (this.timer.unref) this.timer.unref(); }
  }
  async observe(seen) {                         // seen: 'on' | 'off' (explicit standby) | null (unreachable)
    let next = this.power;
    if (seen === 'on') { next = 'on'; this.misses = 0; }
    else if (seen === 'off') { next = 'off'; this.misses = 0; }
    else if (++this.misses >= this.offConfirm || this.power === 'unknown' && this.misses >= 1) next = 'off';
    const prev = this.power;
    if (next === prev) return;
    this.power = next;
    this.tv.setPower(next === 'on');
    this.emit('power', next, prev);
    this.log('tv power ' + next + (this.info && this.info.model ? ' (' + this.info.model + ')' : ''));
    if (next !== 'on') { clearTimeout(this.launchT); return; }
    this.burstUntil = 0;
    const startup = prev === 'unknown';
    if (startup && this.startupDone) return;
    this.startupDone = true;
    if (!this.autoLaunch) return;
    clearTimeout(this.launchT);
    this.launchT = setTimeout(() => this.maybeLaunch(startup ? 'relay start' : 'power on'), startup ? 0 : this.settleMs);
  }
  async maybeLaunch(why) {
    if (this.halted || this.power !== 'on') return;
    if (Date.now() < this.noLaunchUntil) { this.lastLaunch = { at: Date.now(), why, skipped: 'play request' }; this.emit('skip', why); return; }
    let st = null;
    try { st = await this.tv.appStatus(this.appId); } catch (e) {}
    if (st && (st.running === true || String(st.running) === 'true')) { this.lastLaunch = { at: Date.now(), why, skipped: 'already running' }; this.emit('skip', why); return; }
    try {
      const r = await this.tv.launch(this.appId, { noPair: true });
      this.launches++; this.lastLaunch = { at: Date.now(), why, via: r.via };
      this.log('opened ' + this.appId + ' (' + why + ', ' + r.via + ')'); this.emit('launch', r, why);
    } catch (e) {
      this.lastLaunch = { at: Date.now(), why, error: e.code || e.message };
      this.log('could not open ' + this.appId + ' (' + why + '): ' + (e.message || e.code)); this.emit('launch-failed', e, why);
    }
  }
}
module.exports = { TvPower };
