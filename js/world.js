// WorldGen: endlose Chunk-Stadt, Instancing, Kollisionsdaten (räumliches Hash-Grid),
// Capsule-Kollision (Collide-and-Slide), Raycasts.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, hashInts, hashFloat, valueNoise2, clamp, lerp } from './util.js';

const W = CONFIG.world;
const S = W.chunkSize;
const HALF = S / 2;
const R = W.viewRadius;
const SLOTS = (2 * R + 1) * (2 * R + 1);
const BOX_PER = 128;
const SIGN_CAP = SLOTS * 5;
const G = W.gridCell;

const COL = {
  cyan: [0.10, 0.90, 1.00], magenta: [1.00, 0.17, 0.84], violet: [0.55, 0.30, 1.00],
  amber: [1.00, 0.62, 0.18], yellow: [1.00, 0.88, 0.15], blue: [0.25, 0.45, 1.00], white: [0.9, 0.95, 1.0],
};
const WINDOW_COLS = [COL.cyan, COL.magenta, COL.violet, COL.amber, COL.blue];

const VERT = /* glsl */`
attribute vec3 aColor; attribute vec4 aParams;
varying vec3 vWorld; varying vec3 vLocal; varying vec3 vScale; varying vec3 vColor; varying vec4 vParams; varying vec3 vN;
void main(){
  vLocal = position; vN = normal; vColor = aColor; vParams = aParams;
  vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
precision highp float;
uniform float uTime; uniform vec3 uFogColor; uniform float uFogDensity; uniform float uDesat; uniform float uBeat;
varying vec3 vWorld; varying vec3 vLocal; varying vec3 vScale; varying vec3 vColor; varying vec4 vParams; varying vec3 vN;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float style = vParams.x;
  vec3 an = abs(vN);
  vec2 fuv; vec2 fsize;
  if (an.y > 0.5) { fuv = vLocal.xz * vScale.xz; fsize = vScale.xz; }
  else if (an.x > 0.5) { fuv = vec2(vLocal.z * vScale.z, vLocal.y * vScale.y); fsize = vec2(vScale.z, vScale.y); }
  else { fuv = vec2(vLocal.x * vScale.x, vLocal.y * vScale.y); fsize = vec2(vScale.x, vScale.y); }
  vec2 edgeD = fsize * 0.5 - abs(fuv);
  float edge = min(edgeD.x, edgeD.y);
  vec3 col = vec3(0.03, 0.016, 0.06);
  bool top = an.y > 0.5 && vN.y > 0.0;
  if (style < 0.5) {
    // Hochhaus: Fenster in Weltkoordinaten, zufällig beleuchtet, einzelne flackern
    if (an.y > 0.5) {
      vec2 g = abs(fract(vWorld.xz / 4.0) - 0.5);
      col += vec3(0.02, 0.012, 0.045) * smoothstep(0.46, 0.5, max(g.x, g.y));
      col += vColor * smoothstep(0.32, 0.0, edge) * 0.85;
    } else {
      float u = an.x > 0.5 ? vWorld.z : vWorld.x;
      vec2 cell = vec2(u / 2.4, vWorld.y / 3.4);
      vec2 id = floor(cell); vec2 f = fract(cell);
      float seed = vParams.z;
      float h = hash(id + seed * 17.0);
      float mask = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.78);
      float lit = step(0.7, h);
      float fl = hash(id * 1.31 + seed);
      if (fl > 0.9) lit *= step(0.3, hash(vec2(floor(uTime * (3.0 + fl * 9.0)), h * 31.0)));
      vec3 wc = mix(vColor, vec3(1.0, 0.82, 0.5), step(0.9, h));
      col += mask * lit * wc * (0.28 + 0.42 * h);
      col += vec3(0.022, 0.012, 0.045) * mask * (1.0 - lit);
      col += vColor * smoothstep(0.28, 0.0, edgeD.x) * 0.55 * step(0.45, hash(vec2(seed, 3.0)));
      col += vColor * smoothstep(0.5, 0.0, fsize.y * 0.5 - fuv.y) * 0.7;
    }
  } else if (style < 1.5) {
    // Plattform: dunkle Fläche, Gitter, starke Neon-Kante (Lesbarkeit!)
    float trim = smoothstep(0.22, 0.0, edge);
    if (top) {
      vec2 g = abs(fract(vWorld.xz / 2.0) - 0.5);
      col += vColor * 0.10 * smoothstep(0.47, 0.5, max(g.x, g.y));
      col += vColor * trim * (1.25 + 0.5 * uBeat);
    } else {
      col += vColor * trim * 0.7;
      col += vColor * 0.25 * smoothstep(0.12, 0.0, abs(fsize.y * 0.5 - fuv.y - 0.25));
    }
  } else if (style < 2.5) {
    // Wallrun-Wand: laufende Chevrons
    float trim = smoothstep(0.2, 0.0, edge);
    col += vColor * trim;
    if (an.y < 0.5 && fsize.x > 2.0) {
      float c = fract((fuv.x * vParams.y + abs(fract(fuv.y / 2.4) - 0.5) * 2.4) / 3.2 - uTime * 0.55);
      float glow = smoothstep(0.0, 0.06, c) * smoothstep(0.26, 0.16, c);
      col += vColor * glow * 0.55;
    }
  } else if (style < 3.5) {
    // Boost-/Launch-Pad: Pfeile in Richtung des Schubs
    float a = vParams.y; vec2 d = vec2(cos(a), sin(a));
    vec2 p = vec2(dot(fuv, d), dot(fuv, vec2(-d.y, d.x)));
    float c = fract((p.x - abs(p.y) * 0.8) / 1.4 - uTime * 2.2);
    float glow = smoothstep(0.0, 0.1, c) * smoothstep(0.5, 0.3, c);
    float pulse = vParams.w > 0.5 ? (0.6 + 0.4 * sin(uTime * 9.0)) : 1.0;
    col = vColor * (0.05 + glow * 0.42 * pulse) + vColor * smoothstep(0.2, 0.0, edge) * 0.6;
  } else {
    // Pfeiler
    col += vColor * 0.5 * smoothstep(0.1, 0.0, abs(fuv.x)) * step(0.5, fract(vWorld.y / 6.0 - uTime * 0.2));
  }
  float d = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-d * d * uFogDensity * uFogDensity);
  float hf = smoothstep(26.0, -4.0, vWorld.y);
  col = mix(col, uFogColor, max(fog, hf * 0.9));
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l) * vec3(0.5, 0.58, 0.72), uDesat);
  gl_FragColor = vec4(col, 1.0);
}`;

