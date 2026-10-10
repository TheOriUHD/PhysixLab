/**
 * Inspector pieces for numeric transform entry (ED-14): the "Rotate by" row, relative entries in the Rotation fields
 * (`+15` turns the object by 15° about the field's axis) and the multi-selection transform section. The rules are
 * written down in `src/app/edit/transformEntry.ts` and shown in the tooltips.
 */
import { centreOf } from '../../model/edit/rotateBy';
import { editablePoses, moveSelectionCentre, rotateSelectionBy } from '../../app/edit/transformEntry';
import { numberField, row, rowStack, section, segmented, vec3Field } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from './shared';

const KEY = 'physicslab:rotateBy';
let rotateAngle = 15;
try {
  const saved = Number(localStorage.getItem(KEY));
  if (Number.isFinite(saved) && saved !== 0) rotateAngle = saved;
} catch {
  /* storage unavailable */
}
const saveAngle = (v: number) => {
  rotateAngle = v;
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* ignore */
  }
};

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/** Handler for `vec3Field({ onRelative })` on a Rotation row: a relative entry turns the objects about that axis. */
export function relativeRotation(
  ctx: InspectorContext,
  ids: readonly string[],
): (axis: 0 | 1 | 2, apply: (current: number) => number, shown: number) => void {
  return (axis, apply, shown) => {
    const next = apply(shown);
    if (Number.isFinite(next)) rotateSelectionBy(ctx.app, ids, axis, next - shown);
  };
}

/** "Rotate by": axis X / Y / Z, an angle and −/+ buttons; turns the whole selection (space = the X key's setting). */
export function rotateByRow(ctx: InspectorContext, ids: readonly string[]): HTMLElement {
  const { app } = ctx;
  let axis: 0 | 1 | 2 = 1;
  const seg = segmented<'0' | '1' | '2'>({
    compact: true,
    value: '1',
    options: AXIS_NAMES.map((n, i) => ({ value: String(i) as '0' | '1' | '2', label: n, title: `Rotate about ${n}` })),
    onChange: (v) => {
      axis = Number(v) as 0 | 1 | 2;
    },
  });
  const angle = numberField({
    value: rotateAngle,
    step: 1,
    digits: 2,
    unit: '°',
    title: 'Angle for the − / + buttons (e.g. 15, 90deg, 0.5rad)',
    onChange: saveAngle,
  });
  const spaceChip = h('button', { class: 'space-chip', type: 'button' });
  const spaceText = () => (app.prefs.value.space === 'world' ? 'World' : 'Local');
  const refresh = () => {
    spaceChip.textContent = spaceText();
    spaceChip.title =
      app.prefs.value.space === 'world'
        ? 'World space: turn about the world axis through the selection centre — click for Local (X)'
        : 'Local space: each object turns about its own axis — click for World (X)';
  };
  refresh();
  spaceChip.addEventListener('click', () => {
    app.prefs.set({ space: app.prefs.value.space === 'world' ? 'local' : 'world' });
    refresh();
  });
  const go = (sign: 1 | -1) => () => {
    if (!rotateSelectionBy(app, ids, axis, sign * rotateAngle))
      app.toast('Nothing to rotate (locked, hidden or empty)', 'warn');
  };
  const minus = h('button', { class: 'btn', type: 'button', title: 'Rotate by −angle about the chosen axis' }, '−');
  const plus = h('button', { class: 'btn', type: 'button', title: 'Rotate by +angle about the chosen axis' }, '+');
  minus.addEventListener('click', go(-1));
  plus.addEventListener('click', go(1));
  return rowStack(
    'Rotate by',
    h('div', { class: 'rotate-by' }, seg.el, angle.el, minus, plus, spaceChip),
    'Turn the selection by an angle about X, Y or Z. Also: type +15 into a Rotation field.',
  );
}

/**
 * Transform section for several selected objects: the centre of the selection (editable, see the rules in
 * `transformEntry.ts`) and "Rotate by".
 */
export function multiTransformSection(ctx: InspectorContext, ids: readonly string[]): HTMLElement {
  const { app } = ctx;
  const centre = vec3Field({
    step: 0.05,
    unit: 'm',
    ...ctx.grouped('Move'),
    onChange: (v) => {
      const c = centreOf(editablePoses(app, ids));
      for (const i of [0, 1, 2] as const) if (Math.abs(v[i] - c[i]) > 1e-12) moveSelectionCentre(app, ids, i, v[i]);
    },
  });
  ctx.updaters.push(() => {
    const items = editablePoses(app, ids);
    if (items.length) centre.set(centreOf(items));
  });
  return section(
    `Transform · ${ids.length} objects`,
    [
      rowStack(
        'Centre (m)',
        centre.el,
        'Mean position of the selection. Type a value (or +0.5, *2, 30cm …) to move the whole selection so its centre lands there; the spacing between objects is kept.',
      ),
      rotateByRow(ctx, ids),
      row(
        '',
        h(
          'p',
          { class: 'hint-text entry-hint' },
          'The centre is the mean of the selection; entries move everything together.',
        ),
      ),
    ],
    { id: 'transform-multi' },
  );
}
