/**
 * ED-41 — the Cut tool. Drag a line across the selected bodies (or the body under the start of the line): the
 * plane through the camera and the two ends of the line splits every cuttable body it crosses into two convex
 * chunks with correct masses (src/app/cutTool.ts), as one undo step. Also the command `cut.byAxis`, which halves
 * the selection with the horizontal plane through each body's centre.
 */
import { Vector3 } from 'three';
import { registerCommand, registerTool } from '../../app/registry';
import type { App } from '../../app/app';
import { applyCut, canCut, type CutPlane } from '../../app/cutTool';
import type { Vec3 } from '../../core/math';

const MIN_DRAG_PX = 12;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Plane through the camera and the two ends of a screen-space line (also right for an orthographic camera). */
function planeOfLine(
  app: App,
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): CutPlane | null {
  const oA = app.picker.rayOrigin(a);
  const dA = app.picker.rayDirection(a);
  const oB = app.picker.rayOrigin(b);
  const dB = app.picker.rayDirection(b);
  const p1 = oA.clone().add(dA);
  const p2 = oB.clone().add(dB);
  const n = new Vector3().crossVectors(p1.clone().sub(oA), p2.clone().sub(oA));
  if (n.lengthSq() < 1e-12) return null;
  n.normalize();
  return { point: [oA.x, oA.y, oA.z], normal: [n.x, n.y, n.z] };
}

/** Run the cut and report; shared by the pointer gesture. */
function cutWithLine(app: App, start: PointerEvent, end: { clientX: number; clientY: number }): void {
  if (app.sim.active) return void app.toast('Stop the simulation to cut', 'warn');
  const store = app.store;
  const picked = store.selectedBodies().length ? null : app.pickEntity(start);
  const ids = picked ? [picked.entityId] : store.selectedBodies().map((b) => b.id);
  if (!ids.length) return void app.toast('Select the objects to cut, or start the line on one', 'info');
  if (
    !ids.some((id) => {
      const b = store.body(id);
      return !!b && canCut(b);
    })
  )
    return void app.toast('Locked, hidden and compound bodies cannot be cut', 'warn');
  const plane = planeOfLine(app, start, end);
  if (!plane) return;
  const n = applyCut(store, ids, () => plane);
  if (n === 0) app.toast('The line did not cross a solid body — draw it across the object', 'info');
  else app.toast(n === 1 ? 'Cut into two pieces' : `Cut ${n} bodies in two`, 'info');
}

function pointerDown(app: App, e: PointerEvent): void {
  if (app.sim.active) return void app.toast('Stop the simulation to cut', 'warn');
  const stage = app.shell.stage;
  const rect = stage.getBoundingClientRect();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cut-line');
  svg.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:30;overflow:visible';
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('stroke', '#ff5a5f');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-dasharray', '6 4');
  line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);
  stage.appendChild(svg);
  const set = (x: number, y: number) => {
    line.setAttribute('x1', String(e.clientX - rect.left));
    line.setAttribute('y1', String(e.clientY - rect.top));
    line.setAttribute('x2', String(x - rect.left));
    line.setAttribute('y2', String(y - rect.top));
  };
  set(e.clientX, e.clientY);
  const dom = app.viewport.dom;
  dom.style.cursor = 'crosshair';

  const done = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    svg.remove();
    dom.style.cursor = '';
  };
  const move = (ev: PointerEvent) => set(ev.clientX, ev.clientY);
  const up = (ev: PointerEvent) => {
    done();
    if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < MIN_DRAG_PX) {
      app.toast('Drag a line across the object to cut it', 'info');
      return;
    }
    cutWithLine(app, e, ev);
  };
  const cancel = () => done();
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      done();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}

registerTool({
  id: 'cut',
  group: 'build',
  order: 55,
  label: 'Cut tool',
  title: 'Cut solid bodies in two — drag a line across them',
  icon: 'scissors',
  shortcut: 'K',
  keywords: ['split', 'slice', 'plane'],
  mode: 'cut',
  activate: (app) => app.setTool('cut'),
  isActive: (app) => app.prefs.value.tool === 'cut',
  pointerDown,
  hint: () =>
    '<b>Drag</b> a line across the selected object (or the one you start on) to cut it in two · <b>Esc</b> cancels',
});

registerCommand({
  id: 'cut.byAxis',
  label: 'Cut selection in half (through centre, horizontal)',
  category: 'Edit',
  icon: 'scissors',
  description: 'Split each selected solid body in two with the horizontal plane through its centre',
  keywords: ['split', 'slice', 'halve', 'cut'],
  enabled: (app) => !app.sim.active && app.store.selectedBodies().some(canCut),
  run: ({ app }) => {
    const ids = app.store.selectedBodies().map((b) => b.id);
    const up: Vec3 = [0, 1, 0];
    const n = applyCut(app.store, ids, (b) => ({ point: b.position, normal: up }));
    app.toast(n ? (n === 1 ? 'Cut into two pieces' : `Cut ${n} bodies in half`) : 'Nothing to cut', 'info');
  },
});
