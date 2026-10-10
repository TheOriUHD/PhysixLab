/** Is the primary input touch? (`(pointer: coarse)` or any touch points; used by `touchControls: auto` and by hints.) */
export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}
