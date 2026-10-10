/**
 * Platform awareness for navigation and hints: which operating system this is, which pointing device the user is
 * working with (mouse, trackpad or touch screen), and how to print modifier keys for it (Cmd / Option on a Mac,
 * Ctrl / Alt elsewhere). Pure functions first (unit-tested without a DOM), then a small stateful `PlatformState`
 * that learns the pointing device from the wheel events it sees.
 *
 * Why the wheel: a trackpad and a mouse wheel both arrive as `wheel` events, but they look different. A pinch is a
 * wheel event with `ctrlKey` set and small fractional deltas; a two-finger swipe has pixel deltas on two axes, in
 * bursts, with `wheelDeltaY` that is not a multiple of 120; a mouse wheel gives isolated large notches (multiples of
 * 100 / 120 pixels, or lines in Firefox). Safari additionally sends `gesturestart / change / end` for pinches.
 */

export type OsKind = 'mac' | 'windows' | 'linux' | 'ios' | 'android' | 'other';
export type PointerKind = 'mouse' | 'trackpad' | 'touch';
/** The user's choice in Settings › Navigation: let the app work it out, or force a device. */
export type PointerChoice = 'auto' | PointerKind;

export interface NavigatorInfo {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  /** `navigator.userAgentData.platform` when the browser has it. */
  uaDataPlatform?: string;
}

/** The operating system, from the navigator fields (iPadOS reports itself as a Mac with touch points). */
export function detectOs(info: NavigatorInfo): OsKind {
  const ua = (info.userAgent ?? '').toLowerCase();
  const plat = (info.uaDataPlatform || info.platform || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua) || /iphone|ipad|ipod/.test(plat)) return 'ios';
  if (/android/.test(ua) || plat === 'android') return 'android';
  if (/mac/.test(plat) || (!plat && /mac os x/.test(ua))) return (info.maxTouchPoints ?? 0) > 1 ? 'ios' : 'mac';
  if (/win/.test(plat) || (!plat && /windows/.test(ua))) return 'windows';
  if (/linux|x11|cros|ubuntu|fedora|debian/.test(plat) || (!plat && /linux|x11|cros/.test(ua))) return 'linux';
  return 'other';
}

/** Is this an Apple platform, where Cmd / Option are the working modifiers? */
export const isApple = (os: OsKind): boolean => os === 'mac' || os === 'ios';

/**
 * The pointing device to assume before any wheel has been seen: phones and tablets are touch, Macs are mostly
 * laptops (a trackpad; a mouse proves itself on the first notch), everything else a mouse.
 */
export function defaultPointer(os: OsKind, hints: { coarse?: boolean; hover?: boolean } = {}): PointerKind {
  if (os === 'ios' || os === 'android') return 'touch';
  if (os === 'mac') return 'trackpad';
  if (hints.coarse && hints.hover === false) return 'touch';
  return 'mouse';
}

/** The device navigation follows: the user's override, else what was detected. */
export function resolvePointer(choice: PointerChoice, detected: PointerKind): PointerKind {
  return choice === 'auto' ? detected : choice;
}

// ---- wheel events --------------------------------------------------------------------------------------------------

/** The `WheelEvent` fields the classifier reads (so it can be tested without a DOM). */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  /** The legacy field: a multiple of 120 for a mouse notch, `-3 × deltaY` for a trackpad on Chrome / Mac. */
  wheelDeltaY?: number;
  timeStamp?: number;
}

/** `pinch`: a pinch gesture (or Ctrl + wheel); otherwise the device the scroll came from. */
export type WheelKind = 'pinch' | 'trackpad' | 'mouse';

/**
 * Learns the pointing device from a stream of wheel events. Each event adds a little evidence (positive =
 * trackpad, negative = mouse) to a decaying score, so a single odd event never flips the answer but a few do.
 */
export class WheelClassifier {
  private score = 0;
  private lastT = -1e9;
  private burst = 0;

