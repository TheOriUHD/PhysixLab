/** Persisted layout / behaviour of the on-screen touch controls (a field of `InputSettings`). */
import type { PadButton } from '../input/gamepad';

/** Buttons the overlay can show, with the side of the screen they belong to (before the left-handed swap). */
export const TOUCH_BUTTON_CHOICES: readonly { id: PadButton; side: 'left' | 'right'; label: string; title: string }[] =
  [
    { id: 'LT', side: 'left', label: 'LT', title: 'Left trigger (brake / reverse in the car profile)' },
    { id: 'LB', side: 'left', label: 'LB', title: 'Left bumper (acts as Q)' },
    { id: 'Back', side: 'left', label: 'Reset', title: 'Back (resets the simulation)' },
    { id: 'DUp', side: 'left', label: '↑', title: 'D-pad up (acts as the Up arrow key)' },
    { id: 'DDown', side: 'left', label: '↓', title: 'D-pad down (acts as the Down arrow key)' },
    { id: 'DLeft', side: 'left', label: '←', title: 'D-pad left (acts as the Left arrow key)' },
    { id: 'DRight', side: 'left', label: '→', title: 'D-pad right (acts as the Right arrow key)' },
    { id: 'RT', side: 'right', label: 'RT', title: 'Right trigger (accelerator in the car profile)' },
    { id: 'RB', side: 'right', label: 'RB', title: 'Right bumper (acts as E)' },
    { id: 'South', side: 'right', label: 'A', title: 'South button (A / Cross)' },
    { id: 'East', side: 'right', label: 'B', title: 'East button (B / Circle)' },
    { id: 'West', side: 'right', label: 'X', title: 'West button (X / Square)' },
    { id: 'North', side: 'right', label: 'Y', title: 'North button (Y / Triangle; frames all)' },
    { id: 'Start', side: 'right', label: 'Play', title: 'Start (starts / pauses the simulation)' },
  ];

export type TouchSticks = 'both' | 'left' | 'right' | 'none';
export type TwoFingerDrag = 'orbit' | 'pan';

export interface TouchSettings {
  /** Mirror the layout: left stick and its buttons on the right, and the other way round. */
  leftHanded: boolean;
  /** Scale of the sticks and buttons (1 = 128 px sticks, 52 px buttons). */
  size: number;
  /** Opacity of idle controls, 0.25 … 1. */
  opacity: number;
  /** Which virtual joysticks are shown. */
  sticks: TouchSticks;
  /** Buttons shown (subset of `TOUCH_BUTTON_CHOICES`). */
  buttons: PadButton[];
  /** What a two-finger drag does to the camera (a pinch always zooms; three fingers always pan). */
  twoFingerDrag: TwoFingerDrag;
  /** Hold time (ms) of a long press, which opens the context menu. */
  longPressMs: number;
  /** Two-finger drag moves the selected objects instead of the camera (edit mode, something movable selected). */
  moveWithTwoFingers: boolean;
}

export const DEFAULT_TOUCH: TouchSettings = {
  leftHanded: false,
  size: 1,
  opacity: 0.7,
  sticks: 'both',
  buttons: ['LT', 'RT', 'South', 'East'],
  twoFingerDrag: 'pan', // -- NAV: one finger orbits on empty space, so two fingers pan (and pinch, and twist)
  longPressMs: 500,
  moveWithTwoFingers: false,
};

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Valid touch settings from anything (a stored blob, an imported file); unknown parts fall back to defaults. */
export function sanitizeTouch(raw: unknown): TouchSettings {
  const out: TouchSettings = { ...DEFAULT_TOUCH, buttons: [...DEFAULT_TOUCH.buttons] };
  if (!isRec(raw)) return out;
  if (typeof raw.leftHanded === 'boolean') out.leftHanded = raw.leftHanded;
  out.size = num(raw.size, 0.7, 1.6, DEFAULT_TOUCH.size);
  out.opacity = num(raw.opacity, 0.25, 1, DEFAULT_TOUCH.opacity);
  if (raw.sticks === 'both' || raw.sticks === 'left' || raw.sticks === 'right' || raw.sticks === 'none')
    out.sticks = raw.sticks;
  if (Array.isArray(raw.buttons)) {
    const ok = new Set<string>(TOUCH_BUTTON_CHOICES.map((b) => b.id));
    const seen = new Set<string>();
    out.buttons = [];
    for (const b of raw.buttons)
      if (typeof b === 'string' && ok.has(b) && !seen.has(b)) {
        seen.add(b);
        out.buttons.push(b as PadButton);
      }
  }
  if (raw.twoFingerDrag === 'orbit' || raw.twoFingerDrag === 'pan') out.twoFingerDrag = raw.twoFingerDrag;
  out.longPressMs = Math.round(num(raw.longPressMs, 200, 10000, DEFAULT_TOUCH.longPressMs));
  if (typeof raw.moveWithTwoFingers === 'boolean') out.moveWithTwoFingers = raw.moveWithTwoFingers;
  return out;
}
