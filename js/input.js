// Input: Tastatur/Maus, Edge-Events als Queue (damit bei 120-Hz-Ticks kein Druck verloren geht), Rebinding.
export class Input {
  constructor(game) {
    this.game = game;
    this.down = new Set();
    this.binds = {};
    this.codeToAction = new Map();
    this.pressed = {};          // action -> true bis consume()
    this.mouseDX = 0; this.mouseDY = 0;
    this.fire = false; this.alt = false;
    this.locked = false;
    this.fallbackLook = false;  // wenn Pointer Lock verweigert wird
    this.rebindCb = null;
    this.lastUnlock = 0;
  }

  init(canvas) {
    this.canvas = canvas;
    this.setBinds(this.game.settings.binds);
    window.addEventListener('keydown', (e) => this.onKey(e, true), { passive: false });
    window.addEventListener('keyup', (e) => this.onKey(e, false), { passive: false });
    window.addEventListener('blur', () => { this.down.clear(); this.fire = false; this.alt = false; });
    document.addEventListener('mousemove', (e) => {
      if (this.locked || (this.fallbackLook && this.game.isPlaying())) {
        // Einzelne Ausreisser (Browser-Bug bei Pointer Lock) abfangen
        const mx = e.movementX || 0, my = e.movementY || 0;
        if (Math.abs(mx) < 600 && Math.abs(my) < 600) { this.mouseDX += mx; this.mouseDY += my; }
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.game.isPlaying()) return;
      if (!this.locked && !this.fallbackLook) { this.requestLock(); return; }
      if (e.button === 0) this.fire = true;
      if (e.button === 2) { this.alt = true; this.pressed.alt = true; }
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.alt = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.lastUnlock = performance.now(); this.fire = false; this.alt = false; this.down.clear(); }
      this.game.onPointerLock(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockFail());
  }

  requestLock() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => this.onLockFail());
    } catch (e) { this.onLockFail(); }
  }
  onLockFail() {
    // Chrome sperrt Re-Lock ~1 s nach Esc: dann nur Hinweis, kein Fallback
    if (performance.now() - this.lastUnlock < 1600) { this.game.onLockDenied(true); return; }
    this.fallbackLook = true;
    this.game.onLockDenied(false);
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  setBinds(binds) {
    this.binds = binds;
    this.codeToAction.clear();
    for (const a in binds) for (const c of binds[a]) this.codeToAction.set(c, a);
  }
  startRebind(cb) { this.rebindCb = cb; }

  onKey(e, isDown) {
    if (this.rebindCb && isDown) {
      e.preventDefault();
      const cb = this.rebindCb; this.rebindCb = null;
      cb(e.code === 'Escape' ? null : e.code);
      return;
    }
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.code === 'Escape') { if (isDown && !e.repeat) this.game.onEscape(); return; }
    const action = this.codeToAction.get(e.code);
    if (this.game.isPlaying()) {
      // Browser-Shortcuts (Space scrollt, Ctrl+S/D usw.) im Spiel unterdrücken
      if (action || e.ctrlKey || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    }
    if (isDown) {
      if (e.repeat) return;
      this.down.add(e.code);
      if (action) this.pressed[action] = true;
      this.game.onKeyAction(action, e.code);
    } else {
      this.down.delete(e.code);
    }
  }

  isDown(action) {
    const list = this.binds[action];
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (this.down.has(list[i])) return true;
    return false;
  }
  consume(action) {
    if (this.pressed[action]) { this.pressed[action] = false; return true; }
    return false;
  }
  clearEdges() { for (const k in this.pressed) this.pressed[k] = false; this.mouseDX = 0; this.mouseDY = 0; }
  axisX() { return (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0); }
  axisZ() { return (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0); }
}
