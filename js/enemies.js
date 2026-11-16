// EnemyManager: Pooling, AI (Swarmer-Boids, Sniper, Cutter, Bulwark, Warden-Boss), Projektile, Wellen auf Beats.
import * as THREE from 'three';
import { CONFIG, STATE } from './config.js';
import { InstBatch, makeLitMaterial, makeGlowMaterial } from './vfx.js';
import { mulberry32, clamp, damp, lerp, wrapAngle, smoothstep } from './util.js';

const E = CONFIG.enemies;
export const ET = { SWARMER: 0, SNIPER: 1, CUTTER: 2, BULWARK: 3, WARDEN: 4 };
const NAMES = ['SWARMER', 'SNIPER', 'CUTTER', 'BULWARK', 'WARDEN'];
const BEAT = 60 / CONFIG.audio.bpm;
const HALF_SQRT = Math.SQRT1_2;

function makeEnemy() {
  return {
    uid: 0, type: 0, alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, hp: 0, maxHp: 0, radius: 1,
    st: 0, t: 0, yaw: 0, flash: 0, age: 0, aiming: false, cool: 0, ax: 0, ay: 0, az: -1, px: 0, py: 0, pz: 0,
    orbit: 0, rail: null, hover: false, spin: 0,
    // Warden
    baseY: 0, rot: 0, weakHp: new Float32Array(4), sweepSt: 0, sweepT: 0, sweepA: 0, sweepY: 0, sweepDir: 1, sweepHit: false,
    sweepCool: 0, swarmCool: 0, shockCool: 0, collider: null, far: 0,
  };
}

