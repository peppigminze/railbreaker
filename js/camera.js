// CameraRig: FOV, Tilt, Trauma-Shake, Headbob, Lande-Dip, Recoil, weiches Nachziehen bei Snaps/Stufen.
import * as THREE from 'three';
import { CONFIG, STATE } from './config.js';
import { clamp, damp, smoothstep, noise1, lerp } from './util.js';

const C = CONFIG.camera, P = CONFIG.player;
const DEG = Math.PI / 180;

export class CameraRig {
  constructor(game) {
    this.game = game;
    this.camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.08, 1600);
    this.camera.rotation.order = 'YXZ';
    this.off = new THREE.Vector3();
    this.reset();
  }
  init() {}
  reset() {
    this.off.set(0, 0, 0);
    this.eye = P.eyeHeight; this.roll = 0; this.fov = this.game.settings ? this.game.settings.fov : 90;
    this.trauma = 0; this.dip = 0; this.dipVel = 0; this.kick = 0; this.recoilP = 0; this.recoilY = 0;
    this.bobT = 0; this.bobAmt = 0; this.t = 0; this.deathT = 0;
  }
  addOffset(x, y, z) {
    this.off.x += x; this.off.y += y; this.off.z += z;
    const l = this.off.length();
    if (l > 3.5) this.off.multiplyScalar(3.5 / l);
  }
  addTrauma(a) { this.trauma = Math.min(1, this.trauma + a); }
  land(fallSpeed) { this.dipVel -= Math.min(fallSpeed, 45) * C.landDip * 9; if (fallSpeed > 14) this.addTrauma(Math.min(0.35, fallSpeed * 0.008)); }
  fovKick(a) { if (a > this.kick) this.kick = a; }
  recoil(p, y) { this.recoilP += p; this.recoilY += y; }

  update(dt) {
    const g = this.game, pl = g.player, cam = this.camera, st = pl.state;
    this.t += dt;
    const k = Math.exp(-13 * dt);
    this.off.multiplyScalar(k);
    // Slide: Kamera senkt sich weich
    const eyeT = (st === STATE.SLIDING || pl.h < P.height) ? P.eyeHeight - CONFIG.slide.camDrop : P.eyeHeight;
    this.eye = damp(this.eye, eyeT, 13, dt);
    // Lande-Dip als gedämpfte Feder
    this.dipVel += (-this.dip * 170 - this.dipVel * 17) * dt;
    this.dip = clamp(this.dip + this.dipVel * dt, -0.7, 0.3);
    // Headbob nur am Boden, beim Grinden feines Vibrieren
    const bobTarget = st === STATE.GROUNDED && pl.speedH > 2 ? Math.min(1, pl.speedH / 12) : 0;
    this.bobAmt = damp(this.bobAmt, bobTarget, 10, dt);
    this.bobT += pl.speedH * dt * C.bobFreq * 0.35;
    let bx = Math.cos(this.bobT) * C.bobAmp * 0.6 * this.bobAmt, by = Math.sin(this.bobT * 2) * C.bobAmp * this.bobAmt;
    if (st === STATE.GRINDING) {
      const v = 0.006 + pl.speed * 0.00025;
      bx += noise1(this.t * 55, 3) * v; by += noise1(this.t * 61, 4) * v;
    }
    const cy = Math.cos(pl.yaw), sy = Math.sin(pl.yaw);
    cam.position.set(pl.renderPos.x + this.off.x + cy * bx, pl.renderPos.y + this.eye + this.dip + by + this.off.y, pl.renderPos.z + this.off.z - sy * bx);

    // Roll: Wallrun 12° weg von der Wand, Strafe-Tilt, Grind-Lean
    let rollT = 0;
    if (pl.dead) { this.deathT += dt; rollT = Math.min(55, this.deathT * 80) * DEG; }
    else if (st === STATE.WALLRUNNING) rollT = -pl.wallSide * CONFIG.wallrun.tilt * DEG;
    else if (st === STATE.GRINDING) rollT = -(pl.grindCurve + pl.grindLean * C.grindLean) * DEG;
    else rollT = -(pl.inX || 0) * C.strafeTilt * DEG * (st === STATE.SLIDING ? 2 : 1);
    this.roll = damp(this.roll, rollT, 9, dt);

    // FOV: steigt mit dem Tempo
    this.kick *= Math.exp(-5 * dt);
    const fovT = g.settings.fov + C.fovMaxAdd * smoothstep(C.fovSpeedMin, C.fovSpeedMax, pl.speed)
      + (st === STATE.SLIDING ? CONFIG.slide.fov : 0) + this.kick + (g.score.overdrive ? 4 : 0);
    this.fov = damp(this.fov, Math.min(fovT, 135), 7, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }

    // Screenshake: Trauma² x glattes Noise, zerfällt über die Zeit
    this.trauma = Math.max(0, this.trauma - C.shakeDecay * dt);
    const sh = this.trauma * this.trauma * g.settings.shake * C.shakeAngle;
    const sp = sh * noise1(this.t * 26, 11), syaw = sh * noise1(this.t * 26, 12), sr = sh * 0.8 * noise1(this.t * 26, 13);
    this.recoilP = damp(this.recoilP, 0, 13, dt); this.recoilY = damp(this.recoilY, 0, 13, dt);
    cam.rotation.set(clamp(pl.pitch + this.recoilP + sp, -1.55, 1.55), pl.yaw + this.recoilY + syaw, this.roll + sr);
  }

  // Hauptmenü: Kamera gleitet zwischen den Türmen über den Express-Rails durch die Stadt
  updateMenu(dt, t) {
    const w = this.game.world, cam = this.camera, S = CONFIG.world.chunkSize;
    const z = -t * 13;
    const fz = -z / S; // Fortschritt in Chunks (Richtung -z)
    const c0 = Math.floor(-fz), f = -fz - c0;
    const h0 = w.hubHeight(0, c0), h1 = w.hubHeight(0, c0 + 1);
    const y = lerp(h0, h1, f * f * (3 - 2 * f)) + 27 + Math.sin(t * 0.4) * 2.5;
    this.menuY = this.menuY === undefined ? y : damp(this.menuY, y, 1.2, dt);
    cam.position.set(Math.sin(t * 0.23) * 5, this.menuY, z);
    cam.rotation.set(-0.2 + Math.sin(t * 0.31) * 0.05, Math.sin(t * 0.17) * 0.28, Math.cos(t * 0.23) * 0.07);
    if (Math.abs(cam.fov - 80) > 0.01) { cam.fov = 80; cam.updateProjectionMatrix(); }
  }
}
