/**
 * Gamepad support: a normalised view of whatever the Gamepad API reports (standard mapping for Xbox, PlayStation
 * and most others; a generic fallback otherwise), and the poller that handles hot-plugging. The pure parts
 * (`readPad`, `padLabel`) run in Node.
 */

/** Physical buttons by position, named like the "standard" mapping. */
export const PAD_BUTTONS = [
  'South',
  'East',
  'West',
  'North',
  'LB',
  'RB',
  'LT',
  'RT',
  'Back',
  'Start',
  'LS',
  'RS',
  'DUp',
  'DDown',
  'DLeft',
  'DRight',
  'Home',
] as const;
export type PadButton = (typeof PAD_BUTTONS)[number];
export type PadStick = 'LX' | 'LY' | 'RX' | 'RY';

export interface PadState {
  LX: number;
  LY: number;
  RX: number;
  RY: number;
  /** Trigger pressure, 0…1. */
  LT: number;
  RT: number;
  buttons: Record<PadButton, boolean>;
}

export const emptyPad = (): PadState => ({
  LX: 0,
  LY: 0,
  RX: 0,
  RY: 0,
  LT: 0,
  RT: 0,
  buttons: Object.fromEntries(PAD_BUTTONS.map((b) => [b, false])) as Record<PadButton, boolean>,
});

/** The parts of a `Gamepad` the reader needs (so it can be tested without a browser). */
export interface GamepadLike {
  id: string;
  mapping: string;
  axes: ArrayLike<number>;
  buttons: ArrayLike<{ pressed: boolean; value: number }>;
}

export type PadFamily = 'xbox' | 'playstation' | 'generic';

export function padFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  if (/054c|playstation|dualshock|dualsense|wireless controller.*sony/.test(s)) return 'playstation';
  if (/045e|xbox|xinput|microsoft/.test(s)) return 'xbox';
  return 'generic';
}

const LABELS: Record<PadFamily, Partial<Record<PadButton, string>>> = {
  xbox: {
    South: 'A',
    East: 'B',
    West: 'X',
    North: 'Y',
    LB: 'LB',
    RB: 'RB',
    LT: 'LT',
    RT: 'RT',
    Back: 'View',
    Start: 'Menu',
  },
  playstation: {
    South: 'Cross',
    East: 'Circle',
    West: 'Square',
    North: 'Triangle',
    LB: 'L1',
    RB: 'R1',
    LT: 'L2',
    RT: 'R2',
    Back: 'Share',
    Start: 'Options',
    LS: 'L3',
    RS: 'R3',
  },
  generic: { South: 'Button 1', East: 'Button 2', West: 'Button 3', North: 'Button 4' },
};

/** A button's name as printed on the controller family (`Cross`, `A`, `D-pad up` …). */
export function padLabel(b: PadButton, family: PadFamily = 'xbox'): string {
  const fixed: Partial<Record<PadButton, string>> = {
    DUp: 'D-pad ↑',
    DDown: 'D-pad ↓',
    DLeft: 'D-pad ←',
    DRight: 'D-pad →',
    LS: 'Left stick click',
    RS: 'Right stick click',
    Home: 'Home',
  };
  return LABELS[family][b] ?? fixed[b] ?? b;
}

/** Pseudo key code a pad button produces in the simulation key set (so motors and the inspector can bind it). */
export const padKeyCode = (b: PadButton): string => `Pad${b}`;
export const isPadKeyCode = (code: string): boolean =>
  code.startsWith('Pad') && PAD_BUTTONS.includes(code.slice(3) as PadButton);
export const padButtonOfKeyCode = (code: string): PadButton | null =>
  isPadKeyCode(code) ? (code.slice(3) as PadButton) : null;

const BTN_THRESHOLD = 0.5;

/** Convert one gamepad to the normalised state (stick Y is positive when pushed up, unlike the raw API). */
export function readPad(gp: GamepadLike, into: PadState = emptyPad()): PadState {
  const ax = (i: number): number => {
    const v = gp.axes[i];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  };
  const btn = (i: number): { pressed: boolean; value: number } => gp.buttons[i] ?? { pressed: false, value: 0 };
  into.LX = ax(0);
  into.LY = -ax(1);
  into.RX = ax(2);
  into.RY = -ax(3);
  const standard = gp.mapping === 'standard';
  PAD_BUTTONS.forEach((name, i) => {
    into.buttons[name] = !!btn(i).pressed || btn(i).value > BTN_THRESHOLD;
  });
  if (standard || gp.buttons.length >= 8) {
    into.LT = btn(6).value || (btn(6).pressed ? 1 : 0);
    into.RT = btn(7).value || (btn(7).pressed ? 1 : 0);
  } else if (gp.axes.length >= 6) {
    // Generic devices often report triggers as axes resting at −1.
    into.LT = (ax(4) + 1) / 2;
    into.RT = (ax(5) + 1) / 2;
  } else {
    into.LT = into.RT = 0;
  }
  into.buttons.LT = into.LT > BTN_THRESHOLD;
  into.buttons.RT = into.RT > BTN_THRESHOLD;
  return into;
}

/** The first connected pad with any activity wins; with several, the lowest index that is connected. */
export interface PadEvents {
  onConnect?: (id: string, family: PadFamily) => void;
  onDisconnect?: (id: string) => void;
}

export class GamepadPoller {
  readonly state: PadState = emptyPad();
  private index = -1;
  family: PadFamily = 'generic';
  name = '';
  private listening = false;
  private onConn = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    if (this.index < 0) this.adopt(gp);
    this.ev.onConnect?.(gp.id, padFamily(gp.id));
  };
  private onDisc = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    if (gp.index !== this.index) return;
    this.index = -1;
    Object.assign(this.state, emptyPad());
    this.name = '';
    this.ev.onDisconnect?.(gp.id);
  };

  constructor(private ev: PadEvents = {}) {}

  get connected(): boolean {
    return this.index >= 0;
  }

  private adopt(gp: Gamepad): void {
    this.index = gp.index;
    this.name = gp.id;
    this.family = padFamily(gp.id);
  }

  start(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('gamepadconnected', this.onConn);
    window.addEventListener('gamepaddisconnected', this.onDisc);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('gamepadconnected', this.onConn);
    window.removeEventListener('gamepaddisconnected', this.onDisc);
    this.index = -1;
    Object.assign(this.state, emptyPad());
  }

  /** Refresh `state` from the browser; returns true when a pad is connected. */
  poll(): boolean {
    if (!this.listening || typeof navigator === 'undefined' || !navigator.getGamepads) return false;
    const pads = navigator.getGamepads();
    let gp: Gamepad | null = this.index >= 0 ? (pads[this.index] ?? null) : null;
    if (!gp) {
      gp = pads.find((p): p is Gamepad => !!p && p.connected) ?? null;
      if (!gp) {
        this.index = -1;
        return false;
      }
      this.adopt(gp);
    }
    readPad(gp, this.state);
    return true;
  }
}
