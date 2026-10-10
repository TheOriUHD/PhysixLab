/**
 * Input contexts: which part of the app owns each key *right now*.
 *
 * The same letter used to mean different things at once — Q / E are the Select / Rotate tools in the editor, fly
 * down / up in the free camera, spin in a grab, and shift down / up in a gearbox — and which one worked depended on
 * hidden state. Every key event now goes through `ownerOf(context, key, state)`:
 *
 *   edit        the editor: shortcuts, gizmo keys (nothing is simulating)
 *   simulating  the simulation runs: the scene's motor / component keys go to the world and the editor shortcuts on
 *               the same keys step aside
 *   grab        a body is held with the pointer: W S A D Q E F [ ] and the arrows move / turn / freeze it
 *   fly         the free camera is active: its movement keys belong to the camera
 *   placing     a placement ghost follows the pointer: the ghost gets the keys first
 *   drive       immersive vehicle mode: the vehicle's keys drive, a few utility keys work, everything else is locked
 *   play        immersive "be in the scene" mode: fly camera + grabbing, everything else locked
 *
 * `claims()` lists every owner that wants a key in a context in priority order; the first one owns it and the rest are
 * *shadowed* — reported by `legendFor` as unavailable with the reason, instead of silently doing nothing.
 * This module is pure (no DOM), so the table is unit-tested for exactly one owner per key.
 */
import { keyCapLabel, modNames, type OsKind, type PointerKind } from './platform';

export type InputContext = 'edit' | 'simulating' | 'grab' | 'fly' | 'placing' | 'drive' | 'play';

export const INPUT_CONTEXTS: readonly InputContext[] = [
  'edit',
  'simulating',
  'grab',
  'fly',
  'placing',
  'drive',
  'play',
];

export const CONTEXT_LABEL: Record<InputContext, string> = {
  edit: 'Edit',
  simulating: 'Simulating',
  grab: 'Holding',
  fly: 'Fly camera',
  placing: 'Placing',
  drive: 'Drive',
  play: 'Play',
};

/** One-line explanation shown with the context pill. */
export const CONTEXT_BLURB: Record<InputContext, string> = {
  edit: 'Editor shortcuts and gizmo keys are active.',
  simulating: 'The scene’s own keys go to the simulation; editor shortcuts on those keys step aside.',
  grab: 'You are holding a body: these keys move, turn and freeze it.',
  fly: 'The free camera owns its movement keys.',
  placing: 'A new object follows the pointer: click to drop it.',
  drive: 'Drive mode: the vehicle’s controls are locked in, everything else is off.',
  play: 'Play mode: fly around, grab things; editing is off.',
};

export type KeyOwner =
  'command' | 'nav' | 'sim' | 'camera.fly' | 'grab' | 'placement' | 'drive' | 'play' | 'blocked' | 'none';

export const OWNER_LABEL: Record<KeyOwner, string> = {
  command: 'an editor shortcut',
  nav: 'camera navigation',
  sim: 'the simulation',
  'camera.fly': 'the fly camera',
  grab: 'holding a body',
  placement: 'placing an object',
  drive: 'drive mode',
  play: 'play mode',
  blocked: 'locked in this mode',
  none: 'nothing',
};

// ---- fixed key tables ----------------------------------------------------------------------------------------------

/** What the keys do while a body is held (in addition to the pointer). */
export const GRAB_KEYS = {
  away: ['KeyW', 'ArrowUp', 'BracketRight'],
  toward: ['KeyS', 'ArrowDown', 'BracketLeft'],
  turnLeft: ['KeyA', 'KeyQ'],
  turnRight: ['KeyD', 'KeyE'],
  freeze: ['KeyF'],
  turnDrag: ['KeyR'],
} as const;

export const GRAB_CODES: ReadonlySet<string> = new Set(Object.values(GRAB_KEYS).flat());

/** Utility actions of drive mode. Each has candidate keys in preference order; a candidate the vehicle uses is skipped. */
export type DriveAction = 'exit' | 'reset' | 'pause' | 'camera' | 'lookBehind';

