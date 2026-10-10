/** Persisted navigation settings (a field of `InputSettings`): the pointing device, what a swipe does, speeds and inversions. */
import type { PointerChoice } from './platform';

export type SwipeAction = 'orbit' | 'pan';
export type TouchOneFinger = 'orbit' | 'select';

export interface NavSettings {
  /** `auto` follows what the wheel events say; the other choices force a scheme. */
  device: PointerChoice;
  /** Trackpad: what a two-finger swipe does (Shift / Cmd + swipe does the other one). */
  swipe: SwipeAction;
  /** Speed multipliers, 0.25 … 3. */
  orbitSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  invertOrbitX: boolean;
  invertOrbitY: boolean;
  invertPan: boolean;
  invertZoom: boolean;
  /** Ease camera moves in and out (off = every input moves the camera at once). */
  smooth: boolean;
  /** Zoom towards the point under the cursor instead of the orbit centre. */
  zoomToCursor: boolean;
  /** Arrow keys orbit, Shift + arrows pan, + / − zoom. */
  keyboardNav: boolean;
  /** Touch: one finger on empty space orbits (`select` keeps the selection rectangle there). */
  touchOneFinger: TouchOneFinger;
  /** Touch: twisting two fingers turns the view. */
  touchTwist: boolean;
  /** Informational: the last preset applied (`custom` after a manual change). */
  preset: string;
}

export const DEFAULT_NAV: NavSettings = {
  device: 'auto',
  swipe: 'orbit',
  orbitSpeed: 1,
  panSpeed: 1,
  zoomSpeed: 1,
  invertOrbitX: false,
  invertOrbitY: false,
  invertPan: false,
  invertZoom: false,
  smooth: true,
  zoomToCursor: true,
  keyboardNav: true,
  touchOneFinger: 'orbit',
  touchTwist: true,
  preset: 'auto',
};

export interface NavPreset {
  id: string;
  label: string;
  blurb: string;
  patch: Partial<NavSettings>;
}

/** One-click starting points in Settings › Navigation. */
export const NAV_PRESETS: readonly NavPreset[] = [
  {
    id: 'auto',
    label: 'Automatic',
    blurb: 'Detect mouse, trackpad or touch screen and pick the matching scheme.',
    patch: { device: 'auto', swipe: 'orbit' },
  },
  {
    id: 'mouse',
    label: 'Mouse',
    blurb: 'Right-drag orbits, middle-drag pans, the wheel zooms towards the cursor.',
    patch: { device: 'mouse', swipe: 'orbit' },
  },
  {
    id: 'trackpad',
    label: 'Trackpad',
    blurb: 'Two-finger swipe orbits, Shift / Cmd + swipe pans, pinch zooms; Option + drag orbits.',
    patch: { device: 'trackpad', swipe: 'orbit' },
  },
  {
    id: 'trackpad-map',
    label: 'Trackpad (map style)',
    blurb: 'Two-finger swipe pans, Shift / Cmd + swipe orbits, pinch zooms.',
    patch: { device: 'trackpad', swipe: 'pan' },
  },
  {
    id: 'touch',
    label: 'Touch screen',
    blurb: 'One finger orbits on empty space, two fingers pan, pinch zooms and twist turns the view.',
    patch: { device: 'touch', swipe: 'orbit', touchOneFinger: 'orbit', touchTwist: true },
  },
];

export const presetNav = (id: string): NavPreset | undefined => NAV_PRESETS.find((p) => p.id === id);

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const speed = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(3, Math.max(0.25, v)) : d;
const flag = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** Valid navigation settings from anything (a stored blob, an imported file); unknown parts fall back to defaults. */
export function sanitizeNav(raw: unknown): NavSettings {
  const d = DEFAULT_NAV;
  const out: NavSettings = { ...d };
  if (!isRec(raw)) return out;
  if (raw.device === 'auto' || raw.device === 'mouse' || raw.device === 'trackpad' || raw.device === 'touch')
    out.device = raw.device;
  if (raw.swipe === 'orbit' || raw.swipe === 'pan') out.swipe = raw.swipe;
  out.orbitSpeed = speed(raw.orbitSpeed, d.orbitSpeed);
  out.panSpeed = speed(raw.panSpeed, d.panSpeed);
  out.zoomSpeed = speed(raw.zoomSpeed, d.zoomSpeed);
  out.invertOrbitX = flag(raw.invertOrbitX, d.invertOrbitX);
  out.invertOrbitY = flag(raw.invertOrbitY, d.invertOrbitY);
  out.invertPan = flag(raw.invertPan, d.invertPan);
  out.invertZoom = flag(raw.invertZoom, d.invertZoom);
  out.smooth = flag(raw.smooth, d.smooth);
  out.zoomToCursor = flag(raw.zoomToCursor, d.zoomToCursor);
  out.keyboardNav = flag(raw.keyboardNav, d.keyboardNav);
  if (raw.touchOneFinger === 'orbit' || raw.touchOneFinger === 'select') out.touchOneFinger = raw.touchOneFinger;
  out.touchTwist = flag(raw.touchTwist, d.touchTwist);
  if (typeof raw.preset === 'string') out.preset = raw.preset.slice(0, 40);
  return out;
}
