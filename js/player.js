// PlayerController: State-Machine (GROUNDED, AIRBORNE, SLIDING, WALLRUNNING, GRINDING, DASHING),
// läuft im festen 120-Hz-Tick. Leitsatz: Momentum wird bei jedem Übergang erhalten.
import * as THREE from 'three';
import { CONFIG, STATE } from './config.js';
import { clamp, damp } from './util.js';

const P = CONFIG.player, SL = CONFIG.slide, WR = CONFIG.wallrun, DA = CONFIG.dash, RC = CONFIG.rail, RG = CONFIG.railgun;

export class PlayerController {
  constructor(game) {
    this.game = game;
    this.pos = new THREE.Vector3(); this.prevPos = new THREE.Vector3(); this.renderPos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.res = game.world.makeResult();
    this.probe = { y: 0, ground: null, gnx: 0, gny: 1, gnz: 0 };
    this.wallInfo = { col: null, nx: 0, nz: 0, dist: 0 };
    this.T = { x: 0, y: 0, z: 0 }; this.Q = { x: 0, y: 0, z: 0 };
    this.dashDir = new THREE.Vector3();
    this.god = false;
    this.reset(0, 50, 0);
  }

  init() {}

  reset(x, y, z) {
    this.pos.set(x, y, z); this.prevPos.copy(this.pos); this.renderPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.yaw = 0; this.pitch = 0;
    this.state = STATE.AIRBORNE; this.prevState = STATE.AIRBORNE;
    this.h = P.height;
    this.gnx = 0; this.gny = 1; this.gnz = 0;
    this.hp = P.maxHp; this.dead = false; this.sinceHit = 99; this.iframes = 0;
    this.jumpBuf = 0; this.coyote = 0; this.airTime = 0; this.landGrace = 0;
    this.djump = true; this.slideCd = 0; this.stepDist = 0;
    this.dashCharges = DA.charges; this.dashRecharge = 0; this.dashT = 0; this.dashPrevSpeed = 0;
    this.wallT = 0; this.wallSpeed = 0; this.wallNx = 0; this.wallNz = 0; this.wallTx = 0; this.wallTz = 0;
    this.wallCol = null; this.lastWallCol = null; this.wallCd = 0; this.wallSide = 0; this.wallChain = 0; this.wallVy = 0;
    this.grindRail = null; this.grindS = 0; this.grindDir = 1; this.grindSpeed = 0; this.grindLean = 0; this.grindMeters = 0;
    this.lastRail = null; this.railCd = 0; this.hopTimer = 0; this.pumpCd = 0; this.grindCurve = 0;
    this.speed = 0; this.speedH = 0; this.wishX = 0; this.wishZ = 0; this.hasInput = false;
    this.slideHeld = false; this.time = 0;
  }

  lookDir(out) {
    const cp = Math.cos(this.pitch);
    out.x = -Math.sin(this.yaw) * cp; out.y = Math.sin(this.pitch); out.z = -Math.cos(this.yaw) * cp;
    return out;
  }

  accelerate(wx, wz, wishSpeed, accel, dt) {
    const v = this.vel;
    const add = wishSpeed - (v.x * wx + v.z * wz);
    if (add <= 0) return;
    let a = accel * dt; if (a > add) a = add;
    v.x += wx * a; v.z += wz * a;
  }

