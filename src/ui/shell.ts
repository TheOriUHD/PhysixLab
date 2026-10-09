import type { App, Shell } from '../app/app';
import { defaultSize, SHAPE_LABELS } from '../model/shapes';
import type { ShapeType } from '../model/types';
import { h } from './dom';

export interface ShellDom extends Shell {
  root: HTMLElement;
  topSlot: HTMLElement;
  leftSlot: HTMLElement;
  rightSlot: HTMLElement;
  dockSlot: HTMLElement;
  footSlot: HTMLElement;
  floatSlot: HTMLElement;
  hintBar: HTMLElement;
  dropHint: HTMLElement;
  fpsBadge: HTMLElement;
}

/** Create the static page skeleton; panels are mounted into the slots after the App exists. */
export function createShell(root: HTMLElement): ShellDom {
  const topSlot = h('div', { style: { display: 'contents' } });
  const leftSlot = h('div', { style: { display: 'contents' } });
  const rightSlot = h('div', { style: { display: 'contents' } });
  const dockSlot = h('div', { style: { display: 'contents' } });
  const footSlot = h('div', { style: { display: 'contents' } });
  const viewportHost = h('div', { class: 'viewport-host' });
  const floatSlot = h('div', { style: { display: 'contents' } });
  const hintBar = h('div', { class: 'hint-bar hidden' });
  const dropHint = h('div', { class: 'drop-hint' }, 'Drop to place the shape');
  const stage = h('div', { class: 'stage' }, viewportHost, floatSlot, hintBar, dropHint);
  const workspace = h('div', { class: 'workspace' }, leftSlot, h('div', { class: 'stage-col' }, stage, dockSlot), rightSlot);
  root.append(topSlot, workspace, footSlot);
  return {
    root, topSlot, leftSlot, rightSlot, dockSlot, footSlot, floatSlot, hintBar, dropHint, fpsBadge: h('div'),
    viewportHost, stage,
  };
}

/** Bind panel visibility + hint bar + drag&drop to the app. */
export function wireShell(app: App, shell: ShellDom): void {
  const sync = () => {
    const p = app.prefs.value;
    shell.root.classList.toggle('no-left', !p.showLeft);
    shell.root.classList.toggle('no-right', !p.showRight);
    requestAnimationFrame(() => app.viewport.resize());
  };
  app.prefs.on('change', (k) => { if (k.some((x) => x === 'showLeft' || x === 'showRight' || x === 'showBottom')) sync(); });
  sync();

  app.on('hint', (t) => {
    shell.hintBar.classList.toggle('hidden', !t);
    shell.hintBar.innerHTML = t ?? '';
  });

  // Drag a shape tile from the library into the viewport.
  const host = shell.stage;
  let depth = 0;
  host.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('text/x-physicslab-shape')) { depth++; shell.dropHint.classList.add('show'); } });
  host.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; shell.dropHint.classList.remove('show'); } });
  host.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-physicslab-shape')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  host.addEventListener('drop', (e) => {
    depth = 0;
    shell.dropHint.classList.remove('show');
    const type = e.dataTransfer?.getData('text/x-physicslab-shape');
    if (!type) return;
    e.preventDefault();
    if (!(type in SHAPE_LABELS)) return;
    const t = type as ShapeType;
    app.addShape(t, app.placementAt(e, t, defaultSize(t)));
  });
}
