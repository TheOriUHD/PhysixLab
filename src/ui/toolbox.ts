import type { App } from '../app/app';
import { h } from './dom';
import { icon } from './icons';

interface ToolDef { id: string; icon: string; title: string; kbd: string; run: () => void; active: () => boolean }

export function buildToolbox(app: App): { toolbox: HTMLElement; viewbar: HTMLElement; chips: HTMLElement } {
  const { prefs } = app;

  const defs: (ToolDef | 'sep')[] = [
    { id: 'select', icon: 'select', title: 'Select', kbd: 'Q', run: () => app.setGizmo('none'), active: () => prefs.value.tool === 'select' && prefs.value.gizmo === 'none' },
    { id: 'move', icon: 'move', title: 'Move', kbd: 'W', run: () => app.setGizmo('translate'), active: () => prefs.value.tool === 'select' && prefs.value.gizmo === 'translate' },
    { id: 'rotate', icon: 'rotate', title: 'Rotate', kbd: 'E', run: () => app.setGizmo('rotate'), active: () => prefs.value.tool === 'select' && prefs.value.gizmo === 'rotate' },
    { id: 'scale', icon: 'scale', title: 'Scale (resize)', kbd: 'R', run: () => app.setGizmo('scale'), active: () => prefs.value.tool === 'select' && prefs.value.gizmo === 'scale' },
    'sep',
    { id: 'joint', icon: 'joint', title: 'Connect with a joint — click two bodies', kbd: 'J', run: () => app.setTool('joint'), active: () => prefs.value.tool === 'joint' },
    { id: 'measure', icon: 'measure', title: 'Measure distance', kbd: 'M', run: () => app.setTool('measure'), active: () => prefs.value.tool === 'measure' },
    'sep',
    { id: 'blast', icon: 'blast', title: 'Blast — radial impulse (while simulating)', kbd: 'B', run: () => app.setTool('blast'), active: () => prefs.value.tool === 'blast' },
    { id: 'shoot', icon: 'shoot', title: 'Fire projectiles (while simulating)', kbd: 'T', run: () => app.setTool('shoot'), active: () => prefs.value.tool === 'shoot' },
  ];
  const buttons: { def: ToolDef; el: HTMLButtonElement }[] = [];
  const toolbox = h('div', { class: 'floating toolbox' });
  for (const d of defs) {
    if (d === 'sep') { toolbox.appendChild(h('hr')); continue; }
    const b = h('button', { class: 'icon-btn', type: 'button', title: `${d.title} (${d.kbd})`, dataset: { tool: d.id } }, icon(d.icon));
    b.addEventListener('click', d.run);
    buttons.push({ def: d, el: b });
    toolbox.appendChild(b);
  }
  toolbox.appendChild(h('hr'));
  const snapBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Grid snapping (G)' }, icon('magnet'));
  snapBtn.addEventListener('click', () => prefs.set({ snap: !prefs.value.snap }));
  const gridBtn = h('button', { class: 'icon-btn opt-btn', type: 'button', title: 'Snap grid size — click to cycle' });
  const grids = [0.05, 0.1, 0.25, 0.5, 1];
  gridBtn.addEventListener('click', () => {
    const i = grids.indexOf(prefs.value.snapGrid);
    prefs.set({ snapGrid: grids[(i + 1) % grids.length] });
  });
  const spaceBtn = h('button', { class: 'icon-btn opt-btn', type: 'button', title: 'Gizmo space: world / local (X)' });
  spaceBtn.addEventListener('click', () => prefs.set({ space: prefs.value.space === 'world' ? 'local' : 'world' }));
  toolbox.append(snapBtn, gridBtn, spaceBtn);

  const sync = () => {
    for (const { def, el } of buttons) el.classList.toggle('on', def.active());
    snapBtn.classList.toggle('on', prefs.value.snap);
    gridBtn.textContent = `${prefs.value.snapGrid}`;
    gridBtn.classList.toggle('on', prefs.value.snap);
    spaceBtn.textContent = prefs.value.space === 'world' ? 'World' : 'Local';
  };
  prefs.on('change', sync);
  sync();

  // ---- view bar ---------------------------------------------------------------------------------
  const vb = h('div', { class: 'floating viewbar' });
  const toggle = (ic: string, title: string, get: () => boolean, set: () => void) => {
    const b = h('button', { class: 'icon-btn', type: 'button', title }, icon(ic));
    b.addEventListener('click', set);
    const s = () => b.classList.toggle('on', get());
    prefs.on('change', s);
    s();
    return b;
  };
  vb.append(
    toggle('velocity', 'Velocity vectors', () => prefs.value.overlays.velocity, () => prefs.setOverlay({ velocity: !prefs.value.overlays.velocity })),
    toggle('force', 'Net force vectors (m·Δv/Δt)', () => prefs.value.overlays.force, () => prefs.setOverlay({ force: !prefs.value.overlays.force })),
    toggle('contact', 'Contact points & forces', () => prefs.value.overlays.contacts, () => prefs.setOverlay({ contacts: !prefs.value.overlays.contacts })),
    toggle('com', 'Centres of mass', () => prefs.value.overlays.com, () => prefs.setOverlay({ com: !prefs.value.overlays.com })),
    toggle('trail', 'Motion trails (selected → all → off)', () => prefs.value.overlays.trails !== 'off', () => {
      const t = prefs.value.overlays.trails;
      prefs.setOverlay({ trails: t === 'off' ? 'selected' : t === 'selected' ? 'all' : 'off' });
      app.toast(`Trails: ${prefs.value.overlays.trails}`);
    }),
    h('span', { class: 'sep' }),
    toggle('joints', 'Show joints & constraints', () => prefs.value.showJoints, () => prefs.set({ showJoints: !prefs.value.showJoints })),
    toggle('follow', 'Camera follows selection (C)', () => prefs.value.followSelection, () => prefs.set({ followSelection: !prefs.value.followSelection })),
    h('span', { class: 'sep' }),
  );
  const frame = h('button', { class: 'icon-btn', type: 'button', title: 'Frame selection / everything (F · Home)' }, icon('frame'));
  frame.addEventListener('click', () => app.frameSelection());
  vb.appendChild(frame);

  // ---- mode chips (top-left, next to toolbox) -----------------------------------------------------
  const chips = h('div', { class: 'stage-chip' });
  return { toolbox, viewbar: vb, chips };
}