  // ------------------------------------------------------------------ Haupt-Tick
  fixedUpdate(dt) {
    const g = this.game, inp = g.input, v = this.vel;
    this.prevPos.copy(this.pos);
    this.time += dt;
    if (this.dead) {
      v.y -= P.gravity * dt; v.x *= 1 - 1.5 * dt; v.z *= 1 - 1.5 * dt;
      g.world.moveCapsule(this.pos, v, dt, P.radius, 0.9, false, this.res);
      return;
    }
    const od = g.score.overdrive ? CONFIG.flow.overdriveSpeed : 1;
    this.od = od;
    this.prevState = this.state;

    if (inp.consume('jump')) this.jumpBuf = P.jumpBuffer; else if (this.jumpBuf > 0) this.jumpBuf -= dt;
    const slidePressed = inp.consume('slide');
    this.slideHeld = inp.isDown('slide');
    this.slideCd -= dt; this.wallCd -= dt; this.railCd -= dt; this.landGrace -= dt; this.iframes -= dt;
    this.hopTimer -= dt; this.pumpCd -= dt;
    if (this.dashCharges < DA.charges) {
      this.dashRecharge += dt;
      if (this.dashRecharge >= DA.recharge) { this.dashCharges++; this.dashRecharge = 0; }
    }
    this.sinceHit += dt;
    if (this.sinceHit > P.regenDelay && this.hp < P.maxHp) this.hp = Math.min(P.maxHp, this.hp + P.regenRate * dt);

    const ix = inp.axisX(), iz = inp.axisZ();
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = -sy * iz + cy * ix, wz = -cy * iz - sy * ix;
    const wl = Math.hypot(wx, wz);
    this.hasInput = wl > 0.01;
    if (this.hasInput) { wx /= wl; wz /= wl; }
    this.wishX = wx; this.wishZ = wz; this.inX = ix; this.inZ = iz;

    if (inp.consume('dash') && this.dashCharges > 0 && this.state !== STATE.DASHING) this.startDash();

    switch (this.state) {
      case STATE.GROUNDED: this.tickGround(dt, slidePressed); break;
      case STATE.SLIDING: this.tickSlide(dt); break;
      case STATE.AIRBORNE: this.tickAir(dt); break;
      case STATE.WALLRUNNING: this.tickWall(dt); break;
      case STATE.GRINDING: this.tickGrind(dt); break;
      case STATE.DASHING: this.tickDash(dt); break;
    }
    inp.pressed.forward = false; inp.pressed.back = false;

    this.speedH = Math.hypot(v.x, v.z);
    this.speed = Math.hypot(v.x, v.y, v.z);
    if (this.pos.y < P.killY) this.die('fall');
  }

  move(dt, grounded) {
    const r = this.game.world.moveCapsule(this.pos, this.vel, dt, P.radius, this.h, grounded, this.res);
    if (r.stepUp > 0.03) this.game.cam.addOffset(0, -r.stepUp, 0);
    return r;
  }

  canStand() {
    return this.game.world.capsuleFree(this.pos.x, this.pos.y + 0.03, this.pos.z, P.radius - 0.03, P.height);
  }

  // ------------------------------------------------------------------ Boden
  tickGround(dt, slidePressed) {
    const v = this.vel, od = this.od;
    let sp = Math.hypot(v.x, v.z);
    const wishSpeed = (this.inZ > 0 ? P.sprintSpeed : P.walkSpeed) * od;
    if ((slidePressed || (this.slideHeld && this.landGrace > 0)) && sp >= SL.minSpeed) { this.startSlide(); this.tickSlide(dt); return; }
    // Reibung (Quake-Stil). Kurz nach der Landung keine, über Sprint-Tempo nur sanft: Momentum bleibt für Bunnyhops/Slides.
    if (this.landGrace <= 0 && sp > 0.001) {
      const over = sp > wishSpeed + 0.5 && this.hasInput;
      const fr = over ? P.overspeedFriction : P.friction;
      const control = sp < P.stopSpeed ? P.stopSpeed : sp;
      let ns = sp - control * fr * dt;
      if (over && ns < wishSpeed) ns = wishSpeed;
      if (ns < 0) ns = 0;
      v.x *= ns / sp; v.z *= ns / sp; sp = ns;
    }
    if (this.hasInput) this.accelerate(this.wishX, this.wishZ, wishSpeed, P.groundAccel, dt);
    // Geschwindigkeit folgt der Bodenebene; -1 m/s hält den Kontakt
    const slopeVy = -(this.gnx * v.x + this.gnz * v.z) / this.gny;
    v.y = slopeVy - 1;
    if (this.jumpBuf > 0) { this.groundJump(slopeVy); this.tickAirMove(dt); return; }
    this.move(dt, true);
    this.afterGroundMove(dt);
    if (this.state === STATE.GROUNDED) {
      this.stepDist += sp * dt;
      if (this.stepDist > 2.6) { this.stepDist = 0; this.game.audio.play('step', sp / 15); }
    }
  }

