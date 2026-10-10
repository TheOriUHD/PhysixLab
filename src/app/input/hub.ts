/**
 * InputHub — the per-frame glue between devices and the simulation.
 *
 * Devices (keyboard, gamepad, on-screen touch controls) all end up as two things the physics worker understands:
 *   - pressed key codes (`sim.keys`): raw keys, pad buttons as `PadSouth` … codes, and the keys a pad button stands for;
 *   - analog axes (`client.setAxis`): pad sticks / triggers / touch joysticks through the active vehicle profile,
 *     plus the keyboard keys of axis-driven motors ramped like a stick.
 * Held camera actions and rebinding capture read the same state.
 */
import { clamp } from '../../core/math';
import { sceneControls } from '../../model/controls';
import { isJoint } from '../../model/types';
import type { App } from '../app';
import { runCommand } from '../registry/commands';
import { DEFAULT_AXIS, AxisState, shapeAnalog, type AxisCfg } from './axes';
import { setCaptureHost } from './capture';
import { GamepadPoller, PAD_BUTTONS, emptyPad, padKeyCode, padLabel, type PadButton, type PadState } from './gamepad';
import { inputMap } from './inputMap';
import { PAD_TO_COMMAND, PAD_TO_KEY, profileById, type PadSource, type VehicleProfile } from './profiles';
import { sanitizeInput, type InputSettings } from './settings';

export class InputHub {
  readonly pad: GamepadPoller;
  /** Virtual pad driven by the on-screen touch controls (same shape as a real one). */
  readonly touch: PadState = emptyPad();
  /** Set by the touch overlay while a finger is on a control. */
  touchActive = false;
  /** Combined real + touch pad, refreshed each frame. */
  readonly combined: PadState = emptyPad();

  private physical = new Set<string>();
  /** Lower-cased `key`s and `code`s currently held (for held camera actions). */
  readonly down = new Set<string>();
  private axes = new Map<string, AxisState>();
  private axisKeys = new Map<string, { axis: string; sign: number }[]>();
  private axisNames = new Set<string>();
  private axisDirs = new Map<string, number>();
  private dirty = true;
  private prevPad: Record<PadButton, boolean> = emptyPad().buttons;
  private captureCbs = new Set<(code: string) => void>();
  /** Keys this hub currently holds in `sim.keys` (and the scratch set the next frame fills). */
  private owned = new Set<string>();
  private wanted = new Set<string>();
  private lastAxisSent = new Map<string, number>();

  constructor(private app: App) {
    this.pad = new GamepadPoller({
      onConnect: (id, family) => {
        if (this.settings.gamepad)
          app.toast(`Controller connected: ${id.replace(/\s*\(.*$/, '')} (${family})`, 'success');
      },
      onDisconnect: (id) => app.toast(`Controller disconnected: ${id.replace(/\s*\(.*$/, '')}`, 'warn'),
    });
    setCaptureHost({
      watchPad: (cb) => {
        this.captureCbs.add(cb);
        return () => this.captureCbs.delete(cb);
      },
      padFamily: () => this.pad.family,
    });
    // Saved bindings → the map; later edits in the map → saved.
    inputMap.load(this.settings.bindings, this.settings.preset);
    inputMap.on('change', () => this.update_settings({ bindings: inputMap.bindings, preset: inputMap.preset }));
    app.store.on('change', (c) => {
      // Dragging bodies around changes poses only: the axes and keys the scene listens to stay the same.
      if (c.type === 'update' && [...c.keys].every((k) => k === 'position' || k === 'rotation')) return;
      this.dirty = true;
    });
    app.sim.on('layout', () => (this.dirty = true));
    app.prefs.on('change', (k) => {
      if (k.includes('input')) {
        this.dirty = true;
        this.syncPadListening();
      }
    });
    window.addEventListener('blur', () => this.clearKeys());
    this.syncPadListening();
  }

  get settings(): InputSettings {
    return this.app.prefs.value.input;
  }