const SIGN_VERT = /* glsl */`
attribute vec4 aSign; attribute vec3 aColor;
varying vec2 vUv; varying vec3 vColor; varying vec3 vWorld; varying float vPhase;
void main(){
  vUv = (uv + aSign.xy) * 0.25; vColor = aColor; vPhase = aSign.z;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SIGN_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uAtlas; uniform float uTime; uniform vec3 uFogColor; uniform float uFogDensity; uniform float uDesat;
varying vec2 vUv; varying vec3 vColor; varying vec3 vWorld; varying float vPhase;
void main(){
  float a = texture2D(uAtlas, vUv).r;
  float fl = step(0.08, fract(sin(floor(uTime * 7.0) * 12.9898 + vPhase * 78.233) * 43758.5453) + step(vPhase, 0.6));
  vec3 col = vColor * a * 1.8 * fl;
  float d = distance(vWorld, cameraPosition);
  float fog = exp(-d * d * uFogDensity * uFogDensity);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), uDesat);
  gl_FragColor = vec4(col * fog, a * fog);
}`;

export class WorldGen {
  constructor(game) {
    this.game = game;
    this.seed = 1;
    this.grid = new Map();
    this.chunks = new Map();
    this.freeSlots = [];
    this.queue = [];
    this.center = { cx: 1e9, cz: 1e9 };
    this.stamp = 1;
    this._cand = [];
    this._res = this.makeResult();
    this.signsDirty = false;
    this.colliderId = 1;
    this.dynamic = [];
    this.uniforms = {
      uTime: { value: 0 }, uFogColor: { value: new THREE.Color(W.fogColor) }, uFogDensity: { value: W.fogDensity },
      uDesat: { value: 0 }, uBeat: { value: 0 },
    };
    // Sprungphysik -> maximal sichere Lücke (für den Critical Path)
    const P = CONFIG.player;
    this.jumpApex = (P.jumpImpulse * P.jumpImpulse) / (2 * P.gravity);
  }

  // Horizontale Distanz, die ein einfacher Sprung im Sprint schafft, wenn das Ziel um `rise` höher liegt.
  jumpDist(rise) {
    const P = CONFIG.player, v = P.jumpImpulse, g = P.gravity;
    const disc = v * v - 2 * g * Math.max(rise, -30);
    if (disc <= 0) return 0;
    return P.sprintSpeed * (v + Math.sqrt(disc)) / g;
  }

  makeResult() {
    return { grounded: false, gnx: 0, gny: 1, gnz: 0, ground: null, wall: false, wnx: 0, wnz: 0, wallCol: null, ceiling: false, stepUp: 0 };
  }