  afterGroundMove() {
    const res = this.res, v = this.vel;
    if (res.grounded) { this.gnx = res.gnx; this.gny = res.gny; this.gnz = res.gnz; this.checkPads(); return; }
    // Ground-Snap: Treppen runter / Gefälle folgen, statt bei jeder Kante abzuheben
    if (v.y <= 0.5 && this.game.world.probeGround(this.pos.x, this.pos.y, this.pos.z, P.radius, P.groundSnap, this.probe)) {
      this.game.cam.addOffset(0, this.pos.y - this.probe.y, 0);
      this.pos.y = this.probe.y;
      this.gnx = this.probe.gnx; this.gny = this.probe.gny; this.gnz = this.probe.gnz;
      return;
    }
    v.y += 1;
    this.state = STATE.AIRBORNE; this.coyote = P.coyote; this.airTime = 0;
    if (this.h !== P.height && this.canStand()) this.h = P.height;
  }

  groundJump(slopeVy) {
    const v = this.vel;
    v.y = clamp(slopeVy || 0, 0, 8) + P.jumpImpulse;
    this.state = STATE.AIRBORNE; this.jumpBuf = 0; this.coyote = 0; this.airTime = 0; this.landGrace = 0;
    if (this.h !== P.height && this.canStand()) this.h = P.height;
    this.game.audio.play('jump');
    this.game.onPlayerAction('jump');
  }

  // ------------------------------------------------------------------ Slide
  startSlide() {
    const v = this.vel;
    this.state = STATE.SLIDING; this.h = P.slideHeight;
    if (this.slideCd <= 0) {
      const sp = Math.hypot(v.x, v.z) || 1;
      v.x += v.x / sp * SL.boost; v.z += v.z / sp * SL.boost;
      this.slideCd = SL.cooldown;
      this.game.cam.fovKick(3);
    }
    this.game.audio.play('slide');
    this.game.onPlayerAction('slide');
  }

  tickSlide(dt) {
    const v = this.vel;
    let sp = Math.hypot(v.x, v.z);
    // fast keine Reibung; Hangabtrieb beschleunigt bergab
    const ns = Math.max(0, sp - sp * SL.friction * dt);
    if (sp > 0.001) { v.x *= ns / sp; v.z *= ns / sp; }
    v.x += P.gravity * this.gny * this.gnx * dt; v.z += P.gravity * this.gny * this.gnz * dt;
    if (this.hasInput) {
      // lenken ohne Tempoverlust
      const s0 = Math.hypot(v.x, v.z);
      v.x += this.wishX * SL.steer * dt; v.z += this.wishZ * SL.steer * dt;
      const s1 = Math.hypot(v.x, v.z) || 1;
      v.x *= s0 / s1; v.z *= s0 / s1;
    }
    sp = Math.hypot(v.x, v.z);
    const slopeVy = -(this.gnx * v.x + this.gnz * v.z) / this.gny;
    v.y = slopeVy - 1;
    if (this.jumpBuf > 0) { this.groundJump(slopeVy); this.game.onPlayerAction('slidejump'); this.tickAirMove(dt); return; }   // Slide-Jump: volles Tempo bleibt
    if ((!this.slideHeld || sp < SL.endSpeed) && this.canStand()) { this.state = STATE.GROUNDED; this.h = P.height; }
    this.move(dt, true);
    this.afterGroundMove(dt);
    if (this.state !== STATE.AIRBORNE && Math.random() < sp * dt * 2) this.game.vfx.slideSparks(this.pos, v);
  }

