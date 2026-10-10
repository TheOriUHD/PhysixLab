/**
 * The trace picker: search the signal catalogue, choose an object of the scene (or "the selection"), or type a
 * custom expression with live validation. Also edits an existing trace (label, unit, colour, axis) and manages the
 * short aliases usable in expressions.
 */
import type { App } from '../../app/app';
import { h } from '../dom';
import { openModal } from '../modal';
import { DERIVED_OPS } from './analysis';
import type { DerivedOp } from './analysis';
import type { AppSource } from './appSource';
import { ExprError, MATH_FUNCTIONS, compile } from './expr';
import { PALETTE } from './model';
import type { TraceCfg } from './model';
import { signalGroups, signalExpr } from './signals';
import type { SignalDef } from './signals';
import { valueText } from './ticks';
import { exprHost } from './signals';

export interface TraceDialogOpts {
  app: App;
  source: AppSource;
  /** Edit this trace instead of adding one. */
  existing?: TraceCfg;
  /** Name of the existing trace's source when it is a derived trace. */
  derivedFrom?: string;
  color: string;
  /** Called with the finished trace; `again` = the user chose "Add another". */
  onSave: (
    t: Pick<TraceCfg, 'label' | 'expr' | 'unit' | 'color' | 'axis'> & { derivedOp?: DerivedOp },
    again: boolean,
  ) => void;
  onAliases: () => void;
}

