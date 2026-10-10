/** Virtual joystick / button maths (pure): screen offsets → the pad values the input hub reads. */
import { PAD_BUTTONS, type PadButton, type PadState } from '../input/gamepad';

export interface StickVector {
  /** −1 … 1, right is positive. */
  x: number;
  /** −1 … 1, up is positive (like `PadState`). */
  y: number;
  /** Pull length 0 … 1. */
  mag: number;
  /** Offset of the thumb from the base centre in px, clamped to the radius (screen axes, y down). */
  thumbX: number;
  thumbY: number;
}

/** Stick value for a finger at (px, py) on a stick centred at (cx, cy) with the given radius (px). */
export function stickVector(
  cx: number,
  cy: number,
  px: number,
  py: number,
  radius: number,
  out: StickVector = { x: 0, y: 0, mag: 0, thumbX: 0, thumbY: 0 },
): StickVector {
  const dx = px - cx;
  const dy = py - cy;
  const len = Math.hypot(dx, dy);
  const r = Math.max(1, radius);
  const k = len > r ? r / len : 1;
  out.thumbX = dx * k;
  out.thumbY = dy * k;
  out.x = out.thumbX / r;
  out.y = -out.thumbY / r;
  out.mag = Math.min(1, len / r);
  return out;
}

export type StickId = 'L' | 'R';

/** Write one stick into a pad. */
export function setStick(pad: PadState, which: StickId, x: number, y: number): void {
  if (which === 'L') {
    pad.LX = x;
    pad.LY = y;
  } else {
    pad.RX = x;
    pad.RY = y;
  }
}

/** Press or release a button on a pad; triggers also set their analog value (a real pad does both). */
export function setPadButton(pad: PadState, b: PadButton, down: boolean): void {
  pad.buttons[b] = down;
  if (b === 'LT') pad.LT = down ? 1 : 0;
  if (b === 'RT') pad.RT = down ? 1 : 0;
}

/** Release everything (sticks centred, all buttons and triggers up). */
export function clearPad(pad: PadState): void {
  pad.LX = pad.LY = pad.RX = pad.RY = pad.LT = pad.RT = 0;
  for (const b of PAD_BUTTONS) pad.buttons[b] = false;
}