export const DRIVE_CANDIDATES: Record<DriveAction, readonly string[]> = {
  exit: ['Escape', 'Tab'],
  reset: ['KeyR', 'Backspace', 'Delete'],
  pause: ['KeyP', 'Enter', 'Pause'],
  camera: ['KeyC', 'KeyX', 'KeyN'],
  lookBehind: ['KeyB', 'KeyZ', 'KeyM'],
};

export const DRIVE_LABEL: Record<DriveAction, string> = {
  exit: 'Exit drive mode',
  reset: 'Reset the vehicle (flip it upright if tilted)',
  pause: 'Pause / resume',
  camera: 'Camera: chase / cockpit / orbit',
  lookBehind: 'Look behind (hold)',
};

/**
 * Pick the key of each drive action: the first candidate the vehicle does not use. Exit keys are never skipped (the
 * way out must always exist).
 */
export function assignDriveKeys(vehicleKeys: ReadonlySet<string>): Map<string, DriveAction> {
  const out = new Map<string, DriveAction>();
  const taken = new Set<string>(vehicleKeys);
  for (const a of ['exit', 'reset', 'pause', 'camera', 'lookBehind'] as const) {
    for (const code of DRIVE_CANDIDATES[a]) {
      if (a === 'exit') {
        out.set(code, a);
        taken.add(code);
        continue;
      }
      if (taken.has(code)) continue;
      out.set(code, a);
      taken.add(code);
      break;
    }
  }
  return out;
}

export const PLAY_EXIT: ReadonlySet<string> = new Set(['Escape', 'Tab']);

/** Keys that are never handed to the scene (the way out of anything must keep working). */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set(['Escape']);

// ---- state ---------------------------------------------------------------------------------------------------------

