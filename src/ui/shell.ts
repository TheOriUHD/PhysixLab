import type { App, Shell } from '../app/app';
import { DropController } from '../app/edit/dropController';
import { h } from './dom';
import { mountJointOptionsBar } from './jointOptionsBar';

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
  const workspace = h(
    'div',
    { class: 'workspace' },
    leftSlot,
    h('div', { class: 'stage-col' }, stage, dockSlot),
    rightSlot,
  );
  root.append(topSlot, workspace, footSlot);
  return {
    root,
    topSlot,
    leftSlot,
    rightSlot,
    dockSlot,
    footSlot,
    floatSlot,
    hintBar,
    dropHint,
    fpsBadge: h('div'),
    viewportHost,
    stage,
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
  app.prefs.on('change', (k) => {
    if (k.some((x) => x === 'showLeft' || x === 'showRight' || x === 'showBottom')) sync();
  });
  sync();

  mountJointOptionsBar(app, shell.stage); // JT-21: options bar of the joint tool

  app.on('hint', (t) => {
    shell.hintBar.classList.toggle('hidden', !t);
    shell.hintBar.innerHTML = t ?? '';
  });

  // Drag a shape tile or a prefab card from the library into the viewport.
  // -- ED-A snap: the DropController (src/app/edit/dropController.ts) shows a ghost on the surface under the pointer --
  const drops = new DropController(app);
  const host = shell.stage;
  let depth = 0;
  host.addEventListener('dragenter', (e) => {
    if (drops.accepts(e)) {
      depth++;
      shell.dropHint.classList.add('show');
    }
  });
  host.addEventListener('dragleave', (e) => {
    if (!drops.accepts(e)) return;
    if (--depth <= 0) {
      depth = 0;
      shell.dropHint.classList.remove('show');
      drops.leave();
    }
  });
  host.addEventListener('dragover', (e) => {
    if (drops.accepts(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      drops.over(e);
    }
  });
  host.addEventListener('drop', (e) => {
    depth = 0;
    shell.dropHint.classList.remove('show');
    if (!drops.accepts(e)) return;
    e.preventDefault();
    drops.drop(e);
  });
}
