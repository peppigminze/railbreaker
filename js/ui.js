// UI: HUD (DOM), Popups, Schadenszahlen, Indikatoren, Menüs, Settings.
import * as THREE from 'three';
import { CONFIG, STATE, STATE_NAMES, DEFAULT_SETTINGS } from './config.js';
import { clamp, fmtInt, fmtTime, Store, randomSeedString } from './util.js';

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const ACTION_LABELS = {
  forward: 'Vorwärts', back: 'Rückwärts', left: 'Links', right: 'Rechts', jump: 'Springen / Doppelsprung / Wall-Jump / Rail-Absprung',
  dash: 'Dash', slide: 'Slide', restart: 'Schneller Neustart', skipTutorial: 'Tutorial überspringen',
};

export class UI {
  constructor(game) {
    this.game = game;
    this.cache = {};
    this.dmg = []; this.inds = []; this.dirs = []; this.feed = []; this.pops = [];
    this.hintT = 0; this.hintId = null; this.hintSeen = {}; this.bannerT = 0; this.hitT = 0;
    this.rebinding = null;
  }

  init() {
    const g = this.game;
    this.hud = $('hud');
    const mk = (parent, cls, n) => { const arr = []; for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); arr.push({ el: d, t: 0, life: 0, x: 0, y: 0, z: 0, vy: 0 }); } return arr; };
    this.dmg = mk($('dmgNums'), 'dmg', 26);
    this.inds = mk($('indicators'), 'offind', 8);
    this.dirs = mk($('indicators'), 'dirind', 5);
    this.feed = mk($('feed'), 'feedline', 7);
    this.pops = mk($('popups'), 'pop', 4);
    this.feedHead = 0; this.popHead = 0; this.dmgHead = 0; this.dirHead = 0;

    // --- Menü-Buttons
    const click = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', (e) => { g.audio.unlock(); g.audio.play('ui'); fn(e); }); };
    click('btnPlay', () => g.startRun($('seedInput').value || randomSeedString()));
    click('btnSeedRandom', () => { $('seedInput').value = randomSeedString(); });
    click('btnSettings', () => this.showMenu('settings'));
    click('btnControls', () => this.showMenu('controls'));
    click('btnSettingsBack', () => this.showMenu(this.returnTo || 'main'));
    click('btnControlsBack', () => this.showMenu(this.returnTo || 'main'));
    click('btnResume', () => g.resume());
    click('btnPauseSettings', () => { this.returnTo = 'pause'; this.showMenu('settings'); });
    click('btnPauseControls', () => { this.returnTo = 'pause'; this.showMenu('controls'); });
    click('btnPauseRestart', () => g.startRun(g.seedStr));
    click('btnPauseMenu', () => g.toMenu());
    click('btnRetry', () => g.startRun(g.seedStr));
    click('btnOverMenu', () => g.toMenu());
    click('btnResetBinds', () => { g.settings.binds = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.binds)); g.saveSettings(); g.input.setBinds(g.settings.binds); this.buildControls(); });
    $('seedInput').value = Store.get('lastSeed', '') || randomSeedString();
    $('seedInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('btnPlay').click(); });

    // --- Settings
    const s = g.settings;
    const slider = (id, key, fmt, apply) => {
      const el = $(id), out = $(id + 'Val');
      el.value = s[key]; out.textContent = fmt(s[key]);
      el.addEventListener('input', () => { s[key] = parseFloat(el.value); out.textContent = fmt(s[key]); g.saveSettings(); if (apply) apply(); });
    };
    const pct = (v) => Math.round(v * 100) + '%';
    slider('setSens', 'sens', (v) => v.toFixed(2));
    slider('setFov', 'fov', (v) => Math.round(v) + '°');
    slider('setMaster', 'volMaster', pct, () => g.audio.applyVolumes());
    slider('setMusic', 'volMusic', pct, () => g.audio.applyVolumes());
    slider('setSfx', 'volSfx', pct, () => g.audio.applyVolumes());
    slider('setShake', 'shake', pct);
    const qBtns = document.querySelectorAll('#setQuality button');
    const markQ = () => qBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === s.quality));
    qBtns.forEach((b) => b.addEventListener('click', () => { s.quality = b.dataset.q; g.saveSettings(); g.vfx.setQuality(s.quality); markQ(); g.audio.play('ui'); }));
    markQ();
    const blur = $('setBlur');
    const markB = () => { blur.textContent = s.motionBlur ? 'AN' : 'AUS'; blur.classList.toggle('on', s.motionBlur); };
    blur.addEventListener('click', () => { s.motionBlur = !s.motionBlur; g.saveSettings(); markB(); g.audio.play('ui'); });
    markB();
    this.buildControls();
    this.showMenu('main');
    this.updateMenuStats();
  }

  buildControls() {
    const g = this.game, tb = $('bindTable');
    tb.innerHTML = '';
    const NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'Shift L', ShiftRight: 'Shift R', ControlLeft: 'Ctrl L', ControlRight: 'Ctrl R', AltLeft: 'Alt L', AltRight: 'Alt R' };
    const pretty = (c) => (NAMES[c] || c.replace('Key', '').replace('Digit', '')).toUpperCase();
    for (const a in ACTION_LABELS) {
      const row = document.createElement('div'); row.className = 'bindrow';
      const lab = document.createElement('span'); lab.textContent = ACTION_LABELS[a];
      const btn = document.createElement('button'); btn.className = 'bindbtn';
      btn.textContent = (g.settings.binds[a] || []).map(pretty).join(' / ');
      btn.addEventListener('click', () => {
        btn.textContent = 'TASTE DRÜCKEN …'; btn.classList.add('on');
        g.input.startRebind((code) => {
          if (code) {
            // Taste von anderen Aktionen lösen, dann als Primärtaste setzen
            for (const k in g.settings.binds) g.settings.binds[k] = g.settings.binds[k].filter((c) => c !== code);
            g.settings.binds[a] = [code];
            g.saveSettings(); g.input.setBinds(g.settings.binds);
          }
          this.buildControls();
        });
      });
      row.appendChild(lab); row.appendChild(btn); tb.appendChild(row);
    }
  }

  updateMenuStats() {
    const h = this.game.score.high;
    $('menuStats').textContent = h.score > 0 ? `HIGHSCORE ${fmtInt(h.score)}  //  TOP-SPEED ${h.speed.toFixed(1)} M/S  //  BESTE WELLE ${h.wave}` : 'NOCH KEIN RUN – ZEIT, DAS ZU ÄNDERN';
  }

  showMenu(name) {
    for (const m of ['main', 'settings', 'controls', 'pause', 'over']) $('menu-' + m).classList.toggle('hidden', m !== name);
    $('menus').classList.toggle('hidden', !name);
    if (name === 'main' || name === 'pause') this.returnTo = name;
    document.body.classList.toggle('paused', name === 'pause' || (this.game.paused && (name === 'settings' || name === 'controls')));
    document.body.classList.toggle('inmenu', name === 'main' || (!this.game.paused && (name === 'settings' || name === 'controls')));
  }
  showHud(on) { this.hud.classList.toggle('hidden', !on); }
  lockNote(text) { const el = $('lockNote'); el.textContent = text || ''; el.classList.toggle('hidden', !text); }

  reset() {
    for (const arr of [this.dmg, this.inds, this.dirs, this.feed, this.pops]) for (const d of arr) { d.t = 0; d.life = 0; d.el.style.opacity = 0; }
    this.hintT = 0; this.bannerT = 0; this.cache = {};
    $('hint').classList.remove('show'); $('banner').classList.remove('show'); $('bossBar').classList.add('hidden');
  }

  set(id, prop, val) {
    const k = id + prop;
    if (this.cache[k] === val) return;
    this.cache[k] = val;
    const el = $(id);
    if (prop === 'text') el.textContent = val; else if (prop === 'class') el.className = val; else el.style[prop] = val;
  }

  // ---------------------------------------------------------------- Events
  popup(text, kind) {
    const p = this.pops[this.popHead]; this.popHead = (this.popHead + 1) % this.pops.length;
    p.el.textContent = text; p.el.className = 'pop ' + (kind || '');
    p.el.style.animation = 'none'; void p.el.offsetWidth; p.el.style.animation = '';
    p.el.classList.add('show');
    p.t = 0; p.life = 1.5;
  }
  scorePopup(label, pts, combo, minor) {
    const f = this.feed[this.feedHead]; this.feedHead = (this.feedHead + 1) % this.feed.length;
    f.el.textContent = `+${fmtInt(pts)} ${label}` + (combo > 2 ? `  ·${combo}` : '');
    f.el.className = 'feedline' + (minor ? ' minor' : '');
    f.t = 0; f.life = minor ? 1.2 : 2.2;
    f.el.style.order = this.feedOrder = (this.feedOrder || 0) + 1;
  }
  banner(main, sub, dur) {
    $('bannerMain').textContent = main; $('bannerSub').textContent = sub || '';
    const b = $('banner'); b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    this.bannerT = dur || 2.6;
  }
  hint(id, text, dur, once) {
    if (once && this.hintSeen[id]) return false;
    if (this.hintT > 0 && this.hintId === id) return false;
    if (!once && this.hintSeen[id] && this.game.time - this.hintSeen[id] < 12) return false;
    this.hintSeen[id] = this.game.time || 0.001;
    this.hintId = id; this.hintT = dur || 4;
    const h = $('hint'); h.textContent = text; h.classList.add('show');
    return true;
  }
  damageNumber(x, y, z, amount, weak, kill) {
    const d = this.dmg[this.dmgHead]; this.dmgHead = (this.dmgHead + 1) % this.dmg.length;
    d.x = x; d.y = y + 0.6; d.z = z; d.t = 0; d.life = 0.75; d.vy = 2.6;
    d.dx = (Math.random() - 0.5) * 50;
    d.el.textContent = Math.round(amount);
    // Farbe nach Schadenshöhe
    d.el.className = 'dmg ' + (weak ? 'weak' : amount >= 60 ? 'huge' : amount >= 25 ? 'big' : amount >= 16 ? 'mid' : '') + (kill ? ' kill' : '');
  }
  hitmarker(kill, weak) {
    const h = $('hitmarker');
    h.className = kill ? 'kill' : weak ? 'weak' : 'hit';
    h.style.animation = 'none'; void h.offsetWidth; h.style.animation = '';
    this.hitT = kill ? 0.3 : 0.14;
  }
  damageIndicator(sx, sy, sz) {
    const d = this.dirs[this.dirHead]; this.dirHead = (this.dirHead + 1) % this.dirs.length;
    d.x = sx; d.y = sy; d.z = sz; d.t = 0; d.life = 1.1;
    this.hud.classList.remove('glitch'); void this.hud.offsetWidth; this.hud.classList.add('glitch');
  }

  // ---------------------------------------------------------------- Update
  update(dt) {
    const g = this.game, pl = g.player, sc = g.score, wp = g.weapons, cam = g.cam.camera;
    const W = window.innerWidth, H = window.innerHeight;
    // Balken
    this.set('hpFill', 'width', Math.round(pl.hp) + '%'); this.set('hpText', 'text', '' + Math.ceil(pl.hp));
    this.set('hpFill', 'background', pl.hp < 35 ? '#ff2a4d' : '#ffffff');
    this.set('enFill', 'width', Math.round(wp.energy) + '%'); this.set('enText', 'text', '' + Math.floor(wp.energy));
    this.set('dashPips', 'class', 'c' + pl.dashCharges);
    this.set('heatFill', 'width', Math.round(wp.heat * 100) + '%');
    this.set('br', 'class', 'panel' + (wp.overheated ? ' over' : ''));
    // Speedometer: Weiss -> Cyan -> Magenta, pulsiert ab 35 m/s
    const sp = pl.speed, si = Math.round(sp);
    this.set('speedVal', 'text', '' + si);
    const t1 = clamp(sp / 22, 0, 1), t2 = clamp((sp - 22) / 18, 0, 1);
    const r = Math.round(255 - 230 * t1 + 230 * t2), gg = Math.round(255 - 25 * t1 - 187 * t2), b = Math.round(255 - 41 * t2);
    this.set('speedVal', 'color', `rgb(${r},${gg},${b})`);
    this.set('bc', 'class', sp >= 35 ? 'pulse' : '');
    this.set('stateTag', 'text', pl.speed > CONFIG.player.speedArmorSpeed ? 'SPEED-ARMOR' : '');
    // Fadenkreuz weitet sich mit der Hitze
    const gap = Math.round(5 + wp.heat * 12 + Math.min(6, wp.kick * 120));
    if (this.cache.gap !== gap) { this.cache.gap = gap; $('crosshair').style.setProperty('--gap', gap + 'px'); }
    // Score, Multiplikator, Rang mit Fortschrittsring
    this.set('scoreVal', 'text', fmtInt(sc.score));
    this.set('multVal', 'text', '×' + sc.mult);
    this.set('rank', 'text', CONFIG.flow.names[sc.rank]);
    this.set('rankTitle', 'text', CONFIG.flow.titles[sc.rank]);
    const frac = sc.overdrive ? clamp(sc.odT / CONFIG.flow.overdriveTime, 0, 1) : sc.flow - Math.floor(Math.min(sc.flow, 4));
    const off = Math.round(213.6 * (1 - clamp(frac, 0, 1)));
    this.set('rankRing', 'strokeDashoffset', '' + off);
    this.set('tr', 'class', 'panel r' + sc.rank + (sc.overdrive ? ' od' : ''));
    // Welle, Gegner, Ghost-Delta
    const en = g.enemies;
    this.set('waveNum', 'text', en.wave > 0 ? 'WAVE ' + en.wave : 'GET READY');
    this.set('enemyCount', 'text', en.state === 'pause' ? 'NEXT IN ' + Math.ceil(en.pauseT) : en.wave > 0 ? en.remaining + ' HOSTILES' : '');
    if (sc.ghostDelta === null) this.set('ghostDelta', 'text', '');
    else {
      const d = Math.round(sc.ghostDelta);
      this.set('ghostDelta', 'text', 'GHOST ' + (d >= 0 ? '▲ +' : '▼ ') + fmtInt(d));
      this.set('ghostDelta', 'color', d >= 0 ? '#19e6ff' : '#ff5a3c');
    }
    const boss = en.boss;
    this.set('bossBar', 'class', boss ? '' : 'hidden');
    if (boss) this.set('bossFill', 'width', Math.round(boss.hp / boss.maxHp * 100) + '%');
    // Warnung vor dem Wolkenmeer
    const warn = !pl.dead && pl.pos.y < CONFIG.player.warnY && pl.state !== STATE.GRINDING;
    this.set('warn', 'class', warn ? 'show' : '');
    g.vfx.warn = warn ? 1 : 0;

    // Feed / Popups / Banner / Hint
    for (const f of this.feed) { if (f.life <= 0) continue; f.t += dt; const a = clamp((f.life - f.t) * 3, 0, 1); f.el.style.opacity = a; if (f.t >= f.life) { f.life = 0; f.el.style.opacity = 0; } }
    for (const p of this.pops) { if (p.life <= 0) continue; p.t += dt; if (p.t >= p.life) { p.life = 0; p.el.classList.remove('show'); } }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) $('banner').classList.remove('show'); }
    if (this.hintT > 0) { this.hintT -= dt; if (this.hintT <= 0) $('hint').classList.remove('show'); }

    // Schadenszahlen (Welt -> Bildschirm)
    for (const d of this.dmg) {
      if (d.life <= 0) continue;
      d.t += dt; d.y += d.vy * dt;
      if (d.t >= d.life) { d.life = 0; d.el.style.opacity = 0; continue; }
      _v.set(d.x, d.y, d.z).project(cam);
      if (_v.z > 1 || _v.z < -1) { d.el.style.opacity = 0; continue; }
      const f = d.t / d.life;
      d.el.style.opacity = f > 0.6 ? (1 - f) / 0.4 : 1;
      d.el.style.transform = `translate(${((_v.x * 0.5 + 0.5) * W + d.dx * f).toFixed(0)}px,${((-_v.y * 0.5 + 0.5) * H).toFixed(0)}px) scale(${(1.25 - f * 0.4).toFixed(2)})`;
    }
    // Richtungsanzeige zum Schützen
    _q.copy(cam.quaternion).invert();
    for (const d of this.dirs) {
      if (d.life <= 0) continue;
      d.t += dt;
      if (d.t >= d.life) { d.life = 0; d.el.style.opacity = 0; continue; }
      _v.set(d.x - cam.position.x, d.y - cam.position.y, d.z - cam.position.z).applyQuaternion(_q);
      const ang = Math.atan2(_v.x, -_v.z);
      d.el.style.opacity = 1 - d.t / d.life;
      d.el.style.transform = `translate(-50%,-50%) rotate(${ang.toFixed(3)}rad) translateY(-${Math.round(Math.min(W, H) * 0.2)}px)`;
    }
    // Off-Screen-Indikatoren für zielende Gegner
    let k = 0;
    const act = en.active;
    for (let i = 0; i < act.length && k < this.inds.length; i++) {
      const e = act[i];
      if (!e.aiming) continue;
      const ey = e.type === 4 ? e.sweepY : e.y;
      _v.set(e.x - cam.position.x, ey - cam.position.y, e.z - cam.position.z).applyQuaternion(_q);
      const fwd = -_v.z, tanH = Math.tan(cam.fov * Math.PI / 360), nx = _v.x / (Math.abs(fwd) * tanH * cam.aspect), ny = _v.y / (Math.abs(fwd) * tanH);
      if (fwd > 0 && Math.abs(nx) < 0.92 && Math.abs(ny) < 0.92) continue;   // im Bild: kein Indikator nötig
      const ang = Math.atan2(_v.y, _v.x);
      const d = this.inds[k++];
      d.el.style.opacity = 0.55 + 0.45 * Math.sin(g.time * 18);
      d.el.style.transform = `translate(${(W / 2 + Math.cos(ang) * W * 0.42).toFixed(0)}px,${(H / 2 - Math.sin(ang) * H * 0.4).toFixed(0)}px) rotate(${(-ang).toFixed(3)}rad)`;
      d.used = true;
    }
    for (let i = k; i < this.inds.length; i++) if (this.inds[i].used) { this.inds[i].used = false; this.inds[i].el.style.opacity = 0; }
  }

  gameOver(stats) {
    $('overTitle').textContent = stats.reason === 'fall' ? 'INS WOLKENMEER GESTÜRZT' : 'SIGNAL VERLOREN';
    $('ovScore').textContent = fmtInt(stats.score);
    $('ovRank').textContent = CONFIG.flow.names[stats.rank];
    $('ovSpeed').textContent = stats.topSpeed.toFixed(1) + ' M/S';
    $('ovKills').textContent = stats.kills;
    $('ovGrind').textContent = fmtInt(stats.grind) + ' M';
    $('ovCombo').textContent = '×' + stats.combo;
    $('ovWave').textContent = stats.wave;
    $('ovTime').textContent = fmtTime(stats.time);
    $('ovSeed').textContent = 'SEED ' + stats.seed + (stats.ghost ? '  //  GHOST GESPEICHERT' : '');
    $('ovRecord').classList.toggle('hidden', !stats.newRecord);
    this.showMenu('over');
    this.updateMenuStats();
  }
}
