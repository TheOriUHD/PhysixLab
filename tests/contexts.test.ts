import { beforeAll, describe, expect, it } from 'vitest';
import {
  GRAB_CODES,
  GRAB_KEYS,
  INPUT_CONTEXTS,
  assignDriveKeys,
  claims,
  emptyKeyState,
  legendFor,
  ownerOf,
  resolveContext,
  shadowed,
  type InputContext,
  type KeyInfo,
  type KeyState,
} from '../src/app/input/contexts';
import { listCommands, shortcutsOf } from '../src/app/registry/commands';
import { keymap } from '../src/app/registry/keymap';
import { parseShortcut } from '../src/app/registry/shortcuts';
import { registerBuiltins } from '../src/ui/builtin';
import { buildCar } from '../src/model/templates';
import { buildPowertrainCar } from '../src/model/content/powered-car';
import { Builder } from '../src/model/builder';
import { sceneControls } from '../src/model/controls';
import { describeKey } from '../src/app/drive/vehicle';
import { isJoint } from '../src/model/types';

const CODES: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Home', 'End',
  'PageUp', 'PageDown', 'Equal', 'Minus', 'BracketLeft', 'BracketRight', 'Period', 'Comma', 'ShiftLeft', 'ShiftRight',
  'Numpad1', 'Numpad3', 'Numpad5', 'Numpad7', 'Numpad9', 'NumpadAdd', 'NumpadSubtract', 'F1', 'F5',
];

const keyOf = (code: string): string => {
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  const d = /^Digit(\d)$/.exec(code);
  return d ? d[1] : code;
};
const info = (code: string, mods: Partial<KeyInfo> = {}): KeyInfo => ({
  code,
  key: keyOf(code),
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  ...mods,
});

/** A key state wired to the real command registry, with the given scene bindings. */
function stateWith(over: Partial<KeyState> & { sceneKeys?: Set<string> }): KeyState {
  const st = emptyKeyState();
  return {
    ...st,
    hasCommand: (k) => !!keymap.find({ key: k.key ?? keyOf(k.code), code: k.code, ctrlKey: k.ctrl, metaKey: k.meta, shiftKey: k.shift }),
    commandLabel: (k) =>
      keymap.find({ key: k.key ?? keyOf(k.code), code: k.code, ctrlKey: k.ctrl, metaKey: k.meta, shiftKey: k.shift })?.label,
    isPaletteKey: (k) => (k.ctrl || k.meta) && k.code === 'KeyK',
    ...over,
  };
}

beforeAll(async () => {
  registerBuiltins();
  const files = import.meta.glob(['../src/ui/extensions/*.ts', '!../src/ui/extensions/*.test.ts', '!../src/ui/extensions/plugins.ts']);
  for (const load of Object.values(files)) await load();
});

describe('which context is active', () => {
  const base = { immersive: 'none' as const, placing: false, grabbing: false, flyCamera: false, simActive: false };
  it('resolves by priority: drive, play, placing, grab, fly, simulating, edit', () => {
    expect(resolveContext(base)).toBe('edit');
    expect(resolveContext({ ...base, simActive: true })).toBe('simulating');
    expect(resolveContext({ ...base, simActive: true, flyCamera: true })).toBe('fly');
    expect(resolveContext({ ...base, simActive: true, flyCamera: true, grabbing: true })).toBe('grab');
    expect(resolveContext({ ...base, placing: true, grabbing: true })).toBe('placing');
    expect(resolveContext({ ...base, immersive: 'play', placing: true })).toBe('play');
    expect(resolveContext({ ...base, immersive: 'drive', simActive: true, grabbing: true })).toBe('drive');
  });
});