  // ------------------------------------------------------------------ Luft
  tickAir(dt) {
    const v = this.vel, od = this.od;
    this.airTime += dt; this.coyote -= dt;
    if (this.jumpBuf > 0) {
      if (this.coyote > 0) this.groundJump(0);
      else if (this.djump) this.doubleJump();
    }
    v.y -= P.gravity * dt;
    if (v.y < -75) v.y = -75;
    if (this.hasInput) {
      // Luftkontrolle: bis Sprint-Tempo normale Beschleunigung. Darüber dreht Input den Geschwindigkeitsvektor nur
      // (kein Tempoverlust in Kurven, Gegenrichtung bremst), sauberes Air-Strafing legt sogar leicht zu.
      const sp = Math.hypot(v.x, v.z), top = P.sprintSpeed * od;
      const maxSp = sp > top ? sp + P.airStrafeGain * dt : top;
      this.accelerate(this.wishX, this.wishZ, top, P.airAccel, dt);
      const ns = Math.hypot(v.x, v.z);
      if (ns > maxSp) { v.x *= maxSp / ns; v.z *= maxSp / ns; }
    }
    this.tickAirMove(dt);
  }

  tickAirMove(dt) {
    const v = this.vel, od = this.od;
    // weiche Geschwindigkeitsgrenze: sanfter Luftwiderstand statt hartem Cap
    const sp = Math.hypot(v.x, v.z), cap = P.softCap * od;
    if (sp > cap) { const ns = sp - (sp - cap) * P.softCapDrag * dt; v.x *= ns / sp; v.z *= ns / sp; }
    const vyBefore = v.y;
    this.move(dt, false);
    if (this.state !== STATE.AIRBORNE) return;
    if (this.res.grounded && v.y <= 2.5) { this.land(-vyBefore); return; }
    if (this.tryRailSnap()) return;
    this.tryWallrun();
  }

  doubleJump() {
    const v = this.vel;
    v.y = P.doubleJumpImpulse;
    if (this.hasInput) { v.x += this.wishX * P.doubleJumpSteer; v.z += this.wishZ * P.doubleJumpSteer; }
    this.djump = false; this.jumpBuf = 0;
    this.game.audio.play('djump');
    this.game.vfx.ring(this.pos.x, this.pos.y, this.pos.z, 0.1, 0.9, 1.0, 14);
    this.game.onPlayerAction('djump');
  }

  land(fallSpeed) {
    const g = this.game;
    this.gnx = this.res.gnx; this.gny = this.res.gny; this.gnz = this.res.gnz;
    this.djump = true; this.wallChain = 0; this.lastWallCol = null; this.airTime = 0;
    this.landGrace = P.landGrace;
    g.cam.land(fallSpeed);
    g.audio.play('land', clamp(fallSpeed / 30, 0.15, 1));
    if (fallSpeed > 7) g.vfx.ring(this.pos.x, this.pos.y + 0.05, this.pos.z, 0.75, 0.7, 1.0, Math.min(40, 10 + fallSpeed));
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (this.slideHeld && sp >= SL.minSpeed) this.startSlide();
    else { this.state = STATE.GROUNDED; if (this.h !== P.height && this.canStand()) this.h = P.height; }
    this.checkPads();
  }

  // ------------------------------------------------------------------ Dash
  startDash() {
    const v = this.vel, d = this.dashDir, g = this.game;
    this.dashPrevSpeed = Math.hypot(v.x, v.y, v.z);
    if (this.hasInput) d.set(this.wishX, 0, this.wishZ);
    else { this.lookDir(d); if ((this.state === STATE.GROUNDED || this.state === STATE.SLIDING) && d.y < 0) { d.y = 0; d.normalize(); } }
    if (this.state === STATE.GRINDING) this.leaveRail();
    if (this.h !== P.height && this.canStand()) this.h = P.height;
    this.state = STATE.DASHING; this.dashT = DA.time; this.dashCharges--; this.iframes = DA.time + 0.06;
    g.cam.fovKick(CONFIG.camera.dashFov); g.cam.addTrauma(0.12);
    g.audio.play('dash');
    g.vfx.dashBurst(this.pos, d);
    g.onPlayerAction('dash');
  }

