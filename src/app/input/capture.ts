/**
 * Capturing "the next key or pad button" for any rebinding field (Settings › Keyboard, the inspector's motor and
 * thruster keys), and naming a stored key code for display. Everything that binds a key goes through here so
 * keyboard and gamepad behave the same in every field.
 */
import { isPadKeyCode, padButtonOfKeyCode, padLabel, type PadFamily } from './gamepad';

export interface CaptureHost {
  /** Start watching the pad for the next button press; returns the stop function. */
  watchPad(onButton: (code: string) => void): () => void;
  padFamily(): PadFamily;
}

let host: CaptureHost | null = null;
export const setCaptureHost = (h: CaptureHost | null): void => {
  host = h;
};

/**
 * Wait for the next key (or pad button) and report its code; `Escape` reports `''` (clear). Returns the function
 * that stops listening. The event is swallowed so it never reaches shortcuts.
 */
export function captureKey(onKey: (code: string) => void, opts: { allowModifiers?: boolean } = {}): () => void {
  let stopPad: (() => void) | null = null;
  const stop = (): void => {
    window.removeEventListener('keydown', onDown, true);
    stopPad?.();
    stopPad = null;
  };
  const finish = (code: string): void => {
    stop();
    onKey(code);
  };
  function onDown(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!opts.allowModifiers && /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code) === false) {
      /* any ordinary key */
    }
    finish(e.code === 'Escape' ? '' : e.code);
  }
  window.addEventListener('keydown', onDown, true);
  stopPad = host?.watchPad(finish) ?? null;
  return stop;
}

/** A stored key code as a short label: `W`, `↑`, `Space`, `Cross` / `A` for pad buttons (by the connected controller). */
export function describeKey(code: string, keyLabel: (code: string) => string): string {
  const b = padButtonOfKeyCode(code);
  if (b) return padLabel(b, host?.padFamily() ?? 'xbox');
  return keyLabel(code);
}

export { isPadKeyCode };
