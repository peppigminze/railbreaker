// ScoreSystem: Flow-Meter, Combos, Punkte, Highscore, Ghost-Recording und -Wiedergabe.
import * as THREE from 'three';
import { CONFIG, STATE } from './config.js';
import { clamp, Store, wrapAngle } from './util.js';
import { Ribbon } from './vfx.js';

const F = CONFIG.flow, SC = CONFIG.score, GH = CONFIG.ghost;
const MAX_SAMPLES = GH.rate * GH.maxSeconds;
const STRIDE = 5;

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b) {
  const s = atob(b), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export class ScoreSystem {
  constructor(game) {
    this.game = game;
    this.rec = new Int16Array(MAX_SAMPLES * STRIDE);
    this.recScore = new Int32Array(GH.maxSeconds + 2);
    this.ghost = null;
    this.high = Store.get('high', { score: 0, speed: 0, wave: 0 });
    this.waveTimes = Store.get('waveTimes', {});
    this.reset('');
  }

  init(scene) {
    // Ghost: halbtransparente Silhouette mit Trail
    const mat = new THREE.MeshBasicMaterial({ color: 0x9ff4ff, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ghostMesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.85, 3, 8), mat); body.position.y = 0.8;
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.24, 1), mat); head.position.y = 1.62;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })); visor.position.set(0, 1.64, -0.2);
    this.ghostMesh.add(body, head, visor);
    this.ghostMesh.visible = false;
    scene.add(this.ghostMesh);
    this.ghostTrail = new Ribbon(scene, 0x7fe9ff, 40);
  }

  reset(seedStr) {
    this.seedStr = seedStr;
    this.score = 0; this.flow = 0; this.overdrive = false; this.odT = 0; this.rank = 0; this.mult = 1;
    this.combo = 0; this.comboT = 0; this.longestCombo = 0;
    this.kills = 0; this.topSpeed = 0; this.grindDist = 0; this.runTime = 0; this.bestRank = 0;
    this.multiCount = 0; this.multiT = 0; this.speedAcc = 0; this.highAcc = 0; this.grindAcc = 0;
    this.recN = 0; this.recT = 0; this.recLast = [0, 0, 0]; this.recOrigin = [0, 0, 0];
    this.ghostDelta = null; this.newRecord = false;
    this.loadGhost(seedStr);
    if (this.ghostTrail) this.ghostTrail.clear();
  }

  // ---------------------------------------------------------------- Punkte & Flow
  add(points, label, flowGain) {
    const g = this.game;
    if (flowGain) {
      if (this.overdrive) this.odT = Math.min(F.overdriveTime, this.odT + F.overdriveExtend * Math.min(1.5, flowGain * 3));   // Overdrive verlängern
      else {
        this.flow += flowGain;
        if (this.flow >= 5) { this.flow = 5; this.overdrive = true; this.odT = F.overdriveTime; g.onOverdrive(true); }
      }
    }
    this.updateRank();
    const pts = Math.round(points * this.mult);
    this.score += pts;
    if (label) {
      this.combo++; this.comboT = SC.comboWindow;
      if (this.combo > this.longestCombo) this.longestCombo = this.combo;
      g.ui.scorePopup(label, pts, this.combo);
    }
  }
  updateRank() {
    const r = this.overdrive ? 4 : Math.min(4, Math.floor(this.flow));
    if (r !== this.rank) { if (r > this.rank && r > 0) this.game.onRankUp(r); this.rank = r; }
    if (r > this.bestRank) this.bestRank = r;
    this.mult = r + 1;
  }

  onKill(type, name, air, grind, pierce, slow) {
    this.kills++;
    let pts = pierce ? SC.pierceKill : SC.kill;
    if (type === 4) pts = 2500; else if (type === 3) pts *= 3; else if (type === 1 || type === 2) pts *= 1.5;
    let label = pierce ? 'RAIL-PIERCE ' + name : name + ' KILL';
    if (grind) { pts *= 1 + SC.grindKill; label = 'GRIND-KILL'; }
    else if (air) { pts *= 1 + SC.airKill; label = 'AIR-KILL'; }
    if (pierce) label = 'RAIL-PIERCE';
    this.add(pts, label, 0.34 + (pierce ? 0.15 : 0));
    if (slow) this.add(SC.perfectDismount, 'PERFECT DISMOUNT', 0.4);
    // Multikill
    if (this.multiT > 0) {
      this.multiCount++;
      const names = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL'];
      this.add(SC.multiKill * (this.multiCount - 1), names[this.multiCount] || ('MULTIKILL x' + this.multiCount), 0.1);
    } else this.multiCount = 1;
    this.multiT = SC.multiWindow;
  }
  onHit() { if (this.overdrive) this.odT = Math.min(F.overdriveTime, this.odT + 0.04); else this.flow = Math.min(4.999, this.flow + 0.012); }
  closeCall() { this.add(SC.closeCall, 'CLOSE CALL', 0.25); this.game.audio.play('closeCall'); }
  onDamage() {
    if (!this.overdrive) this.flow = Math.max(0, this.flow - F.damageLoss);
    else this.odT -= 1.5;
    this.updateRank();
  }

  // ---------------------------------------------------------------- Update
  update(dt) {
    const g = this.game, pl = g.player;
    this.runTime += dt;
    const sp = pl.speed;
    if (sp > this.topSpeed) this.topSpeed = sp;
    // Flow leert sich langsam – schnell, wenn man stehen bleibt
    if (this.overdrive) {
      this.odT -= dt;
      if (this.odT <= 0) { this.overdrive = false; this.flow = 4.0; g.onOverdrive(false); }
    } else {
      const idle = sp < F.idleSpeed;
      this.flow = Math.max(0, this.flow - (idle ? F.idleDecay : F.decay * (1 + this.flow * 0.25)) * dt);
    }
    // Speed-Bonus: konstante Punkte pro Sekunde über 30 m/s
    if (sp > SC.speedBonusMin) {
      this.speedAcc += dt;
      if (!this.overdrive) this.flow = Math.min(5, this.flow + 0.16 * dt);
      if (this.speedAcc >= 1) { this.speedAcc -= 1; this.add(SC.speedPerSec, null, 0.001); g.ui.scorePopup('SPEED', Math.round(SC.speedPerSec * this.mult), 0, true); }
    }
    // Hohe Routen geben mehr Punkte
    const ch = g.world.chunkAt(pl.pos.x, pl.pos.z);
    if (ch && pl.pos.y > ch.hubY + 11 && sp > 16) {
      this.highAcc += dt;
      if (this.highAcc >= 1) { this.highAcc -= 1; this.add(SC.highLinePerSec, null, 0.05); g.ui.scorePopup('HIGH LINE', Math.round(SC.highLinePerSec * this.mult), 0, true); }
    }
    // Grind-Distanz: Punkte pro Meter
    if (pl.state === STATE.GRINDING) {
      const m = pl.grindSpeed * dt;
      this.grindDist += m; this.grindAcc += m;
      if (!this.overdrive) this.flow = Math.min(5, this.flow + m * 0.0075);
      if (this.grindAcc >= 10) { this.grindAcc -= 10; this.add(SC.grindPerMeter * 10, null, 0.001); }
    }
    if (this.flow >= 5 && !this.overdrive) { this.overdrive = true; this.odT = F.overdriveTime; g.onOverdrive(true); }
    this.updateRank();
    if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; }
    if (this.multiT > 0) this.multiT -= dt;
    g.audio.targetIntensity = this.overdrive ? 5 : this.flow;
    this.record(dt);
    this.playGhost(dt);
  }

  // ---------------------------------------------------------------- Ghost
  // Aufzeichnung mit 20 Hz. Positionen in cm, als Delta zum vorherigen Sample (Int16) -> kompakt genug für localStorage.
  record(dt) {
    const pl = this.game.player;
    this.recT += dt;
    const step = 1 / GH.rate;
    while (this.recT >= step && this.recN < MAX_SAMPLES) {
      this.recT -= step;
      const x = Math.round(pl.pos.x * 100), y = Math.round(pl.pos.y * 100), z = Math.round(pl.pos.z * 100);
      const o = this.recN * STRIDE, r = this.rec;
      if (this.recN === 0) { this.recOrigin = [x, y, z]; r[o] = 0; r[o + 1] = 0; r[o + 2] = 0; }
      else { r[o] = clamp(x - this.recLast[0], -32767, 32767); r[o + 1] = clamp(y - this.recLast[1], -32767, 32767); r[o + 2] = clamp(z - this.recLast[2], -32767, 32767); }
      this.recLast[0] += r[o]; this.recLast[1] += r[o + 1]; this.recLast[2] += r[o + 2];
      if (this.recN === 0) { this.recLast[0] = x; this.recLast[1] = y; this.recLast[2] = z; }
      r[o + 3] = Math.round(wrapAngle(pl.yaw) / Math.PI * 32767);
      r[o + 4] = pl.state | (Math.round((pl.pitch / 1.6) * 100 + 128) << 3);
      if (this.recN % GH.rate === 0) this.recScore[this.recN / GH.rate] = this.score;
      this.recN++;
    }
  }

  saveGhost() {
    if (this.recN < GH.rate * 3) return;
    const key = 'ghost.' + this.seedStr;
    const old = Store.get(key, null);
    if (old && old.score >= this.score) return;
    const u8 = new Uint8Array(this.rec.buffer, 0, this.recN * STRIDE * 2);
    const secs = Math.floor((this.recN - 1) / GH.rate) + 1;
    Store.set(key, { score: this.score, n: this.recN, o: this.recOrigin, d: toB64(u8), s: Array.from(this.recScore.subarray(0, secs)) });
    // nur die letzten Seeds behalten (Speicherplatz)
    let seeds = Store.get('ghostSeeds', []).filter((s) => s !== this.seedStr);
    seeds.push(this.seedStr);
    while (seeds.length > 4) Store.del('ghost.' + seeds.shift());
    Store.set('ghostSeeds', seeds);
  }

  loadGhost(seedStr) {
    this.ghost = null;
    if (this.ghostMesh) this.ghostMesh.visible = false;
    if (!seedStr) return;
    const data = Store.get('ghost.' + seedStr, null);
    if (!data || !data.d) return;
    try {
      const u8 = fromB64(data.d);
      const i16 = new Int16Array(u8.buffer, 0, Math.floor(u8.length / 2));
      const n = Math.min(data.n, Math.floor(i16.length / STRIDE));
      const pos = new Float32Array(n * 3), yaw = new Float32Array(n), st = new Uint8Array(n);
      let x = data.o[0], y = data.o[1], z = data.o[2];
      for (let i = 0; i < n; i++) {
        x += i16[i * STRIDE]; y += i16[i * STRIDE + 1]; z += i16[i * STRIDE + 2];
        pos[i * 3] = x / 100; pos[i * 3 + 1] = y / 100; pos[i * 3 + 2] = z / 100;
        yaw[i] = i16[i * STRIDE + 3] / 32767 * Math.PI; st[i] = i16[i * STRIDE + 4] & 7;
      }
      this.ghost = { n, pos, yaw, st, scores: data.s || [], score: data.score };
    } catch (e) { this.ghost = null; }
  }

  playGhost(dt) {
    const gh = this.ghost;
    if (!gh) { this.ghostDelta = null; return; }
    const f = this.runTime * GH.rate, i = Math.floor(f);
    if (i >= gh.n - 1) { this.ghostMesh.visible = false; this.ghostTrail.update(dt, false, 0, 0, 0, 1.2); this.ghostDelta = this.score - gh.score; return; }
    const t = f - i, p = gh.pos;
    const x = p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * t, y = p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * t, z = p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * t;
    const m = this.ghostMesh;
    m.visible = true; m.position.set(x, y, z);
    m.rotation.y = gh.yaw[i] + wrapAngle(gh.yaw[i + 1] - gh.yaw[i]) * t;
    m.scale.y = gh.st[i] === STATE.SLIDING ? 0.55 : 1;
    const sp = Math.hypot(p[i * 3 + 3] - p[i * 3], p[i * 3 + 4] - p[i * 3 + 1], p[i * 3 + 5] - p[i * 3 + 2]) * GH.rate;
    this.ghostTrail.update(dt, sp > 18, x, y + 0.8, z, 1.2);
    // Indikator: liegt man nach Punkten vorne oder hinten?
    const si = Math.min(gh.scores.length - 1, Math.floor(this.runTime));
    const s0 = gh.scores[si] || 0, s1 = gh.scores[Math.min(gh.scores.length - 1, si + 1)] || s0;
    this.ghostDelta = this.score - (s0 + (s1 - s0) * (this.runTime - Math.floor(this.runTime)));
  }

  waveCleared(wave, time) {
    const old = this.waveTimes[wave];
    const best = !old || time < old;
    if (best) { this.waveTimes[wave] = Math.round(time * 100) / 100; Store.set('waveTimes', this.waveTimes); }
    return { best, old };
  }

  finalize(wave) {
    this.newRecord = this.score > this.high.score;
    const h = this.high;
    if (this.newRecord) h.score = this.score;
    if (this.topSpeed > h.speed) h.speed = Math.round(this.topSpeed * 10) / 10;
    if (wave > h.wave) h.wave = wave;
    Store.set('high', h);
    this.saveGhost();
    return this.newRecord;
  }
}