  /** Merge a patch into the saved input settings. */
  update_settings(patch: Partial<InputSettings>): void {
    this.app.prefs.set({ input: sanitizeInput({ ...this.settings, ...patch }) });
  }

  get profile(): VehicleProfile {
    return profileById(this.settings.profile);
  }

  private syncPadListening(): void {
    if (this.settings.gamepad) this.pad.start();
    else this.pad.stop();
  }

  // ---- keyboard --------------------------------------------------------------------------------

  keyDown(e: KeyboardEvent, forwardToSim: boolean): void {
    this.down.add(e.code);
    this.down.add(e.key.toLowerCase());
    if (forwardToSim) this.physical.add(e.code);
  }

  keyUp(e: KeyboardEvent): void {
    this.down.delete(e.code);
    this.down.delete(e.key.toLowerCase());
    this.physical.delete(e.code);
  }

  // -- CP: keys held with the mouse by the Controls panel's key caps count as pressed on the keyboard, so the per-frame
  // rebuild of `sim.keys` below does not wipe them (and keys bound to ramped axes still ramp) --
  holdKey(code: string): void {
    this.physical.add(code);
  }

  releaseKey(code: string): void {
    this.physical.delete(code);
  }

  clearKeys(): void {
    this.down.clear();
    this.physical.clear();
    this.owned.clear();
    this.app.sim.keys.clear();
  }

  /** Is a held camera action (see `inputMap.registerAction`) down? */
  held(actionId: string): boolean {
    return inputMap.isHeld(actionId, this.down);
  }

  // ---- axes ------------------------------------------------------------------------------------

  private cfgFor(axis: string): AxisCfg {
    const s = this.settings;
    const p = this.profile;
    const own = <T>(o: Record<string, T> | undefined): T | undefined =>
      o && Object.hasOwn(o, axis) ? o[axis] : undefined;
    const user = Object.hasOwn(s.axisTuning, p.id) ? s.axisTuning[p.id] : undefined;
    return { ...DEFAULT_AXIS, ...own(p.tuning), ...own(user) };
  }

  /** Tuning currently in force for an axis (profile defaults + the user's edits). */
  axisConfig(axis: string): AxisCfg {
    return this.cfgFor(axis);
  }

  /** Axis names the scene's motors read, and the keys that ramp them. */
  private rescan(): void {
    this.dirty = false;
    this.axisKeys.clear();
    this.axisNames.clear();
    for (const name of Object.keys(this.profile.pad)) this.axisNames.add(name);
    for (const e of this.app.store.all()) {
      if (!isJoint(e)) continue;
      const m = e.motor;
      if (!m.axis || m.mode === 'off') continue;
      this.axisNames.add(m.axis);
      for (const [code, sign] of [
        [m.keyPos, 1],
        [m.keyNeg, -1],
      ] as const) {
        if (!code) continue;
        const l = this.axisKeys.get(code);
        if (l) l.push({ axis: m.axis, sign });
        else this.axisKeys.set(code, [{ axis: m.axis, sign }]);
      }
    }
    for (const a of sceneControls(this.app.store.all()).axes) this.axisNames.add(a.name);
    for (const n of this.axes.keys()) if (!this.axisNames.has(n)) this.axes.delete(n);
  }

  private sourceValue(src: PadSource, pad: PadState): number {
    if ('stick' in src) return pad[src.stick] * (src.invert ? -1 : 1);
    const v = (i: PadButton | 'LX' | 'LY' | 'RX' | 'RY' | undefined): number => {
      if (!i) return 0;
      if (i === 'LT' || i === 'RT') return pad[i];
      if (i === 'LX' || i === 'LY' || i === 'RX' || i === 'RY') return Math.max(0, pad[i]);
      return pad.buttons[i] ? 1 : 0;
    };
    return v(src.pos) - v(src.neg);
  }

  // ---- frame -----------------------------------------------------------------------------------

