/**
 * The joint tool's options bar (JT-21): a compact floating strip over the viewport, shown only while the joint tool
 * is active. Type, axis (from the first click's face normal, or a fixed world axis), quick limits for hinges and
 * sliders, snapping, "collide connected", chain mode and "Connect all" for the selected bodies. Every choice is a
 * preference (`src/app/prefs.ts`), so it is remembered; the strip carries no state of its own.
 */
import type { App } from '../app/app';
import { JOINT_ITEMS } from '../app/addCatalog';
import { connectSelected, jointOptions } from '../app/jointTool';
import {
  AXIS_CHOICES,
  AXIS_CHOICE_LABELS,
  CONNECT_MODES,
  limitPresetsFor,
  type AxisChoice,
  type ConnectMode,
} from '../model/jointDefaults';
import { AXIS_TYPES } from '../model/jointParams';
import type { JointType } from '../model/types';
import { h } from './dom';
import { icon } from './icons';

const AXIS_TITLES: Record<AxisChoice, string> = {
  auto: 'Auto: the face normal under the first click (a cylinder’s own axle for round bodies)',
  x: 'World X axis',
  y: 'World Y axis',
  z: 'World Z axis',
  normal: 'Always the face normal under the first click',
};

function group(label: string, ...children: (Node | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'jo-group', role: 'group', 'aria-label': label },
    h('span', { class: 'jo-label' }, label),
    children,
  );
}

function toggle(label: string, title: string, onClick: () => void, iconName?: string): HTMLButtonElement {
  const b = h(
    'button',
    { class: 'jo-btn', type: 'button', title, 'aria-label': title, 'aria-pressed': 'false' },
    iconName ? icon(iconName) : null,
    h('span', null, label),
  );
  b.addEventListener('click', onClick);
  return b;
}

/** Build the options bar into `host` (the viewport stage) and keep it in step with the preferences. */
export function mountJointOptionsBar(app: App, host: HTMLElement): HTMLElement {
  const prefs = app.prefs;

  const typeSel = h(
    'select',
    { class: 'jo-select', 'aria-label': 'Joint type', title: 'Joint type to create' },
    JOINT_ITEMS.map((j) => h('option', { value: j.type, title: j.blurb }, j.label)),
  );
  typeSel.addEventListener('change', () => {
    app.cancelJointDraft();
    prefs.set({ jointType: typeSel.value as JointType });
    app.updateToolHint();
  });

  const axisBtns = AXIS_CHOICES.map((c) => {
    const b = h(
      'button',
      {
        class: 'jo-seg',
        type: 'button',
        title: AXIS_TITLES[c],
        'aria-label': `Axis: ${AXIS_TITLES[c]}`,
        dataset: { value: c },
      },
      AXIS_CHOICE_LABELS[c],
    );
    b.addEventListener('click', () => prefs.set({ jointAxis: c }));
    return b;
  });
  const axisGroup = group('Axis', h('div', { class: 'jo-segs' }, axisBtns));

  const limitSel = h('select', { class: 'jo-select', 'aria-label': 'Limits', title: 'Quick limits for the new joint' });
  limitSel.addEventListener('change', () => prefs.set({ jointLimit: limitSel.value }));
  const limitGroup = group('Limits', limitSel);

  const snapBtn = toggle(
    'Snap',
    'Snap anchors to a body’s centre, face centres, edge midpoints and corners',
    () => prefs.set({ jointSnap: !prefs.value.jointSnap }),
    'magnet',
  );
  const collideBtn = toggle('Collide', 'Let the two connected bodies collide with each other', () =>
    prefs.set({ jointCollide: !prefs.value.jointCollide }),
  );
  const chainBtn = toggle(
    'Chain',
    'Chain mode: each click continues from the body just joined. Enter or double-click finishes; the chain is one undo step',
    () => prefs.set({ jointChain: !prefs.value.jointChain }),
  );

  const modeSel = h(
    'select',
    { class: 'jo-select', 'aria-label': 'Connect all mode', title: 'How Connect all pairs the selected bodies' },
    CONNECT_MODES.map((m) => h('option', { value: m.value, title: m.title }, m.label)),
  );
  modeSel.addEventListener('change', () => prefs.set({ jointConnect: modeSel.value as ConnectMode }));
  const connectBtn = h(
    'button',
    {
      class: 'jo-btn primary',
      type: 'button',
      title: 'Join the selected bodies with the chosen joint type (one undo step)',
      'aria-label': 'Connect all selected bodies',
    },
    h('span', null, 'Connect all'),
  );
  connectBtn.addEventListener('click', () => connectSelected(app));

  const bar = h(
    'div',
    { class: 'floating joint-options hidden', role: 'toolbar', 'aria-label': 'Joint tool options' },
    group('Type', typeSel),
    axisGroup,
    limitGroup,
    h('div', { class: 'jo-group' }, snapBtn, collideBtn, chainBtn),
    h('div', { class: 'jo-group' }, modeSel, connectBtn),
  );
  // The strip must not start a selection box or orbit when it is clicked.
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  host.appendChild(bar);

  const bodies = (): number => app.store.selection.filter((id) => !!app.store.body(id)).length;

  const sync = (): void => {
    const o = jointOptions(prefs.value);
    const on = prefs.value.tool === 'joint';
    bar.classList.toggle('hidden', !on);
    if (!on) return;
    typeSel.value = o.type;
    for (const b of axisBtns) {
      const pressed = b.dataset.value === o.axis;
      b.classList.toggle('on', pressed);
      b.setAttribute('aria-pressed', String(pressed));
    }
    const usesAxis = AXIS_TYPES.includes(o.type);
    axisGroup.classList.toggle('disabled', !usesAxis);
    for (const b of axisBtns) b.disabled = !usesAxis;
    const presets = limitPresetsFor(o.type);
    limitGroup.classList.toggle('hidden', presets.length === 0);
    if (presets.length) {
      limitSel.replaceChildren(...presets.map((p) => h('option', { value: p.id }, p.label)));
      limitSel.value = presets.some((p) => p.id === o.limit) ? o.limit : 'off';
    }
    const flag = (b: HTMLButtonElement, v: boolean) => {
      b.classList.toggle('on', v);
      b.setAttribute('aria-pressed', String(v));
    };
    flag(snapBtn, o.snap);
    flag(collideBtn, o.collide);
    flag(chainBtn, o.chain);
    modeSel.value = o.connect;
    const n = bodies();
    connectBtn.disabled = n < 2 || app.sim.active;
    connectBtn.title =
      n < 2
        ? 'Select two or more bodies (Shift+click) to connect them all at once'
        : `Join the ${n} selected bodies with ${o.type} joints (one undo step)`;
  };
  prefs.on('change', sync);
  app.store.on('selection', sync);
  app.sim.on('mode', sync);
  sync();
  return bar;
}
