/**
 * The Arrange panel: align, distribute, drop, stack, centre, randomise and the pivot controls. Every button runs a
 * registered command (`arrange.*`, `pivot.*`), so the panel, the menus, the palette and the shortcuts are one path.
 */
import type { App } from '../app/app';
import { arrangeSettings } from '../app/edit/arrangeOps';
import { onPivotState, pivotState } from '../app/edit/pivotState';
import { runCommand } from '../app/registry/commands';
import { PIVOT_MODES, type PivotMode } from '../model/edit/pivot';
import { button, numberField, row, rowStack, section, segmented, toggleField, vec3Field } from './controls';
import { h } from './dom';

const AXES = ['x', 'y', 'z'] as const;
const run = (app: App, id: string) => () => runCommand(id, app, 'button');

export function buildArrangePanel(app: App): { el: HTMLElement; refresh: () => void; dispose: () => void } {
  const el = h('div', { class: 'panel-body ed-arrange' });
  const refreshers: (() => void)[] = [];
  const buttons: { b: HTMLButtonElement; min: number }[] = [];
  const act = (label: string, id: string, min = 1, title?: string, icon?: string) => {
    const b = button(label, run(app, id), { title: title ?? label, icon });
    b.dataset.cmd = id;
    buttons.push({ b, min });
    return b;
  };

  const summary = h('div', { class: 'arrange-summary' });
  refreshers.push(() => {
    const n = app.store.selection.length;
    summary.textContent = app.sim.active
      ? 'Reset the simulation to arrange objects'
      : n === 0
        ? 'Select objects to arrange them'
        : `${n} selected${n < 3 ? ' · distribute needs 3' : ''}`;
    for (const { b, min } of buttons) b.disabled = app.sim.active || n < min;
  });

  // ── align ──
  const target = segmented<'selection' | 'active'>({
    options: [
      { value: 'selection', label: 'Selection', title: 'Align to the bounds of the whole selection' },
      { value: 'active', label: 'Active', title: 'Align to the active (last selected) object, which stays put' },
    ],
    value: arrangeSettings.alignTarget,
    compact: true,
    onChange: (v) => (arrangeSettings.alignTarget = v),
  });
  const alignGrid = h('div', { class: 'arrange-grid' });
  for (const a of AXES) {
    alignGrid.append(h('span', { class: `arrange-axis axis-${a}` }, a.toUpperCase()));
    for (const [m, label] of [
      ['min', 'Min'],
      ['centre', 'Centre'],
      ['max', 'Max'],
    ] as const)
      alignGrid.append(
        act(label, `arrange.align.${a}.${m}`, 1, `Align ${a.toUpperCase()}: ${label.toLowerCase()} edges`),
      );
  }
  const alignSec = section('Align', [rowStack('Align to', target.el), alignGrid], { id: 'arrange-align' });

  // ── distribute ──
  const distGrid = h('div', { class: 'arrange-grid two' });
  for (const a of AXES) {
    distGrid.append(h('span', { class: `arrange-axis axis-${a}` }, a.toUpperCase()));
    distGrid.append(act('Even spacing', `arrange.distribute.${a}.spacing`, 3, 'Equal distance between centres'));
    distGrid.append(act('Even gaps', `arrange.distribute.${a}.gaps`, 3, 'Equal empty space between bounds'));
  }
  const distSec = section('Distribute', [distGrid], { id: 'arrange-distribute' });

  // ── place ──
  const placeSec = section(
    'Place',
    [
      h(
        'div',
        { class: 'row-actions wrap' },
        act('Drop to ground', 'arrange.dropGround', 1, 'Lower or raise each object until it touches the ground (End)'),
        act(
          'Drop onto surface',
          'arrange.dropSurface',
          1,
          'Rest each object on the highest body below it, else the ground',
        ),
      ),
      h(
        'div',
        { class: 'row-actions wrap' },
        act('Centre on origin', 'arrange.centreOrigin', 1, 'Centre the selection on X, Y and Z'),
        act('Centre XZ', 'arrange.centreOriginXZ', 1, 'Centre the selection on X and Z, keep the height'),
      ),
    ],
    { id: 'arrange-place' },
  );

  // ── stack ──
  const gap = numberField({
    value: arrangeSettings.stackGap,
    step: 0.05,
    min: -10,
    max: 100,
    unit: 'm',
    onChange: (v) => (arrangeSettings.stackGap = v),
  });
  const order = segmented<'selection' | 'height'>({
    options: [
      { value: 'selection', label: 'Selection', title: 'First selected at the bottom' },
      { value: 'height', label: 'Height', title: 'Lowest object at the bottom' },
    ],
    value: arrangeSettings.stackOrder,
    compact: true,
    onChange: (v) => (arrangeSettings.stackOrder = v),
  });
  const centre = toggleField({
    label: 'Centre over the first',
    value: arrangeSettings.stackCentre,
    onChange: (v) => (arrangeSettings.stackCentre = v),
  });
  const stackSec = section(
    'Stack',
    [
      row('Gap', gap.el),
      rowStack('Order', order.el),
      centre.el,
      h(
        'div',
        { class: 'row-actions' },
        act('Stack', 'arrange.stack', 2, 'Pile the selection vertically with the gap'),
      ),
    ],
    { id: 'arrange-stack' },
  );

  // ── randomise ──
  const R = arrangeSettings.randomise;
  const rPos = vec3Field({ step: 0.1, digits: 2, unit: 'm', min: 0, onChange: (v) => (R.position = v) });
  const rRot = vec3Field({ step: 5, digits: 1, unit: '°', min: 0, max: 360, onChange: (v) => (R.rotation = v) });
  const sMin = vec3Field({ step: 0.05, digits: 2, min: 0.05, onChange: (v) => (R.scale = { ...R.scale, min: v }) });
  const sMax = vec3Field({ step: 0.05, digits: 2, min: 0.05, onChange: (v) => (R.scale = { ...R.scale, max: v }) });
  const uniform = toggleField({
    label: 'Uniform scale (X range only)',
    value: R.scale.uniform,
    onChange: (v) => {
      R.scale = { ...R.scale, uniform: v };
      sMin.el.classList.toggle('dim-yz', v);
      sMax.el.classList.toggle('dim-yz', v);
    },
  });
  rPos.set(R.position);
  rRot.set(R.rotation);
  sMin.set(R.scale.min);
  sMax.set(R.scale.max);
  sMin.el.classList.toggle('dim-yz', R.scale.uniform);
  sMax.el.classList.toggle('dim-yz', R.scale.uniform);
  const seed = numberField({
    value: R.seed,
    step: 1,
    min: 0,
    max: 4294967295,
    digits: 0,
    onChange: (v) => (R.seed = Math.floor(v) >>> 0),
  });
  refreshers.push(() => seed.set(R.seed));
  const randSec = section(
    'Randomise',
    [
      rowStack('Position ± range', rPos.el, 'Each axis moves by a random amount between -range and +range'),
      rowStack('Rotation ± range', rRot.el, 'Random turn about the world axes, around each object’s own pivot'),
      rowStack('Scale min', sMin.el, 'Smallest size factor'),
      rowStack('Scale max', sMax.el, 'Largest size factor'),
      uniform.el,
      row('Seed', seed.el, 'The same seed on the same selection always gives the same result'),
      h(
        'div',
        { class: 'row-actions' },
        act('Randomise', 'arrange.randomise', 1, 'Apply the ranges with this seed'),
        act('Re-roll', 'arrange.reroll', 1, 'Take back the last randomise and try a new seed'),
      ),
    ],
    { id: 'arrange-random', open: false },
  );

  // ── pivot ──
  const mode = segmented<PivotMode>({
    options: PIVOT_MODES.map((m) => ({ value: m.id, label: m.short, title: `${m.label}: ${m.hint}` })),
    value: app.prefs.value.pivotMode,
    compact: true,
    onChange: (v) => app.prefs.set({ pivotMode: v }),
  });
  const modeHint = h('div', { class: 'arrange-summary' });
  const syncMode = () => {
    const m = app.prefs.value.pivotMode;
    mode.set(m);
    modeHint.textContent = PIVOT_MODES.find((x) => x.id === m)?.hint ?? '';
  };
  refreshers.push(syncMode);
  const groupOnly = toggleField({
    label: 'Edit group pivot only',
    value: pivotState.groupPivotOnly,
    onChange: () => runCommand('pivot.groupOnly', app, 'button'),
  });
  const pivotSec = section(
    'Pivot',
    [
      rowStack('Rotate / scale about', mode.el),
      modeHint,
      h(
        'div',
        { class: 'row-actions wrap' },
        act(
          'Cursor → selection',
          'pivot.cursor.toSelection',
          0,
          'Put the 3D cursor at the centre of the selection',
          undefined,
        ),
        act('Cursor → origin', 'pivot.cursor.toOrigin', 0, 'Put the 3D cursor at the world origin'),
      ),
      h(
        'div',
        { class: 'row-actions wrap' },
        act('Rotate about axis…', 'pivot.rotateAxis', 1, 'Rotate about X, Y, Z or any axis through the pivot'),
        act('Scale about pivot…', 'pivot.scaleAbout', 1, 'Scale the selection about the pivot'),
      ),
      h('div', { class: 'arrange-sub' }, 'Group pivot (members stay put)'),
      h(
        'div',
        { class: 'row-actions wrap' },
        act('Centre', 'pivot.group.centre', 1, 'Pivot to the median of the members'),
        act('Bounds', 'pivot.group.bounds', 1, 'Pivot to the centre of the members’ bounds'),
        act('Bottom', 'pivot.group.bottom', 1, 'Pivot to the bottom centre of the members’ bounds'),
        act('Cursor', 'pivot.group.cursor', 1, 'Pivot to the 3D cursor'),
      ),
      groupOnly.el,
    ],
    { id: 'arrange-pivot' },
  );

  el.append(summary, alignSec, distSec, placeSec, stackSec, randSec, pivotSec);

  const refresh = () => {
    for (const r of refreshers) r();
  };
  const offs = [
    app.store.on('selection', refresh),
    app.sim.on('mode', refresh),
    app.prefs.on('change', (keys) => {
      if (keys.includes('pivotMode')) syncMode();
    }),
    onPivotState(() => {
      groupOnly.set(pivotState.groupPivotOnly);
    }),
  ];
  refresh();
  return { el, refresh, dispose: () => offs.forEach((o) => o()) };
}
