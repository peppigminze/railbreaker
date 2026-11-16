// VFX: Partikel, Instanz-Batches, Tracer, Decals, Shards, Trails, Himmel/Wolkenmeer, Post-Processing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { CONFIG, QUALITY, STATE } from './config.js';
import { clamp, damp, smoothstep, hashFloat } from './util.js';

// ---------------------------------------------------------------- Instanz-Batch
// Dynamische Objekte (Gegnerteile, Projektile, Tracer, Shards ...) werden jeden Frame neu in einen
// InstancedMesh-Puffer geschrieben: ein Draw-Call pro Typ, keine Objekt-Allokationen.
const BATCH_VERT = /* glsl */`
attribute vec4 aColor; varying vec4 vColor; varying vec3 vWorld;
void main(){ vColor = aColor; vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BATCH_LIT_FRAG = /* glsl */`
precision highp float;
uniform vec3 uFogColor; uniform float uFogDensity;
varying vec4 vColor; varying vec3 vWorld;
void main(){
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 v = normalize(cameraPosition - vWorld);
  float diff = max(dot(n, normalize(vec3(0.35, 0.85, 0.3))), 0.0);
  float rim = pow(1.0 - abs(dot(n, v)), 2.0);
  vec3 col = vColor.rgb * (0.5 + 0.7 * diff) + vColor.rgb * rim * 0.9 + vec3(1.0) * vColor.a;
  float d = distance(vWorld, cameraPosition);
  float fog = exp(-d * d * uFogDensity * uFogDensity * 0.5);
  gl_FragColor = vec4(mix(uFogColor, col, fog), 1.0);
}`;
const BATCH_GLOW_FRAG = /* glsl */`
precision highp float;
varying vec4 vColor; varying vec3 vWorld;
void main(){ gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a); }`;

export function makeLitMaterial(world) {
  return new THREE.ShaderMaterial({ vertexShader: BATCH_VERT, fragmentShader: BATCH_LIT_FRAG, uniforms: { uFogColor: world.uniforms.uFogColor, uFogDensity: world.uniforms.uFogDensity } });
}
export function makeGlowMaterial() {
  return new THREE.ShaderMaterial({ vertexShader: BATCH_VERT, fragmentShader: BATCH_GLOW_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
}

export class InstBatch {
  constructor(geometry, material, capacity, scene) {
    this.cap = capacity; this.n = 0;
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aColor', this.color);
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.matrixAutoUpdate = false; this.mesh.count = 0;
    this.M = this.mesh.instanceMatrix.array; this.C = this.color.array;
    scene.add(this.mesh);
  }
  begin() { this.n = 0; }
  // Position + Quaternion + Skalierung
  push(x, y, z, qx, qy, qz, qw, sx, sy, sz, r, g, b, a) {
    if (this.n >= this.cap) return;
    const o = this.n * 16, M = this.M;
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
    M[o] = (1 - (yy + zz)) * sx; M[o + 1] = (xy + wz) * sx; M[o + 2] = (xz - wy) * sx; M[o + 3] = 0;
    M[o + 4] = (xy - wz) * sy; M[o + 5] = (1 - (xx + zz)) * sy; M[o + 6] = (yz + wx) * sy; M[o + 7] = 0;
    M[o + 8] = (xz + wy) * sz; M[o + 9] = (yz - wx) * sz; M[o + 10] = (1 - (xx + yy)) * sz; M[o + 11] = 0;
    M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
    const c = this.n * 4, C = this.C;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = a;
    this.n++;
  }
  // Lokale +Z-Achse zeigt entlang (dx,dy,dz) (normiert); optionaler Roll um diese Achse
  pushLook(x, y, z, dx, dy, dz, sx, sy, sz, r, g, b, a, roll) {
    if (this.n >= this.cap) return;
    let ax, ay, az;
    if (Math.abs(dy) > 0.985) { ax = 1; ay = 0; az = 0; } else { ax = dz; ay = 0; az = -dx; }   // up x dir
    const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    let bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const tx = ax * c + bx * s, ty = ay * c + by * s, tz = az * c + bz * s;
      bx = bx * c - ax * s; by = by * c - ay * s; bz = bz * c - az * s;
      ax = tx; ay = ty; az = tz;
    }
    const o = this.n * 16, M = this.M;
    M[o] = ax * sx; M[o + 1] = ay * sx; M[o + 2] = az * sx; M[o + 3] = 0;
    M[o + 4] = bx * sy; M[o + 5] = by * sy; M[o + 6] = bz * sy; M[o + 7] = 0;
    M[o + 8] = dx * sz; M[o + 9] = dy * sz; M[o + 10] = dz * sz; M[o + 11] = 0;
    M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
    const c4 = this.n * 4, C = this.C;
    C[c4] = r; C[c4 + 1] = g; C[c4 + 2] = b; C[c4 + 3] = a;
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    if (this.n > 0) { this.mesh.instanceMatrix.needsUpdate = true; this.color.needsUpdate = true; }
  }
}

// ---------------------------------------------------------------- Partikel
const PART_VERT = /* glsl */`
attribute vec4 aColor; attribute float aSize; uniform float uPx; varying vec4 vColor;
void main(){
  vColor = aColor;
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPx / max(0.1, -mv.z), 1.0, 96.0);
  gl_Position = projectionMatrix * mv;
}`;
const PART_FRAG = /* glsl */`
precision highp float; varying vec4 vColor;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(vColor.rgb * a * vColor.a, a * vColor.a);
}`;

class Particles {
  constructor(max, scene) {
    this.max = max; this.limit = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.size0 = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3); this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4); this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1); this.aSize.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos); geo.setAttribute('aColor', this.aCol); geo.setAttribute('aSize', this.aSize);
    geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({ vertexShader: PART_VERT, fragmentShader: PART_FRAG, uniforms: { uPx: { value: 500 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false; this.points.matrixAutoUpdate = false;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, size, r, g, b, grav, drag) {
    if (this.n >= this.limit) return;
    const i = this.n++, i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i4] = r; this.col[i4 + 1] = g; this.col[i4 + 2] = b; this.col[i4 + 3] = 1;
    this.life[i] = life; this.maxLife[i] = life; this.size0[i] = size; this.size[i] = size;
    this.grav[i] = grav || 0; this.drag[i] = drag || 0;
  }
  update(dt) {
    const pos = this.pos, vel = this.vel, col = this.col;
    let n = this.n;
    for (let i = 0; i < n; i++) {
      const l = this.life[i] - dt;
      if (l <= 0) {
        // Swap-Remove hält die Arrays dicht
        n--;
        if (i < n) {
          const i3 = i * 3, n3 = n * 3, i4 = i * 4, n4 = n * 4;
          pos[i3] = pos[n3]; pos[i3 + 1] = pos[n3 + 1]; pos[i3 + 2] = pos[n3 + 2];
          vel[i3] = vel[n3]; vel[i3 + 1] = vel[n3 + 1]; vel[i3 + 2] = vel[n3 + 2];
          col[i4] = col[n4]; col[i4 + 1] = col[n4 + 1]; col[i4 + 2] = col[n4 + 2];
          this.life[i] = this.life[n]; this.maxLife[i] = this.maxLife[n]; this.size0[i] = this.size0[n];
          this.grav[i] = this.grav[n]; this.drag[i] = this.drag[n];
          i--;
        }
        continue;
      }
      this.life[i] = l;
      const i3 = i * 3;
      const dr = 1 - this.drag[i] * dt;
      vel[i3] *= dr; vel[i3 + 1] = vel[i3 + 1] * dr - this.grav[i] * dt; vel[i3 + 2] *= dr;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const f = l / this.maxLife[i];
      col[i * 4 + 3] = f;
      this.size[i] = this.size0[i] * (0.4 + 0.6 * f);
    }
    this.n = n;
    this.points.geometry.setDrawRange(0, n);
    if (n > 0) {
      this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true;
      this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, n * 3);
      this.aCol.clearUpdateRanges(); this.aCol.addUpdateRange(0, n * 4);
      this.aSize.clearUpdateRanges(); this.aSize.addUpdateRange(0, n);
    }
  }
}

// ---------------------------------------------------------------- Licht-Trail (Spieler + Ghost)
const RIB_VERT = /* glsl */`attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`;
const RIB_FRAG = /* glsl */`precision highp float; uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA, vA); }`;
export class Ribbon {
  constructor(scene, color, n) {
    this.N = n || 44; this.count = 0; this.head = 0;
    this.pts = new Float32Array(this.N * 3); this.age = new Float32Array(this.N);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(this.N * 2 * 3), 3);
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(this.N * 2), 1);
    geo.setAttribute('position', this.posAttr); geo.setAttribute('aAlpha', this.alphaAttr);
    const idx = [];
    for (let i = 0; i < this.N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: RIB_VERT, fragmentShader: RIB_FRAG, uniforms: { uColor: { value: new THREE.Color(color) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.visible = false;
    scene.add(this.mesh);
    this.lx = 0; this.ly = 0; this.lz = 0;
  }
  clear() { this.count = 0; this.mesh.visible = false; }
  update(dt, active, x, y, z, life) {
    for (let i = 0; i < this.count; i++) this.age[i] += dt;
    if (active && (this.count === 0 || Math.hypot(x - this.lx, y - this.ly, z - this.lz) > 0.6)) {
      // vorne einfügen (Array schieben: N ist klein)
      const c = Math.min(this.count, this.N - 1);
      this.pts.copyWithin(3, 0, c * 3); this.age.copyWithin(1, 0, c);
      this.pts[0] = x; this.pts[1] = y; this.pts[2] = z; this.age[0] = 0;
      this.count = c + 1; this.lx = x; this.ly = y; this.lz = z;
    }
    while (this.count > 0 && this.age[this.count - 1] > life) this.count--;
    if (this.count < 2) { this.mesh.visible = false; return; }
    const P = this.posAttr.array, A = this.alphaAttr.array;
    for (let i = 0; i < this.count; i++) {
      const px = this.pts[i * 3], py = this.pts[i * 3 + 1], pz = this.pts[i * 3 + 2];
      const a = Math.max(0, 1 - this.age[i] / life);
      const w = 0.12 + 0.4 * a, o = i * 6;
      P[o] = px; P[o + 1] = py + w; P[o + 2] = pz; P[o + 3] = px; P[o + 4] = py - w; P[o + 5] = pz;
      A[i * 2] = a * 0.9; A[i * 2 + 1] = a * 0.9;
    }
    this.posAttr.needsUpdate = true; this.alphaAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (this.count - 1) * 6);
    this.mesh.visible = true;
  }
}

// ---------------------------------------------------------------- Umgebung
const SKY_FRAG = /* glsl */`
precision highp float;
uniform float uTime; uniform vec3 uFogColor; uniform float uDesat; uniform float uBeat;
varying vec3 vDir;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 zen = vec3(0.02, 0.008, 0.06);
  vec3 col = mix(uFogColor, zen, smoothstep(0.0, 0.55, h));
  col += vec3(0.55, 0.08, 0.5) * pow(1.0 - clamp(abs(h), 0.0, 1.0), 9.0) * 0.5;
  // Synthwave-Sonne mit Streifen
  vec3 sd = normalize(vec3(0.0, 0.16, -1.0));
  float sa = acos(clamp(dot(d, sd), -1.0, 1.0));
  float disc = smoothstep(0.19, 0.185, sa);
  float band = step(0.35, fract((d.y - 0.02) * 34.0 - uTime * 0.05)) + smoothstep(0.1, 0.2, d.y);
  vec3 sun = mix(vec3(1.0, 0.15, 0.55), vec3(1.0, 0.75, 0.2), smoothstep(0.02, 0.3, d.y));
  col += sun * disc * clamp(band, 0.0, 1.0) * 0.5;
  col += vec3(0.8, 0.15, 0.6) * exp(-sa * 5.0) * (0.22 + 0.06 * uBeat);
  // Sterne
  // Sterne: kleine Punkte in einem Winkelraster
  vec2 sp = vec2(atan(d.z, d.x) * 60.0, d.y * 90.0);
  vec2 sc = floor(sp); float sh = hash(sc);
  vec2 so = fract(sp) - 0.5 - (vec2(hash(sc + 1.7), hash(sc + 9.2)) - 0.5) * 0.6;
  float st = step(0.9, sh) * smoothstep(0.12, 0.0, length(so)) * smoothstep(0.08, 0.35, h);
  col += vec3(0.75, 0.85, 1.0) * st * (0.45 + 0.4 * sin(uTime * 2.0 + sh * 40.0));
  col = mix(col, uFogColor, smoothstep(0.02, -0.12, h));
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), uDesat * 0.85);
  gl_FragColor = vec4(col, 1.0);
}`;
const CLOUD_FRAG = /* glsl */`
precision highp float;
uniform float uTime; uniform vec3 uFogColor; uniform float uFogDensity; uniform float uDesat;
varying vec3 vWorld;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
void main(){
  vec2 p = vWorld.xz;
  float n = fbm(p * 0.012 + vec2(uTime * 0.02, uTime * 0.012));
  float n2 = fbm(p * 0.03 - vec2(uTime * 0.03, 0.0));
  vec3 col = mix(vec3(0.05, 0.015, 0.11), vec3(0.3, 0.1, 0.42), smoothstep(0.3, 0.8, n * 0.7 + n2 * 0.4));
  // pulsierende Lichter tief unter den Wolken
  vec2 cell = floor(p / 70.0); vec2 f = fract(p / 70.0) - 0.5;
  float hh = hash(cell);
  vec2 off = (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6;
  float glow = exp(-dot(f - off, f - off) * 22.0) * step(0.45, hh);
  float pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (0.8 + hh * 2.0) + hh * 40.0), 3.0);
  vec3 lc = mix(vec3(1.0, 0.2, 0.7), vec3(0.2, 0.8, 1.0), step(0.72, hh));
  col += lc * glow * pulse * (0.5 + 0.6 * (1.0 - n));
  float d = distance(vWorld, cameraPosition);
  float fog = 1.0 - exp(-d * d * uFogDensity * uFogDensity * 0.22);
  col = mix(col, uFogColor, fog);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), uDesat);
  gl_FragColor = vec4(col, 1.0);
}`;
const SKYLINE_VERT = /* glsl */`
attribute vec4 aColor; varying vec3 vWorld; varying vec3 vLocal; varying float vSeed; varying float vFade;
void main(){ vLocal = position; vSeed = aColor.x; vFade = aColor.y;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const SKYLINE_FRAG = /* glsl */`
precision highp float;
uniform vec3 uFogColor; uniform float uTime; uniform float uDesat;
varying vec3 vWorld; varying vec3 vLocal; varying float vSeed; varying float vFade;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float u = abs(vLocal.x) > 0.499 ? vWorld.z : vWorld.x;
  vec2 c = vec2(u / 5.0, vWorld.y / 6.5); vec2 cell = floor(c); vec2 f = fract(c);
  float mask = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.7);
  float lit = step(0.8, hash(cell + vSeed * 31.0)) * mask;
  vec3 lc = mix(vec3(1.0, 0.25, 0.8), vec3(0.2, 0.85, 1.0), step(0.5, hash(cell * 1.7 + vSeed)));
  // Silhouette: dunkler als der Horizont, oben mit Neon-Kante
  vec3 col = uFogColor * 0.42 + lc * lit * 0.4;
  col += lc * 0.5 * smoothstep(0.492, 0.5, vLocal.y);
  col = mix(uFogColor, col, vFade * smoothstep(-10.0, 40.0, vWorld.y));
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), uDesat);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- Post-Shader
const FS_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
function speedShader(taps) {
  return {
    uniforms: { tDiffuse: { value: null }, uBlur: { value: 0 }, uCA: { value: 0 }, uLines: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 } },
    vertexShader: FS_VERT,
    fragmentShader: /* glsl */`
precision highp float;
#define TAPS ${taps}
uniform sampler2D tDiffuse; uniform float uBlur; uniform float uCA; uniform float uLines; uniform float uTime; uniform float uAspect;
varying vec2 vUv;
float hash(float n){ return fract(sin(n * 12.9898) * 43758.5453); }
void main(){
  vec2 c = vUv - 0.5; float r = length(c);
  vec3 col;
  // Radialer Blur vom Zentrum (Mitte bleibt scharf, damit man zielen kann)
  float blur = uBlur * smoothstep(0.1, 0.62, r);
  if (blur > 0.002) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < TAPS; i++) { float t = float(i) / float(TAPS - 1); acc += texture2D(tDiffuse, vUv - c * blur * t * 0.1).rgb; }
    col = acc / float(TAPS);
  } else col = texture2D(tDiffuse, vUv).rgb;
  // Chromatic Aberration an den Rändern
  float ca = uCA * r * r * 0.045;
  if (ca > 0.0004) {
    col.r = mix(col.r, texture2D(tDiffuse, vUv + c * ca).r, 0.85);
    col.b = mix(col.b, texture2D(tDiffuse, vUv - c * ca).b, 0.85);
  }
  // Speed-Lines: radiale Streifen am Bildrand
  if (uLines > 0.01) {
    float ang = atan(c.y, c.x * uAspect);
    float seg = floor(ang * 28.0);
    float n = hash(seg + floor(uTime * 18.0) * 7.0);
    float streak = step(0.9, n) * smoothstep(0.3 + hash(seg) * 0.12, 0.72, r) * (0.5 + 0.5 * sin(fract(ang * 28.0) * 3.14159));
    col += vec3(0.65, 0.9, 1.0) * streak * uLines * 0.3;
  }
  gl_FragColor = vec4(col, 1.0);
}` };
}
const FINAL_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uOverdrive: { value: 0 },
    uDamage: { value: 0 }, uSlowmo: { value: 0 }, uDeath: { value: 0 }, uGlitch: { value: 0 }, uWarn: { value: 0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
precision highp float;
uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; uniform float uOverdrive; uniform float uDamage;
uniform float uSlowmo; uniform float uDeath; uniform float uGlitch; uniform float uWarn;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec2 uv = vUv;
  if (uGlitch > 0.01) {
    float row = floor(uv.y * 28.0); float tt = floor(uTime * 30.0);
    float s = step(0.86, hash(vec2(row, tt)));
    uv.x += (hash(vec2(tt, row)) - 0.5) * 0.07 * uGlitch * s;
  }
  vec3 col = texture2D(tDiffuse, uv).rgb;
  if (uDamage > 0.01) {
    float o = 0.007 * uDamage;
    col.r = texture2D(tDiffuse, uv + vec2(o, 0.0)).r; col.b = texture2D(tDiffuse, uv - vec2(o, 0.0)).b;
  }
  // Overdrive: Kantenglühen (die Entsättigung der Welt passiert in den Welt-Shadern, Gegner/Rails/Trail bleiben farbig)
  if (uOverdrive > 0.01) {
    vec2 px = 1.5 / uRes; float l0 = luma(col);
    float lx = luma(texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb), ly = luma(texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb);
    float e = clamp((abs(lx - l0) + abs(ly - l0)) * 3.5, 0.0, 1.0);
    col += vec3(0.5, 0.85, 1.0) * e * 0.35 * uOverdrive;
  }
  float r = length(vUv - 0.5);
  col *= mix(1.0, smoothstep(0.92, 0.28, r), 0.55);
  col = mix(col, col * vec3(0.7, 0.9, 1.25), uSlowmo * smoothstep(0.15, 0.7, r));
  col *= 1.0 - uSlowmo * 0.55 * smoothstep(0.3, 0.78, r);
  col += vec3(0.95, 0.04, 0.12) * uDamage * smoothstep(0.22, 0.75, r) * 0.75;
  col += vec3(0.9, 0.5, 0.05) * uWarn * smoothstep(0.3, 0.75, r) * (0.4 + 0.3 * sin(uTime * 14.0));
  float l = luma(col);
  col = mix(col, vec3(l) * vec3(1.0, 0.92, 0.96), uDeath);
  col += (hash(vUv * uRes + fract(uTime) * 91.0) - 0.5) * 0.02 * (0.25 + l);
  col *= 0.97 + 0.03 * sin(gl_FragCoord.y * 2.4);
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`,
};