  tickDash(dt) {
    const v = this.vel, d = this.dashDir;
    const sp = Math.max(DA.speed * this.od, this.dashPrevSpeed);
    v.set(d.x * sp, d.y * sp, d.z * sp);
    this.move(dt, false);
    this.dashT -= dt;
    this.game.vfx.dashTrail(this.pos, d);
    if (this.tryRailSnap()) return;
    if (this.dashT <= 0) {
      // Momentum: mindestens das alte Tempo, mindestens 18 m/s – in Dash-Richtung
      const out = Math.max(this.dashPrevSpeed, DA.exitMinSpeed);
      v.set(d.x * out, d.y * out, d.z * out);
      if (this.res.grounded) { this.state = STATE.GROUNDED; this.landGrace = P.landGrace; this.gnx = this.res.gnx; this.gny = this.res.gny; this.gnz = this.res.gnz; this.djump = true; }
      else { this.state = STATE.AIRBORNE; this.coyote = 0; }
    }
  }

  // ------------------------------------------------------------------ Wallrun
  tryWallrun() {
    const v = this.vel, w = this.game.world;
    if (this.airTime < WR.minAirTime) return false;
    const sp = Math.hypot(v.x, v.z);
    if (sp < WR.minSpeed) return false;
    if (!w.findWall(this.pos.x, this.pos.y, this.pos.z, P.radius, WR.maxDist, this.wallInfo)) return false;
    const info = this.wallInfo;
    if (info.col === this.lastWallCol && this.wallCd > 0) return false;
    const into = -(v.x * info.nx + v.z * info.nz);       // > 0: bewegt sich auf die Wand zu
    if (into < -1.5 || into > sp * 0.88) return false;   // weg von der Wand oder frontal dagegen
    // genug Luft unter den Füssen?
    if (w.probeGround(this.pos.x, this.pos.y, this.pos.z, P.radius, 0.9, this.probe)) return false;
    let tx = -info.nz, tz = info.nx;
    let along = v.x * tx + v.z * tz;
    if (along < 0) { tx = -tx; tz = -tz; along = -along; }
    this.wallNx = info.nx; this.wallNz = info.nz; this.wallTx = tx; this.wallTz = tz;
    this.wallSpeed = Math.max(along, sp * 0.92);
    this.wallVy = clamp(v.y * 0.6 + 2.2, -1.5, 6.5);
    this.wallT = 0; this.wallCol = info.col;
    this.wallEntry = this.wallSpeed;
    // Kameraneigung weg von der Wand
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    this.wallSide = (info.nx * rx + info.nz * rz) > 0 ? 1 : -1;
    this.state = STATE.WALLRUNNING;
    this.djump = true; this.dashCharges = DA.charges; this.dashRecharge = 0;
    if (info.col !== this.lastWallCol) this.wallChain++;
    this.game.audio.play('wallStart');
    this.game.onPlayerAction('wallrun', this.wallChain);
    return true;
  }

