// Game: Hauptschleife (Fixed Timestep 120 Hz + Interpolation), State-Machine, Verdrahtung aller Systeme.
import * as THREE from 'three';
import { CONFIG, STATE, DEFAULT_SETTINGS } from './config.js';
import { Store, seedFromString, randomSeedString, clamp, fmtTime } from './util.js';
import { Input } from './input.js';
import { WorldGen } from './world.js';
import { RailSystem } from './rails.js';
import { PlayerController } from './player.js';
import { CameraRig } from './camera.js';
import { WeaponSystem } from './weapons.js';
import { EnemyManager } from './enemies.js';
import { VFX } from './vfx.js';
import { AudioEngine } from './audio.js';
import { ScoreSystem } from './score.js';
import { UI } from './ui.js';

const GS = { MENU: 0, PLAYING: 1, PAUSED: 2, GAMEOVER: 3 };
const FIXED = 1 / CONFIG.physicsHz;
const SC = CONFIG.score, RC = CONFIG.rail;

class Game {
  constructor() {
    const saved = Store.get('settings', {});
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.binds = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS.binds)), saved.binds || {});
    this.state = GS.MENU; this.paused = false;
    this.time = 0; this.acc = 0; this.last = 0; this.menuT = 0;
    this.hitstop = 0; this.sm = { on: false, t: 0, scale: 1, dur: 0, fade: 0 }; this.dismountT = 0; this.timeScale = 1;
    this.lookDX = 0; this.lookDY = 0; this.deadT = 0; this.deathReason = '';
    this.seedStr = ''; this.tut = null; this.fps = 60;
    this.world = new WorldGen(this);
    this.rails = new RailSystem(this);
    this.score = new ScoreSystem(this);
    this.player = new PlayerController(this);
    this.cam = new CameraRig(this);
    this.input = new Input(this);
    this.audio = new AudioEngine(this);
    this.weapons = new WeaponSystem(this);
    this.enemies = new EnemyManager(this);
    this.vfx = new VFX(this);
    this.ui = new UI(this);
  }

  init() {
    const canvas = document.getElementById('game');
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setClearColor(CONFIG.world.fogColor, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(62, 16 / 9, 0.01, 10);
    this.world.init(this.scene);
    this.rails.init(this.scene);
    this.enemies.init(this.scene);
    this.vfx.init(renderer, this.scene, this.cam.camera, this.vmScene, this.vmCamera);
    this.weapons.init(this.vmScene, this.vmCamera);
    this.score.init(this.scene);
    this.input.init(canvas);
    this.ui.init();
    this.vfx.setQuality(this.settings.quality);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === GS.PLAYING) this.pause(); });
    window.addEventListener('beforeunload', (e) => { if (this.state === GS.PLAYING) { e.preventDefault(); e.returnValue = ''; } });
    // Erste Nutzergeste schaltet Audio frei (Menü-Musik)
    const unlock = () => { this.audio.unlock(); this.audio.startMusic(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    this.audio.onBeat = (beat, bar) => { if (this.state === GS.PLAYING) this.enemies.onBeat(beat, bar); };
    setInterval(() => this.audio.pump(), 50);     // hält den Lookahead-Scheduler gefüllt, auch wenn rAF stockt
    this.setupMenuWorld();
    window.__railbreakerBooted = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  saveSettings() { Store.set('settings', this.settings); }
  isPlaying() { return this.state === GS.PLAYING; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.cam.camera.aspect = w / h; this.cam.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h; this.vmCamera.updateProjectionMatrix();
    this.vfx.resize(w, h);
  }

  setupMenuWorld() {
    this.world.reset(seedFromString(Store.get('lastSeed', 'NEON')));
    this.rails.reset(); this.enemies.reset(1); this.vfx.clearAll();
    this.world.update(0, 0, true);
    this.enemies.draw();
    this.menuT = 0; this.cam.menuY = undefined;
    this.vfx.death = 0; this.vfx.slowmo = 0;
    this.audio.targetIntensity = 0;
  }

  // ---------------------------------------------------------------- State-Wechsel
  startRun(seedStr) {
    this.audio.unlock(); this.audio.startMusic(); this.audio.setPaused(false); this.audio.setSlowmo(0);
    seedStr = String(seedStr || randomSeedString()).trim().toUpperCase().slice(0, 12) || randomSeedString();
    this.seedStr = seedStr;
    Store.set('lastSeed', seedStr);
    const seed = seedFromString(seedStr);
    this.world.reset(seed); this.rails.reset();
    this.world.update(0, 0, true);
    const ch = this.world.chunkAt(0, 0);
    this.player.reset(ch.startX || 0, ch.hubY + 0.05, ch.startZ || 0);
    this.cam.reset(); this.weapons.reset(); this.enemies.reset(seed); this.vfx.clearAll(); this.score.reset(seedStr); this.ui.reset();
    this.enemies.startRun();
    this.time = 0; this.acc = 0; this.hitstop = 0; this.sm.on = false; this.dismountT = 0; this.deadT = 0; this.timeScale = 1;
    this.state = GS.PLAYING; this.paused = false;
    this.ui.showMenu(null); this.ui.showHud(true); this.ui.lockNote(null);
    this.input.clearEdges(); this.input.fire = false; this.input.alt = false;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.input.requestLock();
    this.ui.banner('RAILBREAKER', 'SEED ' + seedStr + (this.score.ghost ? '  //  GHOST AKTIV' : ''), 2.4);
    const done = Store.get('tutorialDone', false);
    this.tut = done ? null : { t: 0, shown: {}, did: {} };
    this.last = performance.now();
  }

  toMenu() {
    this.state = GS.MENU; this.paused = false;
    this.input.exitLock();
    this.audio.setPaused(false); this.audio.setSlowmo(0);
    this.setupMenuWorld();
    this.ui.showHud(false); this.ui.lockNote(null);
    this.ui.showMenu('main'); this.ui.updateMenuStats();
  }

  pause() {
    if (this.state !== GS.PLAYING) return;
    this.state = GS.PAUSED; this.paused = true;
    this.ui.showMenu('pause'); this.ui.lockNote(null);
    this.audio.setPaused(true);
    this.input.exitLock();
  }
  resume() {
    if (this.state !== GS.PAUSED) return;
    this.state = GS.PLAYING; this.paused = false;
    this.ui.showMenu(null);
    this.audio.setPaused(false);
    this.input.clearEdges();
    this.input.requestLock();
    this.last = performance.now();
  }

  onPointerLock(locked) {
    if (locked) this.ui.lockNote(null);
    else if (this.state === GS.PLAYING && !this.player.dead && !this.input.fallbackLook) this.pause();
  }
  onLockDenied(temporary) {
    if (this.state !== GS.PLAYING) return;
    if (temporary) this.ui.lockNote('Klick ins Bild, um die Maus zu fangen');
    else { this.ui.lockNote('Pointer Lock ist hier blockiert – Maus läuft ohne Fang. Am besten in einem eigenen Tab öffnen.'); setTimeout(() => this.ui.lockNote(null), 6000); }
  }
  onEscape() {
    const sub = ['settings', 'controls', 'scores'].some((m) => !document.getElementById('menu-' + m).classList.contains('hidden'));
    if (sub) { this.ui.showMenu(this.ui.returnTo || 'main'); return; }
    if (this.state === GS.PLAYING) this.pause();
    else if (this.state === GS.PAUSED) this.resume();
  }
  onKeyAction(action) {
    if (action === 'restart' && (this.state === GS.PLAYING || this.state === GS.GAMEOVER)) this.startRun(this.seedStr);
    else if (action === 'skipTutorial' && this.tut) { this.tut = null; Store.set('tutorialDone', true); this.ui.hint('skip', 'Tutorial übersprungen', 2); }
  }

  // ---------------------------------------------------------------- Zeit-Effekte
  hitStop(s) { this.hitstop = Math.max(this.hitstop, s); }
  slowmo() { const s = this.sm; s.on = true; s.t = 0; s.scale = RC.slowmoScale; s.dur = RC.slowmoTime; s.fade = RC.slowmoFade; }

  // ---------------------------------------------------------------- Events aus den Systemen
  onPlayerAction(name, arg) {
    const sc = this.score, ui = this.ui, t = this.tut;
    if (t) t.did[name] = true;
    switch (name) {
      case 'slidejump': sc.add(10, null, 0.08); break;
      case 'dash': sc.add(0, null, 0.04); break;
      case 'wallrun': sc.add(SC.wallChain * arg, arg > 1 ? 'WALLRUN ×' + arg : 'WALLRUN', 0.2 + Math.min(0.2, arg * 0.04)); break;
      case 'walljump': sc.add(5, null, 0.06); break;
      case 'grind':
        if (arg) { sc.add(SC.railHop, 'RAIL HOP', 0.3); this.audio.play('hop'); }
        else sc.add(10, null, 0.1);
        break;
      case 'grindend': if (arg >= 12) ui.scorePopup('GRIND ' + Math.round(arg) + ' M', Math.round(arg * SC.grindPerMeter * sc.mult), 0, true); break;
      case 'pump':
        this.audio.play('pump', arg);
        if (arg) { sc.add(15, 'PUMP', 0.12); this.cam.fovKick(2.5); }
        break;
      case 'railjump':
        if (arg) {
          // Perfekter Absprung kurz vor dem Rail-Ende
          this.weapons.addEnergy(RC.perfectEnergy);
          this.slowmo(); this.audio.play('railEnd');
          sc.add(40, 'PERFECT RELEASE', 0.3); ui.popup('PERFECT RELEASE', 'mg');
        }
        break;
      case 'railend': this.slowmo(); this.audio.play('railEnd'); break;
      case 'raillost': ui.popup('RAIL WEG!', 'warn'); break;
      case 'pad': case 'launch': sc.add(5, null, 0.08); break;
    }
  }
  onPlayerHit(amount, sx, sy, sz) {
    this.vfx.damage = Math.min(1, 0.55 + amount / 50); this.vfx.glitch = 0.9;
    this.cam.addTrauma(0.25 + amount / 100);
    this.ui.damageIndicator(sx, sy, sz);
    this.audio.play('hurt');
    this.score.onDamage();
  }
  onPlayerDeath(reason) {
    this.deadT = 0; this.deathReason = reason;
    this.audio.play('death'); this.audio.setSlowmo(1);
    this.vfx.death = 1; this.cam.addTrauma(0.7);
    if (this.rails.growing) this.rails.stopGrow();
  }
  onWaveStart(wave, boss) {
    this.ui.banner(boss ? 'WARDEN' : 'WAVE ' + wave, boss ? 'BOSS – 4 WEAKPOINTS, NUR AUS DER NÄHE VERWUNDBAR' : this.enemies.remaining + ' HOSTILES', 2.6);
    this.audio.play('waveStart');
    if (boss) this.ui.hint('boss', 'RAIL-GUN: BAU SPIRALEN UM DEN TURM, UM DIE WEAKPOINTS ZU ERREICHEN', 6);
  }
  onWaveCleared(wave, time) {
    const r = this.score.waveCleared(wave, time);
    this.ui.banner('WAVE ' + wave + ' CLEARED', fmtTime(time) + ' S' + (r.best ? '  ·  BESTZEIT' : r.old ? '  ·  BEST ' + fmtTime(r.old) : ''), 3.2);
    this.audio.play('waveClear');
    this.score.add(200 + 50 * wave, 'WAVE CLEAR', 0.3);
    this.weapons.addEnergy(40);
  }
  onOverdrive(on) {
    if (on) { this.ui.popup('OVERDRIVE', 'mg'); this.audio.play('overdrive'); this.cam.fovKick(8); this.cam.addTrauma(0.3); }
    else this.audio.play('overdriveEnd');
  }
  onHighscoreBeaten(old) {
    this.ui.popup('HIGHSCORE GEBROCHEN', 'gold'); this.audio.play('waveClear');
    this.cam.fovKick(5);
  }
  onRankUp(r) { if (r < 4) this.ui.popup(CONFIG.flow.names[r] + ' – ' + CONFIG.flow.titles[r], 'gold'); }

  showGameOver() {
    this.state = GS.GAMEOVER;
    const s = this.score;
    const hadGhostScore = s.ghost ? s.ghost.score : -1;
    const res = s.finalize(this.enemies.wave);
    this.input.exitLock();
    this.ui.showHud(false);
    this.ui.gameOver(Object.assign(res, {
      reason: this.deathReason, time: s.runTime, topSpeed: s.topSpeed, avgSpeed: s.avgSpeed, dist: s.dist, fastTime: s.fastTime,
      ghost: s.score > hadGhostScore && s.recN > 60,
    }));
  }

  // Kontextuelles Tutorial im ersten Run (T überspringt)
  updateTutorial(dt) {
    const t = this.tut, pl = this.player, ui = this.ui;
    if (!t || pl.dead) return;
    t.t += dt;
    const show = (id, text, dur) => { if (t.shown[id]) return false; if (ui.hintT > 0) return false; t.shown[id] = true; ui.hint('tut' + id, text + '   [T = Tutorial aus]', dur || 5.5, true); return true; };
    if (t.t > 1.2) show('move', 'WASD + Maus · W halten = Sprint · Space = Sprung, in der Luft nochmal = Doppelsprung', 6);
    if (t.t > 7 && !t.did.slide && pl.state === STATE.GROUNDED && pl.speedH > 12) show('slide', 'Im Sprint Ctrl oder C = Slide (+Tempo) · im Slide springen behält das volle Tempo');
    if (t.t > 4 && !t.did.wallrun && this.world.findWall(pl.pos.x, pl.pos.y, pl.pos.z, 0.4, 3.5, pl.wallInfo)) show('wall', 'Wand: seitlich dagegen springen = Wallrun · Space = Wall-Jump');
    if (t.t > 3 && !t.did.grind && this.rails.findSnap(pl.pos.x, pl.pos.y + 1, pl.pos.z, 8, null)) show('rail', 'Rail: einfach draufspringen = Grind · W/S im Takt der Musik = Speed-Pumping');
    if (t.did.grind && pl.state !== STATE.GRINDING) show('railgun', 'Rechtsklick halten = Rail-Gun: bau dir eine eigene Rail – auch mitten in der Luft');
    if (t.t > 22 && !t.did.dash) show('dash', 'Shift = Dash: kurzer Schub, unverwundbar, 2 Ladungen');
    if (this.enemies.active.length > 0) show('shoot', 'Linksklick = Feuer · je schneller du bist, desto mehr Schaden machst du');
    if (t.t > 60 && Object.keys(t.shown).length >= 6) { this.tut = null; Store.set('tutorialDone', true); }
  }

  // ---------------------------------------------------------------- Hauptschleife
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const rdt = Math.min(0.1, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    if (rdt > 0.001) this.fps += (1 / rdt - this.fps) * 0.06;
    const U = this.world.uniforms, pl = this.player;

    if (this.state === GS.MENU) {
      this.menuT += rdt;
      this.cam.updateMenu(rdt, this.menuT);
      this.world.update(this.cam.camera.position.x, this.cam.camera.position.z);
      U.uTime.value += rdt; U.uBeat.value = this.audio.pulse;
      this.audio.update(rdt);
      this.weapons.update(rdt, rdt);
      this.vfx.update(rdt, rdt);
      this.vfx.render();
      return;
    }
    if (this.state === GS.PAUSED) { this.audio.update(rdt); this.input.mouseDX = this.input.mouseDY = 0; this.vfx.render(); return; }

    // Umsehen direkt pro Frame (nicht im Physik-Tick) für minimale Latenz
    const inp = this.input;
    if (this.state === GS.PLAYING && !pl.dead) {
      const k = 0.0022 * this.settings.sens;
      pl.yaw -= inp.mouseDX * k;
      pl.pitch = clamp(pl.pitch - inp.mouseDY * k, -1.5, 1.5);
    }
    this.lookDX = inp.mouseDX; this.lookDY = inp.mouseDY; inp.mouseDX = 0; inp.mouseDY = 0;

    // Zeitskala: Hit-Stop, Absprung-Zeitlupe (mit Ein-/Ausblenden), Tod
    let ts = 1, slowAmt = 0;
    const sm = this.sm;
    if (sm.on) {
      sm.t += rdt;
      const total = sm.dur + sm.fade * 2;
      if (sm.t >= total) sm.on = false;
      else { slowAmt = sm.t < sm.fade ? sm.t / sm.fade : sm.t > sm.fade + sm.dur ? 1 - (sm.t - sm.fade - sm.dur) / sm.fade : 1; ts = 1 + (sm.scale - 1) * slowAmt; }
      this.dismountT = sm.on ? total - sm.t : 0;
    } else this.dismountT = 0;
    if (pl.dead) { ts = 0.28; slowAmt = 1; }
    let weaponDt = rdt;
    if (this.hitstop > 0) { this.hitstop -= rdt; ts *= 0.03; weaponDt = rdt * 0.03; }
    this.timeScale = ts;
    this.vfx.slowmo = pl.dead ? 0.6 : slowAmt;
    this.audio.setSlowmo(Math.round(slowAmt * 5) / 5);
    const sdt = rdt * ts;
    this.time += sdt;

    // Physik im festen 120-Hz-Takt, Rendering interpoliert dazwischen
    this.acc += sdt;
    let n = 0;
    while (this.acc >= FIXED && n < CONFIG.maxTicksPerFrame) { pl.fixedUpdate(FIXED); this.acc -= FIXED; n++; }
    if (n === CONFIG.maxTicksPerFrame) this.acc = 0;
    pl.interpolate(this.acc / FIXED);

    this.world.update(pl.pos.x, pl.pos.z);
    this.rails.update(sdt);
    this.weapons.update(weaponDt, sdt);
    this.enemies.update(sdt);
    if (this.state === GS.PLAYING && !pl.dead) { this.score.update(sdt); this.updateTutorial(rdt); }
    this.cam.update(rdt);
    U.uTime.value += rdt * (0.25 + 0.75 * ts); U.uBeat.value = this.audio.pulse;
    this.audio.update(rdt);
    this.vfx.update(rdt, sdt);
    if (this.state === GS.PLAYING) { this.ui.update(rdt); this.vfx.adaptResolution(rdt, this.fps); }
    if (pl.dead && this.state === GS.PLAYING) { this.deadT += rdt; if (this.deadT > 2.0) this.showGameOver(); }
    this.vfx.render();
  }
}

function boot() {
  try {
    const game = new Game();
    window.__game = game;
    game.init();
  } catch (err) {
    console.error(err);
    const d = document.createElement('div'); d.id = 'fatal';
    d.innerHTML = '<div><b style="color:#ff3b3b;font-size:20px">RAILBREAKER konnte nicht starten.</b><br><br>Dein Browser braucht WebGL 2.<br><small>' + String(err && err.message || err) + '</small></div>';
    document.body.appendChild(d);
    window.__railbreakerBooted = true;
  }
}
boot();