export interface KeyInfo {
  code: string;
  key?: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ContextFacts {
  immersive: 'none' | 'drive' | 'play';
  placing: boolean;
  grabbing: boolean;
  /** The camera mode is a free-flight one (its movement keys are held actions). */
  flyCamera: boolean;
  simActive: boolean;
}

/** The first matching context, by priority: drive, play, placing, grab, fly, simulating, edit. */
export function resolveContext(f: ContextFacts): InputContext {
  if (f.immersive === 'drive') return 'drive';
  if (f.immersive === 'play') return 'play';
  if (f.placing) return 'placing';
  if (f.grabbing) return 'grab';
  if (f.flyCamera) return 'fly';
  if (f.simActive) return 'simulating';
  return 'edit';
}

export interface KeyState {
  simActive: boolean;
  grabbing: boolean;
  /** `KeyboardEvent.code`s the scene's motors / components listen to. */
  sceneKeys: ReadonlySet<string>;
  /** What the scene calls each of those keys ("Throttle (Engine)"). */
  sceneLabels: ReadonlyMap<string, string>;
  /** Codes of the fly camera's held actions (effective, so rebinding is respected). */
  flyKeys: ReadonlySet<string>;
  /** Does a registered command (editor shortcut) use this key press? */
  hasCommand: (k: KeyInfo) => boolean;
  commandLabel: (k: KeyInfo) => string | undefined;
  /** Edit mode with a selection: plain arrows nudge it instead of moving the camera. */
  nudgeOwnsArrows: boolean;
  /** Keyboard camera navigation (arrows, + / −) is switched on. */
  navKeys: boolean;
  /** Codes the placement ghost wants (from `legendEntries`); the ghost's own `handleKey` decides at run time. */
  placementKeys: ReadonlySet<string>;
  /** Drive mode: the vehicle's key codes, and the utility key assignment. */
  vehicleKeys: ReadonlySet<string>;
  vehicleLabels: ReadonlyMap<string, string>;
  driveUtil: ReadonlyMap<string, DriveAction>;
  isPaletteKey: (k: KeyInfo) => boolean;
}

export function emptyKeyState(): KeyState {
  return {
    simActive: false,
    grabbing: false,
    sceneKeys: new Set(),
    sceneLabels: new Map(),
    flyKeys: new Set(),
    hasCommand: () => false,
    commandLabel: () => undefined,
    nudgeOwnsArrows: false,
    navKeys: true,
    placementKeys: new Set(),
    vehicleKeys: new Set(),
    vehicleLabels: new Map(),
    driveUtil: new Map(),
    isPaletteKey: () => false,
  };
}

const plain = (k: KeyInfo): boolean => !k.ctrl && !k.meta && !k.alt;

/** Does the camera-navigation layer want this key press (arrows orbit / pan, + / − zoom, Alt + digit views)? */
export function navWants(k: KeyInfo, st: KeyState): boolean {
  if (!st.navKeys || k.ctrl || k.meta) return false;
  if (/^Arrow(Left|Right|Up|Down)$/.test(k.code)) return !(st.nudgeOwnsArrows && !k.alt);
  if (k.alt) return /^Digit[13579]$/.test(k.code);
  return (
    (k.code === 'Equal' ||
      k.code === 'NumpadAdd' ||
      k.code === 'Minus' ||
      k.code === 'NumpadSubtract' ||
      k.code === 'PageUp' ||
      k.code === 'PageDown') &&
    !st.hasCommand(k)
  );
}

/** Every owner that wants this key press in this context, highest priority first. */
export function claims(ctx: InputContext, k: KeyInfo, st: KeyState): KeyOwner[] {
  const out: KeyOwner[] = [];
  const add = (o: KeyOwner, cond: boolean) => {
    if (cond && !out.includes(o)) out.push(o);
  };
  const simKey = st.simActive && plain(k) && st.sceneKeys.has(k.code) && !PROTECTED_KEYS.has(k.code);
  const cmd = st.hasCommand(k);
  switch (ctx) {
    case 'drive': {
      const util = plain(k) || k.code === 'Escape' ? st.driveUtil.get(k.code) : undefined;
      add('drive', util === 'exit');
      add('sim', plain(k) && st.vehicleKeys.has(k.code));
      add('drive', util !== undefined);
      add('command', st.isPaletteKey(k));
      break;
    }
    case 'play': {
      add('play', plain(k) && PLAY_EXIT.has(k.code));
      add('grab', st.grabbing && plain(k) && GRAB_CODES.has(k.code));
      add('camera.fly', plain(k) && st.flyKeys.has(k.code));
      add('sim', simKey);
      add('command', st.isPaletteKey(k));
      break;
    }
    case 'placing':
      add('placement', plain(k) && st.placementKeys.has(k.code));
      add('nav', navWants(k, st));
      add('command', cmd);
      break;
    case 'grab':
      add('grab', plain(k) && GRAB_CODES.has(k.code));
      add('sim', simKey);
      add('nav', navWants(k, st));
      add('command', cmd);
      break;
    case 'fly':
      add('camera.fly', plain(k) && st.flyKeys.has(k.code));
      add('sim', simKey);
      add('nav', navWants(k, st));
      add('command', cmd);
      break;
    case 'simulating':
      add('sim', simKey);
      add('nav', navWants(k, st));
      add('command', cmd);
      break;
    case 'edit':
      add('nav', navWants(k, st));
      add('command', cmd);
      break;
  }
  return out;
}

/** The single owner of a key press in a context (`blocked` in the immersive modes, `none` where the browser keeps it). */
export function ownerOf(ctx: InputContext, k: KeyInfo, st: KeyState): KeyOwner {
  const c = claims(ctx, k, st);
  if (c.length) return c[0];
  return ctx === 'drive' || ctx === 'play' ? 'blocked' : 'none';
}

/** Owners that wanted the key but lost it: the legend names them as unavailable. */
export function shadowed(ctx: InputContext, k: KeyInfo, st: KeyState): KeyOwner[] {
  return claims(ctx, k, st).slice(1);
}

// ---- the legend ----------------------------------------------------------------------------------------------------

export interface LegendEntry {
  id: string;
  /** Key caps, as printed ("W", "↑", "Shift"). May be empty for a pure gesture. */
  keys: string[];
  /** Plain text shown after the key caps: a gesture ("Two-finger swipe") or what the keys combine with ("+ drag"). */
  with?: string;
  /** `KeyboardEvent.code`s that light the entry while one is pressed. */
  codes?: string[];
  action: string;
  /** Set when the key does nothing right now; says why. */
  unavailable?: string;
}

export interface LegendSection {
  id: string;
  title: string;
  entries: LegendEntry[];
}

export interface LegendEnv {
  os: OsKind;
  device: PointerKind;
}

const cap = (code: string, env: LegendEnv): string => keyCapLabel(code, env.os);

function navSection(env: LegendEnv, st: KeyState): LegendSection {
  const m = modNames(env.os);
  const e: LegendEntry[] = [];
  const k = (...keys: string[]) => keys;
  if (env.device === 'trackpad') {
    e.push({ id: 'nav.swipe', keys: [], with: 'Two-finger swipe', action: 'Orbit' });
    e.push({
      id: 'nav.swipe.pan',
      keys: k(m.shift),
      with: '+ swipe',
      codes: ['ShiftLeft', 'ShiftRight'],
      action: `Pan (also ${m.mod} + swipe)`,
    });
    e.push({ id: 'nav.pinch', keys: [], with: 'Pinch', action: 'Zoom towards the cursor' });
    e.push({
      id: 'nav.alt.drag',
      keys: k(m.alt),
      with: '+ drag',
      codes: ['AltLeft', 'AltRight'],
      action: 'Orbit with one finger',
    });
    e.push({ id: 'nav.space.drag', keys: k('Space'), with: '+ drag', codes: ['Space'], action: 'Pan with one finger' });
  } else if (env.device === 'touch') {
    e.push({ id: 'nav.one', keys: [], with: 'One finger', action: 'Orbit (on empty space)' });
    e.push({ id: 'nav.two', keys: [], with: 'Two fingers', action: 'Pan · pinch zooms · twist turns' });
    e.push({ id: 'nav.dtap', keys: [], with: 'Double-tap', action: 'Focus an object / frame all' });
  } else {
    e.push({ id: 'nav.rdrag', keys: [], with: 'Right-drag', action: 'Orbit' });
    e.push({ id: 'nav.mdrag', keys: [], with: 'Middle-drag', action: 'Pan (or Space + drag)' });
    e.push({ id: 'nav.wheel', keys: [], with: 'Wheel', action: 'Zoom towards the cursor' });
    e.push({
      id: 'nav.alt.drag',
      keys: k(m.alt),
      with: '+ drag',
      codes: ['AltLeft', 'AltRight'],
      action: 'Orbit with the left button',
    });
  }
  if (env.device !== 'touch')
    e.push({ id: 'nav.dbl', keys: [], with: 'Double-click', action: 'Focus an object / frame all' });
  if (st.navKeys) {
    const nudge = st.nudgeOwnsArrows;
    e.push({
      id: 'nav.arrows',
      keys: nudge ? [m.alt] : ['←', '↑', '↓', '→'],
      with: nudge ? '+ ←↑↓→' : undefined,
      codes: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
      action: nudge ? 'Orbit (plain arrows nudge the selection)' : 'Orbit',
    });
    e.push({
      id: 'nav.arrows.pan',
      keys: ['Shift'],
      with: '+ arrows',
      codes: ['ShiftLeft', 'ShiftRight'],
      action: 'Pan',
    });
    e.push({
      id: 'nav.zoom',
      keys: ['+', '−'],
      codes: ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'],
      action: 'Zoom',
    });
  }
  e.push({ id: 'nav.frame', keys: ['F'], codes: ['KeyF'], action: 'Frame selection' });
  e.push({ id: 'nav.home', keys: ['Home'], codes: ['Home'], action: 'Frame everything' });
  e.push({
    id: 'nav.views',
    keys: [m.alt],
    with: '+ 1 3 7 9',
    action: 'Front / side / top / iso view (or Num 1 3 7 9)',
  });
  return { id: 'nav', title: 'Camera', entries: e };
}

function shadowedEditorKeys(st: KeyState, env: LegendEnv, ctx: InputContext): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const code of st.sceneKeys) {
    const k: KeyInfo = { code, ctrl: false, meta: false, alt: false, shift: false };
    const label = st.commandLabel(k);
    if (!label || !st.hasCommand(k)) continue;
    const owners = claims(ctx, k, st);
    if (owners[0] !== 'sim') continue;
    out.push({
      id: `shadow.${code}`,
      keys: [cap(code, env)],
      codes: [code],
      action: label,
      unavailable: `the scene uses ${cap(code, env)} for ${st.sceneLabels.get(code) ?? 'a control'}`,
    });
  }
  return out;
}

