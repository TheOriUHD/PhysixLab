/**
 * ED-1 — the "Select" panel: pick entities by name (substring or regex), tag, kind, shape, layer and body type, with a
 * live match count and Replace / Add / Subtract buttons, plus the paint-brush radius. Every number shown is computed
 * from the document by `filterEntities`; the buttons run `selectByFilter`.
 */
import { countFilter, getBrushRadius, onBrushRadius, selectByFilter, setBrushRadius } from '../app/edit/selectTools';
import type { App } from '../app/app';
import type { PanelView } from '../app/registry/panels';
import {
  filterIsEmpty,
  filterIsValid,
  MAX_FILTER_PATTERN,
  type EntityFilter,
  type SelectMode,
} from '../model/edit/selection';
import { isBody } from '../model/types';
import { listShapes } from '../model/shapeRegistry';
import { row, selectField, sliderField, toggleField } from './controls';
import { h } from './dom';

const KINDS: { value: string; label: string }[] = [
  { value: '', label: 'Any kind' },
  { value: 'body', label: 'Bodies' },
  { value: 'soft', label: 'Soft bodies' },
  { value: 'joint', label: 'Joints' },
  { value: 'group', label: 'Groups' },
  { value: 'light', label: 'Lights' },
  { value: 'path', label: 'Paths' },
];
const BODY_TYPES = [
  { value: '', label: 'Any type' },
  { value: 'dynamic', label: 'Dynamic' },
  { value: 'static', label: 'Static' },
  { value: 'kinematic', label: 'Kinematic' },
];

export function buildSelectPanel(app: App): PanelView {
  const filter: EntityFilter = { name: '', regex: false, tag: '', kind: '', shape: '', layer: '', bodyType: '' };

  const name = h('input', {
    class: 'ed-sel-input',
    type: 'text',
    placeholder: 'Name contains…',
    spellcheck: false,
    'aria-label': 'Name contains',
  });
  const tag = h('input', {
    class: 'ed-sel-input',
    type: 'text',
    placeholder: 'Tag…',
    spellcheck: false,
    'aria-label': 'Tag',
    list: 'ed-sel-tags',
  });
  const tagList = h('datalist', { id: 'ed-sel-tags' });
  const count = h('div', { class: 'ed-sel-count', role: 'status', 'aria-live': 'polite' });
  const modes: [SelectMode, string, string][] = [
    ['replace', 'Replace', 'Select the matches instead of the current selection'],
    ['add', 'Add', 'Add the matches to the selection'],
    ['subtract', 'Subtract', 'Remove the matches from the selection'],
  ];
  const buttons = modes.map(([mode, label, title]) => {
    const b = h('button', { class: `btn small ed-sel-${mode}`, type: 'button', title }, label);
    b.addEventListener('click', () => {
      selectByFilter(app, filter, mode);
    });
    return b;
  });

  // Dropdowns whose options depend on the scene (layers) are rebuilt on show / change.
  const layerSel = h('select', { class: 'select ed-sel-layer', 'aria-label': 'Layer' });
  layerSel.addEventListener('change', () => {
    filter.layer = layerSel.value;
    refresh();
  });
  const shapeSel = h(
    'select',
    { class: 'select ed-sel-shape', 'aria-label': 'Shape' },
    h('option', { value: '' }, 'Any shape'),
    listShapes().map((s) => h('option', { value: s.id }, s.label)),
  );
  shapeSel.addEventListener('change', () => {
    filter.shape = shapeSel.value;
    refresh();
  });

  const kind = selectField({
    options: KINDS,
    value: '',
    onChange: (v) => {
      filter.kind = v as EntityFilter['kind'];
      refresh();
    },
  });
  const bodyType = selectField({
    options: BODY_TYPES,
    value: '',
    onChange: (v) => {
      filter.bodyType = v as EntityFilter['bodyType'];
      refresh();
    },
  });
  const regex = toggleField({
    label: 'Regular expression',
    value: false,
    onChange: (v) => {
      filter.regex = v;
      refresh();
    },
  });
  name.addEventListener('input', () => {
    filter.name = name.value;
    refresh();
  });
  tag.addEventListener('input', () => {
    filter.tag = tag.value;
    refresh();
  });
  // Typing in the fields must never reach the viewport shortcuts.
  for (const el of [name, tag]) el.addEventListener('keydown', (e) => e.stopPropagation());

  const radius = sliderField({
    min: 6,
    max: 240,
    step: 1,
    unit: 'px',
    digits: 0,
    value: getBrushRadius(),
    onChange: (v) => setBrushRadius(v),
  });
  onBrushRadius(() => radius.set(getBrushRadius()));

  function rebuildChoices(): void {
    const layers = new Set<string>();
    const tags = new Set<string>();
    for (const e of app.store.all())
      if (isBody(e)) {
        layers.add(e.layer);
        for (const t of e.tags) tags.add(t);
      }
    const cur = layerSel.value;
    layerSel.replaceChildren(
      h('option', { value: '' }, 'Any layer'),
      ...[...layers].sort().map((l) => h('option', { value: l }, l)),
    );
    layerSel.value = layers.has(cur) ? cur : '';
    filter.layer = layerSel.value;
    tagList.replaceChildren(...[...tags].sort().map((t) => h('option', { value: t })));
  }

  function refresh(): void {
    const empty = filterIsEmpty(filter);
    const valid = filterIsValid(filter);
    name.classList.toggle('invalid', !valid);
    name.title = valid ? '' : `Not a valid regular expression (at most ${MAX_FILTER_PATTERN} characters)`;
    if (countTimer) clearTimeout(countTimer);
    countTimer = null;
    if (!valid || empty) {
      showCount(0, empty, valid);
    } else if (filter.regex) {
      // A regular expression runs over every name: wait for a pause in typing before counting.
      for (const b of buttons) b.disabled = true;
      countTimer = setTimeout(() => {
        countTimer = null;
        showCount(countFilter(app, filter), false, true);
      }, 150);
    } else showCount(countFilter(app, filter), false, true);
  }

  function showCount(n: number, empty: boolean, valid: boolean): void {
    count.textContent = !valid
      ? 'Invalid regular expression'
      : empty
        ? 'Set at least one condition'
        : `${n} ${n === 1 ? 'match' : 'matches'}`;
    count.dataset.matches = String(n);
    for (const b of buttons) b.disabled = n === 0;
  }
  let countTimer: ReturnType<typeof setTimeout> | null = null;

  const el = h(
    'div',
    { class: 'panel-body ed-select-panel' },
    h(
      'div',
      { class: 'ed-sel-section' },
      h('div', { class: 'ed-sel-title' }, 'Select by condition'),
      row('Name', name),
      row('', regex.el),
      row('Tag', [tag, tagList]),
      row('Kind', kind.el),
      row('Shape', shapeSel),
      row('Layer', layerSel),
      row('Body type', bodyType.el),
      count,
      h('div', { class: 'ed-sel-actions' }, buttons),
    ),
    h(
      'div',
      { class: 'ed-sel-section' },
      h('div', { class: 'ed-sel-title' }, 'Paint brush'),
      row('Radius', radius.el, 'Size of the paint-select brush; also [ and ] while the tool is active'),
      h(
        'p',
        { class: 'ed-sel-note' },
        'Lasso and paint: Shift adds, Ctrl/Cmd subtracts. Locked objects can be selected; hidden ones cannot.',
      ),
    ),
  );

  const rerun = () => {
    rebuildChoices();
    refresh();
  };
  app.store.on('change', rerun);
  rebuildChoices();
  refresh();
  return { el, onShow: rerun };
}
