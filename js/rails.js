// RailSystem: Spline-Verwaltung, Snapping-Abfragen, Rail-Gun-Erzeugung, Rail-Meshes.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp } from './util.js';

const RC = CONFIG.rail, RG = CONFIG.railgun;
const DS = RC.sampleDist;
const RADIAL = 5;
const CHUNK_RINGS = 760;
const PLAYER_CAP = Math.ceil(RG.maxLength / DS) + 6;
const TABLE_K = 12;

const RAIL_VERT = /* glsl */`
attribute float aU; varying float vU; varying vec3 vWorld;
void main(){ vU = aU; vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const RAIL_FRAG = /* glsl */`
precision highp float;
uniform vec3 uColor; uniform float uTime; uniform float uBeat; uniform float uFade; uniform vec3 uFogColor; uniform float uFogDensity;
varying float vU; varying vec3 vWorld;
void main(){
  // Energie-Pulse laufen in Fahrtrichtung über die Rail
  float pulse = pow(0.5 + 0.5 * sin(vU * 0.6 - uTime * 8.0), 12.0);
  vec3 col = uColor * (0.8 + 1.7 * pulse + 0.8 * uBeat);
  col = mix(col, vec3(1.0), pulse * 0.45);
  float flick = uFade < 0.999 ? (0.6 + 0.4 * step(0.5, fract(uTime * 14.0 + vU * 0.3))) : 1.0;
  float d = distance(vWorld, cameraPosition);
  float fog = exp(-d * d * uFogDensity * uFogDensity * 0.3);
  col = mix(uFogColor, col, fog) * uFade * flick;
  gl_FragColor = vec4(col, 1.0);
}`;

const _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 };

export class Rail {
  constructor(cap, type) {
    this.cap = cap; this.type = type;     // 0 = World, 1 = Player
    this.px = new Float32Array(cap); this.py = new Float32Array(cap); this.pz = new Float32Array(cap);
    this.n = 0; this.length = 0; this.alive = false; this.growing = false;
    this.age = 0; this.fade = 1; this.chunk = null; this.mesh = null; this.meshedN = 0;
    this.minX = 0; this.minY = 0; this.minZ = 0; this.maxX = 0; this.maxY = 0; this.maxZ = 0;
    this.dx = 0; this.dy = 0; this.dz = -1; this.cs = 0; this.id = 0; this.cutT = 0;
    this.pierced = new Set();
  }
  computeBounds() {
    let a = 1e9, b = 1e9, c = 1e9, d = -1e9, e = -1e9, f = -1e9;
    for (let i = 0; i < this.n; i++) {
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      if (x < a) a = x; if (y < b) b = y; if (z < c) c = z; if (x > d) d = x; if (y > e) e = y; if (z > f) f = z;
    }
    this.minX = a; this.minY = b; this.minZ = c; this.maxX = d; this.maxY = e; this.maxZ = f;
  }
  segIndex(s) { let i = Math.floor(s / DS); if (i > this.n - 2) i = this.n - 2; if (i < 0) i = 0; return i; }
  // Position bei Bogenlänge s (Samples liegen gleichmässig im Abstand DS, das letzte bei length)
  posAt(s, out) {
    const i = this.segIndex(s);
    const segLen = i === this.n - 2 ? this.length - i * DS : DS;
    const f = segLen > 1e-6 ? clamp((s - i * DS) / segLen, 0, 1) : 0;
    out.x = this.px[i] + (this.px[i + 1] - this.px[i]) * f;
    out.y = this.py[i] + (this.py[i + 1] - this.py[i]) * f;
    out.z = this.pz[i] + (this.pz[i + 1] - this.pz[i]) * f;
    return out;
  }
  // Geglättete Tangente (zentrale Differenzen, zwischen den Samples interpoliert)
  tanAt(s, out) {
    const i = this.segIndex(s), n = this.n;
    const segLen = i === n - 2 ? this.length - i * DS : DS;
    const f = segLen > 1e-6 ? clamp((s - i * DS) / segLen, 0, 1) : 0;
    const i0 = i > 0 ? i - 1 : 0, i3 = i + 2 < n ? i + 2 : n - 1;
    const ax = this.px[i + 1] - this.px[i0], ay = this.py[i + 1] - this.py[i0], az = this.pz[i + 1] - this.pz[i0];
    const bx = this.px[i3] - this.px[i], by = this.py[i3] - this.py[i], bz = this.pz[i3] - this.pz[i];
    const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
    let x = ax / la + (bx / lb - ax / la) * f, y = ay / la + (by / lb - ay / la) * f, z = az / la + (bz / lb - az / la) * f;
    const l = Math.hypot(x, y, z) || 1;
    out.x = x / l; out.y = y / l; out.z = z / l;
    return out;
  }
  // Nächster Punkt auf der Rail; gibt dist² zurück, Bogenlänge in this.cs
  closest(x, y, z) {
    let best = 1e18, bs = 0;
    const px = this.px, py = this.py, pz = this.pz, n = this.n;
    for (let i = 0; i < n - 1; i++) {
      const ax = px[i], ay = py[i], az = pz[i];
      const ex = px[i + 1] - ax, ey = py[i + 1] - ay, ez = pz[i + 1] - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let t = l2 > 1e-10 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = ax + ex * t - x, qy = ay + ey * t - y, qz = az + ez * t - z;
      const d2 = qx * qx + qy * qy + qz * qz;
      if (d2 < best) { best = d2; bs = i * DS + t * (i === n - 2 ? this.length - i * DS : DS); }
    }
    this.cs = bs;
    return best;
  }
}

// Centripetal Catmull-Rom (Barry-Goldman): Knotenabstände = |P(i+1)-P(i)|^0.5 -> keine Schlaufen/Überschwinger.
function crEval(P, j, t, out) {
  const m = P.length / 3;
  const g = (i, k) => {
    if (i < 0) return 2 * P[k] - P[3 + k];                              // Phantom-Punkt am Anfang
    if (i >= m) return 2 * P[(m - 1) * 3 + k] - P[(m - 2) * 3 + k];     // ... und am Ende
    return P[i * 3 + k];
  };
  const x0 = g(j - 1, 0), y0 = g(j - 1, 1), z0 = g(j - 1, 2), x1 = g(j, 0), y1 = g(j, 1), z1 = g(j, 2);
  const x2 = g(j + 1, 0), y2 = g(j + 1, 1), z2 = g(j + 1, 2), x3 = g(j + 2, 0), y3 = g(j + 2, 1), z3 = g(j + 2, 2);
  const t0 = 0;
  const t1 = t0 + Math.sqrt(Math.hypot(x1 - x0, y1 - y0, z1 - z0)) + 1e-4;
  const t2 = t1 + Math.sqrt(Math.hypot(x2 - x1, y2 - y1, z2 - z1)) + 1e-4;
  const t3 = t2 + Math.sqrt(Math.hypot(x3 - x2, y3 - y2, z3 - z2)) + 1e-4;
  const tt = t1 + (t2 - t1) * t;
  const a1 = (t1 - tt) / (t1 - t0), b1 = (tt - t0) / (t1 - t0);
  const a2 = (t2 - tt) / (t2 - t1), b2 = (tt - t1) / (t2 - t1);
  const a3 = (t3 - tt) / (t3 - t2), b3 = (tt - t2) / (t3 - t2);
  const c1 = (t2 - tt) / (t2 - t0), d1 = (tt - t0) / (t2 - t0);
  const c2 = (t3 - tt) / (t3 - t1), d2 = (tt - t1) / (t3 - t1);
  const A1x = a1 * x0 + b1 * x1, A1y = a1 * y0 + b1 * y1, A1z = a1 * z0 + b1 * z1;
  const A2x = a2 * x1 + b2 * x2, A2y = a2 * y1 + b2 * y2, A2z = a2 * z1 + b2 * z2;
  const A3x = a3 * x2 + b3 * x3, A3y = a3 * y2 + b3 * y3, A3z = a3 * z2 + b3 * z3;
  const B1x = c1 * A1x + d1 * A2x, B1y = c1 * A1y + d1 * A2y, B1z = c1 * A1z + d1 * A2z;
  const B2x = c2 * A2x + d2 * A3x, B2y = c2 * A2y + d2 * A3y, B2z = c2 * A2z + d2 * A3z;
  out.x = a2 * B1x + b2 * B2x; out.y = a2 * B1y + b2 * B2y; out.z = a2 * B1z + b2 * B2z;
}

// Bogenlängen-Tabelle: Spline fein abtasten, kumulierte Längen merken, dann in gleichmässigen
// Abständen DS neu abtasten. Danach ist "s Meter entlang der Rail" ein simpler Index -> konstante Geschwindigkeit.
const _table = new Float32Array(4096);
function bakeSpline(P) {
  const m = P.length / 3, segs = m - 1, tn = segs * TABLE_K + 1;
  let lx = 0, ly = 0, lz = 0, cum = 0;
  for (let i = 0; i < tn; i++) {
    const u = i / TABLE_K, j = Math.min(segs - 1, Math.floor(u));
    crEval(P, j, u - j, _a);
    if (i > 0) cum += Math.hypot(_a.x - lx, _a.y - ly, _a.z - lz);
    _table[i] = cum; lx = _a.x; ly = _a.y; lz = _a.z;
  }
  const total = cum;
  const n = Math.max(2, Math.ceil(total / DS) + 1);
  const rail = new Rail(n, 0);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(i * DS, total);
    while (idx < tn - 2 && _table[idx + 1] < s) idx++;
    const span = _table[idx + 1] - _table[idx];
    const f = span > 1e-8 ? (s - _table[idx]) / span : 0;
    const u = (idx + f) / TABLE_K, j = Math.min(segs - 1, Math.floor(u));
    crEval(P, j, u - j, _a);
    rail.px[i] = _a.x; rail.py[i] = _a.y; rail.pz[i] = _a.z;
  }
  rail.n = n; rail.length = total;
  rail.computeBounds();
  return rail;
}

export class RailSystem {
  constructor(game) {
    this.game = game;
    this.rails = [];          // alle aktiven Rails (World + Player)
    this.playerRails = [];
    this.chunkMeshes = [];
    this.growing = null;
    this.nextId = 1;
    this.snapS = 0;
    this.hop = { rail: null, s: 0, x: 0, y: 0, z: 0 };
    this.ringCos = []; this.ringSin = [];
    for (let i = 0; i < RADIAL; i++) { this.ringCos.push(Math.cos(i / RADIAL * Math.PI * 2)); this.ringSin.push(Math.sin(i / RADIAL * Math.PI * 2)); }
  }

  makeGeometry(rings) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rings * RADIAL * 3), 3));
    geo.setAttribute('aU', new THREE.BufferAttribute(new Float32Array(rings * RADIAL), 1));
    const idx = new Uint16Array((rings - 1) * RADIAL * 6);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    return geo;
  }
  makeMaterial(color, transparent) {
    const U = this.game.world.uniforms;
    return new THREE.ShaderMaterial({
      vertexShader: RAIL_VERT, fragmentShader: RAIL_FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uTime: U.uTime, uBeat: U.uBeat, uFade: { value: 1 }, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity },
    });
  }

  init(scene) {
    this.scene = scene;
    this.worldMat = this.makeMaterial(RC.worldColor);
    const slots = (2 * CONFIG.world.viewRadius + 1) ** 2;
    for (let i = 0; i < slots; i++) {
      const mesh = new THREE.Mesh(this.makeGeometry(CHUNK_RINGS), this.worldMat);
      mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 90);
      mesh.visible = false; mesh.matrixAutoUpdate = false;
      scene.add(mesh); this.chunkMeshes.push(mesh);
    }
    for (let i = 0; i < RG.maxRails; i++) {
      const r = new Rail(PLAYER_CAP, 1);
      r.mesh = new THREE.Mesh(this.makeGeometry(PLAYER_CAP), this.makeMaterial(RC.playerColor));
      r.mesh.frustumCulled = false; r.mesh.visible = false; r.mesh.matrixAutoUpdate = false;
      scene.add(r.mesh);
      this.playerRails.push(r);
    }
  }

  reset() {
    for (const r of this.playerRails) { r.alive = false; r.growing = false; r.mesh.visible = false; }
    this.rails = this.rails.filter((r) => r.type === 0 && r.alive);
    this.growing = null;
  }

  // ---------------------------------------------------------------- World-Rails
  addWorldRail(ctrl, chunk) {
    const rail = bakeSpline(ctrl);
    rail.alive = true; rail.chunk = chunk; rail.id = this.nextId++;
    chunk.rails.push(rail);
    this.rails.push(rail);
    return rail;
  }
  removeChunkRails(chunk) {
    for (const r of chunk.rails) {
      r.alive = false;
      const i = this.rails.indexOf(r);
      if (i >= 0) { this.rails[i] = this.rails[this.rails.length - 1]; this.rails.pop(); }
      this.game.player.onRailLost(r);
    }
    chunk.rails.length = 0;
    this.chunkMeshes[chunk.slot].visible = false;
  }

  // Schreibt einen Ring (RADIAL Vertices) um Sample i der Rail
  writeRing(rail, i, pos, au, ring, radius) {
    const n = rail.n;
    const i0 = i > 0 ? i - 1 : 0, i1 = i < n - 1 ? i + 1 : n - 1;
    let tx = rail.px[i1] - rail.px[i0], ty = rail.py[i1] - rail.py[i0], tz = rail.pz[i1] - rail.pz[i0];
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // Frame: N = up x T (bei fast senkrechter Tangente auf x ausweichen)
    let nx, ny, nz;
    if (Math.abs(ty) > 0.97) { nx = 0; ny = tz; nz = -ty; } else { nx = tz; ny = 0; nz = -tx; }
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const s = Math.min(i * DS, rail.length);
    for (let k = 0; k < RADIAL; k++) {
      const c = this.ringCos[k] * radius, si = this.ringSin[k] * radius;
      const o = (ring * RADIAL + k) * 3;
      pos[o] = rail.px[i] + nx * c + bx * si; pos[o + 1] = rail.py[i] + ny * c + by * si; pos[o + 2] = rail.pz[i] + nz * c + bz * si;
      au[ring * RADIAL + k] = s;
    }
  }
  writeIndices(idx, ringA, o) {
    for (let k = 0; k < RADIAL; k++) {
      const a = ringA * RADIAL + k, b = ringA * RADIAL + (k + 1) % RADIAL, c = a + RADIAL, d = b + RADIAL;
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    return o;
  }

  buildChunkMesh(chunk) {
    const mesh = this.chunkMeshes[chunk.slot];
    const geo = mesh.geometry;
    const pos = geo.attributes.position.array, au = geo.attributes.aU.array, idx = geo.index.array;
    let ring = 0, io = 0;
    for (const rail of chunk.rails) {
      let first = true;
      for (let i = 0; i < rail.n; i += 2) {
        if (ring >= CHUNK_RINGS) break;
        const si = (i + 2 >= rail.n) ? rail.n - 1 : i;     // letztes Sample exakt treffen
        this.writeRing(rail, si, pos, au, ring, RC.radius);
        if (!first) io = this.writeIndices(idx, ring - 1, io);
        first = false; ring++;
      }
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.aU.needsUpdate = true; geo.index.needsUpdate = true;
    geo.setDrawRange(0, io);
    geo.boundingSphere.center.set(chunk.cx * CONFIG.world.chunkSize, 50, chunk.cz * CONFIG.world.chunkSize);
    geo.boundingSphere.radius = 110;
    mesh.visible = io > 0;
  }

  // ---------------------------------------------------------------- Abfragen
  findSnap(x, y, z, maxDist, ignore) {
    let best = maxDist * maxDist, found = null;
    const rails = this.rails;
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      if (r === ignore || r.n < 3) continue;
      if (x < r.minX - maxDist || x > r.maxX + maxDist || y < r.minY - maxDist || y > r.maxY + maxDist || z < r.minZ - maxDist || z > r.maxZ + maxDist) continue;
      const d2 = r.closest(x, y, z);
      if (d2 < best) { best = d2; found = r; this.snapS = r.cs; }
    }
    return found;
  }

  // Rail-Hop-Zielhilfe: beste andere Rail vor dem Spieler (in Blick-/Bewegungsrichtung)
  findHopTarget(x, y, z, dx, dy, dz, exclude, range) {
    let bestScore = 1e9; this.hop.rail = null;
    const rails = this.rails;
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      if (r === exclude || r.n < 6) continue;
      if (x < r.minX - range || x > r.maxX + range || y < r.minY - range || y > r.maxY + range * 0.6 || z < r.minZ - range || z > r.maxZ + range) continue;
      for (let k = 1; k < r.n - 1; k += 3) {
        const ex = r.px[k] - x, ey = r.py[k] - y, ez = r.pz[k] - z;
        const d = Math.hypot(ex, ey, ez);
        if (d > range || d < 3.5 || ey > 6) continue;
        const dot = (ex * dx + ey * dy + ez * dz) / d;
        if (dot < 0.55) continue;
        const score = d * (1.6 - dot);
        if (score < bestScore) { bestScore = score; this.hop.rail = r; this.hop.s = k * DS; this.hop.x = r.px[k]; this.hop.y = r.py[k]; this.hop.z = r.pz[k]; }
      }
    }
    return this.hop.rail;
  }

  // Für Swarmer (Ausweichen) und Cutter (Ziel): nächster Punkt auf einer Player-Rail
  nearestPlayerRail(x, y, z, out) {
    let best = 1e18, found = null;
    for (const r of this.playerRails) {
      if (!r.alive || r.n < 3) continue;
      for (let k = 0; k < r.n; k += 3) {
        const ex = r.px[k] - x, ey = r.py[k] - y, ez = r.pz[k] - z;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < best) { best = d2; found = r; out.x = r.px[k]; out.y = r.py[k]; out.z = r.pz[k]; }
      }
    }
    out.d2 = best;
    return found;
  }

  // ---------------------------------------------------------------- Rail-Gun
  startGrow(ox, oy, oz, dx, dy, dz) {
    let rail = null, oldest = null;
    for (const r of this.playerRails) {
      if (!r.alive) { rail = r; break; }
      if (!r.growing && (!oldest || r.age > oldest.age)) oldest = r;
    }
    if (!rail) { if (!oldest) return null; this.destroyRail(oldest, true); rail = oldest; }   // max. 6: älteste zuerst weg
    rail.alive = true; rail.growing = true; rail.age = 0; rail.fade = 1; rail.length = 0; rail.cutT = 0;
    rail.id = this.nextId++;
    rail.px[0] = rail.px[1] = ox; rail.py[0] = rail.py[1] = oy; rail.pz[0] = rail.pz[1] = oz;
    rail.n = 2; rail.meshedN = 0;
    rail.dx = dx; rail.dy = dy; rail.dz = dz;
    rail.pierced.clear();
    rail.computeBounds();
    rail.mesh.material.uniforms.uFade.value = 1;
    rail.mesh.geometry.setDrawRange(0, 0);
    rail.mesh.visible = true;
    this.rails.push(rail);
    this.growing = rail;
    return rail;
  }

  // Lässt die Spitze mit growSpeed wachsen; die Richtung folgt geglättet der Blickrichtung.
  updateGrow(dt, lx, ly, lz) {
    const rail = this.growing;
    if (!rail) return false;
    const k = 1 - Math.exp(-RG.turnRate * dt);
    let dx = rail.dx + (lx - rail.dx) * k, dy = rail.dy + (ly - rail.dy) * k, dz = rail.dz + (lz - rail.dz) * k;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    rail.dx = dx; rail.dy = dy; rail.dz = dz;
    let move = RG.growSpeed * dt, done = false;
    const world = this.game.world;
    while (move > 1e-6 && !done) {
      const t = rail.n - 1, p = t - 1;
      const cur = Math.hypot(rail.px[t] - rail.px[p], rail.py[t] - rail.py[p], rail.pz[t] - rail.pz[p]);
      const step = Math.min(move, DS - cur);
      const nx = rail.px[t] + dx * step, ny = rail.py[t] + dy * step, nz = rail.pz[t] + dz * step;
      if (world.pointSolid(nx, ny, nz) || ny < CONFIG.player.killY) { done = true; break; }
      rail.px[t] = nx; rail.py[t] = ny; rail.pz[t] = nz;
      rail.length += step; move -= step;
      if (cur + step >= DS - 1e-5) {
        if (rail.n >= rail.cap || rail.length >= RG.maxLength) { done = true; break; }
        rail.px[rail.n] = nx; rail.py[rail.n] = ny; rail.pz[rail.n] = nz; rail.n++;
      }
    }
    const t = rail.n - 1;
    const tx = rail.px[t], ty = rail.py[t], tz = rail.pz[t];
    if (tx < rail.minX) rail.minX = tx; if (tx > rail.maxX) rail.maxX = tx;
    if (ty < rail.minY) rail.minY = ty; if (ty > rail.maxY) rail.maxY = ty;
    if (tz < rail.minZ) rail.minZ = tz; if (tz > rail.maxZ) rail.maxZ = tz;
    this.game.enemies.pierceAt(tx, ty, tz, RG.pierceRadius, rail);
    this.game.vfx.railTip(tx, ty, tz, dx, dy, dz);
    this.updatePlayerMesh(rail);
    if (done) { this.stopGrow(); return false; }
    return true;
  }

  stopGrow() {
    const rail = this.growing;
    if (!rail) return;
    rail.growing = false; this.growing = null;
    // letztes Sample darf nicht mit dem vorletzten zusammenfallen
    if (rail.n > 2) {
      const t = rail.n - 1;
      if (Math.hypot(rail.px[t] - rail.px[t - 1], rail.py[t] - rail.py[t - 1], rail.pz[t] - rail.pz[t - 1]) < 0.02) { rail.n--; }
    }
    rail.length = Math.max(0, Math.min(rail.length, (rail.n - 1) * DS));
    if (rail.n < 5) { this.destroyRail(rail, false); return; }
    this.updatePlayerMesh(rail, true);
  }

  updatePlayerMesh(rail, full) {
    if (rail.n < 2) return;
    const geo = rail.mesh.geometry;
    const pos = geo.attributes.position.array, au = geo.attributes.aU.array, idx = geo.index.array;
    const from = full ? 0 : Math.max(0, rail.meshedN - 2);
    for (let i = from; i < rail.n; i++) this.writeRing(rail, i, pos, au, i, RC.radius * 1.15);
    let io = Math.max(0, from - 1) * RADIAL * 6;
    for (let i = Math.max(1, from); i < rail.n; i++) io = this.writeIndices(idx, i - 1, (i - 1) * RADIAL * 6);
    rail.meshedN = rail.n;
    geo.attributes.position.needsUpdate = true; geo.attributes.aU.needsUpdate = true; geo.index.needsUpdate = true;
    geo.setDrawRange(0, (rail.n - 1) * RADIAL * 6);
  }

  destroyRail(rail, burst) {
    if (!rail.alive) return;
    rail.alive = false;
    if (this.growing === rail) { this.growing = null; rail.growing = false; }
    if (rail.mesh && rail.type === 1) rail.mesh.visible = false;
    const i = this.rails.indexOf(rail);
    if (i >= 0) { this.rails[i] = this.rails[this.rails.length - 1]; this.rails.pop(); }
    if (burst) this.game.vfx.railShatter(rail);
    this.game.player.onRailLost(rail);
  }

  update(dt) {
    for (const r of this.playerRails) {
      if (!r.alive || r.growing) continue;
      r.age += dt;
      r.fade = clamp((RG.lifetime - r.age) / RG.fadeTime, 0, 1);
      r.mesh.material.uniforms.uFade.value = 0.25 + 0.75 * r.fade;
      if (r.age >= RG.lifetime) this.destroyRail(r, true);
    }
  }
}