function sceneControlEntries(st: KeyState, env: LegendEnv): LegendEntry[] {
  return [...st.sceneKeys].map((code) => ({
    id: `scene.${code}`,
    keys: [cap(code, env)],
    codes: [code],
    action: st.sceneLabels.get(code) ?? 'Scene control',
  }));
}

/** The sections the controls legend shows in a context. */
export function legendFor(ctx: InputContext, st: KeyState, env: LegendEnv, extra: LegendEntry[] = []): LegendSection[] {
  const m = modNames(env.os);
  const sections: LegendSection[] = [];
  switch (ctx) {
    case 'edit':
      sections.push({
        id: 'tools',
        title: 'Tools',
        entries: [
          { id: 'tool.select', keys: ['Q'], codes: ['KeyQ'], action: 'Select' },
          { id: 'tool.move', keys: ['W'], codes: ['KeyW'], action: 'Move gizmo' },
          { id: 'tool.rotate', keys: ['E'], codes: ['KeyE'], action: 'Rotate gizmo' },
          { id: 'tool.scale', keys: ['R'], codes: ['KeyR'], action: 'Scale gizmo' },
          { id: 'sim.toggle', keys: ['Space'], codes: ['Space'], action: 'Simulate' },
          { id: 'drive', keys: ['V'], codes: ['KeyV'], action: 'Drive the vehicle' },
        ],
      });
      sections.push(navSection(env, st));
      break;
    case 'simulating': {
      const ctl = sceneControlEntries(st, env);
      sections.push({
        id: 'scene',
        title: 'Scene controls',
        entries: ctl.length ? ctl : [{ id: 'scene.none', keys: ['—'], action: 'This scene has no key controls' }],
      });
      const sh = shadowedEditorKeys(st, env, ctx);
      sections.push({
        id: 'editor',
        title: 'Editor keys',
        entries: [
          { id: 'sim.toggle', keys: ['Space'], codes: ['Space'], action: 'Pause / resume' },
          { id: 'sim.reset', keys: ['Shift', 'Space'], codes: ['Space'], action: 'Stop and return to the layout' },
          ...(['KeyQ', 'KeyW', 'KeyE', 'KeyR'] as const).map((code): LegendEntry => {
            const names: Record<string, string> = {
              KeyQ: 'Select',
              KeyW: 'Move gizmo',
              KeyE: 'Rotate gizmo',
              KeyR: 'Scale gizmo',
            };
            const used = st.sceneKeys.has(code);
            return {
              id: `tool.${code}`,
              keys: [cap(code, env)],
              codes: [code],
              action: names[code],
              unavailable: used
                ? `the scene uses ${cap(code, env)} for ${st.sceneLabels.get(code) ?? 'a control'}`
                : undefined,
            };
          }),
          ...sh.filter((x) => !['KeyQ', 'KeyW', 'KeyE', 'KeyR'].includes(x.id.slice(7))),
        ],
      });
      sections.push({
        id: 'grab',
        title: 'Hold a body',
        entries: [
          { id: 'grab.hint', keys: [], with: 'Drag', action: 'Grab and throw (W S A D Q E F work while holding)' },
        ],
      });
      sections.push(navSection(env, st));
      break;
    }
    case 'grab': {
      const caps = (codes: readonly string[]) => codes.map((c) => cap(c, env));
      sections.push({
        id: 'grab',
        title: 'Holding a body',
        entries: [
          { id: 'grab.away', keys: caps(GRAB_KEYS.away), codes: [...GRAB_KEYS.away], action: 'Push away' },
          { id: 'grab.toward', keys: caps(GRAB_KEYS.toward), codes: [...GRAB_KEYS.toward], action: 'Pull closer' },
          {
            id: 'grab.turn',
            keys: [...caps(GRAB_KEYS.turnLeft), ...caps(GRAB_KEYS.turnRight)],
            codes: [...GRAB_KEYS.turnLeft, ...GRAB_KEYS.turnRight],
            action: `Turn in 15° steps (${m.shift} = fine)`,
          },
          { id: 'grab.freeze', keys: ['F'], codes: ['KeyF'], action: 'Freeze / unfreeze in place' },
          { id: 'grab.turnDrag', keys: ['R'], with: '+ drag', codes: ['KeyR'], action: 'Turn freely' },
          { id: 'grab.wheel', keys: [], with: 'Scroll', action: 'Push / pull (touch: pinch)' },
        ],
      });
      const sh = [...st.sceneKeys].filter((c) => GRAB_CODES.has(c));
      if (sh.length)
        sections.push({
          id: 'grab.paused',
          title: 'Paused while holding',
          entries: sh.map((code) => ({
            id: `paused.${code}`,
            keys: [cap(code, env)],
            codes: [code],
            action: st.sceneLabels.get(code) ?? 'Scene control',
            unavailable: 'used for the held body',
          })),
        });
      break;
    }
    case 'fly':
      sections.push({
        id: 'fly',
        title: 'Fly camera',
        entries: [
          { id: 'fly.move', keys: ['W', 'A', 'S', 'D'], codes: ['KeyW', 'KeyA', 'KeyS', 'KeyD'], action: 'Move' },
          { id: 'fly.updown', keys: ['E', 'Q'], codes: ['KeyE', 'KeyQ'], action: 'Up / down' },
          { id: 'fly.boost', keys: ['Shift'], codes: ['ShiftLeft', 'ShiftRight'], action: 'Faster' },
          { id: 'fly.look', keys: [], with: 'Right-drag', action: 'Look around' },
          { id: 'fly.speed', keys: [], with: 'Wheel', action: 'Fly speed' },
          { id: 'fly.next', keys: ['Z'], codes: ['KeyZ'], action: 'Next camera mode' },
        ],
      });
      if (st.simActive) {
        const sh = [...st.sceneKeys].filter((c) => st.flyKeys.has(c));
        if (sh.length)
          sections.push({
            id: 'fly.shadow',
            title: 'Scene keys used by the camera',
            entries: sh.map((code) => ({
              id: `fly.${code}`,
              keys: [cap(code, env)],
              codes: [code],
              action: st.sceneLabels.get(code) ?? 'Scene control',
              unavailable: 'the fly camera uses this key — switch camera (Z) to drive',
            })),
          });
      }
      break;
    case 'placing':
      sections.push({
        id: 'placing',
        title: 'Placing',
        entries: extra.length ? extra : [{ id: 'place.esc', keys: ['Esc'], codes: ['Escape'], action: 'Cancel' }],
      });
      sections.push(navSection(env, st));
      break;
    case 'drive': {
      const util = [...st.driveUtil.entries()];
      const u = (a: DriveAction): LegendEntry => {
        const codes = util.filter(([, v]) => v === a).map(([c]) => c);
        return { id: `drive.${a}`, keys: codes.map((c) => cap(c, env)), codes, action: DRIVE_LABEL[a] };
      };
      sections.push({
        id: 'vehicle',
        title: 'Vehicle controls',
        entries: [...st.vehicleKeys].map((code) => ({
          id: `veh.${code}`,
          keys: [cap(code, env)],
          codes: [code],
          action: st.vehicleLabels.get(code) ?? 'Control',
        })),
      });
      sections.push({
        id: 'drive',
        title: 'Drive mode',
        entries: [
          ...extra,
          u('camera'),
          u('lookBehind'),
          u('reset'),
          u('pause'),
          u('exit'),
          { id: 'drive.look', keys: [], with: 'Drag / swipe', action: 'Look around (springs back)' },
        ],
      });
      break;
    }
    case 'play':
      sections.push({
        id: 'play',
        title: 'Play mode',
        entries: [
          { id: 'play.move', keys: ['W', 'A', 'S', 'D'], codes: ['KeyW', 'KeyA', 'KeyS', 'KeyD'], action: 'Move' },
          { id: 'play.updown', keys: ['E', 'Q'], codes: ['KeyE', 'KeyQ'], action: 'Up / down' },
          { id: 'play.boost', keys: ['Shift'], codes: ['ShiftLeft', 'ShiftRight'], action: 'Faster' },
          { id: 'play.look', keys: [], with: 'Right-drag', action: 'Look around' },
          { id: 'play.grab', keys: [], with: 'Drag', action: 'Grab and throw bodies' },
          {
            id: 'play.held',
            keys: ['W', 'S', 'A', 'D', 'Q', 'E', 'F'],
            action: 'While holding: push, pull, turn, freeze',
          },
          { id: 'play.exit', keys: ['Esc', 'Tab'], codes: ['Escape', 'Tab'], action: 'Leave play mode' },
        ],
      });
      break;
  }
  return sections;
}
