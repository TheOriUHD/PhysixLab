/** The user's "reduce motion" operating-system setting, tracked live. Used by effects that flash or shake. */
let query: MediaQueryList | null = null;
let reduced = false;
const listeners = new Set<(reduced: boolean) => void>();

function init(): void {
  if (query || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  query = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduced = query.matches;
  query.addEventListener('change', (e) => {
    reduced = e.matches;
    for (const fn of [...listeners]) fn(reduced);
  });
}

export function prefersReducedMotion(): boolean {
  init();
  return reduced;
}

/** Call `fn` whenever the setting changes. Returns the unsubscribe function. */
export function onReducedMotionChange(fn: (reduced: boolean) => void): () => void {
  init();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
