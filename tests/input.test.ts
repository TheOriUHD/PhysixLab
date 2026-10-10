/**
 * CM-A input pipeline without a DOM: analog processing, gamepad reading, the InputMap (rebinding, conflicts,
 * presets, files), the keymap seeing rebinds, and analog axes reaching a real motor in the real engine.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle } from '../src/core/math';
import { registerAppBuiltins } from '../src/app/builtin';
import { AxisState, DEFAULT_AXIS, shapeAnalog } from '../src/app/input/axes';
import { padButtonOfKeyCode, padFamily, padKeyCode, padLabel, readPad } from '../src/app/input/gamepad';
import { InputMap } from '../src/app/input/inputMap';
import { duplicateChords, presetById } from '../src/app/input/presets';
import { PROFILES, profileById } from '../src/app/input/profiles';
import { DEFAULT_INPUT, sanitizeInput } from '../src/app/input/settings';
import { keymap } from '../src/app/registry/keymap';
import { getCommand, primaryShortcut } from '../src/app/registry/commands';
import { createBody, createJoint, run, worldOf } from './helpers';

const key = (k: string, code = k, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('analog axis processing', () => {
  it('applies the dead zone without a jump at its edge, then the curve and sensitivity', () => {
    const cfg = { ...DEFAULT_AXIS, deadzone: 0.2, expo: 2, sensitivity: 1 };
    expect(shapeAnalog(0.19, cfg)).toBe(0);
    expect(shapeAnalog(0.2001, cfg)).toBeLessThan(0.001);
    // halfway through the live range with a quadratic curve = 0.25
    expect(shapeAnalog(0.2 + 0.8 * 0.5, cfg)).toBeCloseTo(0.25, 6);
    expect(shapeAnalog(-1, cfg)).toBeCloseTo(-1, 6);
    expect(shapeAnalog(1, { ...cfg, invert: true })).toBeCloseTo(-1, 6);
    expect(shapeAnalog(1, { ...cfg, sensitivity: 3 })).toBe(1); // clamped
  });

  it('ramps keys up in `rise` seconds and back to centre in `fall` seconds', () => {
    const cfg = { ...DEFAULT_AXIS, rise: 0.5, fall: 0.25 };
    const a = new AxisState();
    for (let i = 0; i < 25; i++) a.stepKey(1, 0.01, cfg); // 0.25 s
    expect(a.key).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 25; i++) a.stepKey(1, 0.01, cfg);
    expect(a.key).toBe(1);
    for (let i = 0; i < 12; i++) a.stepKey(0, 0.01, cfg);
    expect(a.key).toBeCloseTo(1 - 0.12 / 0.25, 6);
    for (let i = 0; i < 100; i++) a.stepKey(0, 0.01, cfg);
    expect(a.key).toBe(0);
  });

  it('reversing crosses zero twice as fast, and without auto-centre the value stays', () => {
    const cfg = { ...DEFAULT_AXIS, rise: 1, autoCentre: false };
    const a = new AxisState();
    for (let i = 0; i < 100; i++) a.stepKey(1, 0.01, cfg);
    expect(a.key).toBeCloseTo(1, 6);
    for (let i = 0; i < 50; i++) a.stepKey(-1, 0.01, cfg);
    expect(a.key).toBeCloseTo(0, 6);
    a.stepKey(0, 1, cfg);
    expect(a.key).toBeCloseTo(0, 6);
    for (let i = 0; i < 30; i++) a.stepKey(1, 0.01, cfg);
    a.stepKey(0, 5, cfg);
    expect(a.key).toBeCloseTo(0.3, 1); // first step may count as a reversal (float noise at 0)
  });

  it('smooths an analog step with the time constant', () => {
    const cfg = { ...DEFAULT_AXIS, smoothing: 0.1 };
    const a = new AxisState();
    for (let i = 0; i < 100; i++) a.stepAnalog(1, 0.001, cfg); // one time constant
    expect(a.analog).toBeCloseTo(1 - Math.exp(-1), 2);
    a.stepAnalog(1, 10, cfg);
    expect(a.analog).toBeCloseTo(1, 3);
  });
});

describe('gamepad reading', () => {
  const buttons = (pressed: number[], values: Record<number, number> = {}) =>
    Array.from({ length: 17 }, (_, i) => ({
      pressed: pressed.includes(i),
      value: values[i] ?? (pressed.includes(i) ? 1 : 0),
    }));

  it('reads the standard mapping: sticks (Y up is positive), triggers, buttons', () => {
    const s = readPad({
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
      mapping: 'standard',
      axes: [0.5, -1, -0.25, 0.75],
      buttons: buttons([0, 12], { 7: 0.6, 6: 0.1 }),
    });
    expect(s.LX).toBe(0.5);
    expect(s.LY).toBe(1);
    expect(s.RX).toBe(-0.25);
    expect(s.RY).toBe(-0.75);
    expect(s.RT).toBeCloseTo(0.6);
    expect(s.buttons.RT).toBe(true);
    expect(s.buttons.LT).toBe(false);
    expect(s.buttons.South).toBe(true);
    expect(s.buttons.DUp).toBe(true);
    expect(s.buttons.East).toBe(false);
  });

  it('falls back to axes 4 / 5 as triggers on a generic device and survives missing data', () => {
    const s = readPad({ id: 'USB Gamepad', mapping: '', axes: [0, 0, 0, 0, 1, -1], buttons: buttons([]).slice(0, 4) });
    expect(s.LT).toBe(1);
    expect(s.RT).toBe(0);
    const bad = readPad({ id: 'x', mapping: '', axes: [NaN, 5], buttons: [] });
    expect(bad.LX).toBe(0);
    expect(bad.LY).toBe(-1);
  });

  it('names buttons by controller family and round-trips pad key codes', () => {
    expect(padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe(
      'playstation',
    );
    expect(padFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(padFamily('Some Pad')).toBe('generic');
    expect(padLabel('South', 'playstation')).toBe('Cross');
    expect(padLabel('South', 'xbox')).toBe('A');
    expect(padButtonOfKeyCode(padKeyCode('RT'))).toBe('RT');
    expect(padButtonOfKeyCode('KeyW')).toBeNull();
  });
});

describe('vehicle profiles and settings', () => {
  it('defines the four vehicle kinds with distinct axis sets', () => {
    expect(PROFILES.map((p) => p.id)).toEqual(expect.arrayContaining(['car', 'plane', 'tank', 'crane']));
    expect(Object.keys(profileById('tank').pad)).toEqual(expect.arrayContaining(['left', 'right']));
    expect(Object.keys(profileById('crane').pad)).toEqual(expect.arrayContaining(['slew', 'lift']));
    expect(profileById('nope').id).toBe('car');
  });

  it('sanitises stored settings', () => {
    expect(sanitizeInput(null)).toEqual(DEFAULT_INPUT);
    const s = sanitizeInput({
      bindings: { a: ['Q'], b: 'bad', c: [1] },
      profile: 5,
      axisTuning: { car: { steer: { expo: 2, junk: 1, invert: true, deadzone: 'x' } } },
      touchControls: 'maybe',
      gamepad: false,
    });
    expect(s.bindings).toEqual({ a: ['Q'] });
    expect(s.profile).toBe('car');
    expect(s.axisTuning.car.steer).toEqual({ expo: 2, invert: true });
    expect(s.touchControls).toBe('auto');
    expect(s.gamepad).toBe(false);
  });
});

describe('InputMap', () => {
  beforeAll(() => registerAppBuiltins());
  let map: InputMap | null = null;
  const fresh = () => (map = new InputMap());
  afterEach(() => map?.resetAll());

  it('lists every command with its binding and flags rebinding as custom', () => {
    const m = fresh();
    const row = m.rows().find((r) => r.id === 'sim.toggle')!;
    expect(row.shortcuts).toEqual(['Space']);
    expect(row.custom).toBe(false);
    m.rebind('sim.toggle', 0, 'F9');
    const after = m.rows().find((r) => r.id === 'sim.toggle')!;
    expect(after.shortcuts).toEqual(['F9']);
    expect(after.custom).toBe(true);
    expect(m.preset).toBe('custom');
  });

  it('a rebinding changes what the keymap, the tooltips and the help see; reset restores it', () => {
    const m = fresh();
    expect(keymap.find(key(' ', 'Space'))?.id).toBe('sim.toggle');
    m.rebind('sim.toggle', 0, 'F9');
    expect(keymap.find(key(' ', 'Space'))).toBeUndefined();
    expect(keymap.find(key('F9', 'F9'))?.id).toBe('sim.toggle');
    expect(primaryShortcut(getCommand('sim.toggle')!)).toBe('F9');
    m.reset('sim.toggle');
    expect(keymap.find(key(' ', 'Space'))?.id).toBe('sim.toggle');
  });

  it('detects conflicts, refuses them, and can take the key over', () => {
    const m = fresh();
    const res = m.rebind('sim.toggle', 0, 'Mod+Z');
    expect(res.ok).toBe(false);
    expect(res.conflict?.id).toBe('edit.undo');
    expect(m.shortcuts('sim.toggle')).toEqual(['Space']);
    const stolen = m.rebind('sim.toggle', 0, 'Mod+Z', true);
    expect(stolen.ok).toBe(true);
    expect(m.shortcuts('edit.undo')).toEqual([]);
    expect(keymap.find(key('z', 'KeyZ', { ctrlKey: true }))?.id).toBe('sim.toggle');
    m.resetAll();
    expect(m.shortcuts('edit.undo')).toEqual(['Mod+Z']);
  });

  it('keeps held-action scopes apart from global bindings', () => {
    const m = fresh();
    m.registerAction({ id: 'test.fly.fwd', label: 'Fly forward', category: 'Camera', shortcuts: ['W'], scope: 'fly' });
    // W is the Move tool globally; inside the fly scope it is free to use
    expect(m.findConflict('W', 'test.fly.fwd')).toBeNull();
    m.registerAction({ id: 'test.fly.back', label: 'Fly back', category: 'Camera', shortcuts: ['S'], scope: 'fly' });
    expect(m.findConflict('W', 'test.fly.back')?.id).toBe('test.fly.fwd');
    expect(m.isHeld('test.fly.fwd', new Set(['w']))).toBe(true);
    expect(m.isHeld('test.fly.fwd', new Set(['s']))).toBe(false);
    expect(m.ownsKey(key('w', 'KeyW'), 'fly')).toBe(true);
    expect(m.ownsKey(key('q', 'KeyQ'), 'fly')).toBe(false);
    // A real KeyboardEvent exposes key / code as prototype getters, not own properties.
    class FakeEvent {
      get key() {
        return 'w';
      }
      get code() {
        return 'KeyW';
      }
      ctrlKey = false;
      metaKey = false;
      shiftKey = false;
    }
    expect(m.ownsKey(new FakeEvent(), 'fly')).toBe(true);
  });

  it('exports, validates and imports bindings', () => {
    const m = fresh();
    m.rebind('sim.toggle', 0, 'F9');
    const file = m.exportJson();
    m.resetAll();
    expect(m.shortcuts('sim.toggle')).toEqual(['Space']);
    const r = m.importJson(file);
    expect(r.applied).toBe(1);
    expect(m.shortcuts('sim.toggle')).toEqual(['F9']);
    expect(() => m.importJson('{nope')).toThrow(/valid JSON/);
    expect(() => m.importJson('{"format":"other"}')).toThrow(/key-bindings file/);
    const partly = JSON.stringify({
      format: 'physicslab-keybindings',
      version: 1,
      bindings: { 'does.not.exist': ['Q'], 'sim.toggle': ['Esc'], 'sim.reset': ['F10'] },
    });
    expect(m.importJson(partly)).toEqual({ applied: 1, skipped: 2 });
    expect(m.shortcuts('sim.reset')).toEqual(['F10']);
  });

  it('presets produce collision-free layouts', () => {
    const m = fresh();
    m.registerAction({
      id: 'camera.fly.forward',
      label: 'Fly forward',
      category: 'Camera',
      shortcuts: ['W'],
      scope: 'fly',
    });
    m.registerAction({ id: 'camera.fly.left', label: 'Fly left', category: 'Camera', shortcuts: ['A'], scope: 'fly' });
    for (const id of ['left-handed', 'one-handed', 'wasd-free']) {
      const preset = presetById(id)!;
      const built = preset.build(m.rows());
      expect(Object.keys(built).length, id).toBeGreaterThan(0);
      expect(duplicateChords(m.rows(), built), id).toEqual([]);
    }
    const lh = presetById('left-handed')!.build(m.rows());
    expect(lh['tool.move']).toEqual(['O']);
    m.applyPreset(presetById('wasd-free')!);
    expect(m.shortcuts('camera.fly.forward')).toEqual(['ArrowUp']);
    expect(m.preset).toBe('wasd-free');
    const noWasd = m
      .rows()
      .filter((r) => r.scope !== 'fly')
      .flatMap((r) => r.shortcuts);
    expect(noWasd.some((s) => /^(w|a|s|d)$/i.test(s))).toBe(false);
  });

  it('one-handed moves the right-hand keys to free keys', () => {
    const m = fresh();
    m.applyPreset(presetById('one-handed')!);
    const all = m.rows().flatMap((r) => r.shortcuts);
    expect(all).not.toContain('Delete');
    expect(all).not.toContain('H');
    expect(m.shortcuts('edit.delete').length).toBeGreaterThan(0);
  });
});

describe('analog axes drive motors in the engine', () => {
  const motorScene = async (axis: string, keyPos = '') => {
    const wheel = createBody({
      shape: { type: 'cylinder', size: [1, 0.2, 1] },
      position: [0, 3, 0],
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
      linearDamping: 0,
      angularDamping: 0,
    });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: null,
      bodyB: wheel.id,
      anchorA: [0, 3, 0],
      axis: [0, 0, 1],
      motor: {
        mode: 'velocity',
        targetVelocity: 8,
        targetPosition: 0,
        stiffness: 0,
        damping: 100,
        maxForce: 5000,
        keyPos,
        keyNeg: '',
        axis,
        slewRate: 1,
        brake: true,
      },
    });
    return { w: await worldOf([wheel, hinge]), id: hinge.id };
  };

  it('scales the motor speed with the axis value, both directions, and ignores other axes', async () => {
    const { w, id } = await motorScene('drive');
    w.setAxes({ drive: 0.5 });
    run(w, 1.5);
    expect(w.getJointRec(id)!.speed).toBeGreaterThan(3.7);
    expect(w.getJointRec(id)!.speed).toBeLessThan(4.3);
    w.setAxes({ drive: -1 });
    run(w, 2);
    expect(w.getJointRec(id)!.speed).toBeLessThan(-7.5);
    w.setAxes({ steer: 1 });
    run(w, 2);
    expect(Math.abs(w.getJointRec(id)!.speed)).toBeLessThan(0.2);
  });

  it('adds to a held key and clamps at full input', async () => {
    const { w, id } = await motorScene('drive', 'KeyW');
    w.setKeys(['KeyW']);
    w.setAxes({ drive: 1 });
    run(w, 1.5);
    expect(w.getJointRec(id)!.speed).toBeLessThan(8.5); // 1 + 1 clamps to 1, never 2×
    expect(w.getJointRec(id)!.speed).toBeGreaterThan(7.4);
  });
});

describe('gamepad hot-plugging', () => {
  it('announces a controller when it connects, reads it, and clears the state when it leaves', async () => {
    const { GamepadPoller } = await import('../src/app/input/gamepad');
    const g = globalThis as unknown as Record<string, unknown>;
    const had = { window: g.window, navigator: g.navigator };
    const win = new EventTarget();
    const pad = {
      id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
      index: 2,
      connected: true,
      mapping: 'standard',
      axes: [0.5, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, value: i === 0 ? 1 : 0 })),
    };
    let present: typeof pad | null = null;
    g.window = win;
    Object.defineProperty(globalThis, 'navigator', {
      value: { getGamepads: () => [null, null, present, null] },
      configurable: true,
    });
    try {
      const log: string[] = [];
      const poller = new GamepadPoller({
        onConnect: (id, family) => log.push(`+${family}:${id.slice(0, 10)}`),
        onDisconnect: (id) => log.push(`-${id.slice(0, 10)}`),
      });
      poller.start();
      expect(poller.poll()).toBe(false); // nothing plugged in
      present = pad;
      win.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
      expect(log).toEqual(['+playstation:Wireless C']);
      expect(poller.connected).toBe(true);
      expect(poller.poll()).toBe(true);
      expect(poller.state.LX).toBe(0.5);
      expect(poller.state.buttons.South).toBe(true);
      expect(poller.family).toBe('playstation');
      present = null;
      win.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: pad }));
      expect(log[1]).toBe('-Wireless C');
      expect(poller.connected).toBe(false);
      expect(poller.state.LX).toBe(0);
      expect(poller.state.buttons.South).toBe(false);
      poller.stop();
      win.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
      expect(log).toHaveLength(2); // stopped: no more events
    } finally {
      g.window = had.window;
      Object.defineProperty(globalThis, 'navigator', { value: had.navigator, configurable: true });
    }
  });
});