  /** Evidence of one event in −1 … 1 (positive = trackpad), given the time since the previous event. */
  static evidence(e: WheelLike, dt: number, burst: number): number {
    const ay = Math.abs(e.deltaY);
    const ax = Math.abs(e.deltaX);
    if (e.ctrlKey) {
      // A pinch is small and fractional; Ctrl held while turning a mouse wheel gives whole 100 / 120 px notches.
      return Number.isInteger(e.deltaY) && ay >= 50 ? -0.6 : 0.8;
    }
    if (e.deltaMode !== 0) return -1; // lines or pages: Firefox with a mouse wheel
    if (ax > 0 && ay > 0) return 1; // two axes at once: only a finger does that
    const wd = e.wheelDeltaY;
    if (wd !== undefined && wd !== 0) {
      if (wd % 120 === 0 && ay >= 4) return -0.9;
      if (wd % 120 !== 0) return 0.7;
    }
    if (!Number.isInteger(e.deltaY) && !Number.isInteger(e.deltaX)) return 0.8;
    if (burst >= 3 && ay < 40) return 0.6; // a stream of small steps: a finger gliding
    if (ay >= 50 && dt > 60 && Number.isInteger(e.deltaY)) return -0.5; // an isolated big notch
    return 0;
  }

  /** Feed one event; returns what it is (pinch / trackpad scroll / mouse scroll). */
  push(e: WheelLike, t: number = e.timeStamp ?? 0): WheelKind {
    const dt = t - this.lastT;
    this.burst = dt < 50 ? this.burst + 1 : 0;
    this.lastT = t;
    const ev = WheelClassifier.evidence(e, dt, this.burst);
    this.score = this.score * 0.75 + ev * 0.5;
    if (e.ctrlKey) return 'pinch';
    return this.device('mouse');
  }

  /** The device the events so far point to (`fallback` while there is no evidence either way). */
  device(fallback: 'mouse' | 'trackpad'): 'mouse' | 'trackpad' {
    return this.score > 0.15 ? 'trackpad' : this.score < -0.15 ? 'mouse' : fallback;
  }

  get confidence(): number {
    return Math.min(1, Math.abs(this.score));
  }

  reset(): void {
    this.score = 0;
    this.burst = 0;
    this.lastT = -1e9;
  }
}

/** Safari's `gesturechange` reports the pinch as a total scale since `gesturestart`; this turns it into steps. */
export class GestureTracker {
  private prev = 1;
  private rot = 0;
  active = false;

  start(): void {
    this.prev = 1;
    this.rot = 0;
    this.active = true;
  }

  /** Scale factor since the last call (1 = unchanged) and the rotation step in degrees. */
  change(scale: number, rotationDeg = 0): { factor: number; rotation: number } {
    const s = Number.isFinite(scale) && scale > 0 ? scale : this.prev;
    const factor = s / this.prev;
    const rotation = rotationDeg - this.rot;
    this.prev = s;
    this.rot = rotationDeg;
    return { factor, rotation };
  }

  end(): void {
    this.active = false;
  }
}

// ---- modifier names and key caps ---------------------------------------------------------------------------------------

export interface ModNames {
  /** The shortcut modifier: Cmd on Apple, Ctrl elsewhere. */
  mod: string;
  alt: string;
  shift: string;
  ctrl: string;
}

export function modNames(os: OsKind): ModNames {
  return isApple(os)
    ? { mod: 'Cmd', alt: 'Option', shift: 'Shift', ctrl: 'Control' }
    : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl' };
}

const CODE_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Del',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Minus: '−',
  Equal: '+',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadDecimal: 'Num .',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/** What is printed on the key for a `KeyboardEvent.code`: `KeyW` → `W`, `ArrowUp` → `↑`, `AltLeft` → `Option`. */
