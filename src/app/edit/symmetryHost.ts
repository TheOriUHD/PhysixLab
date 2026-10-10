/**
 * ED-11: the one `Symmetry` per `App`, created on first use. It owns the viewport indicator of the mirror plane and
 * remembers the chosen plane (axis + offset) in the browser — a per-viewer convenience, not part of the scene.
 */
import { MirrorPlaneView } from '../../render/editGhosts';
import { isBody } from '../../model/types';
import type { App } from '../app';
import { Symmetry } from './symmetry';
import type { Axis } from '../../model/edit/mirror';

const KEY = 'physicslab:ed:symmetryPlane';
const hosts = new WeakMap<App, Symmetry>();

function loadPlane(): { axis: Axis; offset: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { axis?: unknown; offset?: unknown } | null;
    const axis = raw?.axis === 0 || raw?.axis === 1 || raw?.axis === 2 ? raw.axis : 0;
    const offset = typeof raw?.offset === 'number' && Number.isFinite(raw.offset) ? raw.offset : 0;
    return { axis, offset };
  } catch {
    return { axis: 0, offset: 0 };
  }
}

function savePlane(axis: Axis, offset: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ axis, offset }));
  } catch {
    /* private window or blocked storage: the plane is simply not remembered */
  }
}

export function getSymmetry(app: App): Symmetry {
  const have = hosts.get(app);
  if (have) return have;
  const sym = new Symmetry({ store: app.store, simActive: () => app.sim.active, notify: (m, k) => app.toast(m, k) });
  const saved = loadPlane();
  sym.axis = saved.axis;
  sym.offset = saved.offset;
  const view = new MirrorPlaneView(app.viewport.helpers);
  let queued = false;
  const redraw = () => {
    queued = false;
    if (!sym.enabled) {
      view.hide();
    } else {
      // Size the plane to the scene: the bodies' extent around the plane, never smaller than the ground grid's core.
      let lo: [number, number, number] = [Infinity, Infinity, Infinity];
      let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const b of app.store.all()) {
        if (!isBody(b)) continue;
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], b.position[k]);
          hi[k] = Math.max(hi[k], b.position[k]);
        }
      }
      if (lo[0] === Infinity) {
        lo = [-4, 0, -4];
        hi = [4, 4, 4];
      }
      const centre: [number, number, number] = [
        (lo[0] + hi[0]) / 2,
        Math.max(0, (lo[1] + hi[1]) / 2),
        (lo[2] + hi[2]) / 2,
      ];
      const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      view.update(sym.axis, sym.offset, centre, Math.max(10, span * 1.4 + 4));
    }
    app.viewport.needsRender = true;
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(redraw);
  };
  sym.on('change', () => {
    savePlane(sym.axis, sym.offset);
    queue();
    // The toolbox chips follow the preferences' change event; nothing in them changed, but they re-read their state.
    app.prefs.emit('change', []);
  });
  // Bodies appear, move and vanish while the mode is on: keep the plane sized to them (coalesced per frame).
  app.store.on('change', () => {
    if (sym.enabled) queue();
  });
  hosts.set(app, sym);
  return sym;
}
