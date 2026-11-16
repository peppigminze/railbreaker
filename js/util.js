// Kleine Mathe-/RNG-Helfer ohne Allokationen im Hot Path.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
// Framerate-unabhängiges exponentielles Glätten
export const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

// mulberry32: schneller, seed-basierter RNG – macht Runs reproduzierbar (Ghost-Replays).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashInts(a, b, c, d) {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ (a | 0), 0x01000193); h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ (b | 0), 0x5bd1e995); h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2d); h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ (d | 0), 0x165667b1); h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}
export const hashFloat = (a, b, c, d) => hashInts(a, b, c, d) / 4294967296;

export function seedFromString(str) {
  const s = String(str).trim().toUpperCase();
  if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0) || 1;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}
export function randomSeedString() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[(Math.random() * abc.length) | 0];
  return s;
}

// Glattes 2D-Value-Noise auf Integer-Gitter (für das Höhenfeld der Stadt)
export function valueNoise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hashFloat(xi, yi, seed, 11), b = hashFloat(xi + 1, yi, seed, 11);
  const c = hashFloat(xi, yi + 1, seed, 11), d = hashFloat(xi + 1, yi + 1, seed, 11);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// 1D-Noise (glatt) für das Trauma-Screenshake
export function noise1(x, seed) {
  const xi = Math.floor(x), xf = x - xi;
  const u = xf * xf * (3 - 2 * xf);
  return lerp(hashFloat(xi, seed, 7, 3), hashFloat(xi + 1, seed, 7, 3), u) * 2 - 1;
}

export function fmtInt(n) { return Math.round(n).toLocaleString('de-CH').replace(/[’']/g, ' '); }
export function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return (m > 0 ? m + ':' + (s < 10 ? '0' : '') : '') + s.toFixed(1);
}

// localStorage mit Fallback (kann in Sandboxes fehlen oder werfen)
const mem = {};
export const Store = {
  get(key, def) {
    try { const v = localStorage.getItem('railbreaker.' + key); return v == null ? (key in mem ? mem[key] : def) : JSON.parse(v); }
    catch (e) { return key in mem ? mem[key] : def; }
  },
  set(key, val) {
    mem[key] = val;
    try { localStorage.setItem('railbreaker.' + key, JSON.stringify(val)); } catch (e) { /* voll oder gesperrt */ }
  },
  del(key) { delete mem[key]; try { localStorage.removeItem('railbreaker.' + key); } catch (e) { /* egal */ } },
};
