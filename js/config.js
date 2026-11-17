// RAILBREAKER – zentrale Tuning-Werte. Alles, was sich "anfühlt", steht hier.
export const CONFIG = {
  physicsHz: 120,
  maxTicksPerFrame: 10,

  player: {
    walkSpeed: 10, sprintSpeed: 15,
    groundAccel: 80, airAccel: 25,
    airStrafeGain: 2.5,       // m/s², die sauberes Air-Strafing (seitlich drücken + Maus mitziehen) oberhalb des Sprint-Tempos bringt
    friction: 8, overspeedFriction: 1.6, stopSpeed: 3,
    landGrace: 0.22,          // Sekunden ohne Reibung nach der Landung (Bunnyhop/Slide-Fenster)
    gravity: 30,
    jumpImpulse: 11, doubleJumpImpulse: 10.5, doubleJumpSteer: 3,
    coyote: 0.12, jumpBuffer: 0.15,
    softCap: 40, softCapDrag: 0.9,
    radius: 0.4, height: 1.8, slideHeight: 0.9, eyeHeight: 1.62,
    stepHeight: 0.4, ledgeHeight: 0.6, groundSnap: 0.35,
    maxHp: 100, regenDelay: 3, regenRate: 25,
    speedArmorSpeed: 25, speedArmor: 0.4,
    killY: 4, warnY: 15,
  },
  slide: { boost: 4, cooldown: 1, friction: 0.5, minSpeed: 9, endSpeed: 3.5, camDrop: 0.8, fov: 5, steer: 7 },
  wallrun: {
    maxDist: 0.8, minSpeed: 8, gravityScale: 0.15, maxTime: 1.8, tilt: 12,
    jumpOut: 8.5, jumpUp: 9, sameWallCooldown: 0.5, minAirTime: 0.1, accel: 6, speedBonus: 1.12,
  },
  dash: { time: 0.15, speed: 30, charges: 2, recharge: 1.5, exitMinSpeed: 18 },

  rail: {
    snapDist: 1.5, minSpeed: 14, radius: 0.14, sampleDist: 0.5,
    uphillFactor: 0.35, holdAccel: 3.5, brake: 10,
    pumpOnBeat: 3.2, pumpOffBeat: 0.5, pumpWindow: 0.09, pumpCooldown: 0.18,
    sameRailCooldown: 0.45, hopRange: 16, hopWindow: 1.6,
    endJump: 4.5, perfectWindow: 5,
    slowmoScale: 0.25, slowmoTime: 0.35, slowmoFade: 0.12, slowmoDamage: 1.5,
    energyPerSec: 15, perfectEnergy: 20,
    worldColor: 0x19e6ff, playerColor: 0xff2bd6,
  },
  railgun: {
    growSpeed: 35, energyCost: 20, maxEnergy: 100, maxLength: 40, minEnergyToStart: 4,
    pierceDamage: 80, pierceRadius: 1.3, lifetime: 12, fadeTime: 2, maxRails: 6,
    startAhead: 2.4, startDrop: 1.0, turnRate: 9, killEnergy: 10,
  },
  weapon: {
    fireRate: 10, baseDamage: 10, speedScale: 20, range: 320,
    heatTime: 4, cooldownTime: 1.5, coolRate: 0.55, weakMult: 2,
    spread: 0.004, heatSpread: 0.012,
  },
  enemies: {
    maxAlive: 64,
    swarmer: { hp: 20, speed: 17, accel: 34, armDist: 7, armTime: 0.5, blastRadius: 3.6, damage: 14, radius: 0.75 },
    sniper: { hp: 60, aimTime: 1.5, lockTime: 0.28, idleMin: 1.4, idleMax: 3.0, damage: 40, range: 150, beamRadius: 1.0, radius: 1.1 },
    cutter: { hp: 50, speed: 19, cutTime: 0.9, radius: 1.0 },
    bulwark: { hp: 200, speed: 4.5, turnRate: 0.75, fireEvery: 2.6, telegraph: 0.6, orbSpeed: 15, orbDamage: 20, radius: 2.0 },
    warden: {
      hp: 3000, height: 50, radius: 4.5, weakRadius: 2.1, weakHeights: [9, 21, 33, 45],
      closeRange: 22, sweepDamage: 30, shockDamage: 25, pierceMult: 3,
    },
    spawnMin: 34, spawnMax: 62, leashDist: 190,
  },
  waves: { pause: 5, firstDelayBeats: 8, bossEvery: 5 },

  world: {
    chunkSize: 80, viewRadius: 2, gridCell: 16,
    baseHeight: 42, heightAmp: 12, heightFreq: 0.31,
    buildingBottom: -40, cloudY: 0,
    fogColor: 0x1b0638, fogDensity: 0.0078,
    padBoost: 10, launchUp: 25, launchForward: 9,
    jumpSafety: 0.7,          // Anteil der theoretischen Sprungweite, der im Critical Path genutzt wird
  },

  camera: {
    fovMaxAdd: 25, fovSpeedMin: 12, fovSpeedMax: 45, dashFov: 9,
    bobAmp: 0.045, bobFreq: 1.9, landDip: 0.022, shakeAngle: 0.07, shakeDecay: 1.6,
    strafeTilt: 2.2, grindLean: 9,
  },

  flow: {
    names: ['D', 'C', 'B', 'A', 'S'],
    titles: ['CRUISE', 'RUSH', 'BLAZE', 'SURGE', 'OVERDRIVE'],
    decay: 0.11, idleDecay: 0.75, idleSpeed: 6, damageLoss: 0.7,
    overdriveTime: 8, overdriveExtend: 0.7, overdriveSpeed: 1.15,
  },
  score: {
    kill: 100, airKill: 0.5, grindKill: 0.75, pierceKill: 200, multiKill: 60, multiWindow: 1.2,
    grindPerMeter: 2, railHop: 50, wallChain: 30, closeCall: 75, perfectDismount: 150,
    speedPerSec: 25, speedBonusMin: 30, highLinePerSec: 15, comboWindow: 3.5,
    grades: [3000, 10000, 25000, 60000],   // Punkte-Schwellen für die Run-Note C, B, A, S (darunter: D)
  },
  audio: { bpm: 128, lookahead: 0.2 },
  ghost: { rate: 20, maxSeconds: 900 },
};

export const STATE = { GROUNDED: 0, AIRBORNE: 1, SLIDING: 2, WALLRUNNING: 3, GRINDING: 4, DASHING: 5 };
export const STATE_NAMES = ['GROUNDED', 'AIRBORNE', 'SLIDING', 'WALLRUNNING', 'GRINDING', 'DASHING'];

export const QUALITY = {
  low:  { pixelRatio: 0.7,  particles: 1800, bloom: true,  fxaa: false, blurTaps: 4,  shadow: 0, skyline: 90 },
  med:  { pixelRatio: 1.0,  particles: 4000, bloom: true,  fxaa: true,  blurTaps: 8,  shadow: 1, skyline: 160 },
  high: { pixelRatio: 1.5,  particles: 6000, bloom: true,  fxaa: true,  blurTaps: 12, shadow: 2, skyline: 240 },
};

export const DEFAULT_SETTINGS = {
  sens: 1.0, fov: 90, volMaster: 0.8, volMusic: 0.7, volSfx: 0.9,
  quality: 'med', motionBlur: true, shake: 1.0,
  binds: {
    forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    jump: ['Space'], dash: ['ShiftLeft', 'ShiftRight'], slide: ['ControlLeft', 'KeyC'],
    restart: ['KeyR'], skipTutorial: ['KeyT'],
  },
};
