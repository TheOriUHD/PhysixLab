/** Numeric dialogs for the pivot tools: rotate about an arbitrary axis, scale about the pivot. */
import type { Vec3 } from '../core/math';
import { rotateSelectionAbout, scaleSelectionAbout } from '../app/edit/arrangeOps';
import { pivotState } from '../app/edit/pivotState';
import type { App } from '../app/app';
import { PIVOT_MODES } from '../model/edit/pivot';
import { button, numberField, row, rowStack, segmented, toggleField, vec3Field } from './controls';
import { h } from './dom';
import { openModal } from './modal';

type AxisChoice = 'x' | 'y' | 'z' | 'custom';
const AXIS_VECTORS: Record<Exclude<AxisChoice, 'custom'>, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function pivotNote(app: App): HTMLElement {
  const m = app.prefs.value.pivotMode;
  const info = PIVOT_MODES.find((x) => x.id === m);
  const cursor = pivotState.cursor.map((v) => v.toFixed(2)).join(', ');
  return h(
    'div',
    { class: 'arrange-summary' },
    `Pivot: ${info?.label ?? m}${m === 'cursor' ? ` (${cursor})` : ''} — change it with the Pivot setting in the Arrange panel.`,
  );
}

/** "Rotate about axis…": X / Y / Z / custom axis through the current pivot, angle in degrees, world or local axes. */
export function openRotateAxisDialog(app: App): void {
  let choice: AxisChoice = 'y';
  let axis: Vec3 = [0, 1, 0];
  let angle = 90;
  let space: 'world' | 'local' = app.prefs.value.space;
  const custom = vec3Field({ step: 0.1, digits: 3, onChange: (v) => (axis = v) });
  custom.set(axis);
  const customRow = rowStack('Axis vector', custom.el, 'Need not be normalised');
  customRow.hidden = true;
  const pick = segmented<AxisChoice>({
    options: [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y' },
      { value: 'z', label: 'Z' },
      { value: 'custom', label: 'Custom' },
    ],
    value: choice,
    onChange: (v) => {
      choice = v;
      if (v !== 'custom') {
        axis = [...AXIS_VECTORS[v]] as Vec3;
        custom.set(axis);
      }
      customRow.hidden = v !== 'custom';
    },
  });
  const ang = numberField({
    value: angle,
    step: 5,
    digits: 2,
    unit: '°',
    min: -3600,
    max: 3600,
    onChange: (v) => (angle = v),
  });
  const sp = segmented<'world' | 'local'>({
    options: [
      { value: 'world', label: 'World', title: 'The axis is a world direction' },
      { value: 'local', label: 'Local', title: 'The axis is in the active object’s own frame' },
    ],
    value: space,
    onChange: (v) => (space = v),
  });
  const body = [
    pivotNote(app),
    rowStack('Axis', pick.el),
    customRow,
    row('Angle', ang.el, 'Right-handed: positive turns counter-clockwise looking down the axis'),
    rowStack('Axis space', sp.el),
  ];
  const dlg = openModal({
    title: 'Rotate about axis',
    body,
    width: '380px',
    footer: [],
  });
  const apply = button(
    'Rotate',
    () => {
      if (rotateSelectionAbout(app, choice === 'custom' ? axis : AXIS_VECTORS[choice], angle, space)) dlg.close();
    },
    { cls: 'primary' },
  );
  apply.dataset.action = 'apply';
  const foot = dlg.el.querySelector('.modal-foot');
  foot?.append(
    button('Close', () => dlg.close()),
    apply,
  );
}

/** "Scale about pivot…": uniform or per-axis factor about the current pivot. */
export function openScaleAboutDialog(app: App): void {
  let factor: Vec3 = [2, 2, 2];
  let uniform = true;
  const vec = vec3Field({ step: 0.1, digits: 3, min: 0.01, onChange: (v) => (factor = v) });
  vec.set(factor);
  const u = numberField({
    value: 2,
    step: 0.1,
    digits: 3,
    min: 0.01,
    max: 100,
    onChange: (v) => {
      factor = [v, v, v];
      vec.set(factor);
    },
  });
  const vecRow = rowStack('Factor per axis', vec.el);
  vecRow.hidden = true;
  const tog = toggleField({
    label: 'Uniform',
    value: true,
    onChange: (v) => {
      uniform = v;
      vecRow.hidden = v;
      if (v) {
        factor = [factor[0], factor[0], factor[0]];
        vec.set(factor);
      }
    },
  });
  const dlg = openModal({
    title: 'Scale about pivot',
    body: [pivotNote(app), tog.el, row('Factor', u.el), vecRow],
    width: '380px',
    footer: [],
  });
  const apply = button(
    'Scale',
    () => {
      if (scaleSelectionAbout(app, uniform ? [factor[0], factor[0], factor[0]] : factor)) dlg.close();
    },
    { cls: 'primary' },
  );
  apply.dataset.action = 'apply';
  dlg.el.querySelector('.modal-foot')?.append(
    button('Close', () => dlg.close()),
    apply,
  );
}