  tickWall(dt) {
    const v = this.vel, g = this.game;
    this.wallT += dt;
    const late = this.wallT > WR.maxTime * 0.7 ? 0.5 : 0;
    this.wallVy -= P.gravity * (WR.gravityScale + late) * dt;
    const target = Math.max(this.wallEntry, P.sprintSpeed * WR.speedBonus * this.od);
    if (this.wallSpeed < target) this.wallSpeed = Math.min(target, this.wallSpeed + WR.accel * dt);
    if (this.jumpBuf > 0) {
      // Wall-Jump: tangentiales Tempo bleibt, plus Stoss entlang der Wandnormalen und nach oben
      v.set(this.wallTx * this.wallSpeed + this.wallNx * WR.jumpOut, WR.jumpUp, this.wallTz * this.wallSpeed + this.wallNz * WR.jumpOut);
      this.endWallrun();
      this.jumpBuf = 0; this.djump = true;
      g.audio.play('wallJump');
      g.vfx.ring(this.pos.x, this.pos.y + 0.5, this.pos.z, 0.6, 0.4, 1.0, 12);
      g.onPlayerAction('walljump');
      this.tickAirMove(dt);
      return;
    }
    v.set(this.wallTx * this.wallSpeed - this.wallNx * 1.5, this.wallVy, this.wallTz * this.wallSpeed - this.wallNz * 1.5);
    this.move(dt, false);
    if (this.res.grounded) { this.endWallrun(); this.land(1); return; }
    const still = g.world.findWall(this.pos.x, this.pos.y, this.pos.z, P.radius, WR.maxDist + 0.35, this.wallInfo)
      && this.wallInfo.nx === this.wallNx && this.wallInfo.nz === this.wallNz;
    if (!still || this.wallT > WR.maxTime || this.inZ < 0) {
      v.set(this.wallTx * this.wallSpeed + this.wallNx * 2, this.wallVy, this.wallTz * this.wallSpeed + this.wallNz * 2);
      this.endWallrun();
      return;
    }
    v.set(this.wallTx * this.wallSpeed, this.wallVy, this.wallTz * this.wallSpeed);
    if (Math.random() < dt * 40) g.vfx.wallSparks(this.pos, this.wallNx, this.wallNz, this.wallTx, this.wallTz);
  }

  endWallrun() {
    this.lastWallCol = this.wallCol; this.wallCd = WR.sameWallCooldown;
    this.state = STATE.AIRBORNE; this.coyote = 0; this.airTime = WR.minAirTime;
    this.wallSide = 0;
  }

  // ------------------------------------------------------------------ Rails
  tryRailSnap() {
    const rails = this.game.rails;
    const rail = rails.findSnap(this.pos.x, this.pos.y + 0.4, this.pos.z, RC.snapDist, this.railCd > 0 ? this.lastRail : null);
    if (!rail) return false;
    this.enterGrind(rail, rails.snapS);
    return true;
  }

  enterGrind(rail, s) {
    const v = this.vel, T = this.T, g = this.game;
    rail.tanAt(s, T);
    const d = v.x * T.x + v.y * T.y + v.z * T.z;
    const total = Math.hypot(v.x, v.y, v.z);
    let dir = d >= 0 ? 1 : -1;
    if (Math.abs(d) < total * 0.2) {           // fast quer zur Rail: Blickrichtung entscheidet
      const L = this.lookDir(this.Q);
      dir = (L.x * T.x + L.y * T.y + L.z * T.z) >= 0 ? 1 : -1;
    }
    if (rail.growing) dir = 1;
    // Eintrittstempo auf die Tangente projiziert, aber nie unter 80 % des Gesamttempos und nie unter Minimum
    this.grindSpeed = Math.max(Math.abs(d), total * 0.8, RC.minSpeed * this.od);
    this.grindRail = rail; this.grindS = s; this.grindDir = dir; this.grindLean = 0; this.grindMeters = 0;
    const ox = this.pos.x, oy = this.pos.y, oz = this.pos.z;
    rail.posAt(s, this.Q);
    this.pos.set(this.Q.x, this.Q.y + RC.radius, this.Q.z);
    g.cam.addOffset(ox - this.pos.x, oy - this.pos.y, oz - this.pos.z);   // magnetisches Einrasten, Kamera easet nach
    this.state = STATE.GRINDING; this.h = P.height;
    this.djump = true; this.dashCharges = DA.charges; this.dashRecharge = 0;
    this.wallChain = 0; this.lastWallCol = null;
    g.input.pressed.forward = false; g.input.pressed.back = false;
    const hop = this.hopTimer > 0 && this.lastRail && rail !== this.lastRail;
    g.audio.play('railSnap');
    g.cam.addTrauma(0.1);
    g.onPlayerAction('grind', hop ? 1 : 0);
  }