export function keyCapLabel(code: string, os: OsKind): string {
  const m = modNames(os);
  if (/^(Shift)(Left|Right)$/.test(code)) return m.shift;
  if (/^Alt(Left|Right)$/.test(code)) return m.alt;
  if (/^Control(Left|Right)$/.test(code)) return m.ctrl;
  if (/^Meta(Left|Right)$/.test(code)) return isApple(os) ? 'Cmd' : 'Win';
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  let r = /^Key([A-Z])$/.exec(code);
  if (r) return r[1];
  r = /^Digit(\d)$/.exec(code);
  if (r) return r[1];
  r = /^Numpad(\d)$/.exec(code);
  if (r) return `Num ${r[1]}`;
  if (/^Pad[A-Za-z]+$/.test(code)) return code.slice(3); // gamepad buttons published as keys
  return code;
}

/** Fill the `{mod} {alt} {shift} {ctrl}` placeholders of a hint with this platform's names. */
export function fillMods(text: string, os: OsKind): string {
  const m = modNames(os);
  return text.replace(/\{(mod|alt|shift|ctrl)\}/g, (_, k: keyof ModNames) => m[k]);
}

// ---- the runtime state ---------------------------------------------------------------------------------------------

export function readNavigatorInfo(): NavigatorInfo {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return {
    platform: nav.platform,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    uaDataPlatform: nav.userAgentData?.platform,
  };
}

function mediaHints(): { coarse: boolean; hover: boolean } {
  if (typeof matchMedia !== 'function') return { coarse: false, hover: true };
  return { coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches };
}

/** The OS and the pointing device the user is on right now. */
export class PlatformState {
  readonly os: OsKind;
  private readonly classifier = new WheelClassifier();
  private touchSeenAt = -1e9;
  /** Best guess before / without evidence. */
  private guess: PointerKind;
  readonly gestures = new GestureTracker();

  constructor(info: NavigatorInfo = readNavigatorInfo(), hints = mediaHints()) {
    this.os = detectOs(info);
    this.guess = defaultPointer(this.os, hints);
  }

  /** Classify a wheel event and remember what it says about the device. */
  noteWheel(e: WheelLike, t?: number): WheelKind {
    return this.classifier.push(e, t ?? e.timeStamp ?? 0);
  }

  /** A touch pointer was seen (a hybrid laptop's screen); a mouse or pen pointer clears that. */
  notePointer(type: string, t: number): void {
    if (type === 'touch') this.touchSeenAt = t;
  }

  /** The detected device: touch while a finger was just seen, else mouse / trackpad from the wheel evidence. */
  get detected(): PointerKind {
    const fallback = this.guess === 'touch' ? 'mouse' : this.guess;
    const wheel = this.classifier.device(fallback);
    if (this.guess === 'touch' && this.classifier.confidence < 0.3) return 'touch';
    return wheel;
  }

  /** Same, but touch only while a finger is down or was a moment ago (for per-event decisions). */
  fingerRecently(t: number, windowMs = 1500): boolean {
    return t - this.touchSeenAt < windowMs;
  }

  /** The device navigation follows, given the user's override from Settings › Navigation. */
  pointer(choice: PointerChoice): PointerKind {
    return resolvePointer(choice, this.detected);
  }

  get mod(): ModNames {
    return modNames(this.os);
  }

  label(code: string): string {
    return keyCapLabel(code, this.os);
  }

  fill(text: string): string {
    return fillMods(text, this.os);
  }

  /** A short description for Settings › Navigation: "macOS · trackpad". */
  describe(choice: PointerChoice): string {
    const names: Record<OsKind, string> = {
      mac: 'macOS',
      windows: 'Windows',
      linux: 'Linux',
      ios: 'iPadOS / iOS',
      android: 'Android',
      other: 'an unknown system',
    };
    const dev = this.detected;
    return choice === 'auto' ? `${names[this.os]} · ${dev} (detected)` : `${names[this.os]} · ${choice} (your choice)`;
  }
}

let shared: PlatformState | null = null;

/** The one platform state of the page (created on first use). */
export function platform(): PlatformState {
  return (shared ??= new PlatformState());
}

/** Tests install a state built from fixed navigator fields. */
export function setPlatformForTests(p: PlatformState | null): void {
  shared = p;
}