/** Validate an expression against the live scene: error text (with a caret hint) or the current value. */
export function checkExpression(
  source: AppSource,
  expr: string,
): { ok: true; value: number; refs: string[] } | { ok: false; error: string } {
  try {
    const c = compile(expr, exprHost(source));
    return { ok: true, value: c.eval(), refs: c.refs };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: `${e.message} (at character ${e.pos + 1})` };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function openTraceDialog(o: TraceDialogOpts): void {
  const { app, source } = o;
  const ex = o.existing;
  const derived = ex?.derived;
  let labelTouched = !!ex?.label;
  let unitTouched = !!ex?.unit;

  const entitySel = h('select', { class: 'select', title: 'Which object the signal is read from' });
  entitySel.append(
    h('option', { value: 'selected' }, '(the selected object, follows selection)'),
    h('optgroup', { label: 'Bodies' }, ...app.store.bodies().map((b) => h('option', { value: `b:${b.id}` }, b.name))),
    h(
      'optgroup',
      { label: 'Joints' },
      ...app.store.joints().map((j) => h('option', { value: `j:${j.id}` }, `${j.name} (${j.type})`)),
    ),
  );
  const search = h('input', {
    type: 'search',
    class: 'plain',
    placeholder: 'Search signals: speed, energy, spring, angular…',
    spellcheck: false,
    'aria-label': 'Search signals',
  });
  const list = h('div', { class: 'td-list', role: 'listbox' });
  const exprIn = h('input', {
    type: 'text',
    class: 'plain td-expr',
    value: ex?.expr ?? '',
    spellcheck: false,
    placeholder: 'speed(Crate) - speed(Ball)    0.5*mass(a)*speed(a)^2',
    disabled: !!derived,
    'aria-label': 'Expression',
  });
  const status = h('div', { class: 'td-status', role: 'status' });
  const labelIn = h('input', {
    type: 'text',
    class: 'plain',
    value: ex?.label ?? '',
    placeholder: 'Defaults to the expression',
    maxLength: 80,
  });
  const unitIn = h('input', {
    type: 'text',
    class: 'plain',
    value: ex?.unit ?? '',
    placeholder: 'auto',
    maxLength: 20,
  });
  const colorIn = h('input', { type: 'color', class: 'td-color', value: ex?.color ?? o.color });
  const axisSel = h(
    'select',
    { class: 'select' },
    h('option', { value: 'L', selected: (ex?.axis ?? 'L') === 'L' }, 'Left axis'),
    h('option', { value: 'R', selected: ex?.axis === 'R' }, 'Right axis'),
  );
  const swatches = h(
    'div',
    { class: 'td-swatches' },
    ...PALETTE.map((c) => {
      const b = h('button', { type: 'button', class: 'td-swatch', style: { background: c }, title: c });
      b.addEventListener('click', () => (colorIn.value = c));
      return b;
    }),
  );
  const opSel = h(
    'select',
    { class: 'select' },
    ...DERIVED_OPS.map((d) => h('option', { value: d.id, selected: derived?.op === d.id }, d.label)),
  );

  const selectedKind = (): 'body' | 'joint' | 'any' => {
    const v = entitySel.value;
    return v.startsWith('b:') ? 'body' : v.startsWith('j:') ? 'joint' : 'any';
  };
  const refName = (): string => {
    const v = entitySel.value;
    if (v === 'selected') return 'selected';
    const e = app.store.get(v.slice(2));
    return e?.name ?? 'selected';
  };
  const entityLabel = (): string => (entitySel.value === 'selected' ? 'Selection' : refName());

  const validate = () => {
    if (derived) {
      status.className = 'td-status ok';
      status.textContent = 'Derived from another trace of this chart.';
      return true;
    }
    const text = exprIn.value.trim();
    if (!text) {
      status.className = 'td-status';
      status.textContent = 'Pick a signal above or type an expression.';
      return false;
    }
    const r = checkExpression(source, text);
    if (!r.ok) {
      status.className = 'td-status bad';
      status.textContent = r.error;
      return false;
    }
    status.className = 'td-status ok';
    status.textContent = Number.isNaN(r.value)
      ? 'Valid. No value yet (start the simulation).'
      : `Valid. Current value ${valueText(r.value)}`;
    return true;
  };

  const choose = (def: SignalDef) => {
    exprIn.value = signalExpr(def, def.target === 'world' ? null : refName());
    if (!labelTouched) labelIn.value = def.target === 'world' ? def.label : `${entityLabel()} · ${def.label}`;
    if (!unitTouched) unitIn.value = '';
    validate();
    exprIn.focus();
  };

  const render = () => {
    const kind = selectedKind();
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const g of signalGroups()) {
      const items = g.signals.filter((s) => {
        if (kind === 'body' && s.target === 'joint') return false;
        if (kind === 'joint' && s.target === 'body') return false;
        return !q || `${s.label} ${s.id} ${s.group} ${s.unit}`.toLowerCase().includes(q);
      });
      if (!items.length) continue;
      list.appendChild(h('div', { class: 'td-group' }, g.group));
      for (const s of items) {
        const b = h(
          'button',
          { type: 'button', class: 'td-sig', role: 'option', title: s.note ?? s.label, dataset: { signal: s.id } },
          h('span', { class: 'td-sig-name' }, s.label),
          h('code', null, s.target === 'world' ? `${s.id}()` : `${s.id}(…)`),
          h('span', { class: 'td-sig-unit' }, s.unit),
        );
        b.addEventListener('click', () => choose(s));
        b.addEventListener('dblclick', () => finish(false));
        list.appendChild(b);
      }
    }
    if (!list.firstChild)
      list.appendChild(h('div', { class: 'td-none' }, 'No signal matches. Type an expression below instead.'));
  };
  entitySel.addEventListener('change', render);
  search.addEventListener('input', render);
  exprIn.addEventListener('input', validate);
  exprIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(false);
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  labelIn.addEventListener('input', () => (labelTouched = true));
  labelIn.addEventListener('keydown', (e) => e.stopPropagation());
  unitIn.addEventListener('input', () => (unitTouched = true));
  unitIn.addEventListener('keydown', (e) => e.stopPropagation());

  // aliases
  const aliasBox = h('div', { class: 'td-aliases' });
  const renderAliases = () => {
    aliasBox.replaceChildren();
    const cur = { ...source.aliases() };
    const commit = (next: Record<string, string>) => {
      source.setAliases(next);
      o.onAliases();
      renderAliases();
      validate();
    };
    for (const [name, id] of Object.entries(cur)) {
      const nameIn = h('input', {
        type: 'text',
        class: 'plain',
        value: name,
        maxLength: 24,
        'aria-label': 'Alias name',
      });
      const sel = h(
        'select',
        { class: 'select' },
        ...app.store.bodies().map((b) => h('option', { value: b.id, selected: b.id === id }, b.name)),
        ...app.store.joints().map((j) => h('option', { value: j.id, selected: j.id === id }, `${j.name} (joint)`)),
      );
      const del = h('button', { type: 'button', class: 'btn small' }, 'Remove');
      nameIn.addEventListener('keydown', (e) => e.stopPropagation());
      nameIn.addEventListener('change', () => {
        const n = nameIn.value.trim();
        const next = { ...cur };
        delete next[name];
        if (/^[A-Za-z_]\w*$/.test(n) && !['selected', 'sel'].includes(n)) next[n] = id;
        commit(next);
      });
      sel.addEventListener('change', () => commit({ ...cur, [name]: sel.value }));
      del.addEventListener('click', () => {
        const next = { ...cur };
        delete next[name];
        commit(next);
      });
      aliasBox.appendChild(h('div', { class: 'td-alias' }, nameIn, h('span', null, '→'), sel, del));
    }
    const add = h('button', { type: 'button', class: 'btn small' }, '+ Add alias');
    add.addEventListener('click', () => {
      const first = app.store.bodies()[0] ?? app.store.joints()[0];
      if (!first) return;
      let n = 'a';
      for (let i = 0; Object.prototype.hasOwnProperty.call(cur, n); i++) n = String.fromCharCode(98 + i);
      commit({ ...cur, [n]: first.id });
    });
    aliasBox.appendChild(add);
  };
  renderAliases();

  const finish = (again: boolean) => {
    if (!validate()) {
      exprIn.focus();
      return;
    }
    o.onSave(
      {
        label: labelIn.value.trim(),
        expr: exprIn.value.trim(),
        unit: unitIn.value.trim(),
        color: colorIn.value,
        axis: axisSel.value === 'R' ? 'R' : 'L',
        derivedOp: derived ? (opSel.value as DerivedOp) : undefined,
      },
      again,
    );
    if (!again) m.close();
    else {
      exprIn.value = '';
      labelIn.value = '';
      labelTouched = false;
      status.textContent = 'Added. Pick another signal.';
      status.className = 'td-status ok';
    }
  };

  const field = (label: string, el: HTMLElement) => h('label', { class: 'td-field' }, h('span', null, label), el);
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => m.close());
  const add = h('button', { class: 'btn primary td-save', type: 'button' }, ex ? 'Save trace' : 'Add trace');
  add.addEventListener('click', () => finish(false));
  const again = h(
    'button',
    { class: 'btn td-again', type: 'button', title: 'Add this trace and keep the picker open' },
    'Add another',
  );
  again.addEventListener('click', () => finish(true));

  const body = derived
    ? [
        h(
          'p',
          { class: 'sub' },
          `Derived from ${o.derivedFrom ?? 'another trace'}. Change what is computed, or how it looks.`,
        ),
        field('Computation', opSel),
        h('div', { class: 'td-row' }, field('Label', labelIn), field('Unit', unitIn)),
        h(
          'div',
          { class: 'td-row' },
          field('Axis', axisSel),
          field('Colour', h('div', { class: 'td-colorrow' }, colorIn, swatches)),
        ),
        status,
      ]
    : [
        h('div', { class: 'td-pick' }, field('Object', entitySel), field('Signal', search)),
        list,
        field('Expression', exprIn),
        status,
        h(
          'p',
          { class: 'td-help' },
          'Combine signals with + - * / ^ and parentheses, e.g. ',
          h('code', null, 'speed(a) - speed(b)'),
          ' or ',
          h('code', null, '0.5*mass(a)*speed(a)^2'),
          `. Use a body's name (quote names with spaces: "My box"), an alias, or `,
          h('code', null, 'selected'),
          `. Maths: ${MATH_FUNCTIONS.join(' ')}, pi, t.`,
        ),
        h('div', { class: 'td-row' }, field('Label', labelIn), field('Unit', unitIn)),
        h(
          'div',
          { class: 'td-row' },
          field('Axis', axisSel),
          field('Colour', h('div', { class: 'td-colorrow' }, colorIn, swatches)),
        ),
        h('details', { class: 'td-details' }, h('summary', null, 'Aliases (short names for objects)'), aliasBox),
      ];
  const m = openModal({
    title: ex ? 'Edit trace' : 'Add trace',
    width: '660px',
    body: h('div', { class: 'td' }, body),
    footer: ex ? [cancel, add] : [cancel, again, add],
  });
  m.el.classList.add('td-modal');
  render();
  validate();
  setTimeout(() => (derived ? labelIn : search).focus(), 30);
}
