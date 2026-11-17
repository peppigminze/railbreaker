// UI: HUD (DOM), Popups, Schadenszahlen, Indikatoren, Menüs, Settings.
import * as THREE from 'three';
import { CONFIG, STATE, STATE_NAMES, DEFAULT_SETTINGS } from './config.js';
import { clamp, fmtInt, fmtTime, Store, randomSeedString } from './util.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// Tempo-Farbe: Weiss -> Cyan -> Magenta (HUD-Tacho und Tempo-Graph)
const speedColor = (sp) => {
  const t1 = clamp(sp / 22, 0, 1), t2 = clamp((sp - 22) / 18, 0, 1);
  return `rgb(${Math.round(255 - 230 * t1 + 230 * t2)},${Math.round(255 - 25 * t1 - 187 * t2)},${Math.round(255 - 41 * t2)})`;
};
const REDUCED = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    click('btnScores', () => this.showMenu('scores'));
    click('btnScoresBack', () => this.showMenu('main'));
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

  // Kachel-Reihe (Rekorde): items = [{ k, v, unit, sub, pb }]
  tilesInto(parent, items) {
    parent.textContent = '';
    for (const it of items) {
      const t = el('div', 'tile' + (it.pb ? ' pb' : ''));
      t.appendChild(el('span', 'k', it.k));
      const b = el('b', null, it.v);
      if (it.unit) { b.appendChild(document.createTextNode(' ')); b.appendChild(el('i', null, it.unit)); }
      t.appendChild(b); t.appendChild(el('small', null, it.sub || ''));
      parent.appendChild(t);
    }
  }

  // Bestenliste: board = Top-10-Runs, cur = der gerade beendete Run (wird hervorgehoben)
  boardInto(parent, board, cur, limit) {
    const g = this.game;
    parent.textContent = '';
    const head = el('div', 'brow h');
    for (const h of ['#', 'PUNKTE', 'TOP M/S', 'Ø M/S', 'WELLE', 'ZEIT', 'SEED']) head.appendChild(el('span', null, h));
    parent.appendChild(head);
    if (!board.length) { parent.appendChild(el('div', 'brow empty', 'NOCH KEINE RUNS')); return; }
    board.slice(0, limit || 10).forEach((r, i) => {
      const row = el('div', 'brow' + (r === cur ? ' cur' : ''));
      row.appendChild(el('span', 'pl', '' + (i + 1)));
      const sc = el('span', 'sc', fmtInt(r.score));
      sc.appendChild(el('em', 'g' + g.score.grade(r.score), CONFIG.flow.names[g.score.grade(r.score)]));
      row.appendChild(sc);
      row.appendChild(el('span', null, r.top.toFixed(1)));
      row.appendChild(el('span', null, r.avg.toFixed(1)));
      row.appendChild(el('span', null, 'W' + r.wave));
      row.appendChild(el('span', null, fmtTime(r.time)));
      row.appendChild(el('span', 'sd', r.seed || ''));
      parent.appendChild(row);
    });
  }

  updateMenuStats() {
    const sc = this.game.score, h = sc.high;
    const ms = $('menuStats');
    if (h.score > 0) {
      this.tilesInto(ms, [
        { k: 'Highscore', v: fmtInt(h.score) },
        { k: 'Top-Tempo', v: h.speed.toFixed(1), unit: 'M/S' },
        { k: 'Ø-Tempo', v: h.avg.toFixed(1), unit: 'M/S' },
        { k: 'Beste Welle', v: '' + h.wave },
      ]);
    } else { ms.textContent = ''; ms.appendChild(el('div', 'empty', 'NOCH KEIN RUN – ZEIT, DAS ZU ÄNDERN')); }
    // Highscore-Menü
    this.tilesInto($('scoreRecords'), [
      { k: 'Highscore', v: fmtInt(h.score) }, { k: 'Top-Tempo', v: h.speed.toFixed(1), unit: 'M/S' },
      { k: 'Bestes Ø-Tempo', v: h.avg.toFixed(1), unit: 'M/S' }, { k: 'Speed-Anteil', v: h.fast + '%', sub: 'ÜBER ' + CONFIG.score.speedBonusMin + ' M/S' },
      { k: 'Beste Welle', v: '' + h.wave }, { k: 'Meiste Kills', v: '' + h.kills },
      { k: 'Längste Combo', v: '×' + h.combo }, { k: 'Grind-Distanz', v: fmtInt(h.grind), unit: 'M' },
    ]);
    this.boardInto($('scoreBoard'), sc.board, null, 10);
  }

  updatePauseStats() {
    const sc = this.game.score, best = Math.max(sc.high.score, sc.score);
    $('pauseStats').textContent = `PUNKTE ${fmtInt(sc.score)}  //  BEST ${fmtInt(best)}\nØ-TEMPO ${sc.avgSpeed.toFixed(1)}  //  TOP ${sc.topSpeed.toFixed(1)} M/S`;
  }

  showMenu(name) {
    for (const m of ['main', 'settings', 'controls', 'scores', 'pause', 'over']) $('menu-' + m).classList.toggle('hidden', m !== name);
    $('menus').classList.toggle('hidden', !name);
    if (name === 'main' || name === 'pause') this.returnTo = name;
    if (name === 'pause') this.updatePauseStats();
    document.body.classList.toggle('paused', name === 'pause' || (this.game.paused && (name === 'settings' || name === 'controls')));
    document.body.classList.toggle('inmenu', name === 'main' || name === 'scores' || (!this.game.paused && (name === 'settings' || name === 'controls')));
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
    this.set('speedVal', 'color', speedColor(sp));
    this.set('bc', 'class', sp >= 35 ? 'pulse' : '');
    // Tempo-Zeile: Ø und Top dieses Runs, gelb sobald der Tempo-Rekord fällt
    this.set('tempoLine', 'text', `Ø ${sc.avgSpeed.toFixed(1)}  ·  TOP ${sc.topSpeed.toFixed(1)}`);
    this.set('tempoLine', 'class', sc.high.speed > 0 && sc.topSpeed > sc.high.speed ? 'rec' : '');
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
    // Highscore-Jagd: Fortschritt zum Rekord, nach dem Überholen live der neue Wert
    const hs = sc.high.score;
    if (hs <= 0) { this.set('bestLbl', 'text', 'BEST'); this.set('bestVal', 'text', '–'); this.set('bestFill', 'width', '0%'); this.set('bestLine', 'class', ''); }
    else if (sc.score > hs) { this.set('bestLbl', 'text', 'REKORD'); this.set('bestVal', 'text', fmtInt(sc.score)); this.set('bestFill', 'width', '100%'); this.set('bestLine', 'class', 'beat'); }
    else { this.set('bestLbl', 'text', 'BEST'); this.set('bestVal', 'text', fmtInt(hs)); this.set('bestFill', 'width', Math.round(sc.score / hs * 100) + '%'); this.set('bestLine', 'class', ''); }
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

  gameOver(r) {
    const run = r.run, prev = r.prev, pb = r.pb, names = CONFIG.flow.names;
    $('overTitle').textContent = r.reason === 'fall' ? 'INS WOLKENMEER GESTÜRZT' : 'SIGNAL VERLOREN';
    $('ovRecord').classList.toggle('hidden', !r.newRecord);
    // Punkte: hochzählen, Fortschrittsbalken zum bisherigen Highscore
    this.countUp($('ovScore'), run.score, 1100);
    const scale = Math.max(run.score, prev.score, 1);
    const bar = $('ovBestBar'), fill = $('ovBestFill'), mark = $('ovBestMark');
    bar.classList.toggle('rec', r.newRecord);
    mark.style.display = prev.score > 0 ? '' : 'none'; mark.style.left = (prev.score / scale * 100).toFixed(1) + '%';
    fill.style.width = '0%'; void fill.offsetWidth; fill.style.width = (run.score / scale * 100).toFixed(1) + '%';
    const dl = $('ovDelta');
    if (!r.newRecord) { dl.className = 'down'; dl.textContent = `NOCH ${fmtInt(prev.score - run.score)} BIS ZUM HIGHSCORE`; }
    else if (prev.score > 0) { dl.className = 'up'; dl.textContent = `+${fmtInt(run.score - prev.score)} ÜBER DEM ALTEN HIGHSCORE`; }
    else { dl.className = 'up'; dl.textContent = 'ERSTER HIGHSCORE GESETZT'; }
    $('ovPlace').textContent = r.place >= 0 ? `PLATZ ${r.place + 1} IN DEN TOP 10` : run.score > 0 ? 'KNAPP DANEBEN – NICHT IN DEN TOP 10' : '';
    $('ovRank').textContent = names[r.grade]; $('ovRank').className = 'g' + r.grade;
    $('ovRankName').textContent = CONFIG.flow.titles[r.grade];

    // Kacheln: Wert, Bestwert-Markierung mit Verbesserung bzw. bisheriger Rekord
    const tile = (id, text, unit, isPb, prevVal, fmtPrev, delta) => {
      const t = $(id), b = t.querySelector('b'), sm = t.querySelector('small');
      b.textContent = text;
      if (unit) { b.appendChild(document.createTextNode(' ')); b.appendChild(el('i', null, unit)); }
      const fresh = isPb && prevVal > 0;
      t.classList.toggle('pb', fresh);
      sm.textContent = fresh ? '★ BESTWERT' + (delta ? '  ' + delta : '') : prevVal > 0 ? 'BEST ' + fmtPrev(prevVal) : '';
    };
    const f1 = (v) => v.toFixed(1), fi = (v) => fmtInt(v);
    tile('tlTop', f1(run.top), 'M/S', pb.speed, prev.speed, f1, '+' + f1(run.top - prev.speed));
    tile('tlAvg', f1(run.avg), 'M/S', pb.avg, prev.avg, f1, '+' + f1(run.avg - prev.avg));
    $('tlFast').querySelector('.k').textContent = 'Über ' + CONFIG.score.speedBonusMin + ' M/S';
    tile('tlFast', run.fast + '%', '', pb.fast, prev.fast, (v) => v + '%', '+' + (run.fast - prev.fast) + '%');
    const dist = r.dist, perMin = r.time > 0 ? run.score / r.time * 60 : 0;
    tile('tlDist', dist < 1000 ? fi(dist) : (dist / 1000).toFixed(2), dist < 1000 ? 'M' : 'KM', false, 0, fi);
    $('tlDist').querySelector('small').textContent = fi(perMin) + ' PKT/MIN';
    tile('tlKills', '' + run.kills, '', pb.kills, prev.kills, fi, '+' + (run.kills - prev.kills));
    tile('tlCombo', '×' + run.combo, '', pb.combo, prev.combo, (v) => '×' + v, '+' + (run.combo - prev.combo));
    tile('tlGrind', fi(run.grind), 'M', pb.grind, prev.grind, fi, '+' + fi(run.grind - prev.grind));
    tile('tlWave', '' + run.wave, '', pb.wave, prev.wave, fi, '+' + (run.wave - prev.wave));
    $('ovFlow').textContent = names[run.rank];
    $('ovTime').textContent = fmtTime(r.time) + ' S';
    this.boardInto($('ovBoard'), r.board, run, 5);
    $('ovSeed').textContent = 'SEED ' + run.seed + (r.ghost ? '  //  GHOST GESPEICHERT' : '');
    this.showMenu('over');
    this.drawGraph(r);
    this.updateMenuStats();
  }

  countUp(node, to, ms) {
    cancelAnimationFrame(this._cu);
    if (REDUCED() || to <= 0) { node.textContent = fmtInt(to); return; }
    const t0 = performance.now();
    const step = (now) => {
      const f = clamp((now - t0) / ms, 0, 1);
      node.textContent = fmtInt(to * (1 - Math.pow(1 - f, 3)));
      if (f < 1) this._cu = requestAnimationFrame(step);
    };
    node.textContent = '0';
    this._cu = requestAnimationFrame(step);
  }

  // Tempo-Verlauf des Runs: Farbe nach Tempo, Overdrive-Phasen, Speed-Bonus-Schwelle, Ø-Linie, Top-Marker, Vergleich mit dem Rekord-Run
  drawGraph(r) {
    const cv = $('ovGraph'), dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = cv.clientWidth || 760, ch = 190;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    c.font = '10px ui-monospace, "SF Mono", Consolas, monospace'; c.textBaseline = 'middle';
    const { v, od, dt } = r.curve, n = v.length;
    if (n < 3) { c.fillStyle = '#8f7fbf'; c.textAlign = 'center'; c.fillText('ZU KURZ FÜR EINEN TEMPO-VERLAUF', cw / 2, ch / 2); return; }
    const L = 34, R = 10, T = 12, B = 40, w = cw - L - R, h = ch - T - B, dur = n * dt;
    const vmax = Math.ceil(Math.max(40, r.topSpeed + 4) / 10) * 10;
    const X = (t) => L + t / dur * w, Y = (s) => T + h - s / vmax * h;
    const bonus = CONFIG.score.speedBonusMin;
    // Raster + Zeitachse
    c.lineWidth = 1; c.textAlign = 'right';
    for (let s = 0; s <= vmax; s += 10) {
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.beginPath(); c.moveTo(L, Y(s) + 0.5); c.lineTo(L + w, Y(s) + 0.5); c.stroke();
      c.fillStyle = '#8f7fbf'; c.fillText('' + s, L - 6, Y(s));
    }
    const steps = [5, 10, 15, 30, 60, 120, 300, 600];
    const stp = steps.find((q) => dur / q <= 8) || 600;
    c.textAlign = 'center'; c.fillStyle = '#8f7fbf';
    for (let t = 0; t <= dur; t += stp) c.fillText(t < 60 ? t + 'S' : Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2), X(t), ch - B + 12);
    // Overdrive-Phasen
    c.fillStyle = 'rgba(255,43,214,0.16)';
    for (let i = 0; i < n; i++) if (od[i]) c.fillRect(X(i * dt), T, X((i + 1) * dt) - X(i * dt) + 0.6, h);
    // Speed-Bonus-Schwelle
    c.setLineDash([5, 4]); c.strokeStyle = 'rgba(255,224,42,0.55)'; c.beginPath(); c.moveTo(L, Y(bonus) + 0.5); c.lineTo(L + w, Y(bonus) + 0.5); c.stroke(); c.setLineDash([]);
    c.textAlign = 'left'; c.fillStyle = 'rgba(255,224,42,0.8)'; c.fillText('SPEED-BONUS', L + 4, Y(bonus) - 7);
    // Fläche unter der Kurve
    const gr = c.createLinearGradient(0, T, 0, T + h); gr.addColorStop(0, 'rgba(25,230,255,0.38)'); gr.addColorStop(1, 'rgba(25,230,255,0)');
    c.fillStyle = gr; c.beginPath(); c.moveTo(X(0.5 * dt), Y(0));
    for (let i = 0; i < n; i++) c.lineTo(X((i + 0.5) * dt), Y(v[i]));
    c.lineTo(X((n - 0.5) * dt), Y(0)); c.closePath(); c.fill();
    // Rekord-Run als gestrichelte Vergleichslinie
    if (r.compare && r.compare.v && r.compare.v.length > 2) {
      const cp = r.compare, st = cp.step;
      c.setLineDash([4, 4]); c.strokeStyle = 'rgba(255,224,42,0.85)'; c.lineWidth = 1.5; c.beginPath();
      let started = false;
      for (let i = 0; i < cp.v.length; i++) { const t = (i + 0.5) * st; if (t > dur) break; const x = X(t), y = Y(cp.v[i]); if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y); }
      c.stroke(); c.setLineDash([]);
    }
    // Tempo-Linie, segmentweise nach Tempo gefärbt
    c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round';
    let top = 0;
    for (let i = 1; i < n; i++) {
      c.strokeStyle = speedColor((v[i - 1] + v[i]) / 2);
      c.beginPath(); c.moveTo(X((i - 0.5) * dt), Y(v[i - 1])); c.lineTo(X((i + 0.5) * dt), Y(v[i])); c.stroke();
      if (v[i] > v[top]) top = i;
    }
    // Ø-Tempo
    c.lineWidth = 1; c.setLineDash([2, 3]); c.strokeStyle = 'rgba(255,255,255,0.6)'; c.beginPath(); c.moveTo(L, Y(r.avgSpeed) + 0.5); c.lineTo(L + w, Y(r.avgSpeed) + 0.5); c.stroke(); c.setLineDash([]);
    c.textAlign = 'right'; c.fillStyle = '#fff'; c.fillText('Ø ' + r.avgSpeed.toFixed(1), L + w - 4, Y(r.avgSpeed) + (r.avgSpeed > vmax * 0.8 ? 9 : -7));
    // Top-Marker
    const tx = X((top + 0.5) * dt), ty = Y(v[top]);
    c.fillStyle = '#fff'; c.shadowColor = '#ff2bd6'; c.shadowBlur = 10; c.beginPath(); c.arc(tx, ty, 3.5, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
    c.textAlign = tx > cw * 0.82 ? 'right' : 'left'; c.fillStyle = '#fff'; c.fillText('TOP ' + r.topSpeed.toFixed(1), tx + (tx > cw * 0.82 ? -7 : 7), Math.max(T + 6, ty - 8));
    // Legende
    let lx = L; const ly = ch - 9;
    const leg = (col, txt, dash) => { c.strokeStyle = col; c.lineWidth = 2; c.setLineDash(dash || []); c.beginPath(); c.moveTo(lx, ly); c.lineTo(lx + 16, ly); c.stroke(); c.setLineDash([]); c.textAlign = 'left'; c.fillStyle = '#b9a8e6'; c.fillText(txt, lx + 21, ly); lx += 21 + c.measureText(txt).width + 16; };
    leg('#19e6ff', 'TEMPO (M/S)');
    if (od.some((x) => x)) { c.fillStyle = 'rgba(255,43,214,0.5)'; c.fillRect(lx, ly - 4, 16, 8); c.fillStyle = '#b9a8e6'; c.fillText('OVERDRIVE', lx + 21, ly); lx += 21 + c.measureText('OVERDRIVE').width + 16; }
    if (r.compare && r.compare.v && r.compare.v.length > 2) leg('rgba(255,224,42,0.9)', r.newRecord ? 'ALTER REKORD-RUN' : 'REKORD-RUN', [4, 4]);
  }
}