describe('exactly one owner for every key in every context', () => {
  const car = new Builder('c');
  car.doc = buildCar(true);
  const carKeys = new Set(sceneControls(car.doc.entities).keys.map((k) => k.code));
  const pt = new Builder('p');
  buildPowertrainCar(pt);
  const ptKeys = new Set(sceneControls(pt.doc.entities).keys.map((k) => k.code));
  const scenes: [string, Set<string>][] = [
    ['no scene keys', new Set()],
    ['the Drivable car (W S A D)', carKeys],
    ['the powertrain car (W S A D Q E R C L P)', ptKeys],
    ['every letter and arrow', new Set(CODES)],
  ];

  it('the scenes used here really bind the keys they are named for', () => {
    expect([...carKeys].sort()).toEqual(['KeyA', 'KeyD', 'KeyS', 'KeyW']);
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyC', 'KeyL', 'KeyP']) expect(ptKeys.has(k)).toBe(true);
  });

  it('claims() has no duplicates and ownerOf() is the first claim, for every context × key × scene', () => {
    for (const ctx of INPUT_CONTEXTS)
      for (const [name, sceneKeys] of scenes)
        for (const sim of [false, true])
          for (const grabbing of [false, true]) {
            const st = stateWith({
              simActive: sim,
              grabbing,
              sceneKeys,
              flyKeys: new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft']),
              vehicleKeys: sceneKeys,
              driveUtil: assignDriveKeys(sceneKeys),
              nudgeOwnsArrows: !sim,
            });
            for (const code of CODES)
              for (const mods of [{}, { shift: true }, { alt: true }, { ctrl: true }]) {
                const k = info(code, mods);
                const c = claims(ctx, k, st);
                expect(new Set(c).size, `${ctx}/${name}/${code}`).toBe(c.length);
                const owner = ownerOf(ctx, k, st);
                expect(owner, `${ctx}/${name}/${code}`).toBe(c.length ? c[0] : ctx === 'drive' || ctx === 'play' ? 'blocked' : 'none');
                expect(shadowed(ctx, k, st)).toEqual(c.slice(1));
              }
          }
  });

  it('the fixed key tables never give one code to two actions', () => {
    const all = Object.values(GRAB_KEYS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...GRAB_CODES].sort()).toEqual([...all].sort());
    for (const sceneKeys of [new Set<string>(), carKeys, ptKeys, new Set(CODES)]) {
      const util = assignDriveKeys(sceneKeys);
      const seen = new Set<string>();
      for (const [code, action] of util) {
        expect(seen.has(code)).toBe(false);
        seen.add(code);
        if (action !== 'exit') expect(sceneKeys.has(code), `${action} must not take a vehicle key`).toBe(false);
      }
      const actions = new Set(util.values());
      expect(actions.has('exit')).toBe(true);
      expect([...util.entries()].some(([c, a]) => a === 'exit' && c === 'Escape')).toBe(true);
      expect([...util.entries()].some(([c, a]) => a === 'exit' && c === 'Tab')).toBe(true);
    }
  });

  it('drive utility keys step aside for the powertrain car (R is reverse, P the parking brake, C the clutch)', () => {
    const util = assignDriveKeys(ptKeys);
    const keyOfAction = (a: string) => [...util.entries()].find(([, v]) => v === a)?.[0];
    expect(keyOfAction('reset')).toBe('Backspace');
    expect(keyOfAction('pause')).toBe('Enter');
    expect(keyOfAction('camera')).toBe('KeyX');
    const plain = assignDriveKeys(carKeys);
    expect([...plain.entries()].find(([, v]) => v === 'reset')?.[0]).toBe('KeyR');
    expect([...plain.entries()].find(([, v]) => v === 'camera')?.[0]).toBe('KeyC');
    expect([...plain.entries()].find(([, v]) => v === 'lookBehind')?.[0]).toBe('KeyB');
  });
});