const _q = new THREE.Quaternion();
const SHARD_MAX = 360, DECAL_MAX = 64, TRACER_MAX = 48;

export class VFX {
  constructor(game) {
    this.game = game;
    this.damage = 0; this.glitch = 0; this.slowmo = 0; this.death = 0; this.warn = 0;
    this.time = 0; this.quality = QUALITY.med;
    this.shards = { n: 0, p: new Float32Array(SHARD_MAX * 3), v: new Float32Array(SHARD_MAX * 3), life: new Float32Array(SHARD_MAX), col: new Float32Array(SHARD_MAX * 3), rot: new Float32Array(SHARD_MAX * 2), size: new Float32Array(SHARD_MAX) };
    this.decals = { head: 0, p: new Float32Array(DECAL_MAX * 6), age: new Float32Array(DECAL_MAX).fill(99) };
    this.tracers = { head: 0, d: new Float32Array(TRACER_MAX * 10), age: new Float32Array(TRACER_MAX).fill(99) };
    this.skyCell = { x: 1e9, z: 1e9 };
    this.dynScale = 1; this.dynT = 0; this.dynLow = 0; this.dynHigh = 0;
  }

  init(renderer, scene, camera, vmScene, vmCamera) {
    const g = this.game, U = g.world.uniforms;
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.particles = new Particles(6000, scene);
    this.glowMat = makeGlowMaterial();
    this.litMat = makeLitMaterial(g.world);

    // Himmel
    const skyGeo = new THREE.SphereGeometry(900, 24, 12);
    this.sky = new THREE.Mesh(skyGeo, new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }',
      fragmentShader: SKY_FRAG, uniforms: { uTime: U.uTime, uFogColor: U.uFogColor, uDesat: U.uDesat, uBeat: U.uBeat }, side: THREE.BackSide, depthWrite: false,
    }));
    this.sky.frustumCulled = false; this.sky.renderOrder = -10;
    scene.add(this.sky);
    // Wolkenmeer
    const cg = new THREE.PlaneGeometry(2600, 2600); cg.rotateX(-Math.PI / 2);
    this.clouds = new THREE.Mesh(cg, new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vWorld; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }',
      fragmentShader: CLOUD_FRAG, uniforms: { uTime: U.uTime, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity, uDesat: U.uDesat },
    }));
    this.clouds.frustumCulled = false; this.clouds.position.y = CONFIG.world.cloudY;
    scene.add(this.clouds);
    // ferne Skyline
    this.skyline = new InstBatch(new THREE.BoxGeometry(1, 1, 1), new THREE.ShaderMaterial({
      vertexShader: SKYLINE_VERT, fragmentShader: SKYLINE_FRAG, uniforms: { uFogColor: U.uFogColor, uTime: U.uTime, uDesat: U.uDesat },
    }), 260, scene);

    // Batches
    const tg = new THREE.BoxGeometry(1, 1, 1); tg.translate(0, 0, 0.5);
    this.tracerBatch = new InstBatch(tg, this.glowMat, TRACER_MAX, scene);
    this.decalBatch = new InstBatch(new THREE.RingGeometry(0.1, 0.34, 10), this.glowMat, DECAL_MAX, scene);
    this.shardBatch = new InstBatch(new THREE.TetrahedronGeometry(0.3), this.litMat, SHARD_MAX, scene);
    // Lande-Marker (zeigt in der Luft, wo man aufkommt)
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.6, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x19e6ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.marker.visible = false; scene.add(this.marker);
    this.trail = new Ribbon(scene, 0xff2bd6);
    this.probe = { y: 0, ground: null, gnx: 0, gny: 1, gnz: 0 };

    // Post-Processing-Kette
    this.composer = new EffectComposer(renderer);
    this.renderPass = new RenderPass(scene, camera);
    this.vmPass = new RenderPass(vmScene, vmCamera); this.vmPass.clear = false; this.vmPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.62);
    this.finalPass = new ShaderPass(FINAL_SHADER);
    this.outputPass = new OutputPass();
    this.fxaa = new ShaderPass(FXAAShader);
    this.buildChain();
  }

  buildChain() {
    const c = this.composer;
    c.passes.length = 0;
    if (this.speedPass) this.speedPass.dispose();
    this.speedPass = new ShaderPass(speedShader(this.quality.blurTaps));
    c.addPass(this.renderPass); c.addPass(this.vmPass);
    if (this.quality.bloom) c.addPass(this.bloom);
    c.addPass(this.speedPass); c.addPass(this.finalPass); c.addPass(this.outputPass);
    if (this.quality.fxaa) c.addPass(this.fxaa);
    if (this.w) this.resize(this.w, this.h);
  }

  setQuality(name) {
    this.quality = QUALITY[name] || QUALITY.med;
    this.particles.limit = this.quality.particles;
    this.skyCell.x = 1e9; this.dynScale = 1;
    this.buildChain();
  }

  resize(w, h) {
    this.w = w; this.h = h;
    // Qualitätsstufe deckelt die Render-Auflösung (Retina-Displays würden sonst 4x so viele Pixel füllen);
    // dynScale senkt sie zusätzlich, wenn die Framerate einbricht.
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio) * this.dynScale;
    this.pr = Math.max(0.4, pr);
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pr);
    this.composer.setSize(w, h);
    this.finalPass.uniforms.uRes.value.set(w * this.pr, h * this.pr);
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * this.pr), 1 / (h * this.pr));
    this.speedPass.uniforms.uAspect.value = w / h;
  }

  // Dynamische Auflösung: hält 60 FPS auf schwachen GPUs, ohne dass man in die Settings muss
  adaptResolution(dt, fps) {
    this.dynT += dt;
    if (fps < 50) this.dynLow += dt; else this.dynLow = 0;
    if (fps > 58.5) this.dynHigh += dt; else this.dynHigh = 0;
    if (this.dynT < 1.5) return;
    if (this.dynLow > 1.5 && this.dynScale > 0.55) { this.dynScale = Math.max(0.55, this.dynScale - 0.1); this.dynT = 0; this.dynLow = 0; this.resize(this.w, this.h); }
    else if (this.dynHigh > 6 && this.dynScale < 1) { this.dynScale = Math.min(1, this.dynScale + 0.05); this.dynT = 0; this.dynHigh = 0; this.resize(this.w, this.h); }
  }

  clearAll() {
    this.particles.n = 0; this.shards.n = 0; this.decals.age.fill(99); this.tracers.age.fill(99);
    this.damage = 0; this.glitch = 0; this.slowmo = 0; this.death = 0; this.warn = 0;
    this.trail.clear();
  }

  // ---------------------------------------------------------------- Emitter
  burst(x, y, z, count, speed, r, g, b, size, life, grav, drag) {
    const p = this.particles;
    count = Math.ceil(count * (this.quality.particles / 4000));
    for (let i = 0; i < count; i++) {
      // gleichverteilte Richtung auf der Kugel
      const u = Math.random() * 2 - 1, th = Math.random() * 6.2832, s = Math.sqrt(1 - u * u), v = speed * (0.35 + Math.random() * 0.65);
      p.spawn(x, y, z, s * Math.cos(th) * v, u * v, s * Math.sin(th) * v, life * (0.5 + Math.random() * 0.5), size, r, g, b, grav, drag);
    }
  }
  ring(x, y, z, r, g, b, count) {
    const p = this.particles;
    for (let i = 0; i < count; i++) {
      const a = i / count * 6.2832, v = 4 + Math.random() * 3;
      p.spawn(x, y, z, Math.cos(a) * v, 0.6 + Math.random(), Math.sin(a) * v, 0.35 + Math.random() * 0.2, 0.22, r, g, b, 2, 3);
    }
  }
  grindSparks(pos, tx, ty, tz, sp) {
    const p = this.particles;
    for (let i = 0; i < 2; i++) {
      p.spawn(pos.x, pos.y + 0.05, pos.z, -tx * sp * 0.3 + (Math.random() - 0.5) * 5, 2 + Math.random() * 4, -tz * sp * 0.3 + (Math.random() - 0.5) * 5, 0.35 + Math.random() * 0.3, 0.14, 1.0, 0.8, 0.35, 16, 0.5);
    }
  }
  slideSparks(pos, v) {
    this.particles.spawn(pos.x + (Math.random() - 0.5) * 0.5, pos.y + 0.05, pos.z + (Math.random() - 0.5) * 0.5, -v.x * 0.15 + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, -v.z * 0.15 + (Math.random() - 0.5) * 3, 0.3, 0.12, 1.0, 0.7, 0.3, 14, 0.5);
  }
  wallSparks(pos, nx, nz, tx, tz) {
    this.particles.spawn(pos.x - nx * 0.45, pos.y + 0.2 + Math.random() * 0.5, pos.z - nz * 0.45, nx * 2 - tx * 4 + (Math.random() - 0.5) * 2, 1 + Math.random() * 2, nz * 2 - tz * 4 + (Math.random() - 0.5) * 2, 0.3, 0.13, 0.7, 0.5, 1.0, 12, 0.5);
  }
  dashBurst(pos, d) {
    const p = this.particles;
    for (let i = 0; i < 26; i++) {
      p.spawn(pos.x + (Math.random() - 0.5), pos.y + 0.4 + Math.random() * 1.2, pos.z + (Math.random() - 0.5), -d.x * (6 + Math.random() * 10), -d.y * 8 + (Math.random() - 0.5) * 2, -d.z * (6 + Math.random() * 10), 0.3 + Math.random() * 0.2, 0.2, 0.2, 0.9, 1.0, 0, 2);
    }
  }
  dashTrail(pos, d) {
    this.particles.spawn(pos.x + (Math.random() - 0.5) * 0.7, pos.y + 0.3 + Math.random() * 1.3, pos.z + (Math.random() - 0.5) * 0.7, -d.x * 3, 0, -d.z * 3, 0.3, 0.26, 0.15, 0.85, 1.0, 0, 1);
  }
  railTip(x, y, z, dx, dy, dz) {
    const p = this.particles;
    for (let i = 0; i < 2; i++) p.spawn(x, y, z, dx * 4 + (Math.random() - 0.5) * 7, dy * 4 + (Math.random() - 0.5) * 7, dz * 4 + (Math.random() - 0.5) * 7, 0.25 + Math.random() * 0.2, 0.2, 1.0, 0.25, 0.85, 3, 1);
  }
  railShatter(rail) {
    const p = this.particles, c = rail.type === 1;
    for (let i = 0; i < rail.n; i += 2) {
      p.spawn(rail.px[i], rail.py[i], rail.pz[i], (Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5, 0.5 + Math.random() * 0.4, 0.2, c ? 1.0 : 0.1, c ? 0.2 : 0.9, c ? 0.85 : 1.0, 9, 0.6);
    }
  }
  impact(x, y, z, nx, ny, nz, r, g, b, n) {
    const p = this.particles;
    for (let i = 0; i < (n || 5); i++) {
      const s = 3 + Math.random() * 6;
      p.spawn(x, y, z, nx * s + (Math.random() - 0.5) * 6, ny * s + (Math.random() - 0.5) * 6 + 1, nz * s + (Math.random() - 0.5) * 6, 0.2 + Math.random() * 0.25, 0.12, r, g, b, 14, 0.8);
    }
  }
  explosion(x, y, z, r, g, b, scale) {
    this.burst(x, y, z, 26 * scale, 13 * Math.sqrt(scale), r, g, b, 0.3 * Math.sqrt(scale), 0.6, 6, 1.8);
    this.burst(x, y, z, 10 * scale, 5, 1, 0.95, 0.8, 0.5 * Math.sqrt(scale), 0.25, 0, 3);
  }
  spawnShards(x, y, z, count, r, g, b, vx, vy, vz, size) {
    const s = this.shards;
    for (let i = 0; i < count && s.n < SHARD_MAX; i++) {
      const k = s.n++, u = Math.random() * 2 - 1, th = Math.random() * 6.2832, q = Math.sqrt(1 - u * u), v = 4 + Math.random() * 9;
      s.p[k * 3] = x; s.p[k * 3 + 1] = y; s.p[k * 3 + 2] = z;
      s.v[k * 3] = q * Math.cos(th) * v + vx * 0.4; s.v[k * 3 + 1] = u * v + 3 + vy * 0.4; s.v[k * 3 + 2] = q * Math.sin(th) * v + vz * 0.4;
      s.life[k] = 0.7 + Math.random() * 0.6; s.col[k * 3] = r; s.col[k * 3 + 1] = g; s.col[k * 3 + 2] = b;
      s.rot[k * 2] = Math.random() * 6.28; s.rot[k * 2 + 1] = (Math.random() - 0.5) * 20; s.size[k] = (size || 1) * (0.6 + Math.random() * 0.9);
    }
  }
  tracer(x0, y0, z0, x1, y1, z1, r, g, b, w) {
    const t = this.tracers, i = t.head; t.head = (t.head + 1) % TRACER_MAX;
    const o = i * 10;
    t.d[o] = x0; t.d[o + 1] = y0; t.d[o + 2] = z0; t.d[o + 3] = x1; t.d[o + 4] = y1; t.d[o + 5] = z1;
    t.d[o + 6] = r; t.d[o + 7] = g; t.d[o + 8] = b; t.d[o + 9] = w || 0.035;
    t.age[i] = 0;
  }
  decal(x, y, z, nx, ny, nz) {
    const d = this.decals, i = d.head; d.head = (d.head + 1) % DECAL_MAX;
    const o = i * 6;
    d.p[o] = x + nx * 0.03; d.p[o + 1] = y + ny * 0.03; d.p[o + 2] = z + nz * 0.03; d.p[o + 3] = nx; d.p[o + 4] = ny; d.p[o + 5] = nz;
    d.age[i] = 0;
  }

  // ---------------------------------------------------------------- Update / Render
  update(dt, simDt) {
    const g = this.game, pl = g.player, cam = this.camera;
    this.time += dt;
    this.particles.update(simDt);
    this.particles.mat.uniforms.uPx.value = (this.h * this.pr) * 0.5 / Math.tan(cam.fov * Math.PI / 360);

    // Shards (simple Ballistik)
    const s = this.shards, sb = this.shardBatch;
    sb.begin();
    for (let i = 0; i < s.n; i++) {
      s.life[i] -= simDt;
      if (s.life[i] <= 0) {
        const k = --s.n;
        if (i < k) {
          s.p.copyWithin(i * 3, k * 3, k * 3 + 3); s.v.copyWithin(i * 3, k * 3, k * 3 + 3); s.col.copyWithin(i * 3, k * 3, k * 3 + 3);
          s.rot.copyWithin(i * 2, k * 2, k * 2 + 2); s.life[i] = s.life[k]; s.size[i] = s.size[k]; i--;
        }
        continue;
      }
      s.v[i * 3 + 1] -= 22 * simDt;
      s.p[i * 3] += s.v[i * 3] * simDt; s.p[i * 3 + 1] += s.v[i * 3 + 1] * simDt; s.p[i * 3 + 2] += s.v[i * 3 + 2] * simDt;
      s.rot[i * 2] += s.rot[i * 2 + 1] * simDt;
      const a = s.rot[i * 2], sc = s.size[i] * Math.min(1, s.life[i] * 3);
      _q.set(Math.sin(a) * 0.6, Math.sin(a * 0.7) * 0.5, Math.cos(a) * 0.4, Math.cos(a * 0.5)).normalize();
      sb.push(s.p[i * 3], s.p[i * 3 + 1], s.p[i * 3 + 2], _q.x, _q.y, _q.z, _q.w, sc, sc, sc, s.col[i * 3], s.col[i * 3 + 1], s.col[i * 3 + 2], 0.15);
    }
    sb.end();

    // Tracer
    const t = this.tracers, tb = this.tracerBatch;
    tb.begin();
    for (let i = 0; i < TRACER_MAX; i++) {
      if (t.age[i] > 0.12) continue;
      const o = i * 10, f = 1 - t.age[i] / 0.12;
      t.age[i] += dt;
      let dx = t.d[o + 3] - t.d[o], dy = t.d[o + 4] - t.d[o + 1], dz = t.d[o + 5] - t.d[o + 2];
      const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
      const w = t.d[o + 9] * (0.5 + f);
      tb.pushLook(t.d[o], t.d[o + 1], t.d[o + 2], dx, dy, dz, w, w, len, t.d[o + 6], t.d[o + 7], t.d[o + 8], f);
    }
    tb.end();

    // Decals
    const d = this.decals, db = this.decalBatch;
    db.begin();
    for (let i = 0; i < DECAL_MAX; i++) {
      if (d.age[i] > 6) continue;
      d.age[i] += simDt;
      const o = i * 6, f = clamp(1 - d.age[i] / 6, 0, 1), hot = Math.max(0, 1 - d.age[i] * 2);
      db.pushLook(d.p[o], d.p[o + 1], d.p[o + 2], d.p[o + 3], d.p[o + 4], d.p[o + 5], 1 + hot, 1 + hot, 1, 0.2 + hot, 0.75, 1.0, f * 0.7);
    }
    db.end();

    // Himmel/Wolken folgen der Kamera
    this.sky.position.copy(cam.position);
    this.clouds.position.x = Math.round(cam.position.x / 50) * 50; this.clouds.position.z = Math.round(cam.position.z / 50) * 50;
    this.updateSkyline(cam.position.x, cam.position.z);

    // Lande-Marker + Speed-Trail
    const playing = g.isPlaying() && !pl.dead;
    let showMarker = false;
    if (playing && this.quality.shadow > 0 && (pl.state === STATE.AIRBORNE || pl.state === STATE.DASHING)) {
      if (g.world.probeGround(pl.renderPos.x, pl.renderPos.y, pl.renderPos.z, 0.2, 40, this.probe) && pl.renderPos.y - this.probe.y > 1.2) {
        this.marker.position.set(pl.renderPos.x, this.probe.y + 0.06, pl.renderPos.z);
        const sc = 1 + (pl.renderPos.y - this.probe.y) * 0.05; this.marker.scale.set(sc, 1, sc);
        showMarker = true;
      }
    }
    this.marker.visible = showMarker;
    this.trail.update(simDt, playing && pl.speed > 30, pl.renderPos.x, pl.renderPos.y + 0.7, pl.renderPos.z, 0.9);

    // Post-Uniforms
    const speed = playing ? pl.speed : 0;
    const blurOn = g.settings.motionBlur ? 1 : 0;
    const sp = this.speedPass.uniforms;
    const k = smoothstep(20, 45, speed);
    sp.uBlur.value = damp(sp.uBlur.value, k * 0.85 * blurOn, 8, dt);
    sp.uCA.value = damp(sp.uCA.value, k * 0.8 + this.damage * 1.2 + (g.score.overdrive ? 0.3 : 0), 10, dt);
    sp.uLines.value = damp(sp.uLines.value, smoothstep(24, 46, speed), 6, dt);
    sp.uTime.value = this.time;
    const fu = this.finalPass.uniforms;
    this.damage = Math.max(0, this.damage - dt * 2.2);
    this.glitch = Math.max(0, this.glitch - dt * 3);
    fu.uTime.value = this.time; fu.uDamage.value = this.damage; fu.uGlitch.value = this.glitch;
    fu.uSlowmo.value = damp(fu.uSlowmo.value, this.slowmo, 14, dt);
    fu.uDeath.value = damp(fu.uDeath.value, this.death, 3, dt);
    fu.uWarn.value = damp(fu.uWarn.value, this.warn, 8, dt);
    const od = g.score.overdrive ? 1 : 0;
    fu.uOverdrive.value = damp(fu.uOverdrive.value, od, 6, dt);
    g.world.uniforms.uDesat.value = Math.max(fu.uOverdrive.value * 0.92, fu.uDeath.value * 0.6);
    this.bloom.strength = damp(this.bloom.strength, 0.42 + g.score.flow * 0.07 + od * 0.15, 4, dt);
  }

  updateSkyline(cx, cz) {
    const CS = 95, ix = Math.round(cx / CS), iz = Math.round(cz / CS);
    if (ix === this.skyCell.x && iz === this.skyCell.z) return;
    this.skyCell.x = ix; this.skyCell.z = iz;
    const b = this.skyline, seed = this.game.world.seed;
    b.begin();
    const maxN = this.quality.skyline;
    for (let dz = -7; dz <= 7 && b.n < maxN; dz++) for (let dx = -7; dx <= 7 && b.n < maxN; dx++) {
      const dist = Math.hypot(dx, dz);
      if (dist < 2.9 || dist > 7.2) continue;
      const gx = ix + dx, gz = iz + dz;
      if (hashFloat(gx, gz, seed, 41) > 0.42) continue;
      const hgt = 55 + hashFloat(gx, gz, seed, 42) * 85, w = 24 + hashFloat(gx, gz, seed, 43) * 30;
      const fade = smoothstep(2.9, 3.8, dist) * smoothstep(7.2, 5.6, dist);
      b.push(gx * CS + (hashFloat(gx, gz, seed, 44) - 0.5) * 40, hgt / 2 - 30, gz * CS + (hashFloat(gx, gz, seed, 45) - 0.5) * 40, 0, 0, 0, 1, w, hgt, w, hashFloat(gx, gz, seed, 46), fade, 0, 0);
    }
    b.end();
  }

  render() { this.composer.render(); }
}
