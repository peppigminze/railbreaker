// AudioEngine: komplett prozedural (WebAudio). Synthwave-Track mit Lookahead-Scheduler, Beat-Clock, SFX, Loops.
import { CONFIG, STATE } from './config.js';
import { clamp, lerp, smoothstep } from './util.js';

const BPM = CONFIG.audio.bpm;
const BEAT = 60 / BPM, STEP = BEAT / 4;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Akkordfolge Am – F – C – G (i–VI–III–VII), je ein Takt
const CHORDS = [
  { bass: 45, notes: [57, 60, 64] },
  { bass: 41, notes: [53, 57, 60] },
  { bass: 48, notes: [55, 60, 64] },
  { bass: 43, notes: [55, 59, 62] },
];
const BASS_PAT = [0, 0, 12, 0, 0, 12, 7, 12];
const ARP_PAT = [0, 1, 2, 1, 3, 2, 1, 2, 0, 1, 2, 4, 3, 2, 1, 2];
const LEAD = [
  [76, 0, 0, 74, 76, 0, 79, 0], [77, 0, 76, 0, 72, 0, 69, 0],
  [79, 0, 0, 76, 72, 0, 76, 0], [74, 0, 71, 0, 74, 0, 79, 81],
];

export class AudioEngine {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.playing = false;
    this.step = 0; this.nextStepTime = 0; this.t0 = 0;
    this.qTimes = new Float64Array(64); this.qSteps = new Int32Array(64); this.qHead = 0; this.qTail = 0;
    this.lastBeatTime = -10; this.beatCount = 0; this.pulse = 0;
    this.intensity = 0; this.targetIntensity = 0;
    this.onBeat = null;
    this.pitch = 1; this.slow = 0; this.paused = false;
    this.padOscs = [];
    this.railgunLevel = 0; this.railgunOn = false;
    this.lastPlay = {};
  }
  init() {}

  now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }

  // Muss aus einer Nutzergeste aufgerufen werden
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const c = this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = c.createGain();
      // Master-Bus mit Kompressor, damit nichts clippt
      this.comp = c.createDynamicsCompressor();
      this.comp.threshold.value = -14; this.comp.knee.value = 12; this.comp.ratio.value = 6; this.comp.attack.value = 0.004; this.comp.release.value = 0.18;
      this.master.connect(this.comp); this.comp.connect(c.destination);
      this.musicBus = c.createGain(); this.musicFilter = c.createBiquadFilter();
      this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = 18000; this.musicFilter.Q.value = 0.5;
      this.musicBus.connect(this.musicFilter); this.musicFilter.connect(this.master);
      this.duck = c.createGain(); this.duck.connect(this.musicBus);          // Sidechain-Ziel (Pad, Bass, Arp)
      this.arpDelay = c.createDelay(1); this.arpDelay.delayTime.value = STEP * 3;
      this.arpFb = c.createGain(); this.arpFb.gain.value = 0.33;
      this.arpBus = c.createGain(); this.arpBus.connect(this.duck); this.arpBus.connect(this.arpDelay);
      this.arpDelay.connect(this.arpFb); this.arpFb.connect(this.arpDelay); this.arpDelay.connect(this.duck);
      this.sfxBus = c.createGain(); this.sfxBus.connect(this.master);
      const len = c.sampleRate * 2;
      this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.makeLoops();
      this.applyVolumes();
      if (c.state === 'suspended') c.resume().catch(() => {});
      if (this.playing) { this.nextStepTime = c.currentTime + 0.08; this.t0 = this.nextStepTime - this.step * STEP; this.qHead = this.qTail = 0; }
    } catch (e) { this.ctx = null; }
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.game.settings, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.volMaster, t, 0.03);
    this.musicBus.gain.setTargetAtTime(s.volMusic * 0.55 * (this.paused ? 0.5 : 1), t, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.volSfx * 0.8, t, 0.03);
  }

  startMusic() {
    if (this.playing) return;
    this.playing = true; this.step = 0;
    this.nextStepTime = this.now() + 0.1; this.t0 = this.nextStepTime;
    this.qHead = this.qTail = 0; this.beatCount = 0;
  }

  setPaused(p) {
    this.paused = p;
    if (!this.ctx) return;
    this.applyVolumes();
    this.updateFilter();
  }
  // Zeitlupe: Tiefpass + Pitch-Drop auf der gesamten Musik, SFX klingen tiefer
  setSlowmo(a) {
    if (a === this.slow) return;
    this.slow = a; this.pitch = lerp(1, 0.62, a);
    if (!this.ctx) return;
    this.updateFilter();
    const t = this.ctx.currentTime, det = -500 * a;
    for (const o of this.padOscs) { try { o.detune.setTargetAtTime(o._det + det, t, 0.04); } catch (e) { /* schon gestoppt */ } }
  }
  updateFilter() {
    const f = this.paused ? 600 : lerp(18000, 520, this.slow);
    this.musicFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.04);
  }

  // Abstand (in Sekunden) zum nächsten Beat – für das Grind-Pumping
  beatError() {
    if (!this.playing) return 1;
    let ph = ((this.now() - this.t0) / BEAT) % 1; if (ph < 0) ph += 1;
    return Math.min(ph, 1 - ph) * BEAT;
  }
  beatPhase() { if (!this.playing) return 0; let ph = ((this.now() - this.t0) / BEAT) % 1; return ph < 0 ? ph + 1 : ph; }

  // ---------------------------------------------------------------- Scheduler
  // Lookahead-Scheduler: Noten werden mit der Audio-Uhr (sample-genau) bis `lookahead` Sekunden im Voraus
  // eingeplant. Das Pumpen aus rAF/Interval bestimmt nur, WANN geplant wird – nie, wann etwas erklingt.
  pump() {
    if (!this.playing) return;
    const now = this.now();
    if (this.nextStepTime < now - 0.1) {
      // Tab war im Hintergrund: Schritte überspringen statt nachzuholen, Raster bleibt erhalten
      const skip = Math.ceil((now - this.nextStepTime) / STEP);
      this.step += skip; this.nextStepTime += skip * STEP;
    }
    while (this.nextStepTime < now + CONFIG.audio.lookahead) {
      if (this.ctx && this.ctx.state === 'running') this.scheduleStep(this.step, this.nextStepTime);
      const n = (this.qTail + 1) & 63;
      if (n !== this.qHead) { this.qTimes[this.qTail] = this.nextStepTime; this.qSteps[this.qTail] = this.step; this.qTail = n; }
      this.step++; this.nextStepTime += STEP;
    }
  }

  scheduleStep(step, t) {
    const I = this.intensity;
    const s16 = step & 15, bar = (step >> 4) & 3, chord = CHORDS[bar];
    const det = -500 * this.slow;
    if ((s16 & 3) === 0) {
      this.kick(t, s16 === 0 ? 1 : 0.9);
      if (I >= 4.6) { const g = this.duck.gain; g.cancelScheduledValues(t); g.setValueAtTime(0.32, t); g.linearRampToValueAtTime(1, t + BEAT * 0.55); }
    }
    if (s16 === 0) this.pad(t, chord.notes, BEAT * 4, det, I);
    if (I >= 1) {
      if ((s16 & 3) === 2) this.hat(t, 0.16, I >= 4.6 && s16 === 14);
      const sixteenth = I >= 2;
      if (sixteenth || (s16 & 1) === 0) {
        const n = chord.bass - 12 + BASS_PAT[(s16 >> 1) & 7];
        this.bass(t, mtof(n), sixteenth ? STEP * 0.9 : STEP * 1.7, det, (s16 & 1) ? 0.6 : 1);
      }
    }
    if (I >= 2 && (s16 === 4 || s16 === 12)) this.snare(t);
    if (I >= 3) {
      if ((s16 & 1) === 1 || (s16 & 3) === 0) this.hat(t, 0.07, false);
      const a = ARP_PAT[s16];
      const note = a < 3 ? chord.notes[a] + 12 : chord.notes[a - 3] + 24;
      this.arp(t, mtof(note), det);
    }
    if (I >= 4 && (s16 & 1) === 0) {
      const m = LEAD[bar][s16 >> 1];
      if (m) this.lead(t, mtof(m), STEP * 2.6, det);
    }
  }

  env(g, t, peak, attack, dur) {
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  // Kick: Sinus mit Pitch-Envelope
  kick(t, vel) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(165, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    this.env(g, t, 0.95 * vel, 0.002, 0.3);
    o.connect(g); g.connect(this.musicBus); o.start(t); o.stop(t + 0.32);
  }
  // Snare: Noise + Ton
  snare(t) {
    const c = this.ctx;
    this.noiseHit(this.musicBus, t, 'highpass', 1700, 1700, 0.7, 0.17, 0.42, 1);
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    this.env(g, t, 0.35, 0.002, 0.12);
    o.connect(g); g.connect(this.musicBus); o.start(t); o.stop(t + 0.14);
  }
  // Hi-Hat: gefiltertes Noise
  hat(t, gain, open) { this.noiseHit(this.musicBus, t, 'highpass', 7800, 7800, 0.7, open ? 0.2 : 0.045, gain, 1); }
  // Bass: Sägezahn durch Tiefpass mit Filter-Envelope
  bass(t, f, dur, det, vel) {
    const c = this.ctx, o = c.createOscillator(), fl = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
    fl.type = 'lowpass'; fl.Q.value = 7; fl.frequency.setValueAtTime(950, t); fl.frequency.exponentialRampToValueAtTime(220, t + dur);
    this.env(g, t, 0.42 * vel, 0.004, dur);
    o.connect(fl); fl.connect(g); g.connect(this.duck); o.start(t); o.stop(t + dur + 0.03);
  }
  // Pad: detunete Sägezähne mit langsamem Filter
  pad(t, notes, dur, det, I) {
    const c = this.ctx, fl = c.createBiquadFilter(), g = c.createGain();
    fl.type = 'lowpass'; fl.Q.value = 1.2;
    const top = 900 + I * 380;
    fl.frequency.setValueAtTime(520, t); fl.frequency.linearRampToValueAtTime(top, t + dur * 0.5); fl.frequency.linearRampToValueAtTime(520, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.11, t + 0.35); g.gain.setValueAtTime(0.11, t + dur - 0.3); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
    fl.connect(g); g.connect(this.duck);
    this.padOscs.length = 0;
    for (let i = 0; i < notes.length; i++) for (let k = -1; k <= 1; k += 2) {
      const o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(notes[i]); o._det = k * 9; o.detune.value = k * 9 + det;
      o.connect(fl); o.start(t); o.stop(t + dur + 0.3);
      this.padOscs.push(o);
    }
  }
  arp(t, f, det) {
    const c = this.ctx, o = c.createOscillator(), fl = c.createBiquadFilter(), g = c.createGain();
    o.type = 'square'; o.frequency.value = f; o.detune.value = det;
    fl.type = 'lowpass'; fl.frequency.setValueAtTime(3400, t); fl.frequency.exponentialRampToValueAtTime(700, t + 0.13);
    this.env(g, t, 0.085, 0.003, 0.15);
    o.connect(fl); fl.connect(g); g.connect(this.arpBus); o.start(t); o.stop(t + 0.17);
  }
  lead(t, f, dur, det) {
    const c = this.ctx, fl = c.createBiquadFilter(), g = c.createGain();
    fl.type = 'lowpass'; fl.frequency.value = 3200; fl.Q.value = 2;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.04, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    fl.connect(g); g.connect(this.arpBus);
    for (let k = 0; k < 2; k++) {
      const o = c.createOscillator();
      o.type = k ? 'square' : 'sawtooth'; o.frequency.value = f; o.detune.value = (k ? 7 : -7) + det;
      o.connect(fl); o.start(t); o.stop(t + dur + 0.03);
    }
  }

  // ---------------------------------------------------------------- SFX-Bausteine
  tone(dest, t, type, f0, f1, dur, gain, attack) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(), p = this.pitch;
    o.type = type; o.frequency.setValueAtTime(f0 * p, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * p), t + dur);
    this.env(g, t, gain, attack || 0.003, dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.03);
    return o;
  }
  noiseHit(dest, t, ftype, f0, f1, q, dur, gain, pitchScale) {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    const p = pitchScale || this.pitch;
    s.buffer = this.noiseBuf; s.loop = true;
    fl.type = ftype; fl.Q.value = q; fl.frequency.setValueAtTime(f0 * p, t);
    if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(Math.max(30, f1 * p), t + dur);
    this.env(g, t, gain, 0.002, dur);
    s.connect(fl); fl.connect(g); g.connect(dest); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.03);
    return s;
  }

  // 3D-positionierter Sound (PannerNode) – für Gegner-Telegraphing
  play3D(name, x, y, z, a) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const c = this.ctx, pn = c.createPanner();
    pn.panningModel = 'equalpower'; pn.distanceModel = 'inverse'; pn.refDistance = 9; pn.maxDistance = 220; pn.rolloffFactor = 1.1;
    if (pn.positionX) { pn.positionX.value = x; pn.positionY.value = y; pn.positionZ.value = z; } else pn.setPosition(x, y, z);
    pn.connect(this.sfxBus);
    const dur = this.sfx(name, a, pn);
    setTimeout(() => { try { pn.disconnect(); } catch (e) { /* egal */ } }, (dur || 1) * 1000 + 300);
  }
  play(name, a) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.sfx(name, a, this.sfxBus);
  }

  // Alle Soundeffekte, komplett synthetisiert. Gibt die ungefähre Dauer zurück.
  sfx(name, a, d) {
    const t = this.ctx.currentTime + 0.001;
    // Spam-Schutz für sehr häufige Sounds
    const last = this.lastPlay[name] || 0;
    if (t - last < 0.025) return 0.1;
    this.lastPlay[name] = t;
    const r = 0.94 + Math.random() * 0.12;
    switch (name) {
      case 'jump': this.tone(d, t, 'square', 250, 520, 0.09, 0.13); this.noiseHit(d, t, 'highpass', 2500, 2500, 0.7, 0.03, 0.1); return 0.1;
      case 'djump': this.tone(d, t, 'square', 420, 900, 0.1, 0.13); this.tone(d, t + 0.03, 'sine', 840, 1400, 0.13, 0.12); return 0.2;
      case 'land': this.noiseHit(d, t, 'lowpass', 500, 90, 0.7, 0.16 + a * 0.12, 0.25 + a * 0.5); this.tone(d, t, 'sine', 100, 40, 0.15 + a * 0.1, 0.3 * a + 0.1); return 0.3;
      case 'step': this.noiseHit(d, t, 'bandpass', 900 * r, 600, 1.2, 0.045, 0.07 + 0.05 * (a || 0)); return 0.05;
      case 'dash': this.noiseHit(d, t, 'bandpass', 3200, 300, 1.6, 0.28, 0.55); this.tone(d, t, 'sawtooth', 640, 110, 0.16, 0.16); return 0.3;
      case 'slide': this.noiseHit(d, t, 'lowpass', 2400, 500, 0.7, 0.3, 0.28); return 0.3;
      case 'wallStart': this.tone(d, t, 'triangle', 300, 470, 0.08, 0.16); this.noiseHit(d, t, 'bandpass', 1500, 1500, 1, 0.05, 0.15); return 0.1;
      case 'wallJump': this.tone(d, t, 'square', 330, 780, 0.1, 0.14); this.noiseHit(d, t, 'highpass', 2000, 2000, 0.7, 0.04, 0.12); return 0.12;
      case 'railSnap':
        this.tone(d, t, 'square', 1240, 1220, 0.16, 0.07); this.tone(d, t, 'sine', 1870, 1850, 0.2, 0.09); this.tone(d, t, 'sine', 2630, 2600, 0.14, 0.06);
        this.noiseHit(d, t, 'bandpass', 4200, 4200, 2, 0.05, 0.3); return 0.25;
      case 'railJump': this.tone(d, t, 'sawtooth', 500, 1150, 0.12, 0.12); this.tone(d, t + 0.02, 'sine', 1760, 1760, 0.16, 0.08); return 0.2;
      case 'railEnd': this.tone(d, t, 'sine', 900, 110, 0.55, 0.22, 0.02); this.noiseHit(d, t, 'lowpass', 4000, 200, 0.7, 0.5, 0.2); return 0.6;
      case 'pump':
        if (a) { this.tone(d, t, 'triangle', 880, 880, 0.07, 0.2); this.tone(d, t + 0.05, 'triangle', 1320, 1320, 0.1, 0.2); }
        else this.tone(d, t, 'triangle', 300, 260, 0.06, 0.1);
        return 0.15;
      case 'pad': this.tone(d, t, 'sawtooth', 200, 1300, 0.24, 0.16); this.noiseHit(d, t, 'bandpass', 800, 5000, 1.5, 0.22, 0.25); return 0.25;
      case 'launch': this.tone(d, t, 'sine', 140, 950, 0.42, 0.3); this.noiseHit(d, t, 'bandpass', 500, 6000, 1.2, 0.4, 0.3); return 0.45;
      case 'shoot':
        this.tone(d, t, 'sawtooth', 980 * r, 170, 0.075, 0.2); this.noiseHit(d, t, 'highpass', 3200, 3200, 0.7, 0.035, 0.2);
        this.tone(d, t, 'sine', 150, 55, 0.07, 0.26); return 0.08;
      case 'hit': this.tone(d, t, 'triangle', 1900 * r, 1700, 0.035, 0.22, 0.001); return 0.04;
      case 'weak': this.tone(d, t, 'sine', 2637, 2637, 0.22, 0.2, 0.001); this.tone(d, t, 'sine', 3520, 3520, 0.16, 0.12, 0.001); return 0.25;
      case 'kill':
        this.noiseHit(d, t, 'lowpass', 2800, 180, 0.7, 0.26, 0.5); this.tone(d, t, 'sine', 130, 34, 0.3, 0.55);
        this.tone(d, t, 'triangle', 660, 660, 0.2, 0.17); this.tone(d, t + 0.045, 'triangle', 990, 990, 0.2, 0.17); this.tone(d, t + 0.09, 'triangle', 1320, 1320, 0.28, 0.19);
        return 0.4;
      case 'pierce': this.tone(d, t, 'sawtooth', 1600, 380, 0.2, 0.18); this.noiseHit(d, t, 'bandpass', 5000, 1200, 3, 0.15, 0.25); return 0.22;
      case 'shield': this.tone(d, t, 'sine', 1250 * r, 1150, 0.06, 0.1, 0.001); this.tone(d, t, 'square', 190, 170, 0.05, 0.06); return 0.07;
      case 'overheat': this.noiseHit(d, t, 'highpass', 4200, 2500, 0.7, 0.7, 0.3); this.tone(d, t, 'sawtooth', 700, 130, 0.4, 0.14); return 0.7;
      case 'hurt': this.tone(d, t, 'square', 170, 65, 0.24, 0.3); this.noiseHit(d, t, 'lowpass', 1800, 300, 0.7, 0.2, 0.4); return 0.25;
      case 'death': this.tone(d, t, 'sawtooth', 420, 36, 1.3, 0.35, 0.01); this.noiseHit(d, t, 'lowpass', 2500, 80, 0.7, 1.2, 0.4); return 1.4;
      case 'ui': this.tone(d, t, 'sine', 880, 880, 0.05, 0.14, 0.001); return 0.05;
      case 'uiBack': this.tone(d, t, 'sine', 520, 440, 0.06, 0.12, 0.001); return 0.06;
      case 'waveClear': [523, 659, 784, 1047].forEach((f, i) => this.tone(d, t + i * 0.075, 'triangle', f, f, 0.26, 0.2)); return 0.6;
      case 'waveStart': this.tone(d, t, 'sawtooth', 110, 108, 0.5, 0.2, 0.03); this.tone(d, t, 'sawtooth', 165, 163, 0.5, 0.14, 0.03); return 0.5;
      case 'overdrive':
        this.tone(d, t, 'sawtooth', 180, 1800, 0.55, 0.2, 0.3); this.noiseHit(d, t, 'bandpass', 400, 8000, 1.5, 0.55, 0.3);
        [440, 554, 659, 880].forEach((f) => this.tone(d, t + 0.55, 'sawtooth', f, f, 0.6, 0.09)); return 1.2;
      case 'overdriveEnd': this.tone(d, t, 'sawtooth', 900, 120, 0.5, 0.15); return 0.5;
      case 'portal': this.tone(d, t, 'sine', 180, 620, 0.5, 0.25, 0.4); this.noiseHit(d, t, 'bandpass', 300, 2400, 3, 0.5, 0.2); return 0.6;
      case 'spawn': this.tone(d, t, 'square', 520, 240, 0.13, 0.2); return 0.15;
      case 'explode': this.noiseHit(d, t, 'lowpass', 2000, 90, 0.7, 0.4, 0.9); this.tone(d, t, 'sine', 110, 28, 0.35, 0.7); return 0.45;
      case 'swarmerArm': for (let i = 0; i < 4; i++) this.tone(d, t + i * 0.11, 'square', 1750, 1750, 0.05, 0.3, 0.001); return 0.5;
      case 'sniperCharge': this.tone(d, t, 'sawtooth', 380, 1700, a || 1.5, 0.32, (a || 1.5) * 0.9); return a || 1.5;
      case 'sniperFire': this.noiseHit(d, t, 'highpass', 1500, 1500, 0.7, 0.2, 1.0); this.tone(d, t, 'sawtooth', 2200, 90, 0.18, 0.6); return 0.25;
      case 'cutter': {
        const o = this.tone(d, t, 'sawtooth', 150, 220, 0.9, 0.4, 0.05);
        const l = this.ctx.createOscillator(), lg = this.ctx.createGain();
        l.frequency.value = 31; lg.gain.value = 60; l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + 0.95);
        return 1;
      }
      case 'bulwarkCharge': this.tone(d, t, 'sawtooth', 62, 150, 0.6, 0.5, 0.45); return 0.6;
      case 'bulwarkFire': this.tone(d, t, 'sine', 320, 90, 0.2, 0.6); this.noiseHit(d, t, 'lowpass', 1200, 200, 0.7, 0.15, 0.5); return 0.25;
      case 'wardenHorn': this.tone(d, t, 'sawtooth', 55, 52, 1.4, 0.7, 0.2); this.tone(d, t, 'sawtooth', 82.5, 80, 1.4, 0.5, 0.2); this.tone(d, t, 'square', 110, 108, 1.2, 0.2, 0.3); return 1.5;
      case 'wardenSweep': this.noiseHit(d, t, 'bandpass', 300, 3500, 2.5, 1.0, 0.7); this.tone(d, t, 'sawtooth', 90, 400, 1.0, 0.4, 0.8); return 1.1;
      case 'shock': this.tone(d, t, 'sine', 85, 24, 0.9, 0.9, 0.01); this.noiseHit(d, t, 'lowpass', 900, 60, 0.7, 0.8, 0.6); return 1;
      case 'closeCall': this.noiseHit(d, t, 'bandpass', 800, 4500, 2, 0.16, 0.3); this.tone(d, t + 0.05, 'sine', 1568, 1568, 0.15, 0.12); return 0.25;
      case 'warn': this.tone(d, t, 'square', 920, 920, 0.08, 0.16, 0.001); return 0.1;
      case 'railCut': this.noiseHit(d, t, 'highpass', 3000, 800, 0.7, 0.35, 0.5); this.tone(d, t, 'sawtooth', 1200, 100, 0.3, 0.25); return 0.4;
      case 'hop': this.tone(d, t, 'triangle', 988, 988, 0.08, 0.16); this.tone(d, t + 0.06, 'triangle', 1480, 1480, 0.14, 0.16); return 0.2;
    }
    return 0.1;
  }

  // ---------------------------------------------------------------- Loops (Wind, Grind, Wallrun, Slide, Rail-Gun)
  makeLoops() {
    const c = this.ctx;
    const src = () => { const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.start(0, Math.random()); return s; };
    const chain = (ftype, freq, q) => {
      const f = c.createBiquadFilter(); f.type = ftype; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = 0;
      src().connect(f); f.connect(g); g.connect(this.sfxBus);
      return { f, g };
    };
    this.wind = chain('lowpass', 400, 0.6);
    this.slideL = chain('bandpass', 1500, 0.8);
    this.wallL = chain('bandpass', 850, 1.4);
    // Grind: Noise -> Bandpass -> Ringmodulation (Gain wird von einem Oszillator moduliert) = metallisches Kreischen
    const gf = c.createBiquadFilter(); gf.type = 'bandpass'; gf.frequency.value = 2200; gf.Q.value = 5;
    const ring = c.createGain(); ring.gain.value = 0;
    const mod = c.createOscillator(); mod.type = 'square'; mod.frequency.value = 180; mod.start();
    mod.connect(ring.gain);
    const gg = c.createGain(); gg.gain.value = 0;
    src().connect(gf); gf.connect(ring); ring.connect(gg); gg.connect(this.sfxBus);
    const whine = c.createOscillator(); whine.type = 'sawtooth'; whine.frequency.value = 300; whine.start();
    const wg = c.createGain(); wg.gain.value = 0.05; whine.connect(wg); wg.connect(gg);
    this.grind = { f: gf, g: gg, mod, whine };
    // Rail-Gun: aufsteigender Synth-Ton, solange die Rail wächst
    const ro = c.createOscillator(); ro.type = 'sawtooth'; ro.frequency.value = 200; ro.start();
    const ro2 = c.createOscillator(); ro2.type = 'sine'; ro2.frequency.value = 400; ro2.start();
    const rf = c.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 2400;
    const rg = c.createGain(); rg.gain.value = 0;
    ro.connect(rf); ro2.connect(rf); rf.connect(rg); rg.connect(this.sfxBus);
    this.railgun = { o: ro, o2: ro2, g: rg };
  }

  setRailgun(on, level) { this.railgunOn = on; this.railgunLevel = level; }

  update(dt) {
    this.pump();
    const now = this.now();
    // Beat-Clock: Events genau dann feuern, wenn die Audio-Uhr den Schritt erreicht
    while (this.qHead !== this.qTail && this.qTimes[this.qHead] <= now) {
      const st = this.qSteps[this.qHead], tm = this.qTimes[this.qHead];
      this.qHead = (this.qHead + 1) & 63;
      if ((st & 3) === 0) {
        this.lastBeatTime = tm; this.beatCount = st >> 2;
        if (this.onBeat) this.onBeat(st >> 2, (st & 15) === 0);
      }
    }
    this.pulse = this.playing ? Math.exp(-Math.max(0, now - this.lastBeatTime) * 7) : 0;
    this.intensity += clamp(this.targetIntensity - this.intensity, -dt * 1.5, dt * 3);
    if (!this.ctx || this.ctx.state !== 'running') return;
    const c = this.ctx, t = c.currentTime, g = this.game, pl = g.player;
    const live = g.isPlaying() && !pl.dead && !this.paused;
    const sp = live ? pl.speed : 0, p = this.pitch;
    // Wind wird mit dem Tempo lauter
    this.wind.g.gain.setTargetAtTime(live ? smoothstep(6, 46, sp) * 0.5 : 0, t, 0.08);
    this.wind.f.frequency.setTargetAtTime((300 + sp * 42) * p, t, 0.08);
    const grinding = live && pl.state === STATE.GRINDING;
    this.grind.g.gain.setTargetAtTime(grinding ? 0.22 + Math.min(0.3, sp / 130) : 0, t, 0.03);
    if (grinding) {
      this.grind.f.frequency.setTargetAtTime((1500 + sp * 70) * p, t, 0.05);
      this.grind.mod.frequency.setTargetAtTime((95 + sp * 7) * p, t, 0.05);
      this.grind.whine.frequency.setTargetAtTime((220 + sp * 16) * p, t, 0.05);
    }
    this.wallL.g.gain.setTargetAtTime(live && pl.state === STATE.WALLRUNNING ? 0.3 : 0, t, 0.03);
    this.slideL.g.gain.setTargetAtTime(live && pl.state === STATE.SLIDING ? 0.12 + Math.min(0.25, sp / 120) : 0, t, 0.04);
    this.slideL.f.frequency.setTargetAtTime((900 + sp * 35) * p, t, 0.05);
    const rOn = live && this.railgunOn;
    this.railgun.g.gain.setTargetAtTime(rOn ? 0.1 : 0, t, 0.03);
    if (rOn) {
      const f = (220 + this.railgunLevel * 700) * p;
      this.railgun.o.frequency.setTargetAtTime(f, t, 0.03); this.railgun.o2.frequency.setTargetAtTime(f * 2.01, t, 0.03);
    }
    // Listener folgt der Kamera
    const cam = g.cam.camera, L = c.listener;
    const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    if (L.positionX) {
      L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z;
      L.forwardX.value = fx; L.forwardY.value = 0; L.forwardZ.value = fz; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else if (L.setPosition) { L.setPosition(cam.position.x, cam.position.y, cam.position.z); L.setOrientation(fx, 0, fz, 0, 1, 0); }
  }
}