  update(dt: number): void {
    const app = this.app;
    const s = this.settings;
    if (this.dirty) this.rescan();

    // Real pad + touch pad → combined
    const real = s.gamepad && this.pad.poll() ? this.pad.state : null;
    const c = this.combined;
    c.LX = clamp((real?.LX ?? 0) + this.touch.LX, -1, 1);
    c.LY = clamp((real?.LY ?? 0) + this.touch.LY, -1, 1);
    c.RX = clamp((real?.RX ?? 0) + this.touch.RX, -1, 1);
    c.RY = clamp((real?.RY ?? 0) + this.touch.RY, -1, 1);
    c.LT = clamp((real?.LT ?? 0) + this.touch.LT, 0, 1);
    c.RT = clamp((real?.RT ?? 0) + this.touch.RT, 0, 1);
    for (const b of PAD_BUTTONS) c.buttons[b] = !!(real?.buttons[b] || this.touch.buttons[b]);

    // Button edges: rebinding capture, commands
    for (const b of PAD_BUTTONS) {
      const now = c.buttons[b];
      if (now && !this.prevPad[b]) {
        if (this.captureCbs.size) for (const cb of [...this.captureCbs]) cb(padKeyCode(b));
        else {
          const cmd = PAD_TO_COMMAND[b];
          if (cmd) runCommand(cmd, app, 'api');
        }
      }
      this.prevPad[b] = now;
    }

    // Simulation key set. Other parts of the app (the Controls panel's key caps) add keys to the same set, so only
    // the keys this hub put there are ever removed.
    const keys = app.sim.keys;
    const wanted = this.wanted;
    wanted.clear();
    const ramp = s.keyboardRamp;
    for (const code of this.physical) {
      if (ramp && this.axisKeys.has(code)) continue;
      wanted.add(code);
    }
    for (const b of PAD_BUTTONS) {
      if (!c.buttons[b]) continue;
      wanted.add(padKeyCode(b));
      const mapped = PAD_TO_KEY[b];
      if (mapped) wanted.add(mapped);
    }
    for (const k of this.owned) if (!wanted.has(k)) keys.delete(k);
    for (const k of wanted) keys.add(k);
    // swap: this frame's set is the owned one, the old one is next frame's scratch set
    this.wanted = this.owned;
    this.owned = wanted;

    // Analog axes
    const client = app.sim.client;
    if (!client.active || !app.sim.active) {
      if (this.lastAxisSent.size) {
        for (const n of this.lastAxisSent.keys()) client.setAxis(n, 0);
        this.lastAxisSent.clear();
        for (const st of this.axes.values()) {
          st.key = 0;
          st.analog = 0;
        }
      }
      return;
    }
    this.axisDirs.clear();
    if (ramp)
      for (const code of this.physical) {
        for (const ak of this.axisKeys.get(code) ?? [])
          this.axisDirs.set(ak.axis, (this.axisDirs.get(ak.axis) ?? 0) + ak.sign);
      }
    const padPresent = !!real || this.touchActive;
    for (const name of this.axisNames) {
      let st = this.axes.get(name);
      if (!st) this.axes.set(name, (st = new AxisState()));
      const cfg = this.cfgFor(name);
      st.stepKey(clamp(this.axisDirs.get(name) ?? 0, -1, 1), dt, cfg);
      let raw = 0;
      if (padPresent)
        for (const src of Object.hasOwn(this.profile.pad, name) ? this.profile.pad[name] : [])
          raw += this.sourceValue(src, c);
      st.stepAnalog(shapeAnalog(clamp(raw, -1, 1), cfg), dt, cfg);
      const v = st.value;
      if ((this.lastAxisSent.get(name) ?? 0) !== v) {
        client.setAxis(name, v);
        if (v === 0) this.lastAxisSent.delete(name);
        else this.lastAxisSent.set(name, v);
      }
    }
  }

  /** Current processed value of an analog axis (0 when nothing drives it). */
  axisValue(name: string): number {
    return this.axes.get(name)?.value ?? 0;
  }

  /** Display name of a pad button for the connected controller (for hints). */
  padLabel(b: PadButton): string {
    return padLabel(b, this.pad.family);
  }
}