  init(scene) {
    const cap = SLOTS * BOX_PER;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aParams', this.aParams);
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms });
    this.mesh = new THREE.InstancedMesh(geo, this.material, cap);
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);

    // Neon-Schilder: Canvas-Atlas mit Fantasie-Schriftzeichen
    const sgeo = new THREE.PlaneGeometry(1, 1);
    this.aSign = new THREE.InstancedBufferAttribute(new Float32Array(SIGN_CAP * 4), 4);
    this.aSignColor = new THREE.InstancedBufferAttribute(new Float32Array(SIGN_CAP * 3), 3);
    sgeo.setAttribute('aSign', this.aSign);
    sgeo.setAttribute('aColor', this.aSignColor);
    this.signMat = new THREE.ShaderMaterial({
      vertexShader: SIGN_VERT, fragmentShader: SIGN_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uAtlas: { value: this.makeSignAtlas() }, uTime: this.uniforms.uTime, uFogColor: this.uniforms.uFogColor, uFogDensity: this.uniforms.uFogDensity, uDesat: this.uniforms.uDesat },
    });
    this.signMesh = new THREE.InstancedMesh(sgeo, this.signMat, SIGN_CAP);
    this.signMesh.frustumCulled = false;
    this.signMesh.count = 0;
    scene.add(this.signMesh);
    for (let i = SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);
  }

  makeSignAtlas() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
    const rng = mulberry32(90210);
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'square';
    for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
      const ox = cx * 128, oy = cy * 128;
      const vertical = (cx + cy) % 2 === 0;
      const n = 3 + ((rng() * 2) | 0);
      g.lineWidth = 3; g.strokeRect(ox + 8, oy + 8, 112, 112);
      for (let k = 0; k < n; k++) {
        // ein Glyph = zufällige Striche auf einem 3x3-Raster
        const gw = vertical ? 60 : 96 / n, gh = vertical ? 96 / n : 60;
        const gx = vertical ? ox + 34 : ox + 16 + k * gw, gy = vertical ? oy + 16 + k * gh : oy + 34;
        const sx = (gw - 8) / 2, sy = (gh - 8) / 2;
        g.lineWidth = 5;
        const strokes = 3 + ((rng() * 3) | 0);
        for (let s = 0; s < strokes; s++) {
          const ax = (rng() * 3) | 0, ay = (rng() * 3) | 0;
          let bx = ax, by = ay;
          if (rng() < 0.5) bx = (rng() * 3) | 0; else by = (rng() * 3) | 0;
          g.beginPath(); g.moveTo(gx + 4 + ax * sx, gy + 4 + ay * sy); g.lineTo(gx + 4 + bx * sx, gy + 4 + by * sy); g.stroke();
        }
        if (rng() < 0.4) { g.beginPath(); g.arc(gx + gw / 2, gy + gh / 2, 3.5, 0, 6.3); g.fill(); }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
    return tex;
  }

  // ---------------------------------------------------------------- Chunk-Verwaltung
  reset(seed) {
    for (const ch of this.chunks.values()) this.unload(ch, true);
    this.chunks.clear();
    this.grid.clear();
    for (const c of this.dynamic) this.insert(c);
    this.queue.length = 0;
    this.freeSlots.length = 0;
    for (let i = SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.seed = seed >>> 0;
    this.center.cx = 1e9; this.center.cz = 1e9;
  }

  key(cx, cz) { return (cx + 32768) * 65536 + (cz + 32768); }
  chunkAt(x, z) { return this.chunks.get(this.key(Math.round(x / S), Math.round(z / S))); }

  hubHeight(cx, cz) {
    const n = valueNoise2(cx * W.heightFreq + 100, cz * W.heightFreq + 100, this.seed) * 2 - 1;
    return Math.round((W.baseHeight + n * W.heightAmp) * 2) / 2;
  }
  gateY(cx, cz, axis) {
    const a = this.hubHeight(cx, cz), b = axis === 0 ? this.hubHeight(cx + 1, cz) : this.hubHeight(cx, cz + 1);
    return Math.round((a + b)) / 2;
  }
  gateLat(cx, cz, axis) { return (hashFloat(cx, cz, this.seed, 20 + axis) - 0.5) * 10; }

  update(fx, fz, sync) {
    const c = this.center;
    // Hysterese: erst umzentrieren, wenn man klar im Nachbar-Chunk ist
    if (Math.abs(fx - c.cx * S) > S * 0.62 || Math.abs(fz - c.cz * S) > S * 0.62) {
      c.cx = Math.round(fx / S); c.cz = Math.round(fz / S);
      for (const ch of this.chunks.values()) {
        if (Math.abs(ch.cx - c.cx) > R || Math.abs(ch.cz - c.cz) > R) { this.unload(ch); this.chunks.delete(this.key(ch.cx, ch.cz)); }
      }
      this.queue.length = 0;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const cx = c.cx + dx, cz = c.cz + dz;
        if (!this.chunks.has(this.key(cx, cz))) this.queue.push({ cx, cz, d: dx * dx + dz * dz });
      }
      this.queue.sort((a, b) => b.d - a.d);
    }
    let budget = sync ? 999 : 1;
    while (this.queue.length && budget-- > 0) {
      const q = this.queue.pop();
      if (this.chunks.has(this.key(q.cx, q.cz)) || !this.freeSlots.length) continue;
      this.generate(q.cx, q.cz);
    }
    if (this.signsDirty) this.rebuildSigns();
  }

  unload(ch, skipGrid) {
    if (!skipGrid) for (const col of ch.colliders) this.remove(col);
    this.game.rails.removeChunkRails(ch);
    const base = ch.slot * BOX_PER;
    this.mesh.instanceMatrix.array.fill(0, base * 16, (base + BOX_PER) * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.freeSlots.push(ch.slot);
    this.signsDirty = true;
  }

  // ---------------------------------------------------------------- Hash-Grid
  cellKey(ix, iz) { return (ix + 4096) * 8192 + (iz + 4096); }
  insert(c) {
    const x0 = Math.floor(c.minX / G), x1 = Math.floor(c.maxX / G), z0 = Math.floor(c.minZ / G), z1 = Math.floor(c.maxZ / G);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = this.cellKey(ix, iz);
      let arr = this.grid.get(k);
      if (!arr) { arr = []; this.grid.set(k, arr); }
      arr.push(c);
    }
  }
  remove(c) {
    const x0 = Math.floor(c.minX / G), x1 = Math.floor(c.maxX / G), z0 = Math.floor(c.minZ / G), z1 = Math.floor(c.maxZ / G);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = this.cellKey(ix, iz);
      const arr = this.grid.get(k);
      if (!arr) continue;
      const i = arr.indexOf(c);
      if (i >= 0) { arr[i] = arr[arr.length - 1]; arr.pop(); }
      if (!arr.length) this.grid.delete(k);
    }
  }
  addDynamic(c) { c.id = this.colliderId++; c.stamp = 0; this.dynamic.push(c); this.insert(c); return c; }
  removeDynamic(c) { const i = this.dynamic.indexOf(c); if (i >= 0) { this.dynamic.splice(i, 1); this.remove(c); } }

  query(minX, minZ, maxX, maxZ, out) {
    const stamp = ++this.stamp;
    let n = 0;
    const x0 = Math.floor(minX / G), x1 = Math.floor(maxX / G), z0 = Math.floor(minZ / G), z1 = Math.floor(maxZ / G);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const arr = this.grid.get(this.cellKey(ix, iz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (c.stamp === stamp) continue;
        c.stamp = stamp;
        if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
        out[n++] = c;
      }
    }
    return n;
  }

  rampTop(c, x, z) {
    const t = c.axis === 0 ? (x - c.minX) / (c.maxX - c.minX) : (z - c.minZ) / (c.maxZ - c.minZ);
    return c.yA + (c.yB - c.yA) * clamp(t, 0, 1);
  }

  // ---------------------------------------------------------------- Capsule-Kollision
  // Collide-and-Slide in Depenetrations-Form: Bewegung wird in Substeps (<= 0.3 m) zerlegt, nach jedem
  // Substep wird die Kapsel aus allen Boxen herausgeschoben und die Geschwindigkeit an der Kontaktebene
  // abgeklippt (v -= n * min(0, v·n)). Mehrere Iterationen lösen Ecken sauber auf; tangentiales Tempo bleibt.
  // Oberkanten bis stepLimit werden überstiegen (Treppen-/Kanten-Assist, Edge-Grab in der Luft).
  moveCapsule(p, v, dt, r, h, wasGrounded, res) {
    res.grounded = false; res.wall = false; res.ceiling = false; res.stepUp = 0; res.ground = null; res.wallCol = null;
    res.gnx = 0; res.gny = 1; res.gnz = 0;
    const dist = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * dt;
    const reach = dist + r + 1;
    const n = this.query(p.x - reach, p.z - reach, p.x + reach, p.z + reach, this._cand);
    const steps = Math.min(12, Math.max(1, Math.ceil(dist / 0.3)));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      p.x += v.x * sdt; p.y += v.y * sdt; p.z += v.z * sdt;
      if (n === 0) continue;
      for (let it = 0; it < 4; it++) {
        if (!this.resolve(p, v, r, h, wasGrounded || res.grounded, res, this._cand, n)) break;
      }
    }
    return res;
  }

  resolve(p, v, r, h, groundedHint, res, cands, n) {
    const P = CONFIG.player;
    let any = false;
    const r2 = r * r;
    const stepLimit = groundedHint ? P.stepHeight : (v.y < 6 ? P.ledgeHeight : 0.02);
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      if (p.x + r < c.minX || p.x - r > c.maxX || p.z + r < c.minZ || p.z - r > c.maxZ || p.y > c.maxY + 0.12 || p.y + h < c.minY) continue;
      const qx = p.x < c.minX ? c.minX : p.x > c.maxX ? c.maxX : p.x;
      const qz = p.z < c.minZ ? c.minZ : p.z > c.maxZ ? c.maxZ : p.z;
      const dx = p.x - qx, dz = p.z - qz;
      const dxz2 = dx * dx + dz * dz;
      if (dxz2 >= r2) continue;
      let top = c.maxY;
      if (c.ramp) {
        top = this.rampTop(c, qx, qz);
        if (dxz2 === 0 && p.y > top - 1.0) {
          // Schräge: untere Kugel der Kapsel gegen die Ebene
          const d = (p.y + r - top) * c.ny;
          if (d < r) {
            const push = r - d;
            p.x += c.nx * push; p.y += c.ny * push; p.z += c.nz * push;
            const vn = v.x * c.nx + v.y * c.ny + v.z * c.nz;
            if (vn < 0) { v.x -= c.nx * vn; v.y -= c.ny * vn; v.z -= c.nz * vn; }
            res.grounded = true; res.gnx = c.nx; res.gny = c.ny; res.gnz = c.nz; res.ground = c;
            any = true;
          }
          continue;
        }
        if (p.y > top + 0.12) continue;
      }
      const lift = top - p.y;
      if (lift > 0 && lift <= stepLimit) {
        if (lift < 0.06 || this.capsuleFree(p.x, top + 0.02, p.z, r - 0.03, h, cands, n)) {
          res.stepUp += lift;
          p.y = top;
          if (v.y < 0) v.y = 0;
          res.grounded = true; res.gnx = 0; res.gny = 1; res.gnz = 0; res.ground = c;
          any = true;
          continue;
        }
      }
      const a = p.y + r, b = p.y + Math.max(h - r, r);
      let dy = 0;
      if (b < c.minY) dy = b - c.minY; else if (a > top) dy = a - top;
      const d2 = dxz2 + dy * dy;
      if (d2 >= r2) continue;
      let nx, ny, nz, push;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        nx = dx / d; ny = dy / d; nz = dz / d; push = r - d;
      } else {
        // Kapselachse steckt in der Box: über die kürzeste Achse hinaus
        const pxl = p.x - c.minX + r, pxr = c.maxX - p.x + r, pzl = p.z - c.minZ + r, pzr = c.maxZ - p.z + r;
        const pup = top - p.y, pdn = p.y + h - c.minY;
        push = pxl; nx = -1; ny = 0; nz = 0;
        if (pxr < push) { push = pxr; nx = 1; }
        if (pzl < push) { push = pzl; nx = 0; nz = -1; }
        if (pzr < push) { push = pzr; nx = 0; nz = 1; }
        if (pup < push) { push = pup; nx = 0; nz = 0; ny = 1; }
        if (pdn < push) { push = pdn; nx = 0; nz = 0; ny = -1; }
      }
      p.x += nx * push; p.y += ny * push; p.z += nz * push;
      const vn = v.x * nx + v.y * ny + v.z * nz;
      if (vn < 0) { v.x -= nx * vn; v.y -= ny * vn; v.z -= nz * vn; }
      if (ny > 0.7) { res.grounded = true; res.gnx = 0; res.gny = 1; res.gnz = 0; res.ground = c; }
      else if (ny < -0.7) res.ceiling = true;
      else { res.wall = true; res.wnx = nx; res.wnz = nz; res.wallCol = c; }
      any = true;
    }
    return any;
  }

  capsuleFree(x, y, z, r, h, cands, n) {
    if (!cands) { cands = this._cand; n = this.query(x - r - 0.1, z - r - 0.1, x + r + 0.1, z + r + 0.1, cands); }
    const a = y + r, b = y + Math.max(h - r, r);
    for (let i = 0; i < n; i++) {
      const c = cands[i];
      const qx = clamp(x, c.minX, c.maxX), qz = clamp(z, c.minZ, c.maxZ);
      const dx = x - qx, dz = z - qz;
      const top = c.ramp ? this.rampTop(c, qx, qz) : c.maxY;
      let dy = 0;
      if (b < c.minY) dy = b - c.minY; else if (a > top) dy = a - top;
      if (dx * dx + dz * dz + dy * dy < r * r) return false;
    }
    return true;
  }

  // Sucht Boden knapp unter den Füssen (für Ground-Snap auf Treppen/Gefälle und Schatten-Marker)
  probeGround(x, y, z, r, maxDrop, out) {
    const n = this.query(x - r, z - r, x + r, z + r, this._cand);
    let best = -1e9;
    for (let i = 0; i < n; i++) {
      const c = this._cand[i];
      const qx = clamp(x, c.minX, c.maxX), qz = clamp(z, c.minZ, c.maxZ);
      const dx = x - qx, dz = z - qz;
      if (dx * dx + dz * dz >= r * r) continue;
      const top = c.ramp ? this.rampTop(c, qx, qz) : c.maxY;
      if (top <= y + 0.05 && top >= y - maxDrop && top > best) {
        best = top; out.ground = c;
        if (c.ramp && dx === 0 && dz === 0) { out.gnx = c.nx; out.gny = c.ny; out.gnz = c.nz; } else { out.gnx = 0; out.gny = 1; out.gnz = 0; }
      }
    }
    out.y = best;
    return best > -1e8;
  }

  // Wallrun-Kandidat: nächste vertikale Box-Fläche seitlich innerhalb maxDist
  findWall(x, y, z, r, maxDist, out) {
    const reach = r + maxDist;
    const n = this.query(x - reach, z - reach, x + reach, z + reach, this._cand);
    let best = reach + 1; out.col = null;
    const chest = y + 1.0;
    for (let i = 0; i < n; i++) {
      const c = this._cand[i];
      if (c.ramp || c.noWall) continue;
      if (c.maxY - c.minY < 2.5 || chest > c.maxY - 0.15 || chest < c.minY + 0.2) continue;
      const qx = clamp(x, c.minX, c.maxX), qz = clamp(z, c.minZ, c.maxZ);
      const dx = x - qx, dz = z - qz;
      if (dx !== 0 && dz !== 0) continue;        // Ecke: keine eindeutige Fläche
      if (dx === 0 && dz === 0) continue;        // in der Box
      let d, nx = 0, nz = 0;
      if (dx !== 0) { if (c.maxZ - c.minZ < 2.5) continue; d = Math.abs(dx); nx = dx > 0 ? 1 : -1; }
      else { if (c.maxX - c.minX < 2.5) continue; d = Math.abs(dz); nz = dz > 0 ? 1 : -1; }
      if (d <= reach && d < best) { best = d; out.col = c; out.nx = nx; out.nz = nz; out.dist = d; }
    }
    return out.col !== null;
  }

  pointSolid(x, y, z) {
    const arr = this.grid.get(this.cellKey(Math.floor(x / G), Math.floor(z / G)));
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ || y < c.minY) continue;
      const top = c.ramp ? this.rampTop(c, x, z) : c.maxY;
      if (y <= top) return true;
    }
    return false;
  }

  // Raycast: 2D-DDA durch das Hash-Grid, pro Zelle Slab-Test gegen die Boxen.
  raycast(ox, oy, oz, dx, dy, dz, maxT, hit) {
    let ix = Math.floor(ox / G), iz = Math.floor(oz / G);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    let tMaxX = dx !== 0 ? ((dx > 0 ? (ix + 1) * G : ix * G) - ox) / dx : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? (iz + 1) * G : iz * G) - oz) / dz : Infinity;
    const tDX = dx !== 0 ? G / Math.abs(dx) : Infinity, tDZ = dz !== 0 ? G / Math.abs(dz) : Infinity;
    const stamp = ++this.stamp;
    let best = maxT, found = false;
    const ivx = 1 / dx, ivy = 1 / dy, ivz = 1 / dz;
    for (let iter = 0; iter < 96; iter++) {
      const arr = this.grid.get(this.cellKey(ix, iz));
      if (arr) for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (c.stamp === stamp) continue;
        c.stamp = stamp;
        let t0 = (c.minX - ox) * ivx, t1 = (c.maxX - ox) * ivx, ax = 0, sgn = -stepX;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        let tn = t0, tf = t1;
        t0 = (c.minY - oy) * ivy; t1 = (c.maxY - oy) * ivy;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 > tn) { tn = t0; ax = 1; sgn = dy > 0 ? -1 : 1; }
        if (t1 < tf) tf = t1;
        t0 = (c.minZ - oz) * ivz; t1 = (c.maxZ - oz) * ivz;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 > tn) { tn = t0; ax = 2; sgn = -stepZ; }
        if (t1 < tf) tf = t1;
        if (!(tn <= tf) || tf < 0) continue;
        if (tn < 0) tn = 0;
        let nx = ax === 0 ? sgn : 0, ny = ax === 1 ? sgn : 0, nz = ax === 2 ? sgn : 0;
        if (c.ramp) {
          // Treffer oberhalb der Schräge? Dann gegen die Ebene testen.
          const hx = ox + dx * tn, hy = oy + dy * tn, hz = oz + dz * tn;
          if (hy > this.rampTop(c, hx, hz) + 0.05) {
            const px = c.axis === 0 ? c.minX : hx, pz = c.axis === 0 ? hz : c.minZ;
            const denom = dx * c.nx + dy * c.ny + dz * c.nz;
            if (denom >= -1e-6) continue;
            const tp = ((px - ox) * c.nx + (c.yA - oy) * c.ny + (pz - oz) * c.nz) / denom;
            if (tp < tn || tp > tf) continue;
            tn = tp; nx = c.nx; ny = c.ny; nz = c.nz;
          }
        }
        if (tn < best) { best = tn; found = true; hit.t = tn; hit.nx = nx; hit.ny = ny; hit.nz = nz; hit.col = c; }
      }
      const tExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if ((found && best <= tExit) || tExit > maxT) break;
      if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDX; } else { iz += stepZ; tMaxZ += tDZ; }
    }
    if (found) { hit.x = ox + dx * best; hit.y = oy + dy * best; hit.z = oz + dz * best; }
    return found;
  }

  // ---------------------------------------------------------------- Chunk-Generierung
  generate(cx, cz) {
    const slot = this.freeSlots.pop();
    const ch = { cx, cz, slot, colliders: [], rails: [], pads: [], perches: [], signs: [], paths: [], hubY: 0, hubX: 0, hubZ: 0, nInst: 0 };
    this.chunks.set(this.key(cx, cz), ch);
    const rng = mulberry32(hashInts(this.seed, cx, cz, 77));
    const ox = cx * S, oz = cz * S;
    const isStart = cx === 0 && cz === 0;
    const base = slot * BOX_PER;
    const M = this.mesh.instanceMatrix.array, AC = this.aColor.array, AP = this.aParams.array;
    const self = this;

    function inst(minX, minY, minZ, maxX, maxY, maxZ, style, col, p1, p2, p3, shX, shZ) {
      if (ch.nInst >= BOX_PER) return;
      const i = base + ch.nInst++;
      const o = i * 16;
      const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
      M[o] = sx; M[o + 1] = (shX || 0) * sx; M[o + 2] = 0; M[o + 3] = 0;
      M[o + 4] = 0; M[o + 5] = sy; M[o + 6] = 0; M[o + 7] = 0;
      M[o + 8] = 0; M[o + 9] = (shZ || 0) * sz; M[o + 10] = sz; M[o + 11] = 0;
      M[o + 12] = (minX + maxX) / 2; M[o + 13] = (minY + maxY) / 2; M[o + 14] = (minZ + maxZ) / 2; M[o + 15] = 1;
      AC[i * 3] = col[0]; AC[i * 3 + 1] = col[1]; AC[i * 3 + 2] = col[2];
      AP[i * 4] = style; AP[i * 4 + 1] = p1 || 0; AP[i * 4 + 2] = p2 || 0; AP[i * 4 + 3] = p3 || 0;
    }
    function collider(minX, minY, minZ, maxX, maxY, maxZ) {
      const c = { id: self.colliderId++, stamp: 0, minX, minY, minZ, maxX, maxY, maxZ, ramp: false, noWall: false };
      ch.colliders.push(c); self.insert(c);
      return c;
    }
    function box(minX, minY, minZ, maxX, maxY, maxZ, style, col, p1, p2) {
      inst(minX, minY, minZ, maxX, maxY, maxZ, style, col, p1, p2);
      return collider(minX, minY, minZ, maxX, maxY, maxZ);
    }
    // Schräge entlang axis (0 = x, 1 = z): yA an der min-Seite, yB an der max-Seite
    function ramp(minX, minZ, maxX, maxZ, axis, yA, yB, thick, col, solidBase) {
      const len = axis === 0 ? maxX - minX : maxZ - minZ;
      const k = (yB - yA) / len;
      const cy = (yA + yB) / 2;
      inst(minX, cy - thick, minZ, maxX, cy, maxZ, 1, col, 0, 0, 0, axis === 0 ? k : 0, axis === 1 ? k : 0);
      const c = collider(minX, solidBase !== undefined ? solidBase : Math.min(yA, yB) - thick, minZ, maxX, Math.max(yA, yB), maxZ);
      c.ramp = true; c.axis = axis; c.yA = yA; c.yB = yB;
      const inv = 1 / Math.sqrt(1 + k * k);
      c.nx = axis === 0 ? -k * inv : 0; c.ny = inv; c.nz = axis === 1 ? -k * inv : 0;
      return c;
    }
    const B = W.buildingBottom;
    function pylon(x, z, topY, col) { inst(x - 0.5, B, z - 0.5, x + 0.5, topY, z + 0.5, 4, col); }
    function pad(x, y, z, hw, dx, dz, launch) {
      const a = Math.atan2(dz, dx);
      inst(x - hw, y + 0.02, z - hw, x + hw, y + 0.1, z + hw, 3, launch ? COL.magenta : COL.yellow, a, 0, launch ? 1 : 0);
      ch.pads.push({ x, y, z, hw, dx, dz, launch: !!launch, readyAt: 0 });
    }

    // --- Hub: zentrales Dach
    const hubY = this.hubHeight(cx, cz);
    const hubHalf = isStart ? 11 : 8 + Math.floor(rng() * 4);
    const hx = isStart ? ox : ox + Math.round((rng() - 0.5) * 6), hz = isStart ? oz : oz + Math.round((rng() - 0.5) * 6);
    ch.hubY = hubY; ch.hubX = hx; ch.hubZ = hz; ch.hubHalf = hubHalf;
    const hubCol = WINDOW_COLS[(rng() * WINDOW_COLS.length) | 0];
    box(hx - hubHalf, B, hz - hubHalf, hx + hubHalf, hubY, hz + hubHalf, 0, hubCol, 0, rng() * 10);
    if (!isStart) ch.perches.push({ x: hx + (rng() - 0.5) * hubHalf, y: hubY, z: hz + (rng() - 0.5) * hubHalf });

    // --- Gates: geteilte Plattformen auf den Chunk-Kanten (+x und +z gehören diesem Chunk)
    const gates = [
      { a: ox + HALF, l: oz + this.gateLat(cx, cz, 0), y: this.gateY(cx, cz, 0) },
      { a: ox - HALF, l: oz + this.gateLat(cx - 1, cz, 0), y: this.gateY(cx - 1, cz, 0) },
      { a: oz + HALF, l: ox + this.gateLat(cx, cz, 1), y: this.gateY(cx, cz, 1) },
      { a: oz - HALF, l: ox + this.gateLat(cx, cz - 1, 1), y: this.gateY(cx, cz - 1, 1) },
    ];
    {
      const g0 = gates[0], g2 = gates[2];
      box(g0.a - 4, g0.y - 1.2, g0.l - 6, g0.a + 4, g0.y, g0.l + 6, 1, COL.cyan);
      pylon(g0.a, g0.l, g0.y - 1.2, COL.cyan);
      box(g2.l - 6, g2.y - 1.2, g2.a - 4, g2.l + 6, g2.y, g2.a + 4, 1, COL.cyan);
      pylon(g2.l, g2.a, g2.y - 1.2, COL.cyan);
    }

    // --- Critical Path: Hub <-> jedes Gate, garantiert mit einfachen Sprüngen im Sprint machbar (ohne Rail-Gun,
    // ohne Doppelsprung). Lücken werden aus den Movement-Werten berechnet (jumpDist), validateChunk prüft
    // Lücke <= jumpSafety * jumpDist(Stufe). Rails, Wände und Pads kommen als optionale Extras obendrauf.
    const connTypes = [];
    for (let d = 0; d < 4; d++) {
      const xAxis = d < 2;
      const sgn = (d === 0 || d === 2) ? 1 : -1;
      const g = gates[d];
      const hubA = xAxis ? hx : hz, hubL = xAxis ? hz : hx;
      const aStart = hubA + sgn * hubHalf;
      const aEnd = g.a - sgn * 4;
      const L = Math.abs(aEnd - aStart);
      const l = clamp(g.l, hubL - (hubHalf - 3), hubL + (hubHalf - 3));
      const dh = g.y - hubY;
      // Hilfsfunktion: Box aus (along, lateral)-Koordinaten
      const AB = (a0, a1, l0, l1, y0, y1, style, col, p1, p2) => {
        const amin = Math.min(a0, a1), amax = Math.max(a0, a1);
        return xAxis ? box(amin, y0, l0, amax, y1, l1, style, col, p1, p2) : box(l0, y0, amin, l1, y1, amax, style, col, p1, p2);
      };
      const XZ = (a, lat) => (xAxis ? [a, lat] : [lat, a]);
      let type;
      const roll = rng();
      if (roll < 0.27) type = 'steps';
      else if (roll < 0.5) type = 'bridge';
      else if (roll < 0.76) type = 'walls';
      else type = 'rail';
      if (isStart && d === 3) type = 'rail';
      // Grosse Höhenunterschiede überbrückt immer eine Rampe (keine Sprünge nötig)
      const railArc = type === 'rail';
      let railSide = 0;
      if (Math.abs(dh) > 2.4) type = 'bridge';
      connTypes.push(type);
      const path = { type, gaps: [], rises: [] };
      ch.paths.push(path);
      const trim = type === 'walls' ? COL.violet : (railArc ? COL.cyan : COL.blue);

      if (type === 'bridge') {
        const lo = l - 2.2, hi = l + 2.2;
        if (Math.abs(dh) < 0.35) {
          const y = Math.min(hubY, g.y) + Math.abs(dh) / 2;
          AB(aStart, aEnd, lo, hi, y - 0.7, y, 1, trim);
        } else {
          const amin = Math.min(aStart, aEnd), amax = Math.max(aStart, aEnd);
          const yA = sgn > 0 ? hubY : g.y, yB = sgn > 0 ? g.y : hubY;
          if (xAxis) ramp(amin, lo, amax, hi, 0, yA, yB, 0.7, trim); else ramp(lo, amin, hi, amax, 1, yA, yB, 0.7, trim);
        }
        const mid = XZ((aStart + aEnd) / 2, l);
        pylon(mid[0], mid[1], Math.min(hubY, g.y) - 1.2, trim);
        path.gaps.push(0); path.rises.push(0);
      } else {
        // Eine lange Zwischenplattform, zwei Lücken. Die Lücke kommt aus der Sprungphysik:
        // 62 % der Sprint-Sprungweite (bergauf gerechnet) -> ein Absprung an der Kante landet mitten auf dem Ziel,
        // und auch bergab mit vollem Tempo überspringt man weder Plattform noch Gate.
        const yMid = Math.round((hubY + dh / 2) * 4) / 4;
        const rise = Math.max(Math.abs(yMid - hubY), Math.abs(g.y - yMid));
        const gap = Math.min(7.2, 0.62 * this.jumpDist(rise));
        const sLen = L - 2 * gap;
        const zig = type === 'steps' ? (rng() < 0.5 ? -1.6 : 1.6) : 0;
        const hw = type === 'walls' ? 2.4 : 3;
        const yMin = Math.min(hubY, g.y), yMax = Math.max(hubY, g.y);
        const ac = aStart + sgn * (gap + sLen / 2), lat = l + zig;
        AB(ac - sLen / 2, ac + sLen / 2, lat - hw, lat + hw, yMid - 0.8, yMid, 1, trim);
        const pp = XZ(ac, lat); pylon(pp[0], pp[1], yMid - 0.8, trim);
        path.gaps.push(gap, gap); path.rises.push(rise, rise);
        if (type === 'walls') {
          // Wallrun-Korridor: zwei parallele Wände, zwischen denen man hin und her springen kann
          const a0 = aStart + sgn * 3, a1 = aEnd - sgn * 3;
          const w1 = AB(a0, a1, l - 3.7, l - 2.9, yMin - 2, yMax + 8.5, 2, COL.violet, sgn);
          const w2 = AB(a0, a1, l + 2.9, l + 3.7, yMin - 2, yMax + 8.5, 2, COL.violet, sgn);
          w1.isWall = w2.isWall = true;
          const pm = XZ((a0 + a1) / 2, l - 3.3), pn = XZ((a0 + a1) / 2, l + 3.3);
          pylon(pm[0], pm[1], yMin - 2, COL.violet); pylon(pn[0], pn[1], yMin - 2, COL.violet);
        }
      }
      if (railArc) {
        const side = l > hubL ? -1 : 1;      // zur Dachmitte hin: das Boost-Pad davor liegt sicher auf dem Dach
        railSide = side;
        const arc = 3.5 + rng() * 3;
        // Start knapp ausserhalb der Dachkante: kreuzt keinen anderen Laufweg (keine versehentlichen Snaps)
        const p0 = XZ(aStart + sgn * 1.3, l + side * 3.6), p1 = XZ(aStart + sgn * L * 0.36, l + side * 5.2);
        const p2 = XZ(aStart + sgn * L * 0.66, l + side * 5.2), p3 = XZ(aEnd + sgn * 2, l + side * 3);
        this.game.rails.addWorldRail([
          p0[0], hubY + 1.1, p0[1], p1[0], hubY + dh * 0.33 + arc, p1[1],
          p2[0], hubY + dh * 0.66 + arc, p2[1], p3[0], g.y + 1.1, p3[1]], ch);
      }
      ch['conn' + d] = { type, l, aStart, aEnd, sgn, xAxis, railSide };
    }

    // --- Quadranten-Gebäude: Fangdächer (tief), Nebendächer, Türme (hoch)
    let spiralDone = false;
    for (let q = 0; q < 4; q++) {
      const sx = q & 1 ? 1 : -1, sz = q & 2 ? 1 : -1;
      const tx = ox + sx * (23 + rng() * 4), tz = oz + sz * (23 + rng() * 4);
      const half = 6 + rng() * 5;
      const kind = rng();
      let roofY;
      if (kind < 0.33) roofY = hubY - 4 - rng() * 9;
      else if (kind < 0.6) roofY = hubY - 2 + rng() * 8;
      else roofY = hubY + 14 + rng() * 26;
      roofY = Math.max(21, Math.round(roofY * 2) / 2);
      const col = WINDOW_COLS[(rng() * WINDOW_COLS.length) | 0];
      box(tx - half, B, tz - half, tx + half, roofY, tz + half, 0, col, 0, rng() * 10);
      const tall = roofY > hubY + 12;
      if (!tall || roofY < hubY + 30) ch.perches.push({ x: tx + (rng() - 0.5) * half, y: roofY, z: tz + (rng() - 0.5) * half });
      if (kind < 0.33) {
        // Fangdach: Launch-Pad zurück Richtung Hub
        const ddx = hx - tx, ddz = hz - tz, dl = Math.hypot(ddx, ddz);
        pad(tx, roofY, tz, 2, ddx / dl, ddz / dl, true);
      }
      // Dach-Rail zum nächsten Gate (Rückweg nach oben / schnelle Abkürzung)
      const gi = rng() < 0.5 ? (sx > 0 ? 0 : 1) : (sz > 0 ? 2 : 3);
      const gt = gates[gi];
      if (rng() < 0.55 && connTypes[gi] !== 'walls' && Math.abs(roofY - gt.y) <= 13) {
        const xAxis = gi < 2;
        const cxr = tx + (xAxis ? sx : -sx) * (half - 1.5), czr = tz + (xAxis ? -sz : sz) * (half - 1.5);
        const gxp = xAxis ? gt.a - sx * 2 : gt.l + sx * 4.6, gzp = xAxis ? gt.l + sz * 4.6 : gt.a - sz * 2;
        const mx = (cxr + gxp) / 2, mz = (czr + gzp) / 2;
        this.game.rails.addWorldRail([cxr, roofY + 1.1, czr, mx, (roofY + gt.y) / 2 + 3 + rng() * 2, mz, gxp, gt.y + 2.4, gzp], ch);
      }
      // Spiral-Rail um einen Turm nach oben (hohe, riskante Route)
      if (tall && !spiralDone && half <= 7.5 && roofY - hubY <= 34 && (isStart || rng() < 0.8)) {
        spiralDone = true;
        const Rr = half * 1.414 + 1.9;
        const th0 = Math.atan2(hz - tz, hx - tx);
        const turns = 1.25 + rng() * 0.4;
        const dirS = rng() < 0.5 ? 1 : -1;
        const pts = [];
        const dl = Math.hypot(tx - hx, tz - hz);
        pts.push(hx + sx * (hubHalf + 0.9), hubY + 1.1, hz + sz * (hubHalf + 0.9));   // an der Dachecke, abseits der Laufwege
        const steps = Math.ceil(turns * 8);
        for (let i = 0; i <= steps; i++) {
          const f = i / steps;
          const th = th0 + dirS * f * turns * Math.PI * 2;
          const rr = i === steps ? Rr * 0.82 : Rr;
          pts.push(tx + Math.cos(th) * rr, lerp(hubY + 2.6, roofY + 2.2, f), tz + Math.sin(th) * rr);
        }
        const thE = th0 + dirS * (turns + 0.09) * Math.PI * 2;
        pts.push(tx + Math.cos(thE) * half * 0.45, roofY + 1.2, tz + Math.sin(thE) * half * 0.45);
        this.game.rails.addWorldRail(pts, ch);
        pad(tx, roofY, tz, 1.8, (hx - tx) / dl, (hz - tz) / dl, false);
      }
      // Neon-Schild an der Hub-zugewandten Fassade
      if (roofY > hubY + 4 && ch.signs.length < 4 && rng() < 0.8) {
        const faceX = rng() < 0.5;
        const sh = 5 + rng() * 5, sw = sh * (rng() < 0.5 ? 0.45 : 1);
        const sy = Math.min(roofY - sh / 2 - 1, hubY + 6 + rng() * 10);
        const cellI = (rng() * 16) | 0;
        ch.signs.push({
          x: faceX ? tx - sx * (half + 0.15) : tx + (rng() - 0.5) * half, y: sy,
          z: faceX ? tz + (rng() - 0.5) * half : tz - sz * (half + 0.15),
          rot: faceX ? Math.PI / 2 : 0, w: sw, h: sh, cx: cellI & 3, cy: cellI >> 2,
          col: [COL.magenta, COL.cyan, COL.amber, COL.yellow][(rng() * 4) | 0], phase: rng(),
        });
      }
    }

    // --- Hub-Extras: Boost-Pad und Kicker-Rampe
    // Das Pad zeigt immer auf etwas, das +10 m/s sicher auffängt: den Anfang einer Rail (man rastet
    // automatisch ein) oder eine Brücke. Auf dem Start-Dach liegt es direkt vor dem Spieler.
    let hubPadDir = -1;
    {
      if (isStart) hubPadDir = 3;
      else {
        const cands = [];
        for (let d = 0; d < 4; d++) { const c = ch['conn' + d]; if (c.type === 'bridge' || c.railSide) cands.push(d); }
        if (cands.length) hubPadDir = cands[(rng() * cands.length) | 0];
      }
      if (hubPadDir >= 0) {
        const cn = ch['conn' + hubPadDir];
        const lat = cn.railSide ? cn.l + cn.railSide * 3.6 : cn.l;
        const along = (cn.xAxis ? hx : hz) + cn.sgn * hubHalf * 0.45;
        const px = cn.xAxis ? along : lat, pz = cn.xAxis ? lat : along;
        pad(px, hubY, pz, 1.8, cn.xAxis ? cn.sgn : 0, cn.xAxis ? 0 : cn.sgn, false);
        if (isStart) { ch.startX = px; ch.startZ = pz + 8; }
      }
      const kd = (rng() * 4) | 0;
      if (!isStart && rng() < 0.45 && kd !== hubPadDir) {
        const k = ch['conn' + kd];
        const hubL = k.xAxis ? hz : hx;
        const side = rng() < 0.5 ? -1 : 1;
        const lat = clamp(k.l + side * 5.2, hubL - hubHalf + 2, hubL + hubHalf - 2);
        const a1 = k.aStart, a0 = k.aStart - k.sgn * 5.5;
        const amin = Math.min(a0, a1), amax = Math.max(a0, a1);
        const kx0 = k.xAxis ? amin : lat - 2, kx1 = k.xAxis ? amax : lat + 2, kz0 = k.xAxis ? lat - 2 : amin, kz1 = k.xAxis ? lat + 2 : amax;
        // Die Rampe darf keinen der vier Laufwege über das Dach blockieren
        let free = true;
        for (let d = 0; d < 4 && free; d++) {
          const c = ch['conn' + d];
          const ca0 = Math.min(c.xAxis ? hx : hz, c.aStart) - 1, ca1 = Math.max(c.xAxis ? hx : hz, c.aStart) + 1;
          const cx0 = c.xAxis ? ca0 : c.l - 3.6, cx1 = c.xAxis ? ca1 : c.l + 3.6, cz0 = c.xAxis ? c.l - 3.6 : ca0, cz1 = c.xAxis ? c.l + 3.6 : ca1;
          if (kx0 < cx1 && kx1 > cx0 && kz0 < cz1 && kz1 > cz0) free = false;
        }
        if (free) {
          const yA = k.sgn > 0 ? hubY : hubY + 1.7, yB = k.sgn > 0 ? hubY + 1.7 : hubY;
          ramp(kx0, kz0, kx1, kz1, k.xAxis ? 0 : 1, yA, yB, 0.3, COL.yellow, hubY - 0.5);
        }
      }
    }

    // --- Express-Rails: lange Hochbahnen entlang ganzer Chunk-Reihen/-Spalten (schnellste, höchste Route)
    if (hashFloat(cz, this.seed, 5, 1) < 0.42) {
      const lat = oz + (hashFloat(cz, this.seed, 5, 2) - 0.5) * 7;
      const eL = Math.max(this.hubHeight(cx - 1, cz), hubY) + 13, eR = Math.max(this.hubHeight(cx + 1, cz), hubY) + 13;
      this.game.rails.addWorldRail([ox - HALF + 0.3, eL, lat, ox - 14, Math.max(eL, hubY + 14), lat + 1.5, ox + 14, Math.max(eR, hubY + 14), lat - 1.5, ox + HALF - 0.3, eR, lat], ch);
    }
    if (hashFloat(cx, this.seed, 6, 1) < 0.42) {
      const lat = ox + (hashFloat(cx, this.seed, 6, 2) - 0.5) * 7;
      const eL = Math.max(this.hubHeight(cx, cz - 1), hubY) + 17, eR = Math.max(this.hubHeight(cx, cz + 1), hubY) + 17;
      this.game.rails.addWorldRail([lat, eL, oz - HALF + 0.3, lat - 1.5, Math.max(eL, hubY + 18), oz - 14, lat + 1.5, Math.max(eR, hubY + 18), oz + 14, lat, eR, oz + HALF - 0.3], ch);
    }

    // unbenutzte Instanzen des Slots leeren
    M.fill(0, (base + ch.nInst) * 16, (base + BOX_PER) * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aColor.needsUpdate = true; this.aParams.needsUpdate = true;
    this.game.rails.buildChunkMesh(ch);
    this.signsDirty = true;
    return ch;
  }

  rebuildSigns() {
    this.signsDirty = false;
    const M = this.signMesh.instanceMatrix.array, A = this.aSign.array, C = this.aSignColor.array;
    let n = 0;
    for (const ch of this.chunks.values()) for (const s of ch.signs) {
      if (n >= SIGN_CAP) break;
      const o = n * 16, c = Math.cos(s.rot), si = Math.sin(s.rot);
      M[o] = c * s.w; M[o + 1] = 0; M[o + 2] = -si * s.w; M[o + 3] = 0;
      M[o + 4] = 0; M[o + 5] = s.h; M[o + 6] = 0; M[o + 7] = 0;
      M[o + 8] = si; M[o + 9] = 0; M[o + 10] = c; M[o + 11] = 0;
      M[o + 12] = s.x; M[o + 13] = s.y; M[o + 14] = s.z; M[o + 15] = 1;
      A[n * 4] = s.cx; A[n * 4 + 1] = s.cy; A[n * 4 + 2] = s.phase; A[n * 4 + 3] = 0;
      C[n * 3] = s.col[0]; C[n * 3 + 1] = s.col[1]; C[n * 3 + 2] = s.col[2];
      n++;
    }
    this.signMesh.count = n;
    this.signMesh.instanceMatrix.needsUpdate = true;
    this.aSign.needsUpdate = true; this.aSignColor.needsUpdate = true;
  }

  // Prüft die Critical-Path-Garantie eines Chunks (für Tests/Debug)
  validateChunk(ch) {
    for (const p of ch.paths) for (let i = 0; i < p.gaps.length; i++) {
      if (p.gaps[i] > W.jumpSafety * this.jumpDist(p.rises[i]) + 1e-6) return false;
      if (p.rises[i] > this.jumpApex * 0.65 + 1e-6) return false;
    }
    return ch.paths.length === 4;
  }

  // Zufälliger Dach-Sitzplatz (für Sniper) in der Nähe eines Punktes
  findPerch(x, z, minD, maxD, rng, out) {
    let best = null, bestScore = 1e9;
    for (const ch of this.chunks.values()) for (const p of ch.perches) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < minD || d > maxD) continue;
      const sc = rng() ;
      if (sc < bestScore) { bestScore = sc; best = p; }
    }
    if (!best) return false;
    out.x = best.x; out.y = best.y; out.z = best.z;
    return true;
  }
}
