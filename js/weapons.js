// WeaponSystem: Pulse Carbine (Hitscan, Hitze), Rail-Gun-Steuerung + Energie, prozedurales Viewmodel.
import * as THREE from 'three';
import { CONFIG, STATE } from './config.js';
import { clamp, damp, lerp } from './util.js';

const WC = CONFIG.weapon, RG = CONFIG.railgun;
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.whit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, col: null };
    this.ehit = { t: 0, x: 0, y: 0, z: 0, enemy: null, weak: false, blocked: false, part: -1 };
    this.look = { x: 0, y: 0, z: 0 };
    this.reset();
  }

  init(vmScene, vmCamera) {
    this.vmScene = vmScene; this.vmCamera = vmCamera;
    vmScene.add(new THREE.AmbientLight(0x9a86e0, 1.0));
    const l1 = new THREE.DirectionalLight(0xc4a0ff, 1.5); l1.position.set(-1.5, 2, 1); vmScene.add(l1);
    const l2 = new THREE.DirectionalLight(0x35e0ff, 1.4); l2.position.set(2.5, 0.5, -2); vmScene.add(l2);
    const body = new THREE.MeshPhongMaterial({ color: 0x3b2c63, specular: 0x8899dd, shininess: 60, flatShading: true });
    const dark = new THREE.MeshPhongMaterial({ color: 0x1c1430, specular: 0x555577, shininess: 30, flatShading: true });
    this.heatMat = new THREE.MeshBasicMaterial({ color: 0x19e6ff });
    this.railMat = new THREE.MeshBasicMaterial({ color: 0xff2bd6 });
    const g = this.gun = new THREE.Group();
    const add = (geo, mat, x, y, z, rx, ry, rz) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0); g.add(m); return m; };
    add(new THREE.BoxGeometry(0.075, 0.1, 0.4), body, 0, 0, 0);
    add(new THREE.BoxGeometry(0.055, 0.05, 0.22), dark, 0, 0.065, -0.05);
    add(new THREE.CylinderGeometry(0.02, 0.024, 0.3, 8), dark, 0, 0.012, -0.33, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.032, 0.032, 0.05, 8), body, 0, 0.012, -0.47, Math.PI / 2);
    add(new THREE.BoxGeometry(0.05, 0.14, 0.07), dark, 0, -0.1, 0.1, 0.3);
    add(new THREE.BoxGeometry(0.012, 0.07, 0.22), body, -0.045, 0.01, -0.12, 0, 0, 0.25);
    add(new THREE.BoxGeometry(0.012, 0.07, 0.22), body, 0.045, 0.01, -0.12, 0, 0, -0.25);
    // Hitze-Leuchtstreifen
    add(new THREE.BoxGeometry(0.014, 0.012, 0.3), this.heatMat, 0, 0.095, -0.05);
    add(new THREE.BoxGeometry(0.08, 0.012, 0.012), this.heatMat, 0, 0.03, -0.2);
    add(new THREE.BoxGeometry(0.08, 0.012, 0.012), this.heatMat, 0, 0.03, -0.14);
    // Rail-Gun-Emitter unter dem Lauf
    add(new THREE.BoxGeometry(0.05, 0.04, 0.24), dark, 0, -0.06, -0.2);
    this.energyBar = add(new THREE.BoxGeometry(0.058, 0.014, 0.22), this.railMat, 0, -0.06, -0.2);
    this.emitter = add(new THREE.OctahedronGeometry(0.03), this.railMat, 0, -0.06, -0.35);
    // Mündungsfeuer
    this.flash = add(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ color: 0x9df6ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, map: this.flashTexture() }), 0, 0.012, -0.52);
    this.flash.visible = false;
    this.flash2 = add(new THREE.PlaneGeometry(0.3, 0.3), this.flash.material, 0, 0.012, -0.56, 0, Math.PI / 2, 0);
    this.flash2.visible = false;
    g.scale.setScalar(0.82);
    vmScene.add(g);
    g.visible = false;
  }

  flashTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(32, 32, 1, 32, 32, 32);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.3, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    x.strokeStyle = '#fff'; x.lineWidth = 3;
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + 0.2; x.beginPath(); x.moveTo(32, 32); x.lineTo(32 + Math.cos(a) * 30, 32 + Math.sin(a) * 30); x.stroke(); }
    return new THREE.CanvasTexture(c);
  }

  reset() {
    this.heat = 0; this.overheated = false; this.lockT = 0; this.fireT = 0;
    this.energy = RG.maxEnergy * 0.6;
    this.kick = 0; this.swayX = 0; this.swayY = 0; this.flashT = 0; this.shots = 0; this.growTime = 0;
  }

  addEnergy(x) { this.energy = Math.min(RG.maxEnergy, this.energy + x); }

  update(dt, simDt) {
    const g = this.game, pl = g.player, inp = g.input;
    const active = g.isPlaying() && !pl.dead;
    this.gun.visible = active;
    if (!active) { if (g.rails.growing) g.rails.stopGrow(); g.audio.setRailgun(false, 0); return; }

    // --- Pulse Carbine: Hitze-System
    this.fireT -= dt;
    if (this.overheated) {
      this.lockT -= dt; this.heat = clamp(this.lockT / WC.cooldownTime, 0, 1);
      if (this.lockT <= 0) { this.overheated = false; this.heat = 0; }
    } else if (inp.fire) {
      if (this.fireT <= 0) { this.shoot(); this.fireT = this.fireT < -0.05 ? 1 / WC.fireRate : this.fireT + 1 / WC.fireRate; }
      this.heat += dt / WC.heatTime;
      if (this.heat >= 1) { this.heat = 1; this.overheated = true; this.lockT = WC.cooldownTime; g.audio.play('overheat'); g.ui.popup('OVERHEAT', 'warn'); }
    } else this.heat = Math.max(0, this.heat - WC.coolRate * dt);

    // --- Rail-Gun
    const rails = g.rails, od = g.score.overdrive;
    pl.lookDir(this.look);
    if (!rails.growing && inp.consume('alt')) {
      if (this.energy >= RG.minEnergyToStart || od) {
        const cam = g.cam.camera;
        const ox = cam.position.x + this.look.x * RG.startAhead, oy = cam.position.y + this.look.y * RG.startAhead - RG.startDrop, oz = cam.position.z + this.look.z * RG.startAhead;
        if (!g.world.pointSolid(ox, oy, oz) && rails.startGrow(ox, oy, oz, this.look.x, this.look.y, this.look.z)) { this.growTime = 0; g.onPlayerAction('railgun'); }
      } else { g.audio.play('uiBack'); g.ui.popup('NO ENERGY', 'warn'); }
    }
    if (rails.growing) {
      this.growTime += simDt;
      if (!od) this.energy -= RG.energyCost * simDt;     // Overdrive: Rail-Gun kostet nichts
      if (!inp.alt || this.energy <= 0) { this.energy = Math.max(0, this.energy); rails.stopGrow(); }
      else rails.updateGrow(simDt, this.look.x, this.look.y, this.look.z);
    }
    const gr = rails.growing;
    g.audio.setRailgun(!!gr, gr ? gr.length / RG.maxLength : 0);

    // --- Viewmodel: Sway, Bob, Recoil, Hitzefarbe
    const h = this.heat;
    if (this.overheated) this.heatMat.color.setRGB(1, 0.12 + 0.2 * Math.sin(g.time * 30), 0.05);
    else this.heatMat.color.setRGB(lerp(0.06, 0.9, h), lerp(0.6, 0.3, h * h), lerp(0.7, 0.04, h));
    const e = this.energy / RG.maxEnergy;
    this.energyBar.scale.z = Math.max(0.02, e); this.energyBar.position.z = -0.2 + (1 - e) * 0.11;
    const pulse = gr ? 1.2 + Math.sin(g.time * 40) * 0.4 : 0.45 + e * 0.35;
    this.railMat.color.setRGB(1 * pulse, 0.17 * pulse, 0.84 * pulse);
    this.emitter.rotation.z += dt * (gr ? 30 : 3); this.emitter.scale.setScalar(gr ? 1.8 : 1);
    this.swayX = damp(this.swayX, clamp(-g.lookDX * 0.0009, -0.05, 0.05), 9, dt);
    this.swayY = damp(this.swayY, clamp(g.lookDY * 0.0009, -0.05, 0.05), 9, dt);
    this.kick = damp(this.kick, 0, 16, dt);
    const cam = g.cam;
    const bob = cam.bobAmt, bt = cam.bobT;
    const grind = pl.state === STATE.GRINDING, slide = pl.state === STATE.SLIDING;
    const gun = this.gun;
    gun.position.set(0.2 + this.swayX + Math.cos(bt) * 0.012 * bob, -0.19 + this.swayY + Math.sin(bt * 2) * 0.01 * bob - cam.dip * 0.25 + (slide ? 0.03 : 0), -0.66 + this.kick);
    gun.rotation.set(this.kick * 1.1 + this.swayY * 1.5, this.swayX * 2.5 + 0.11, damp(gun.rotation.z, grind ? 0.25 : slide ? -0.35 : pl.state === STATE.WALLRUNNING ? pl.wallSide * 0.3 : 0, 8, dt));
    this.flashT -= dt;
    const fv = this.flashT > 0;
    this.flash.visible = fv; this.flash2.visible = fv;
  }

  shoot() {
    const g = this.game, pl = g.player, cam = g.cam.camera;
    cam.getWorldDirection(_d);
    const sp = WC.spread + this.heat * WC.heatSpread;
    _d.x += (Math.random() - 0.5) * sp; _d.y += (Math.random() - 0.5) * sp; _d.z += (Math.random() - 0.5) * sp; _d.normalize();
    _o.copy(cam.position);
    const wh = g.world.raycast(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, WC.range, this.whit);
    const eh = g.enemies.raycast(_o.x, _o.y, _o.z, _d.x, _d.y, _d.z, wh ? this.whit.t : WC.range, this.ehit);
    let ex, ey, ez;
    // Schaden skaliert mit dem Tempo: 10 im Stand, 30 bei 40 m/s
    let dmg = WC.baseDamage * (1 + pl.speed / WC.speedScale);
    if (g.dismountT > 0) dmg *= CONFIG.rail.slowmoDamage;
    if (eh) {
      const h = this.ehit;
      ex = h.x; ey = h.y; ez = h.z;
      if (h.blocked) { g.vfx.impact(ex, ey, ez, -_d.x, -_d.y, -_d.z, 0.4, 0.8, 1.0, 4); g.audio.play('shield'); g.enemies.onBlocked(h.enemy); }
      else g.enemies.damage(h.enemy, dmg * (h.weak ? WC.weakMult : 1), h.weak, 'gun', ex, ey, ez, h.part);
    } else if (wh) {
      const h = this.whit;
      ex = h.x; ey = h.y; ez = h.z;
      g.vfx.impact(ex, ey, ez, h.nx, h.ny, h.nz, 0.3, 0.85, 1.0, 5);
      g.vfx.decal(ex, ey, ez, h.nx, h.ny, h.nz);
    } else { ex = _o.x + _d.x * 150; ey = _o.y + _d.y * 150; ez = _o.z + _d.z * 150; }
    // Tracer startet an der Mündung (rechts unten vor der Kamera)
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion); _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const mx = _o.x + _r.x * 0.22 - _u.x * 0.2 + _d.x * 0.9, my = _o.y + _r.y * 0.22 - _u.y * 0.2 + _d.y * 0.9, mz = _o.z + _r.z * 0.22 - _u.z * 0.2 + _d.z * 0.9;
    const hot = this.heat;
    g.vfx.tracer(mx, my, mz, ex, ey, ez, 0.3 + hot * 0.7, 0.95 - hot * 0.4, 1.0 - hot * 0.6, 0.03);
    g.cam.recoil(0.006 + Math.random() * 0.004, (Math.random() - 0.5) * 0.006);
    this.kick = 0.045; this.flashT = 0.035;
    this.flash.rotation.z = Math.random() * 6.28; this.flash.scale.setScalar(0.7 + Math.random() * 0.6);
    this.shots++;
    g.audio.play('shoot');
  }
}