  tickGrind(dt) {
    const g = this.game, v = this.vel, T = this.T, rail = this.grindRail;
    if (!rail || !rail.alive) { this.leaveRail(); this.state = STATE.AIRBORNE; return; }
    rail.tanAt(this.grindS, T);
    const dir = this.grindDir;
    let tx = T.x * dir, ty = T.y * dir, tz = T.z * dir;
    // Schwerkraftkomponente entlang der Tangente: Gefälle beschleunigt, Steigung bremst nur leicht
    let a = -P.gravity * ty;
    if (a < 0) a *= RC.uphillFactor;
    let sp = this.grindSpeed + a * dt;
    if (this.inZ > 0) sp += RC.holdAccel * dt; else if (this.inZ < 0) sp -= RC.brake * dt;
    // Speed-Pumping: W/S im Takt der Musik drücken
    if ((g.input.pressed.forward || g.input.pressed.back) && this.pumpCd <= 0) {
      this.pumpCd = RC.pumpCooldown;
      const onBeat = g.audio.beatError() < RC.pumpWindow;
      sp += onBeat ? RC.pumpOnBeat : RC.pumpOffBeat;
      g.onPlayerAction('pump', onBeat ? 1 : 0);
    }
    const minSp = RC.minSpeed * this.od, cap = P.softCap * this.od;
    if (sp < minSp) sp = minSp;
    if (sp > cap) sp -= (sp - cap) * P.softCapDrag * dt;
    this.grindSpeed = sp;
    let s = this.grindS + dir * sp * dt;
    this.grindMeters += sp * dt;
    this.grindLean = damp(this.grindLean, this.inX, 7, dt);

    if (this.jumpBuf > 0) { this.railJump(tx, ty, tz); return; }
    if (rail.growing) {
      if (s > rail.length - 0.4) s = Math.max(0, rail.length - 0.4);
    } else if ((dir > 0 && s >= rail.length) || (dir < 0 && s <= 0)) {
      // Rail-Ende: automatischer Absprung mit Zeitlupe
      v.set(tx * sp, ty * sp + RC.endJump, tz * sp);
      this.leaveRail();
      this.state = STATE.AIRBORNE; this.coyote = 0; this.airTime = 0;
      g.onPlayerAction('railend');
      return;
    }
    this.grindS = s;
    rail.posAt(s, this.Q);
    this.pos.set(this.Q.x, this.Q.y + RC.radius, this.Q.z);
    // Kurvenstärke (für Kamera-Lean): Änderung der Tangente
    rail.tanAt(s + dir * 1.5, this.Q);
    const rx = tz, rz = -tx;                       // Rechtsvektor relativ zur Fahrtrichtung (horizontal)
    this.grindCurve = damp(this.grindCurve, (this.Q.x * dir * rx + this.Q.z * dir * rz) * -6, 6, dt);
    v.set(tx * sp, ty * sp, tz * sp);
    g.weapons.addEnergy(RC.energyPerSec * dt);
    if (Math.random() < dt * (30 + sp)) g.vfx.grindSparks(this.pos, tx, ty, tz, sp);
  }

  railJump(tx, ty, tz) {
    const g = this.game, v = this.vel, rail = this.grindRail, sp = this.grindSpeed;
    const toEnd = this.grindDir > 0 ? rail.length - this.grindS : this.grindS;
    const perfect = !rail.growing && toEnd <= RC.perfectWindow;
    // Absprung: Rail-Tempo entlang der Tangente + Sprungimpuls, A/D gibt seitlichen Schub
    v.set(tx * sp, Math.max(ty * sp, 0) * 0.5 + P.jumpImpulse, tz * sp);
    v.x += tz * this.inX * -3; v.z += -tx * this.inX * -3;
    // Rail-Hopping: liegt eine andere Rail in Blick-/Fahrtrichtung, wird der Sprung ballistisch darauf gelenkt
    const L = this.lookDir(this.Q);
    let ax = L.x * 0.65 + tx * 0.35, ay = L.y * 0.65 + ty * 0.35, az = L.z * 0.65 + tz * 0.35;
    const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    const target = g.rails.findHopTarget(this.pos.x, this.pos.y, this.pos.z, ax, ay, az, rail, RC.hopRange);
    if (target) {
      const h = g.rails.hop;
      const ex = h.x - this.pos.x, ey = h.y + 0.2 - this.pos.y, ez = h.z - this.pos.z;
      const dH = Math.hypot(ex, ez);
      const t = clamp(dH / Math.max(Math.hypot(v.x, v.z), 10), 0.3, 1.1);
      const nvx = ex / t, nvz = ez / t, nvy = ey / t + 0.5 * P.gravity * t;
      if (Math.hypot(nvx, nvz) <= sp * 1.3 + 6 && nvy <= P.jumpImpulse + 7 && nvy > -4) { v.set(nvx, nvy, nvz); }
    }
    this.leaveRail();
    this.state = STATE.AIRBORNE; this.coyote = 0; this.airTime = 0; this.jumpBuf = 0; this.djump = true;
    g.audio.play('railJump');
    g.onPlayerAction('railjump', perfect ? 1 : 0);
  }

