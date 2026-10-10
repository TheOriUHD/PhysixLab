/**
 * SF-2 as a UI extension: the cutting tool (drag a line across cloth or a cable while the simulation runs) and the
 * "tear a hole" command. The line is turned into a cutting triangle — the viewer and two far points on the camera
 * rays through its ends — and sent to the engine, which severs every edge the triangle crosses.
 */
import { registerCommand, registerTool } from '../../app/registry';
import type { App } from '../../app/app';
import type { Vec3 } from '../../core/math';
import { cutTriangle } from './softPick';

const TOOL = 'softcut';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_DRAG_PX = 8;
const SAMPLES = 17;

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  svg: SVGSVGElement;
  line: SVGLineElement;
  off: () => void;
}
let drag: Drag | null = null;

function endDrag(): void {
  if (!drag) return;
  drag.off();
  drag.svg.remove();
  drag = null;
}

function makeOverlay(app: App): { svg: SVGSVGElement; line: SVGLineElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sf-cut-overlay');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'sf-cut-line');
  svg.appendChild(line);
  (app.viewport.dom.parentElement ?? document.body).appendChild(svg);
  return { svg, line };
}

/** Send the cut for every soft body the dragged line crosses. Returns how many soft bodies were cut at. */
function applyCut(app: App, d: Drag): number {
  const dom = app.viewport.dom;
  const rect = dom.getBoundingClientRect();
  // Soft bodies under the line (sampled along it) and how far away the farthest sample of each is.
  const far = new Map<string, number>();
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / (SAMPLES - 1);
    const hit = app.pickEntity(
      { clientX: d.x0 + (d.x1 - d.x0) * t + rect.left, clientY: d.y0 + (d.y1 - d.y0) * t + rect.top },
      { joints: false },
    );
    if (hit && app.store.soft(hit.entityId)) far.set(hit.entityId, Math.max(far.get(hit.entityId) ?? 0, hit.distance));
  }
  if (!far.size) return 0;
  const cam = app.camera.position;
  const origin: Vec3 = [cam.x, cam.y, cam.z];
  const da = app.picker.rayDirection({ clientX: d.x0 + rect.left, clientY: d.y0 + rect.top });
  const db = app.picker.rayDirection({ clientX: d.x1 + rect.left, clientY: d.y1 + rect.top });
  for (const [id, dist] of far) {
    const tri = cutTriangle(origin, [da.x, da.y, da.z], [db.x, db.y, db.z], dist);
    app.sim.client.op({ op: 'cutSoft', id, origin: tri.origin, a: tri.a, b: tri.b });
  }
  return far.size;
}

function pointerDown(app: App, e: PointerEvent): void {
  endDrag();
  if (!app.sim.active) {
    app.toast('Press Space to start the simulation, then drag across the cloth to cut it', 'info');
    return;
  }
  const rect = app.viewport.dom.getBoundingClientRect();
  const { svg, line } = makeOverlay(app);
  const x0 = e.clientX - rect.left,
    y0 = e.clientY - rect.top;
  const move = (ev: PointerEvent): void => {
    if (!drag) return;
    drag.x1 = ev.clientX - rect.left;
    drag.y1 = ev.clientY - rect.top;
    line.setAttribute('x1', String(drag.x0));
    line.setAttribute('y1', String(drag.y0));
    line.setAttribute('x2', String(drag.x1));
    line.setAttribute('y2', String(drag.y1));
  };
  const up = (ev: PointerEvent): void => {
    if (!drag) return;
    move(ev);
    const d = drag;
    endDrag();
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < MIN_DRAG_PX) return;
    if (!app.sim.active) return;
    if (applyCut(app, d) === 0)
      app.toast('The line did not cross a soft body — drag across the cloth or cable', 'warn');
  };
  const cancel = (): void => endDrag();
  const key = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopImmediatePropagation();
      endDrag();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  drag = {
    x0,
    y0,
    x1: x0,
    y1: y0,
    svg,
    line,
    off: () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
    },
  };
}

registerTool({
  id: TOOL,
  group: 'soft',
  order: 63,
  label: 'Cut cloth / cable',
  title: 'Cut — drag a line across cloth or a cable while the simulation runs',
  icon: 'bolt',
  keywords: ['slice', 'scissors', 'tear', 'cloth', 'cable', 'rope'],
  activate: (app) => app.setTool(TOOL),
  isActive: (app) => app.prefs.value.tool === TOOL,
  pointerDown: (app, e) => pointerDown(app, e),
  hint: (app) =>
    app.sim.active
      ? '<b>Cut</b> — drag a line across the cloth or cable · <kbd>Esc</kbd> cancels the drag'
      : 'Press <kbd>Space</kbd> to start the simulation, then drag across the cloth to cut it',
});

registerCommand({
  id: 'soft.tear',
  label: 'Tear a hole in the selected soft body',
  category: 'Soft bodies',
  icon: 'bolt',
  description: 'Severs every edge within 0.2 m of the selected soft body’s centre (while the simulation runs)',
  keywords: ['rip', 'hole', 'cut', 'cloth', 'cable'],
  enabled: (app) => app.sim.active && app.store.selection.some((id) => !!app.store.soft(id)),
  run: ({ app }) => {
    const ids = app.store.selection.filter((id) => !!app.store.soft(id));
    for (const id of ids) {
      const live = app.sim.client.softOf(id);
      let c: Vec3;
      if (live && live.length >= 3) {
        let x = 0,
          y = 0,
          z = 0;
        const n = live.length / 3;
        for (let i = 0; i < live.length; i += 3) {
          x += live[i];
          y += live[i + 1];
          z += live[i + 2];
        }
        c = [x / n, y / n, z / n];
      } else {
        c = app.store.soft(id)?.position ?? [0, 0, 0];
      }
      app.sim.client.op({ op: 'tearSoft', id, point: c, radius: 0.2 });
    }
    app.toast(`Tore ${ids.length === 1 ? 'a hole' : 'holes'} at the centre of the selection`, 'success');
  },
});
