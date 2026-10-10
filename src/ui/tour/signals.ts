/**
 * UI-40: turns the app's events into `WaitSignal`s, so a tour step (`waitFor`) and a context hint (`trigger`) can
 * wait for "the user did X" without each knowing where X is announced.
 */
import type { App } from '../../app/app';
import { onCommandRun } from '../../app/registry/commands';
import type { WaitSignal } from './tourLogic';

/** Call `cb` for every user action the guide knows about. Returns the function that stops listening. */
export function observeSignals(app: App, cb: (signal: WaitSignal) => void): () => void {
  const offs: (() => void)[] = [];
  offs.push(onCommandRun((id) => cb({ event: 'command', id })));
  offs.push(app.store.on('selection', (ids) => cb({ event: 'selection', count: ids.length })));
  offs.push(app.sim.on('mode', (mode) => cb({ event: 'sim-mode', mode })));
  offs.push(app.store.on('change', (c) => cb({ event: 'scene-change', type: c.type })));
  const onClick = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    cb({ event: 'click', matches: (selector) => !!t?.closest(selector) });
  };
  // Capture phase: the click is seen even when the clicked control stops its propagation.
  document.addEventListener('click', onClick, true);
  offs.push(() => document.removeEventListener('click', onClick, true));
  return () => offs.forEach((off) => off());
}