describe('who owns Q, W, E, R in each context (the "Q and E don\'t work" audit)', () => {
  const car = buildCar(true);
  const carKeys = new Set(sceneControls(car.entities).keys.map((k) => k.code));
  const pt = new Builder('p');
  buildPowertrainCar(pt);
  const ptKeys = new Set(sceneControls(pt.doc.entities).keys.map((k) => k.code));

  it('edit: the editor owns the gizmo keys', () => {
    const st = stateWith({});
    for (const c of ['KeyQ', 'KeyW', 'KeyE', 'KeyR']) expect(ownerOf('edit', info(c), st)).toBe('command');
  });

  it('simulating: the powertrain car owns Q, W, E, R — the gizmo keys step aside and the legend says so', () => {
    const st = stateWith({ simActive: true, sceneKeys: ptKeys, sceneLabels: new Map([...ptKeys].map((k) => [k, 'a control'])) });
    for (const c of ['KeyQ', 'KeyW', 'KeyE', 'KeyR']) {
      expect(ownerOf('simulating', info(c), st)).toBe('sim');
      expect(shadowed('simulating', info(c), st)).toContain('command');
    }
    const editor = legendFor('simulating', st, { os: 'windows', device: 'mouse' }).find((s) => s.id === 'editor')!;
    for (const code of ['KeyQ', 'KeyW', 'KeyE', 'KeyR']) {
      const e = editor.entries.find((x) => x.id === `tool.${code}`)!;
      expect(e.unavailable, code).toMatch(/the scene uses/);
    }
  });

  it('simulating the Drivable car: W / A / S / D are the car’s, Q / E still switch tools', () => {
    const st = stateWith({ simActive: true, sceneKeys: carKeys });
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) expect(ownerOf('simulating', info(c), st)).toBe('sim');
    for (const c of ['KeyQ', 'KeyE']) expect(ownerOf('simulating', info(c), st)).toBe('command');
    const editor = legendFor('simulating', st, { os: 'mac', device: 'trackpad' }).find((s) => s.id === 'editor')!;
    expect(editor.entries.find((x) => x.id === 'tool.KeyQ')!.unavailable).toBeUndefined();
    expect(editor.entries.find((x) => x.id === 'tool.KeyW')!.unavailable).toBeDefined();
  });

  it('grab: Q E A D turn the held body, W S push and pull, F freezes — whatever the scene binds', () => {
    const st = stateWith({ simActive: true, grabbing: true, sceneKeys: ptKeys });
    for (const c of ['KeyQ', 'KeyE', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyF', 'ArrowUp', 'ArrowDown', 'BracketLeft', 'BracketRight'])
      expect(ownerOf('grab', info(c), st), c).toBe('grab');
    // shift is a modifier of the step size, still the grab's key
    expect(ownerOf('grab', info('KeyE', { shift: true }), st)).toBe('grab');
    // but Ctrl+Z is the editor's
    expect(ownerOf('grab', info('KeyZ', { ctrl: true }), st)).toBe('command');
    const legend = legendFor('grab', st, { os: 'linux', device: 'mouse' });
    expect(legend.find((s) => s.id === 'grab.paused')!.entries.length).toBeGreaterThan(0);
  });

  it('fly: the camera owns W A S D Q E over the scene', () => {
    const flyKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
    const st = stateWith({ simActive: true, sceneKeys: ptKeys, flyKeys });
    for (const c of flyKeys) {
      expect(ownerOf('fly', info(c), st)).toBe('camera.fly');
      expect(shadowed('fly', info(c), st)).toContain('sim');
    }
    expect(ownerOf('fly', info('KeyR'), st)).toBe('sim');
  });

  it('drive: only the vehicle’s keys, the utility keys and the palette work; everything else is locked', () => {
    const util = assignDriveKeys(carKeys);
    const st = stateWith({ simActive: true, sceneKeys: carKeys, vehicleKeys: carKeys, driveUtil: util });
    for (const c of carKeys) expect(ownerOf('drive', info(c), st)).toBe('sim');
    expect(ownerOf('drive', info('Escape'), st)).toBe('drive');
    expect(ownerOf('drive', info('Tab'), st)).toBe('drive');
    expect(ownerOf('drive', info('KeyR'), st)).toBe('drive');
    expect(ownerOf('drive', info('KeyK', { ctrl: true }), st)).toBe('command');
    for (const c of ['KeyQ', 'KeyE', 'KeyG', 'KeyJ', 'KeyF', 'Delete', 'Home', 'Space'])
      expect(ownerOf('drive', info(c), st), c).toBe('blocked');
    expect(ownerOf('drive', info('KeyZ', { ctrl: true }), st)).toBe('blocked');
  });

  it('play: the camera and the grab own their keys, Esc / Tab leave, the rest is locked', () => {
    const flyKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
    const st = stateWith({ simActive: true, flyKeys, sceneKeys: new Set(['KeyR']) });
    expect(ownerOf('play', info('KeyW'), st)).toBe('camera.fly');
    expect(ownerOf('play', info('Escape'), st)).toBe('play');
    expect(ownerOf('play', info('KeyR'), st)).toBe('sim');
    expect(ownerOf('play', info('KeyG'), st)).toBe('blocked');
    expect(ownerOf('play', info('KeyW'), { ...st, grabbing: true })).toBe('grab');
  });

  it('placing: the ghost gets its keys first', () => {
    const st = stateWith({ placementKeys: new Set(['KeyR']) });
    expect(ownerOf('placing', info('KeyR'), st)).toBe('placement');
    expect(ownerOf('placing', info('KeyW'), st)).toBe('command');
  });

  it('edit: arrows belong to the nudge with a selection, to the camera without one; Alt always navigates', () => {
    expect(ownerOf('edit', info('ArrowLeft'), stateWith({ nudgeOwnsArrows: true }))).toBe('command');
    expect(ownerOf('edit', info('ArrowLeft'), stateWith({ nudgeOwnsArrows: false }))).toBe('nav');
    expect(ownerOf('edit', info('ArrowLeft', { alt: true }), stateWith({ nudgeOwnsArrows: true }))).toBe('nav');
    expect(ownerOf('edit', info('Digit7', { alt: true }), stateWith({}))).toBe('nav');
    expect(ownerOf('edit', info('Digit7'), stateWith({}))).toBe('command'); // plain digits add shapes
    expect(ownerOf('edit', info('Equal'), stateWith({ navKeys: false }))).toBe('none');
  });
});

describe('every registered shortcut has an owner in every context', () => {
  it('no command shortcut is unreachable or double-booked: the keymap, the contexts and Drive agree', () => {
    const st = stateWith({});
    let n = 0;
    for (const def of listCommands())
      for (const s of shortcutsOf(def)) {
        const c = parseShortcut(s);
        if (c.by !== 'key' || c.mod) continue;
        n++;
        const code = /^[a-z]$/.test(c.key) ? `Key${c.key.toUpperCase()}` : /^\d$/.test(c.key) ? `Digit${c.key}` : c.key;
        const k = info(code, { shift: c.shift === true });
        // edit: a command owns it unless the camera navigation takes it first (arrows, + / -)
        expect(['command', 'nav'], `${def.id} ${s}`).toContain(ownerOf('edit', k, st));
        // the immersive modes lock it
        expect(ownerOf('drive', k, st)).toMatch(/blocked|drive/);
      }
    expect(n).toBeGreaterThan(20);
    // V (Drive) and Shift+V (Play) exist and do not clash with anything
    expect(listCommands().find((d) => d.id === 'drive.toggle')).toBeDefined();
    expect(listCommands().find((d) => d.id === 'play.toggle')).toBeDefined();
  });
});

describe('the controls legend', () => {
  it('lists the scene’s controls with friendly names in the simulating context', () => {
    const car = buildCar(true);
    const joints = new Map(car.entities.filter(isJoint).map((j) => [j.id, j]));
    const labels = new Map(sceneControls(car.entities).keys.map((k) => [k.code, describeKey(k.uses, joints)]));
    const st = stateWith({ simActive: true, sceneKeys: new Set(labels.keys()), sceneLabels: labels });
    const sec = legendFor('simulating', st, { os: 'windows', device: 'mouse' }).find((s) => s.id === 'scene')!;
    const byCode = new Map(sec.entries.map((e) => [e.codes![0], e.action]));
    expect(byCode.get('KeyW')).toMatch(/forward/i);
    expect(byCode.get('KeyS')).toMatch(/reverse/i);
    expect(byCode.get('KeyA')).toMatch(/left/i);
    expect(byCode.get('KeyD')).toMatch(/right/i);
  });

  it('adapts the camera section to the OS and the pointing device', () => {
    const nav = (os: 'mac' | 'windows', device: 'mouse' | 'trackpad' | 'touch') =>
      JSON.stringify(legendFor('edit', stateWith({}), { os, device }).find((s) => s.id === 'nav'));
    expect(nav('mac', 'trackpad')).toContain('Option');
    expect(nav('mac', 'trackpad')).toContain('Two-finger swipe');
    expect(nav('windows', 'trackpad')).toContain('Alt');
    expect(nav('windows', 'trackpad')).not.toContain('Option');
    expect(nav('windows', 'mouse')).toContain('Right-drag');
    expect(nav('mac', 'touch')).toContain('Double-tap');
  });

  it('every context has a legend with at least one entry', () => {
    const st = stateWith({ vehicleKeys: new Set(['KeyW']), driveUtil: assignDriveKeys(new Set(['KeyW'])) });
    for (const ctx of INPUT_CONTEXTS as readonly InputContext[]) {
      const sections = legendFor(ctx, st, { os: 'linux', device: 'mouse' });
      expect(sections.flatMap((s) => s.entries).length, ctx).toBeGreaterThan(0);
    }
  });
});
