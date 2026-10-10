import type { App } from '../app/app';

/**
 * NAV: keeps the centred transport (Simulate, step, stop, Drive, Play, speed, clock) clear of the menu bar
 * and the right-hand cluster. The transport is absolutely centred, so on a narrower window it used to sit on
 * top of the Help menu. It now slides right, then gives up its least important parts one at a time:
 * the Drive label, the mode chip (Simulate already says it), the clock, the speed buttons.
 */
const STEPS = ['fit-drive', 'fit-chip', 'fit-clock', 'fit-scale'] as const;
const GAP = 12;

export function fitTransport(app: App, topbar: HTMLElement): void {
  const transport = topbar.querySelector<HTMLElement>('.transport');
  const menubar = topbar.querySelector<HTMLElement>('.menubar');
  const chip = topbar.querySelector<HTMLElement>('.mode-chip');
  const right = topbar.querySelector<HTMLElement>('.topbar-right');
  if (!transport || !menubar || !right) return;
  const wide = window.matchMedia('(min-width: 901px)');
  const apply = (n: number) => STEPS.forEach((c, i) => topbar.classList.toggle(c, i < n));

  let frame = 0;
  const fit = () => {
    frame = 0;
    if (!topbar.isConnected) return;
    if (!wide.matches) {
      apply(0);
      topbar.style.removeProperty('--tb-shift');
      return;
    }
    const x0 = topbar.getBoundingClientRect().left;
    const width = topbar.clientWidth;
    let n = 0;
    for (; ; n++) {
      apply(n);
      const chipOn = !!chip && getComputedStyle(chip).display !== 'none';
      const lo = (chipOn ? chip : menubar).getBoundingClientRect().right - x0 + GAP;
      const firstButton = right.querySelector('button');
      const hi = (firstButton ?? right).getBoundingClientRect().left - x0 - GAP;
      const w = transport.offsetWidth;
      if (w <= hi - lo || n === STEPS.length) {
        const centre = Math.min(Math.max(width / 2, lo + w / 2), Math.max(lo + w / 2, hi - w / 2));
        topbar.style.setProperty('--tb-shift', `${Math.round(centre - width / 2)}px`);
        break;
      }
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(fit);
  };

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(schedule);
    ro.observe(topbar);
    ro.observe(menubar);
    ro.observe(right);
  }
  app.sim.on('mode', schedule); // the chip changes width with the mode
  void document.fonts?.ready.then(schedule);
  schedule();
}