export class EnemyManager {
  constructor(game) {
    this.game = game;
    this.pool = []; this.active = [];
    for (let i = 0; i < E.maxAlive; i++) this.pool.push(makeEnemy());
    this.proj = []; for (let i = 0; i < 96; i++) this.proj.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, dmg: 0, minD: 99, called: false, sx: 0, sy: 0, sz: 0 });
    this.portals = []; for (let i = 0; i < 32; i++) this.portals.push({ alive: false, x: 0, y: 0, z: 0, openAt: 0, spawnAt: 0, type: 0, count: 0, hp: 0 });
    this.shocks = []; for (let i = 0; i < 6; i++) this.shocks.push({ alive: false, x: 0, y: 0, z: 0, r: 0, hit: false });
    this.uid = 1; this.rng = Math.random;
    this.hit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, col: null };
    this.tmp = { x: 0, y: 0, z: 0, d2: 0 };
    this.sp = { x: 0, y: 0, z: 0 };
    this.boss = null;
    this.wave = 0; this.state = 'idle'; this.spawnQueue = []; this.beatsLeft = 0; this.spawnBeat = 0; this.spawnEvery = 2;
    this.pauseT = 0; this.waveTime = 0; this.running = false; this.aggro = 1;
  }

  init(scene) {
    const lit = makeLitMaterial(this.game.world), glow = makeGlowMaterial();
    const B = (geo, mat, cap) => new InstBatch(geo, mat, cap, scene);
    this.bOcta = B(new THREE.OctahedronGeometry(1, 0), lit, 128);
    this.bPyr = B(new THREE.CylinderGeometry(0.35, 0.95, 2.4, 4), lit, 16);
    this.bTorus = B(new THREE.TorusGeometry(1, 0.16, 4, 10), lit, 48);
    this.bDodeca = B(new THREE.DodecahedronGeometry(1, 0), lit, 16);
    this.bCyl = B(new THREE.CylinderGeometry(1, 1, 1, 6), lit, 24);
    this.bOrb = B(new THREE.IcosahedronGeometry(1, 0), lit, 100);
    const bg = new THREE.BoxGeometry(1, 1, 1); bg.translate(0, 0, 0.5);
    this.bBeam = B(bg, glow, 40);
    this.bShield = B(new THREE.CircleGeometry(1, 6), glow, 16);
    this.bRing = B(new THREE.TorusGeometry(1, 0.035, 5, 28), glow, 48);
  }

  reset(seed) {
    for (const e of this.active) { e.alive = false; if (e.collider) { this.game.world.removeDynamic(e.collider); e.collider = null; } this.pool.push(e); }
    this.active.length = 0;
    for (const p of this.proj) p.alive = false;
    for (const p of this.portals) p.alive = false;
    for (const s of this.shocks) s.alive = false;
    this.rng = mulberry32((seed ^ 0x51ED270B) >>> 0);
    this.boss = null; this.wave = 0; this.state = 'idle'; this.spawnQueue.length = 0; this.running = false; this.waveTime = 0;
  }

  startRun() { this.running = true; this.state = 'countdown'; this.beatsLeft = CONFIG.waves.firstDelayBeats; this.wave = 0; }

  get remaining() {
    let n = this.active.length;
    for (const q of this.spawnQueue) n += q.count;
    for (const p of this.portals) if (p.alive) n += p.count;
    return n;
  }
  get pendingPortals() { let n = 0; for (const p of this.portals) if (p.alive) n++; return n; }

  // ---------------------------------------------------------------- Wellen
  buildWave(n) {
    const q = this.spawnQueue; q.length = 0;
    const boss = n % CONFIG.waves.bossEvery === 0;
    const tier = n - Math.floor(n / CONFIG.waves.bossEvery);       // Boss-Wellen zählen nicht zur Eskalation
    const groups = boss ? 1 : Math.min(4, 1 + Math.floor(tier / 2));
    const size = clamp(5 + tier, 6, 12);
    const snipers = tier >= 2 ? Math.min(4, 1 + Math.floor((tier - 2) / 2)) : 0;
    const cutters = tier >= 3 ? Math.min(3, 1 + Math.floor((tier - 3) / 3)) : 0;
    const bulwarks = tier >= 4 ? Math.min(3, 1 + Math.floor((tier - 4) / 3)) : 0;
    const list = [];
    if (boss) list.push({ type: ET.WARDEN, count: 1 });
    for (let i = 0; i < groups; i++) list.push({ type: ET.SWARMER, count: size });
    for (let i = 0; i < (boss ? 0 : snipers); i++) list.push({ type: ET.SNIPER, count: 1 });
    for (let i = 0; i < (boss ? 1 : cutters); i++) list.push({ type: ET.CUTTER, count: 1 });
    for (let i = 0; i < (boss ? 0 : bulwarks); i++) list.push({ type: ET.BULWARK, count: 1 });
    // mischen (Boss bleibt vorne), dann als Stack ablegen
    for (let i = list.length - 1; i > (boss ? 1 : 0); i--) { const j = (boss ? 1 : 0) + Math.floor(this.rng() * (i + 1 - (boss ? 1 : 0))); const t = list[i]; list[i] = list[j]; list[j] = t; }
    for (let i = list.length - 1; i >= 0; i--) q.push(list[i]);
    this.spawnEvery = n >= 6 ? 1 : 2;
    this.aggro = Math.min(1.6, 1 + 0.035 * (n - 1));
  }

  startWave() {
    this.wave++;
    this.buildWave(this.wave);
    this.state = 'spawning'; this.spawnBeat = -1; this.waveTime = 0;
    this.game.onWaveStart(this.wave, this.wave % CONFIG.waves.bossEvery === 0);
  }

  // Gegner erscheinen auf Beats: Portal öffnet sich über genau einen Takt, dann Spawn (wieder auf dem Beat)
  onBeat(beat) {
    if (!this.running || this.game.player.dead) return;
    if (this.state === 'countdown') { if (--this.beatsLeft <= 0) this.startWave(); return; }
    if (this.state === 'spawning') {
      this.spawnBeat++;
      if (this.spawnBeat % this.spawnEvery === 0 && this.spawnQueue.length) {
        const it = this.spawnQueue.pop();
        this.openPortal(it.type, it.count, 0);
      }
      if (!this.spawnQueue.length) this.state = 'active';
    }
  }

  spawnPoint(minD, maxD, yOff, out) {
    const pl = this.game.player, w = this.game.world;
    let dx, dz;
    if (pl.speedH > 4) { dx = pl.vel.x / pl.speedH; dz = pl.vel.z / pl.speedH; } else { dx = -Math.sin(pl.yaw); dz = -Math.cos(pl.yaw); }
    const a = (this.rng() - 0.5) * 1.2, c = Math.cos(a), s = Math.sin(a);
    const rx = dx * c - dz * s, rz = dx * s + dz * c;
    const d = minD + this.rng() * (maxD - minD);
    out.x = pl.pos.x + rx * d; out.z = pl.pos.z + rz * d;
    out.y = Math.max(pl.pos.y + yOff, CONFIG.player.killY + 14);
    for (let k = 0; k < 8 && w.pointSolid(out.x, out.y, out.z); k++) out.y += 5;
    return out;
  }

  openPortal(type, count, hp) {
    let p = null;
    for (const q of this.portals) if (!q.alive) { p = q; break; }
    if (!p) return;
    const g = this.game, pl = g.player, sp = this.sp;
    if (type === ET.SNIPER) {
      // Sniper stehen auf Dächern: Sitzplatz vor dem Spieler suchen, sonst schwebend
      let dx, dz;
      if (pl.speedH > 4) { dx = pl.vel.x / pl.speedH; dz = pl.vel.z / pl.speedH; } else { dx = -Math.sin(pl.yaw); dz = -Math.cos(pl.yaw); }
      let best = null, bs = 1e9;
      for (const ch of g.world.chunks.values()) for (const pc of ch.perches) {
        const ex = pc.x - pl.pos.x, ez = pc.z - pl.pos.z, d = Math.hypot(ex, ez);
        if (d < 30 || d > 105) continue;
        let taken = false;
        for (const e of this.active) if (e.type === ET.SNIPER && Math.hypot(e.x - pc.x, e.z - pc.z) < 6) { taken = true; break; }
        if (taken) continue;
        const sc = Math.abs(d - 60) - (ex * dx + ez * dz) / d * 30 + this.rng() * 25;
        if (sc < bs) { bs = sc; best = pc; }
      }
      if (best) { sp.x = best.x; sp.y = best.y + 1.3; sp.z = best.z; p.hover = false; }
      else { this.spawnPoint(45, 70, 10, sp); p.hover = true; }
    } else if (type === ET.WARDEN) {
      // Boss steht auf einer Chunk-Ecke (dort ist garantiert Luft)
      const S = CONFIG.world.chunkSize;
      this.spawnPoint(62, 80, 0, sp);
      const cx = Math.floor(sp.x / S), cz = Math.floor(sp.z / S);
      sp.x = cx * S + S / 2; sp.z = cz * S + S / 2;
      const w = g.world;
      sp.y = (w.hubHeight(cx, cz) + w.hubHeight(cx + 1, cz) + w.hubHeight(cx, cz + 1) + w.hubHeight(cx + 1, cz + 1)) / 4 - 13;
    } else if (type === ET.BULWARK) this.spawnPoint(48, 68, 7, sp);
    else if (type === ET.CUTTER) this.spawnPoint(40, 60, 9, sp);
    else this.spawnPoint(E.spawnMin + 6, E.spawnMax, 6 + this.rng() * 7, sp);
    p.alive = true; p.x = sp.x; p.y = sp.y; p.z = sp.z; p.type = type; p.count = count; p.hp = hp || 0;
    p.openAt = g.audio.now(); p.spawnAt = p.openAt + BEAT * 4;
    g.audio.play3D(type === ET.WARDEN ? 'wardenHorn' : 'portal', p.x, p.y, p.z);
  }

  spawn(type, x, y, z, hp, hover) {
    if (!this.pool.length) return null;
    const e = this.pool.pop();
    e.uid = this.uid++; e.type = type; e.alive = true; e.x = x; e.y = y; e.z = z; e.vx = e.vy = e.vz = 0;
    e.st = 0; e.t = 0; e.flash = 0; e.age = 0; e.aiming = false; e.rail = null; e.yaw = this.rng() * 6.28; e.spin = this.rng() * 6.28;
    e.orbit = this.rng() * 6.28; e.hover = !!hover; e.far = 0;
    const pl = this.game.player;
    switch (type) {
      case ET.SWARMER: e.maxHp = E.swarmer.hp; e.radius = E.swarmer.radius; break;
      case ET.SNIPER: e.maxHp = E.sniper.hp; e.radius = E.sniper.radius; e.t = 0.8 + this.rng() * 1.2; e.px = pl.pos.x; e.py = pl.pos.y + 1; e.pz = pl.pos.z; break;
      case ET.CUTTER: e.maxHp = E.cutter.hp; e.radius = E.cutter.radius; break;
      case ET.BULWARK: e.maxHp = E.bulwark.hp; e.radius = E.bulwark.radius; e.cool = 1.5 + this.rng(); e.yaw = Math.atan2(pl.pos.x - x, pl.pos.z - z); break;
      case ET.WARDEN: {
        const W = E.warden;
        e.maxHp = W.hp; e.radius = W.radius; e.baseY = y; e.rot = 0;
        for (let i = 0; i < 4; i++) e.weakHp[i] = W.hp / 4;
        e.sweepSt = 0; e.sweepCool = 4; e.swarmCool = 6; e.shockCool = 5;
        e.collider = this.game.world.addDynamic({ minX: x - 3.3, maxX: x + 3.3, minZ: z - 3.3, maxZ: z + 3.3, minY: y - 70, maxY: y + W.height, ramp: false, noWall: true });
        this.boss = e;
        break;
      }
    }
    e.hp = hp > 0 ? hp : e.maxHp;
    this.active.push(e);
    return e;
  }

  remove(e) {
    if (!e.alive) return;
    e.alive = false;
    const i = this.active.indexOf(e);
    if (i >= 0) { this.active[i] = this.active[this.active.length - 1]; this.active.pop(); }
    if (e.collider) { this.game.world.removeDynamic(e.collider); e.collider = null; }
    if (this.boss === e) this.boss = null;
    this.pool.push(e);
  }

  // ---------------------------------------------------------------- Treffer
  weakPos(e, i, out) {
    const W = E.warden, a = e.rot + i * Math.PI / 2;
    out.x = e.x + Math.cos(a) * (W.radius + 0.4); out.y = e.baseY + W.weakHeights[i]; out.z = e.z + Math.sin(a) * (W.radius + 0.4);
    return out;
  }

  raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
    const lx = cx - ox, ly = cy - oy, lz = cz - oz;
    const tca = lx * dx + ly * dy + lz * dz;
    if (tca < 0) return -1;
    const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
    if (d2 > r * r) return -1;
    return Math.max(0, tca - Math.sqrt(r * r - d2));
  }

  raycast(ox, oy, oz, dx, dy, dz, maxT, out) {
    let best = maxT, found = false;
    const tmp = this.tmp;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.type === ET.WARDEN) {
        for (let k = 0; k < 4; k++) {
          if (e.weakHp[k] <= 0) continue;
          this.weakPos(e, k, tmp);
          const t = this.raySphere(ox, oy, oz, dx, dy, dz, tmp.x, tmp.y, tmp.z, E.warden.weakRadius);
          if (t >= 0 && t < best) {
            best = t; found = true; out.enemy = e; out.weak = true; out.part = k;
            out.blocked = Math.hypot(tmp.x - ox, tmp.y - oy, tmp.z - oz) > E.warden.closeRange;
          }
        }
        continue;
      }
      // etwas grosszügigere Trefferkugeln: bei 30+ m/s soll Treffen Spass machen
      let t = this.raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y, e.z, e.radius * 1.15);
      if (t >= 0 && t < best) {
        best = t; found = true; out.enemy = e; out.weak = false; out.blocked = false; out.part = -1;
        if (e.type === ET.BULWARK) {
          // Frontschild: nur von hinten, von oben oder per Rail-Pierce verwundbar
          const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
          const sx = ox - e.x, sy = oy - e.y, sz = oz - e.z, sl = Math.hypot(sx, sy, sz) || 1;
          const front = (sx * fx + sz * fz) / sl > 0.2, above = sy / sl > 0.5;
          out.blocked = front && !above;
        }
      }
      if (e.type === ET.SNIPER) {
        t = this.raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y + 1.6, e.z, 0.6);
        if (t >= 0 && t <= best + 0.5) { best = t; found = true; out.enemy = e; out.weak = true; out.blocked = false; out.part = -1; }
      } else if (e.type === ET.BULWARK) {
        const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
        t = this.raySphere(ox, oy, oz, dx, dy, dz, e.x - fx * 1.7, e.y, e.z - fz * 1.7, 0.85);
        if (t >= 0 && t <= best + 0.3 && !(out.enemy === e && out.blocked)) { best = t; found = true; out.enemy = e; out.weak = true; out.blocked = false; out.part = -1; }
      }
    }
    if (found) { out.t = best; out.x = ox + dx * best; out.y = oy + dy * best; out.z = oz + dz * best; }
    return found;
  }

  onBlocked(e) {
    e.flash = 0.3;
    if (e.type === ET.WARDEN) this.game.ui.hint('bossRange', 'ZU WEIT WEG – BAU DIR MIT DER RAIL-GUN EINE SPIRALE NACH OBEN', 3);
    else if (e.type === ET.BULWARK) this.game.ui.hint('shield', 'SCHILD! VON HINTEN, VON OBEN ODER MIT DER RAIL-SPITZE ANGREIFEN', 3);
  }

  damage(e, amount, weak, source, x, y, z, part) {
    if (!e.alive) return;
    const g = this.game;
    e.flash = 1;
    let dead = false;
    if (e.type === ET.WARDEN) {
      if (part < 0 || e.weakHp[part] <= 0) return;
      e.weakHp[part] -= amount;
      if (e.weakHp[part] <= 0) {
        e.weakHp[part] = 0;
        g.vfx.explosion(x, y, z, 1, 0.8, 0.2, 3); g.vfx.spawnShards(x, y, z, 16, 1, 0.7, 0.1, 0, 0, 0, 2);
        g.audio.play('explode'); g.cam.addTrauma(0.45);
        g.score.add(500, 'WEAKPOINT ZERSTÖRT', 0.8);
      }
      e.hp = e.weakHp[0] + e.weakHp[1] + e.weakHp[2] + e.weakHp[3];
      dead = e.hp <= 0;
    } else { e.hp -= amount; dead = e.hp <= 0; }
    g.ui.damageNumber(x, y, z, amount, weak, dead);
    g.ui.hitmarker(dead, weak);
    g.score.onHit(amount);
    if (source === 'pierce') g.audio.play('pierce'); else g.audio.play(weak ? 'weak' : 'hit');
    if (dead) this.kill(e, source);
  }

  kill(e, source) {
    const g = this.game, pl = g.player;
    const big = e.type === ET.WARDEN ? 8 : e.type === ET.BULWARK ? 2.5 : e.type === ET.SWARMER ? 0.8 : 1.3;
    const cy = e.type === ET.WARDEN ? e.baseY + 30 : e.y;
    g.vfx.explosion(e.x, cy, e.z, 1.0, 0.4, 0.1, big);
    g.vfx.spawnShards(e.x, cy, e.z, Math.round(7 + big * 5), 1.0, 0.3, 0.08, e.vx, e.vy, e.vz, 0.8 + big * 0.3);
    if (e.type === ET.WARDEN) {
      for (let i = 0; i < 6; i++) { g.vfx.explosion(e.x + (Math.random() - 0.5) * 8, e.baseY + i * 9, e.z + (Math.random() - 0.5) * 8, 1, 0.5, 0.1, 4); }
      g.vfx.spawnShards(e.x, e.baseY + 25, e.z, 60, 0.9, 0.15, 0.1, 0, 6, 0, 3);
      g.cam.addTrauma(1);
    }
    g.audio.play('kill');
    g.hitStop(0.05);                // 50 ms Hit-Stop
    g.cam.addTrauma(0.16 + big * 0.04);
    g.weapons.addEnergy(CONFIG.railgun.killEnergy);
    const air = pl.state === STATE.AIRBORNE || pl.state === STATE.DASHING || pl.state === STATE.WALLRUNNING;
    g.score.onKill(e.type, NAMES[e.type], air, pl.state === STATE.GRINDING, source === 'pierce', g.dismountT > 0);
    this.remove(e);
  }

  // Rail-Gun-Spitze: Pierce-Damage an allem, was sie berührt (ignoriert Schilde und Reichweiten-Schutz)
  pierceAt(x, y, z, r, rail) {
    const tmp = this.tmp;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      if (e.type === ET.WARDEN) {
        for (let k = 0; k < 4; k++) {
          if (e.weakHp[k] <= 0 || rail.pierced.has(e.uid * 8 + k)) continue;
          this.weakPos(e, k, tmp);
          if (Math.hypot(tmp.x - x, tmp.y - y, tmp.z - z) < r + E.warden.weakRadius) {
            rail.pierced.add(e.uid * 8 + k);
            this.damage(e, CONFIG.railgun.pierceDamage * E.warden.pierceMult, true, 'pierce', tmp.x, tmp.y, tmp.z, k);
            if (!e.alive) break;
          }
        }
        continue;
      }
      if (rail.pierced.has(e.uid * 8)) continue;
      if (Math.hypot(e.x - x, e.y - y, e.z - z) < r + e.radius) {
        rail.pierced.add(e.uid * 8);
        this.damage(e, CONFIG.railgun.pierceDamage, false, 'pierce', e.x, e.y, e.z, -1);
      }
    }
  }

  fireOrb(x, y, z, tx, ty, tz, speed, dmg) {
    for (const p of this.proj) {
      if (p.alive) continue;
      const dx = tx - x, dy = ty - y, dz = tz - z, l = Math.hypot(dx, dy, dz) || 1;
      p.alive = true; p.x = x; p.y = y; p.z = z; p.vx = dx / l * speed; p.vy = dy / l * speed; p.vz = dz / l * speed;
      p.life = 7; p.dmg = dmg; p.minD = 99; p.called = false; p.sx = x; p.sy = y; p.sz = z;
      return;
    }
  }

  // ---------------------------------------------------------------- Update
  update(dt) {
    const g = this.game, pl = g.player, w = g.world, tmp = this.tmp;
    const px = pl.pos.x, py = pl.pos.y + 1.0, pz = pl.pos.z;
    const alive = !pl.dead;
    const now = g.audio.now();
    if (this.running && alive && (this.state === 'spawning' || this.state === 'active')) this.waveTime += dt;

    // Portale
    for (const p of this.portals) {
      if (!p.alive || now < p.spawnAt) continue;
      p.alive = false;
      if (!alive) continue;
      g.audio.play3D('spawn', p.x, p.y, p.z);
      g.vfx.burst(p.x, p.y, p.z, 20, 9, 1, 0.4, 0.1, 0.25, 0.4, 0, 2);
      if (p.type === ET.SWARMER) {
        for (let i = 0; i < p.count; i++) {
          const e = this.spawn(ET.SWARMER, p.x + (this.rng() - 0.5) * 5, p.y + (this.rng() - 0.5) * 4, p.z + (this.rng() - 0.5) * 5, p.hp);
          if (e) { e.vx = (this.rng() - 0.5) * 8; e.vy = (this.rng() - 0.5) * 6; e.vz = (this.rng() - 0.5) * 8; }
        }
      } else this.spawn(p.type, p.x, p.y, p.z, p.hp, p.hover);
    }

    // Welle geschafft?
    if (this.running && alive && this.state === 'active' && this.active.length === 0 && this.pendingPortals === 0) {
      this.state = 'pause'; this.pauseT = CONFIG.waves.pause;
      g.onWaveCleared(this.wave, this.waveTime);
    }
    if (this.state === 'pause') { this.pauseT -= dt; if (this.pauseT <= 0) { this.state = 'countdown'; this.beatsLeft = 1; } }

    const S = E.swarmer, SN = E.sniper, CU = E.cutter, BU = E.bulwark;
    const act = this.active;
    for (let i = act.length - 1; i >= 0; i--) {
      const e = act[i];
      e.age += dt; e.flash = Math.max(0, e.flash - dt * 6);
      const dx = px - e.x, dy = py - e.y, dz = pz - e.z;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      // Abgehängte Gegner kommen per Portal wieder vor den Spieler (endlose Welt, Wellen bleiben schaffbar)
      if (dist > E.leashDist && alive) {
        e.far += dt;
        if (e.far > (e.type === ET.WARDEN ? 5 : 1.2)) {
          const type = e.type, hp = e.hp, wk = e.type === ET.WARDEN ? Array.from(e.weakHp) : null;
          this.remove(e);
          this.openPortal(type, 1, hp);
          if (wk) this.pendingWeak = wk;
          continue;
        }
      } else e.far = 0;

      switch (e.type) {
        case ET.SWARMER: {
          // Boids: Separation, Alignment, Cohesion + Ziel Spieler; weicht Player-Rails und Gebäuden aus
          let sx = 0, sy = 0, sz = 0, ax = 0, ay = 0, az = 0, cx = 0, cy = 0, cz = 0, n = 0;
          for (let j = 0; j < act.length; j++) {
            const o = act[j];
            if (o === e || o.type !== ET.SWARMER) continue;
            const ox = e.x - o.x, oy = e.y - o.y, oz = e.z - o.z, d2 = ox * ox + oy * oy + oz * oz;
            if (d2 > 100) continue;
            if (d2 < 9 && d2 > 1e-4) { const inv = 1 / d2; sx += ox * inv; sy += oy * inv; sz += oz * inv; }
            ax += o.vx; ay += o.vy; az += o.vz; cx += o.x; cy += o.y; cz += o.z; n++;
          }
          const speed = S.speed * this.aggro * (e.st === 1 ? 1.35 : 1);
          const lead = Math.min(0.5, dist / 40);
          let tx = px + pl.vel.x * lead - e.x, ty = py + pl.vel.y * lead - e.y, tz = pz + pl.vel.z * lead - e.z;
          const tl = Math.hypot(tx, ty, tz) || 1;
          let fx = (tx / tl * speed - e.vx) * 2.2 + sx * 26, fy = (ty / tl * speed - e.vy) * 2.2 + sy * 26, fz = (tz / tl * speed - e.vz) * 2.2 + sz * 26;
          if (n > 0) {
            fx += (ax / n - e.vx) * 0.5 + (cx / n - e.x) * 0.35; fy += (ay / n - e.vy) * 0.5 + (cy / n - e.y) * 0.35; fz += (az / n - e.vz) * 0.5 + (cz / n - e.z) * 0.35;
          }
          if (g.rails.nearestPlayerRail(e.x, e.y, e.z, tmp) && tmp.d2 < 20) {
            const d = Math.sqrt(tmp.d2) || 0.1, k = (4.5 - d) * 18 / d;
            fx += (e.x - tmp.x) * k; fy += (e.y - tmp.y) * k + 6; fz += (e.z - tmp.z) * k;
          }
          if (w.pointSolid(e.x + e.vx * 0.3, e.y + e.vy * 0.3, e.z + e.vz * 0.3)) { fy += 90; fx -= e.vx * 3; fz -= e.vz * 3; }
          const fl = Math.hypot(fx, fy, fz);
          if (fl > S.accel * 2.2) { const k = S.accel * 2.2 / fl; fx *= k; fy *= k; fz *= k; }
          e.vx += fx * dt; e.vy += fy * dt; e.vz += fz * dt;
          const vl = Math.hypot(e.vx, e.vy, e.vz);
          if (vl > speed) { const k = speed / vl; e.vx *= k; e.vy *= k; e.vz *= k; }
          e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
          if (w.pointSolid(e.x, e.y, e.z)) { e.y += 14 * dt; e.x -= e.vx * dt; e.z -= e.vz * dt; }
          e.spin += dt * 9;
          if (e.st === 0) {
            if (dist < S.armDist && alive && e.age > 0.4) { e.st = 1; e.t = S.armTime; e.aiming = true; g.audio.play3D('swarmerArm', e.x, e.y, e.z); }
          } else {
            // Kamikaze: 0,5 s Rotblinken, dann Explosion
            e.t -= dt;
            if (e.t <= 0) {
              g.vfx.explosion(e.x, e.y, e.z, 1.0, 0.25, 0.05, 1.4); g.audio.play3D('explode', e.x, e.y, e.z);
              if (dist < S.blastRadius && alive) pl.damage(S.damage * (1 - dist / S.blastRadius * 0.5), e.x, e.y, e.z);
              else if (dist < S.blastRadius + 4 && alive) g.score.closeCall();
              this.remove(e);
            }
          }
          break;
        }
        case ET.SNIPER: {
          const eyeY = e.y + 1.6;
          if (e.hover) e.y += Math.sin(e.age * 1.3 + e.orbit) * 0.4 * dt;
          if (e.st === 0) {
            e.aiming = false;
            e.t -= dt;
            if (e.t <= 0 && alive && dist < SN.range) {
              const ex = px - e.x, ey = py - eyeY, ez = pz - e.z, el = Math.hypot(ex, ey, ez) || 1;
              if (!w.raycast(e.x, eyeY, e.z, ex / el, ey / el, ez / el, el - 0.5, this.hit)) {
                e.st = 1; e.t = SN.aimTime / Math.min(1.25, this.aggro); e.cool = e.t; e.px = px; e.py = py; e.pz = pz;
                g.audio.play3D('sniperCharge', e.x, eyeY, e.z, e.t);
              } else e.t = 0.4;
            }
          } else {
            // Sichtbarer Laser, folgt dem Spieler leicht verzögert; kurz vor dem Schuss fixiert er (rot blinkend)
            e.aiming = true;
            e.t -= dt;
            if (e.t > SN.lockTime) { const k = 1 - Math.exp(-9 * dt); e.px += (px - e.px) * k; e.py += (py - e.py) * k; e.pz += (pz - e.pz) * k; }
            let ax = e.px - e.x, ay = e.py - eyeY, az = e.pz - e.z; const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
            e.ax = ax; e.ay = ay; e.az = az;
            const ex = px - e.x, ey = py - eyeY, ez = pz - e.z, el = Math.hypot(ex, ey, ez) || 1;
            const blocked = w.raycast(e.x, eyeY, e.z, ex / el, ey / el, ez / el, el - 0.5, this.hit);
            if (blocked || !alive) { e.st = 0; e.t = 1.0; e.aiming = false; break; }      // Sichtlinie unterbrochen: Schuss bricht ab
            if (e.t <= 0) {
              // Abstand Spieler <-> Strahl
              const tca = ex * ax + ey * ay + ez * az;
              const d2 = el * el - tca * tca;
              const endT = w.raycast(e.x, eyeY, e.z, ax, ay, az, 260, this.hit) ? this.hit.t : 260;
              g.vfx.tracer(e.x, eyeY, e.z, e.x + ax * endT, eyeY + ay * endT, e.z + az * endT, 1.0, 0.15, 0.1, 0.16);
              g.audio.play3D('sniperFire', e.x, eyeY, e.z);
              if (tca > 0 && tca < endT + 1 && d2 < SN.beamRadius * SN.beamRadius) pl.damage(SN.damage, e.x, eyeY, e.z);
              else if (d2 < 16) g.score.closeCall();
              e.st = 0; e.t = lerp(SN.idleMin, SN.idleMax, this.rng()) / this.aggro; e.aiming = false;
            }
          }
          break;
        }
        case ET.CUTTER: {
          // Fliegt gezielt zu Player-Rails und zerschneidet sie
          let rail = null;
          if (pl.state === STATE.GRINDING && pl.grindRail && pl.grindRail.type === 1) {
            rail = pl.grindRail; pl.grindRail.posAt(clamp(pl.grindS + pl.grindDir * 10, 0, rail.length), tmp);
          } else rail = g.rails.nearestPlayerRail(e.x, e.y, e.z, tmp);
          let tx, ty, tz;
          if (rail) { tx = tmp.x; ty = tmp.y + 0.4; tz = tmp.z; }
          else { e.orbit += dt * 0.7; tx = px + Math.cos(e.orbit) * 17; ty = py + 7; tz = pz + Math.sin(e.orbit) * 17; e.st = 0; e.t = 0; }
          const ex = tx - e.x, ey = ty - e.y, ez = tz - e.z, el = Math.hypot(ex, ey, ez) || 1;
          const sp = CU.speed * this.aggro * (el < 3 ? el / 3 : 1);
          const k = 1 - Math.exp(-3.5 * dt);
          e.vx += (ex / el * sp - e.vx) * k; e.vy += (ey / el * sp - e.vy) * k; e.vz += (ez / el * sp - e.vz) * k;
          if (w.pointSolid(e.x + e.vx * 0.4, e.y + e.vy * 0.4, e.z + e.vz * 0.4)) e.vy += 60 * dt;
          e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
          e.spin += dt * (e.st === 1 ? 40 : 14);
          e.aiming = false;
          if (rail && el < 1.8) {
            if (e.st === 0 || e.rail !== rail) { e.st = 1; e.t = 0; e.rail = rail; g.audio.play3D('cutter', e.x, e.y, e.z); if (pl.grindRail === rail) g.ui.popup('CUTTER AN DEINER RAIL!', 'warn'); }
            e.t += dt * this.aggro; e.aiming = true;
            g.vfx.impact(tmp.x, tmp.y, tmp.z, 0, 1, 0, 1.0, 0.6, 0.1, 2);
            if (e.t >= CU.cutTime) { g.audio.play3D('railCut', e.x, e.y, e.z); g.rails.destroyRail(rail, true); e.st = 0; e.rail = null; }
          } else if (e.st === 1 && (!rail || !rail.alive || el > 4)) { e.st = 0; e.rail = null; }
          break;
        }
        case ET.BULWARK: {
          // Langsamer Schwebepanzer: hält Abstand, dreht sich träge zum Spieler (-> flankierbar)
          const hd = Math.hypot(dx, dz) || 1;
          const want = hd > 34 ? 1 : hd < 22 ? -1 : 0;
          const k = 1 - Math.exp(-2 * dt);
          e.vx += (dx / hd * want * BU.speed - e.vx) * k; e.vz += (dz / hd * want * BU.speed - e.vz) * k;
          e.vy += (clamp((py + 4 - e.y), -3, 3) - e.vy) * k;
          if (w.pointSolid(e.x + e.vx, e.y - 2.2, e.z + e.vz) || w.pointSolid(e.x, e.y - 2.2, e.z)) e.vy = 5;
          e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
          const ty = Math.atan2(dx, dz);
          e.yaw += clamp(wrapAngle(ty - e.yaw), -BU.turnRate * dt, BU.turnRate * dt);
          e.cool -= dt * this.aggro;
          const facing = Math.cos(wrapAngle(ty - e.yaw)) > 0.6;
          if (e.cool <= BU.telegraph && e.st === 0 && alive && facing && dist < 110) { e.st = 1; e.aiming = true; g.audio.play3D('bulwarkCharge', e.x, e.y, e.z); }
          if (e.cool <= 0) {
            if (e.st === 1 && alive) {
              const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
              const tt = dist / BU.orbSpeed * 0.7;
              this.fireOrb(e.x + fx * 2.4, e.y, e.z + fz * 2.4, px + pl.vel.x * tt, py + pl.vel.y * tt * 0.5, pz + pl.vel.z * tt, BU.orbSpeed * Math.min(1.3, this.aggro), BU.orbDamage);
              g.audio.play3D('bulwarkFire', e.x, e.y, e.z);
            }
            e.st = 0; e.aiming = false; e.cool = BU.fireEvery;
          }
          break;
        }
        case ET.WARDEN: this.updateWarden(e, dt, px, py, pz, dist, alive); break;
      }
    }

    // Projektile
    for (const p of this.proj) {
      if (!p.alive) continue;
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const ex = px - p.x, ey = py - p.y, ez = pz - p.z, d = Math.hypot(ex, ey, ez);
      if (d < p.minD) p.minD = d;
      if (alive && d < 1.25) { p.alive = false; g.vfx.explosion(p.x, p.y, p.z, 1, 0.4, 0.1, 0.8); pl.damage(p.dmg, p.sx, p.sy, p.sz); continue; }
      // "Close Call": knapp vorbei und schon wieder auf dem Weg weg
      if (!p.called && p.minD < 3.2 && d > p.minD + 1.5 && alive) { p.called = true; g.score.closeCall(); }
      if (p.life <= 0 || w.pointSolid(p.x, p.y, p.z)) { p.alive = false; g.vfx.burst(p.x, p.y, p.z, 8, 6, 1, 0.4, 0.1, 0.2, 0.3, 0, 2); }
    }

    // Schockwellen (Boss): treffen nur, wer am Boden steht
    for (const s of this.shocks) {
      if (!s.alive) continue;
      s.r += 24 * dt;
      const hd = Math.hypot(px - s.x, pz - s.z);
      if (!s.hit && alive && Math.abs(hd - s.r) < 1.6 && (pl.state === STATE.GROUNDED || pl.state === STATE.SLIDING) && Math.abs(pl.pos.y - s.y) < 6) {
        s.hit = true; pl.damage(E.warden.shockDamage, s.x, s.y, s.z); g.cam.addTrauma(0.4);
      }
      if (s.r > 95) s.alive = false;
    }
    this.draw();
  }

  updateWarden(e, dt, px, py, pz, dist, alive) {
    const g = this.game, W = E.warden, pl = g.player;
    if (this.pendingWeak) { for (let i = 0; i < 4; i++) e.weakHp[i] = this.pendingWeak[i]; this.pendingWeak = null; e.hp = e.weakHp[0] + e.weakHp[1] + e.weakHp[2] + e.weakHp[3]; }
    let left = 0; for (let i = 0; i < 4; i++) if (e.weakHp[i] > 0) left++;
    const phase = 4 - left;                       // 0..3
    e.rot += dt * (0.3 + phase * 0.14);
    e.aiming = e.sweepSt > 0;
    if (!alive) return;
    // Phase 1+: Laser-Sweeps (1 s Telegraph als dünner Strahl, dann rotierender Schnitt auf Spielerhöhe)
    if (e.sweepSt === 0) {
      e.sweepCool -= dt;
      if (e.sweepCool <= 0 && dist < 130) {
        e.sweepSt = 1; e.sweepT = 1.0; e.sweepDir = this.rng() < 0.5 ? 1 : -1; e.sweepHit = false;
        e.sweepA = Math.atan2(pz - e.z, px - e.x) - e.sweepDir * 0.9;
        e.sweepY = clamp(py, e.baseY + 3, e.baseY + W.height - 2);
        g.audio.play3D('wardenSweep', e.x, e.sweepY, e.z);
      }
    } else if (e.sweepSt === 1) {
      e.sweepT -= dt;
      if (e.sweepT <= 0) { e.sweepSt = 2; e.sweepT = 1.7; }
    } else {
      e.sweepT -= dt;
      e.sweepA += e.sweepDir * (1.8 / 1.7) * dt;
      const ca = Math.cos(e.sweepA), sa = Math.sin(e.sweepA);
      const rx = px - e.x, rz = pz - e.z;
      const along = rx * ca + rz * sa, perp = Math.abs(-rx * sa + rz * ca);
      if (!e.sweepHit && along > 0 && along < 95 && perp < 1.4 && Math.abs(py - e.sweepY) < 1.5) { e.sweepHit = true; pl.damage(W.sweepDamage, e.x, e.sweepY, e.z); }
      if (e.sweepT <= 0) { e.sweepSt = 0; e.sweepCool = 5.5 - phase * 0.8; if (!e.sweepHit && dist < 60) g.score.closeCall(); }
    }
    // Phase 2+: Swarmer-Spawns
    if (phase >= 1) {
      e.swarmCool -= dt;
      if (e.swarmCool <= 0) {
        e.swarmCool = 10 - phase;
        if (this.active.length < 34) {
          let p = null; for (const q of this.portals) if (!q.alive) { p = q; break; }
          if (p) {
            const a = this.rng() * 6.28;
            p.alive = true; p.type = ET.SWARMER; p.count = 4 + phase; p.hp = 0;
            p.x = e.x + Math.cos(a) * 12; p.z = e.z + Math.sin(a) * 12; p.y = clamp(py + 6, e.baseY + 8, e.baseY + W.height);
            p.openAt = g.audio.now(); p.spawnAt = p.openAt + BEAT * 4;
            g.audio.play3D('portal', p.x, p.y, p.z);
          }
        }
      }
    }
    // Phase 3+: Schockwellen am Boden
    if (phase >= 2) {
      e.shockCool -= dt;
      if (e.shockCool <= 0 && dist < 110) {
        e.shockCool = 7.5 - phase;
        for (const s of this.shocks) if (!s.alive) { s.alive = true; s.x = e.x; s.z = e.z; s.y = pl.pos.y; s.r = 4; s.hit = false; break; }
        g.audio.play3D('shock', e.x, py, e.z);
        g.ui.popup('SCHOCKWELLE – SPRING!', 'warn');
      }
    }
  }

  // ---------------------------------------------------------------- Rendering (Instanz-Batches)
  draw() {
    const g = this.game, time = g.time, now = g.audio.now(), tmp = this.tmp;
    const octa = this.bOcta, pyr = this.bPyr, tor = this.bTorus, dod = this.bDodeca, cyl = this.bCyl, orb = this.bOrb, beam = this.bBeam, sh = this.bShield, ring = this.bRing;
    octa.begin(); pyr.begin(); tor.begin(); dod.begin(); cyl.begin(); orb.begin(); beam.begin(); sh.begin(); ring.begin();
    const pl = g.player;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      const pop = Math.min(1, e.age * 5), fl = e.flash;
      switch (e.type) {
        case ET.SWARMER: {
          const vl = Math.hypot(e.vx, e.vy, e.vz) || 1;
          const blink = e.st === 1 ? (Math.sin(time * 50) > 0 ? 1 : 0) : 0;
          octa.pushLook(e.x, e.y, e.z, e.vx / vl, e.vy / vl, e.vz / vl, 0.42 * pop, 0.42 * pop, 0.85 * pop, 1.0, 0.36 - blink * 0.3, 0.07, fl * 0.8 + blink * 0.7, e.spin);
          break;
        }
        case ET.SNIPER: {
          const hy = Math.sin(e.yaw * 0 + time * 0.8) * 0;
          pyr.push(e.x, e.y + hy, e.z, 0, Math.sin(time * 0.3 + e.orbit), 0, Math.cos(time * 0.3 + e.orbit), pop, pop, pop, 0.85, 0.1, 0.1, fl);
          const charge = e.st === 1 ? 1 : 0;
          octa.push(e.x, e.y + 1.6, e.z, 0, Math.sin(time * 2), 0, Math.cos(time * 2), 0.45 * pop, 0.55 * pop, 0.45 * pop, 1.0, 0.75, 0.15, fl + charge * 0.35);
          if (e.st === 1) {
            // Laser: orange, in den letzten 0,45 s rot blinkend
            const late = e.t < 0.45, on = !late || Math.sin(time * 70) > 0;
            const len = Math.hypot(e.px - e.x, e.py - (e.y + 1.6), e.pz - e.z) + 4;
            const wd = late ? 0.09 : 0.04;
            if (on) beam.pushLook(e.x, e.y + 1.6, e.z, e.ax, e.ay, e.az, wd, wd, len, 1.0, late ? 0.08 : 0.45, 0.05, late ? 1 : 0.7);
          }
          break;
        }
        case ET.CUTTER: {
          const c = Math.cos(e.spin * 0.5), s = Math.sin(e.spin * 0.5);
          // Torus liegt in der XY-Ebene: erst flach legen (90° um X), dann um Y drehen
          const qx = HALF_SQRT * c, qy = HALF_SQRT * s, qz = -HALF_SQRT * s, qw = HALF_SQRT * c;
          const hot = e.st === 1 ? 1 : 0;
          tor.push(e.x, e.y, e.z, qx, qy, qz, qw, 0.95 * pop, 0.95 * pop, 0.6 * pop, 1.0, 0.5 - hot * 0.3, 0.02, fl + hot * 0.4);
          octa.push(e.x, e.y, e.z, 0, s, 0, c, 0.3 * pop, 0.5 * pop, 0.3 * pop, 1.0, 0.85, 0.5, fl);
          break;
        }
        case ET.BULWARK: {
          const c = Math.cos(e.yaw * 0.5), s = Math.sin(e.yaw * 0.5);
          const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw), tele = e.st === 1 ? 1 : 0;
          dod.push(e.x, e.y, e.z, 0, s, 0, c, 1.8 * pop, 1.5 * pop, 1.8 * pop, 0.75, 0.13, 0.05, fl + tele * 0.25);
          octa.push(e.x - fx * 1.7, e.y, e.z - fz * 1.7, 0, Math.sin(time * 3), 0, Math.cos(time * 3), 0.6 * pop, 0.6 * pop, 0.6 * pop, 1.0, 0.85, 0.2, fl + 0.2);
          sh.pushLook(e.x + fx * 2.1, e.y, e.z + fz * 2.1, fx, 0, fz, 2.7 * pop, 2.7 * pop, 1, 1.0, 0.45, 0.12, 0.3 + fl * 0.5 + tele * 0.3, time * 0.5);
          if (tele) orb.push(e.x + fx * 2.4, e.y, e.z + fz * 2.4, 0, 0, 0, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.1, 0.8);
          break;
        }
        case ET.WARDEN: {
          const W = E.warden, H = W.height;
          const c = Math.cos(e.rot * 0.5), s = Math.sin(e.rot * 0.5);
          cyl.push(e.x, e.baseY - 40, e.z, 0, 0, 0, 1, 3.6, 80, 3.6, 0.2, 0.04, 0.08, 0);
          for (let k = 0; k < 4; k++) {
            const r = k % 2 ? 3.7 : 4.4;
            cyl.push(e.x, e.baseY + (k + 0.5) * H / 4, e.z, 0, k % 2 ? s : -s, 0, c, r * pop, H / 4, r * pop, 0.62, 0.08, 0.1, fl * 0.3);
          }
          octa.push(e.x, e.baseY + H + 3, e.z, 0, s, 0, c, 4 * pop, 6 * pop, 4 * pop, 0.9, 0.15, 0.1, fl * 0.3 + (e.sweepSt ? 0.5 : 0));
          for (let k = 0; k < 4; k++) {
            this.weakPos(e, k, tmp);
            const aliveW = e.weakHp[k] > 0;
            const pulse = 0.25 + 0.2 * Math.sin(time * 6 + k);
            if (aliveW) octa.push(tmp.x, tmp.y, tmp.z, 0, Math.sin(time * 2 + k), 0, Math.cos(time * 2 + k), 1.6, 2.0, 1.6, 1.0, 0.85, 0.15, pulse + fl * 0.6);
            const a = time * (k % 2 ? 1.2 : -1.2);
            tor.push(e.x, e.baseY + W.weakHeights[k], e.z, HALF_SQRT * Math.cos(a), HALF_SQRT * Math.sin(a), -HALF_SQRT * Math.sin(a), HALF_SQRT * Math.cos(a), 5.4, 5.4, 2.2, aliveW ? 1.0 : 0.25, aliveW ? 0.4 : 0.08, 0.05, 0);
          }
          if (e.sweepSt > 0) {
            const tele = e.sweepSt === 1, wd = tele ? 0.12 : 0.9;
            beam.pushLook(e.x, e.sweepY, e.z, Math.cos(e.sweepA), 0, Math.sin(e.sweepA), wd, wd, 95, 1.0, tele ? 0.5 : 0.12, 0.08, tele ? 0.6 : 1);
          }
          break;
        }
      }
    }
    for (const p of this.proj) if (p.alive) orb.push(p.x, p.y, p.z, 0, 0, 0, 1, 0.55, 0.55, 0.55, 1.0, 0.3, 0.05, 0.6);
    // Portale: Ring öffnet sich über einen Takt, zeigt zum Spieler
    for (const p of this.portals) {
      if (!p.alive) continue;
      const f = clamp((now - p.openAt) / (p.spawnAt - p.openAt), 0, 1);
      let dx = pl.pos.x - p.x, dy = pl.pos.y + 1 - p.y, dz = pl.pos.z - p.z; const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      const big = p.type === ET.WARDEN ? 9 : p.type === ET.SWARMER ? 3.2 : 2.2;
      const r = big * (0.15 + 0.85 * f * f);
      ring.pushLook(p.x, p.y, p.z, dx, dy, dz, r, r, r, 1.0, 0.35, 0.1, 0.5 + f * 0.5, time * 2);
      ring.pushLook(p.x, p.y, p.z, dx, dy, dz, r * 0.7, r * 0.7, r, 1.0, 0.15, 0.3, 0.3 + f * 0.4, -time * 3);
    }
    for (const s of this.shocks) {
      if (!s.alive) continue;
      const a = clamp(1.2 - s.r / 95, 0, 1);
      ring.pushLook(s.x, s.y + 0.3, s.z, 0, 1, 0, s.r, s.r, 14, 1.0, 0.3, 0.1, a);
      ring.pushLook(s.x, s.y + 0.9, s.z, 0, 1, 0, s.r * 0.985, s.r * 0.985, 8, 1.0, 0.6, 0.2, a * 0.6);
    }
    octa.end(); pyr.end(); tor.end(); dod.end(); cyl.end(); orb.end(); beam.end(); sh.end(); ring.end();
  }
}
