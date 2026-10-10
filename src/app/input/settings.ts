/** Persisted input settings (a field of `Prefs`): key bindings, vehicle profile, axis tuning, gamepad and touch options. */
import type { AxisCfg } from './axes';
import { DEFAULT_TOUCH, sanitizeTouch, type TouchSettings } from '../touch/settings'; // -- CM-A touch --

export interface InputSettings {
  /** Rebinding overrides: command / action id → the complete list of shortcuts (empty list = unbound). */
  bindings: Record<string, string[]>;
  /** Name of the last applied preset (informational; `custom` after an edit). */
  preset: string;
  /** Active vehicle profile id (`src/app/input/profiles.ts`). */
  profile: string;
  /** Per profile, per axis name: tuning that replaces the profile defaults. */
  axisTuning: Record<string, Record<string, Partial<AxisCfg>>>;
  /** Keys that drive an analog axis ramp up and down like a stick instead of jumping to full. */
  keyboardRamp: boolean;
  /** Read connected gamepads. */
  gamepad: boolean;
  /** On-screen touch controls: `auto` shows them on touch devices only. */
  touchControls: 'auto' | 'on' | 'off';
  /** Layout and gesture options of the touch controls (`src/app/touch/settings.ts`). */
  touch: TouchSettings;
}

export const DEFAULT_INPUT: InputSettings = {
  bindings: {},
  preset: 'default',
  profile: 'car',
  axisTuning: {},
  keyboardRamp: true,
  gamepad: true,
  touchControls: 'auto',
  touch: DEFAULT_TOUCH,
};

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Make anything (a stored blob, an imported file) into valid settings; unknown or malformed parts are dropped. */
export function sanitizeInput(raw: unknown): InputSettings {
  const out: InputSettings = {
    ...DEFAULT_INPUT,
    bindings: {},
    axisTuning: {},
  };
  if (!isRec(raw)) return out;
  if (isRec(raw.bindings))
    for (const [id, v] of Object.entries(raw.bindings))
      if (Array.isArray(v) && v.every((s) => typeof s === 'string')) out.bindings[id] = v.slice(0, 4);
  if (typeof raw.preset === 'string') out.preset = raw.preset.slice(0, 40);
  if (typeof raw.profile === 'string') out.profile = raw.profile.slice(0, 40);
  if (isRec(raw.axisTuning))
    for (const [prof, axes] of Object.entries(raw.axisTuning)) {
      if (!isRec(axes)) continue;
      const m: Record<string, Partial<AxisCfg>> = {};
      for (const [name, cfg] of Object.entries(axes)) {
        if (!isRec(cfg)) continue;
        const c: Partial<AxisCfg> = {};
        for (const k of ['deadzone', 'sensitivity', 'expo', 'smoothing', 'rise', 'fall'] as const)
          if (typeof cfg[k] === 'number' && Number.isFinite(cfg[k])) c[k] = cfg[k];
        for (const k of ['invert', 'autoCentre'] as const) if (typeof cfg[k] === 'boolean') c[k] = cfg[k];
        m[name] = c;
      }
      out.axisTuning[prof] = m;
    }
  if (typeof raw.keyboardRamp === 'boolean') out.keyboardRamp = raw.keyboardRamp;
  if (typeof raw.gamepad === 'boolean') out.gamepad = raw.gamepad;
  if (raw.touchControls === 'on' || raw.touchControls === 'off' || raw.touchControls === 'auto')
    out.touchControls = raw.touchControls;
  out.touch = sanitizeTouch(raw.touch);
  return out;
}