  leaveRail() {
    if (this.grindRail) {
      this.game.onPlayerAction('grindend', this.grindMeters);
      this.lastRail = this.grindRail; this.railCd = RC.sameRailCooldown; this.hopTimer = RC.hopWindow;
    }
    this.grindRail = null; this.grindCurve = 0; this.grindLean = 0;
  }

  onRailLost(rail) {
    if (this.lastRail === rail) this.lastRail = null;
    if (this.state === STATE.GRINDING && this.grindRail === rail) {
      this.leaveRail(); this.lastRail = null;
      this.state = STATE.AIRBORNE; this.coyote = 0; this.airTime = 0;
      this.game.onPlayerAction('raillost');
    }
  }

  // ------------------------------------------------------------------ Pads, Schaden
  checkPads() {
    const g = this.game, ch = g.world.chunkAt(this.pos.x, this.pos.z);
    if (!ch) return;
    for (let i = 0; i < ch.pads.length; i++) {
      const pd = ch.pads[i];
      if (this.time < pd.readyAt) continue;
      if (Math.abs(this.pos.x - pd.x) > pd.hw + 0.3 || Math.abs(this.pos.z - pd.z) > pd.hw + 0.3 || Math.abs(this.pos.y - pd.y) > 0.7) continue;
      pd.readyAt = this.time + 0.8;
      const v = this.vel;
      if (pd.launch) {
        v.x = v.x * 0.5 + pd.dx * CONFIG.world.launchForward; v.z = v.z * 0.5 + pd.dz * CONFIG.world.launchForward;
        v.y = CONFIG.world.launchUp;
        this.state = STATE.AIRBORNE; this.coyote = 0; this.airTime = 0; this.djump = true;
        if (this.h !== P.height && this.canStand()) this.h = P.height;
      } else {
        v.x += pd.dx * CONFIG.world.padBoost; v.z += pd.dz * CONFIG.world.padBoost;
        this.landGrace = 0.35;
      }
      g.cam.fovKick(6);
      g.audio.play(pd.launch ? 'launch' : 'pad');
      g.vfx.ring(pd.x, pd.y + 0.1, pd.z, 1.0, 0.85, 0.2, 26);
      g.onPlayerAction(pd.launch ? 'launch' : 'pad');
      return;
    }
  }

  damage(amount, sx, sy, sz) {
    if (this.dead || this.iframes > 0 || this.god) return false;
    if (this.speed > P.speedArmorSpeed) amount *= 1 - P.speedArmor;     // Speed-Armor
    this.hp -= amount; this.sinceHit = 0;
    this.game.onPlayerHit(amount, sx, sy, sz);
    if (this.hp <= 0) { this.hp = 0; this.die('killed'); }
    return true;
  }

  die(reason) {
    if (this.dead) return;
    if (this.god && reason !== 'fall') return;
    this.dead = true;
    if (this.state === STATE.GRINDING) this.leaveRail();
    this.state = STATE.AIRBORNE;
    this.game.onPlayerDeath(reason);
  }

  interpolate(alpha) {
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha);
  }
}
