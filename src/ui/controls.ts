/** Reusable form controls for the inspector and settings panels. */
import { captureKey, describeKey } from '../app/input/capture';
import { h } from './dom';
import { icon } from './icons';
// -- UI-A: Simple / Advanced mode --
import { friendly } from './uiMode';
// -- /UI-A --
// -- UI-A: units, expressions, scrub handles --
import { parseFieldInput } from './inspector/upgrades/expr';
import { followUnits, systemOf, unitChip } from './inspector/upgrades/fieldUnits';
import { quantityById, quantityOfSymbol, toDisplay } from './inspector/upgrades/units';
import type { QuantityDef } from './inspector/upgrades/units';
// -- /UI-A --
// -- ED-A snap: relative entries (`+0.5`, `*2`, `x-1`; src/model/edit/expression.ts) --
import { ENTRY_HINT, evaluateEntry } from '../model/edit/expression';

export interface Field<T> {
  el: HTMLElement;
  set(value: T, mixed?: boolean): void;
}

export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

export interface NumberOpts {
  value?: number;
  step?: number;
  min?: number;
  max?: number;
  digits?: number;
  unit?: string;
  label?: string;
  labelClass?: string;
  onChange: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  title?: string;
  // -- UI-A: what the field measures (id of a quantity in inspector/upgrades/units.ts); defaults to the one the `unit` text names, `null` = plain number --
  quantity?: string | null;
  /**
   * -- ED-A snap: called instead of `onChange` when the typed entry is relative ("+0.5", "*2", "x-1"). `apply(current)`
   * gives the new value for an object whose own current value is `current` (NaN if it cannot be computed); `shown` is
   * the value in the field. Lets a multi-selection apply the entry to every object's own value.
   */
  onRelative?: (apply: (current: number) => number, shown: number) => void;
}

// -- UI-A: scrubbing from outside the field (the inspector makes a row's label drag the row's number) --
export const scrubHandles = new WeakMap<HTMLElement, (e: PointerEvent, target: HTMLElement) => void>();
// -- /UI-A --

/** Numeric input with drag-to-scrub label, arrow-key stepping and unit suffix. */
export function numberField(o: NumberOpts): Field<number> {
  const step = o.step ?? 0.1;
  const digits = o.digits ?? Math.max(0, Math.min(5, Math.ceil(-Math.log10(step)) + 1));
  let value = o.value ?? 0;
  const input = h('input', {
    class: 'num-input',
    type: 'text',
    inputMode: 'decimal',
    spellcheck: false,
    title: o.title ? `${o.title}\n${ENTRY_HINT}` : ENTRY_HINT, // -- ED-A snap: entry hint --
  });
  const baseTitle = input.title;
  // -- UI-A: unit toggle --
  const quantity: QuantityDef | undefined =
    o.quantity === null ? undefined : (quantityById(o.quantity) ?? quantityOfSymbol(o.unit));
  let el: HTMLElement | null = null;
  const unit = o.unit
    ? quantity
      ? unitChip(() => el ?? input, quantity)
      : h('span', { class: 'num-unit' }, o.unit)
    : null;
  let mixedNow = false;
  // -- /UI-A --
  const clampV = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const show = (v: number, mixed = false) => {
    // -- UI-A: shown in the field's unit system --
    mixedNow = mixed;
    input.value = mixed ? '—' : fmt(quantity ? toDisplay(quantity, systemOf(el ?? input, quantity), v) : v, digits);
  };
  show(value);

  const commit = (v: number, final = true) => {
    v = clampV(v);
    if (!Number.isFinite(v)) {
      show(value);
      return;
    }
    value = v;
    show(v);
    o.onChange(v);
    if (final) {
      /* history grouping handled by onStart/onEnd */
    }
  };

  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => {
    // -- UI-A: expressions (`2*9.81`, `5 ft`, `3/4`) with units; -- ED-A snap: a leading operator makes it relative --
    const sys = systemOf(el ?? input, quantity);
    const shownOf = (native: number) => (quantity ? toDisplay(quantity, sys, native) : native);
    const evalFor = (native: number) =>
      evaluateEntry(input.value, native, shownOf(native), (t, plain) =>
        parseFieldInput(t, plain ? undefined : quantity, sys),
      );
    const r = evalFor(value);
    if (!r.ok) {
      input.classList.add('invalid');
      input.title = r.error;
      window.setTimeout(() => {
        input.classList.remove('invalid');
        input.title = baseTitle;
      }, 1800);
      show(value, mixedNow);
      return;
    }
    if (r.relative && o.onRelative) {
      const text = input.value;
      o.onStart?.();
      o.onRelative((native) => {
        const x = evaluateEntry(text, native, shownOf(native), (t, plain) =>
          parseFieldInput(t, plain ? undefined : quantity, sys),
        );
        return x.ok ? clampV(x.value) : NaN;
      }, value);
      o.onEnd?.();
      show(value, mixedNow);
      return;
    }
    o.onStart?.();
    commit(r.value);
    o.onEnd?.();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      input.blur();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      show(value);
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      o.onStart?.();
      commit(Number((value + dir * step * mult).toFixed(8)));
      o.onEnd?.();
    }
    e.stopPropagation();
  });

  const label =
    o.label !== undefined
      ? h('span', { class: `num-label ${o.labelClass ?? ''}`, title: 'Drag to scrub' }, o.label)
      : null;
  // -- UI-A: the scrub gesture can be started from any element (the row label of the inspector) --
  const startScrub = (e: PointerEvent, host: HTMLElement) => {
    if (e.button !== 0) return;
    e.preventDefault();
    host.setPointerCapture(e.pointerId);
    const x0 = e.clientX,
      v0 = value;
    let started = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!started && Math.abs(dx) < 2) return;
      if (!started) {
        started = true;
        o.onStart?.();
        document.body.classList.add('scrubbing');
      }
      const mult = ev.shiftKey ? 0.1 : ev.ctrlKey || ev.metaKey ? 10 : 1;
      commit(Number((v0 + (dx / 4) * step * mult).toFixed(8)), false);
    };
    const up = () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      if (started) {
        o.onEnd?.();
        document.body.classList.remove('scrubbing');
      }
    };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
  };
  if (label) label.addEventListener('pointerdown', (e) => startScrub(e, label));
  // -- /UI-A --

  const root = h('label', { class: 'num-field' }, label, input, unit);
  // -- UI-A --
  el = root;
  scrubHandles.set(root, startScrub);
  if (quantity) followUnits(root, () => show(value, mixedNow));
  // -- /UI-A --
  return {
    el: root,
    set(v: number, mixed = false) {
      value = v;
      if (document.activeElement !== input) show(v, mixed);
    },
  };
}

export function vec3Field(o: {
  onChange: (v: [number, number, number]) => void;
  onStart?: () => void;
  onEnd?: () => void;
  step?: number;
  unit?: string;
  min?: number;
  max?: number;
  digits?: number;
  /** -- ED-A snap: relative entries of one axis ("+15"); see `NumberOpts.onRelative`. */
  onRelative?: (axis: 0 | 1 | 2, apply: (current: number) => number, shown: number) => void;
}): Field<[number, number, number]> {
  let cur: [number, number, number] = [0, 0, 0];
  // -- UI-A: one unit chip for the three axes, which share the quantity --
  const vq = o.unit ? quantityOfSymbol(o.unit) : undefined;
  const mk = (i: 0 | 1 | 2, name: string) =>
    numberField({
      quantity: vq?.id ?? null,
      onRelative: o.onRelative ? (apply, shown) => o.onRelative?.(i, apply, shown) : undefined, // -- ED-A snap
      label: name,
      labelClass: `axis-${name.toLowerCase()}`,
      step: o.step ?? 0.1,
      min: o.min,
      max: o.max,
      digits: o.digits,
      onStart: o.onStart,
      onEnd: o.onEnd,
      onChange: (v) => {
        cur = [...cur] as [number, number, number];
        cur[i] = v;
        o.onChange([...cur] as [number, number, number]);
      },
    });
  const fx = mk(0, 'X'),
    fy = mk(1, 'Y'),
    fz = mk(2, 'Z');
  const vecEl = h('div', { class: 'vec3' }, fx.el, fy.el, fz.el);
  if (vq?.imperial) {
    vecEl.classList.add('has-unit');
    vecEl.append(unitChip(() => fx.el, vq, 'num-unit vec-unit'));
  }
  // -- /UI-A --
  return {
    el: vecEl,
    set(v, mixed = false) {
      cur = [...v] as [number, number, number];
      fx.set(v[0], mixed);
      fy.set(v[1], mixed);
      fz.set(v[2], mixed);
    },
  };
}

export function sliderField(o: {
  min: number;
  max: number;
  step?: number;
  value?: number;
  digits?: number;
  unit?: string;
  log?: boolean;
  onChange: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
}): Field<number> {
  const range = h('input', { type: 'range', class: 'slider', min: '0', max: '1000', step: '1' });
  const toPos = (v: number) =>
    o.log
      ? ((Math.log(Math.max(o.min, v)) - Math.log(o.min)) / (Math.log(o.max) - Math.log(o.min))) * 1000
      : ((v - o.min) / (o.max - o.min)) * 1000;
  const fromPos = (p: number) =>
    o.log
      ? Math.exp(Math.log(o.min) + (p / 1000) * (Math.log(o.max) - Math.log(o.min)))
      : o.min + (p / 1000) * (o.max - o.min);
  const snap = (v: number) => (o.step ? Math.round(v / o.step) * o.step : v);
  const num = numberField({
    step: o.step ?? (o.max - o.min) / 100,
    unit: o.unit,
    digits: o.digits,
    min: o.log ? o.min : undefined,
    onChange: (v) => {
      range.value = String(toPos(v));
      o.onChange(v);
    },
    onStart: o.onStart,
    onEnd: o.onEnd,
  });
  range.addEventListener('pointerdown', () => o.onStart?.());
  range.addEventListener('pointerup', () => o.onEnd?.());
  range.addEventListener('input', () => {
    const v = Number(snap(fromPos(Number(range.value))).toFixed(6));
    num.set(v);
    o.onChange(v);
  });
  const set = (v: number, mixed = false) => {
    range.value = String(toPos(v));
    num.set(v, mixed);
  };
  set(o.value ?? o.min);
  return { el: h('div', { class: 'slider-field' }, range, num.el), set };
}

export function selectField<T extends string>(o: {
  options: { value: T; label: string }[];
  value?: T;
  onChange: (v: T) => void;
}): Field<T> {
  const sel = h(
    'select',
    { class: 'select' },
    o.options.map((op) => h('option', { value: op.value }, op.label)),
  );
  sel.addEventListener('change', () => o.onChange(sel.value as T));
  if (o.value !== undefined) sel.value = o.value;
  return {
    el: h('div', { class: 'select-wrap' }, sel, icon('chevronDown', 'icon select-caret')),
    set(v, mixed = false) {
      if (mixed) {
        sel.selectedIndex = -1;
        return;
      }
      sel.value = v;
    },
  };
}

export function toggleField(o: {
  label?: string;
  value?: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}): Field<boolean> {
  const input = h('input', { type: 'checkbox', class: 'switch-input' });
  input.checked = !!o.value;
  input.addEventListener('change', () => o.onChange(input.checked));
  const el = h(
    'label',
    { class: 'switch', title: o.title ?? '' },
    input,
    h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })),
    o.label ? h('span', { class: 'switch-label' }, o.label) : null,
  );
  return {
    el,
    set(v, mixed = false) {
      input.checked = v;
      input.indeterminate = mixed;
    },
  };
}

export function checkChips(o: {
  items: { label: string; title?: string }[];
  value?: boolean[];
  onChange: (v: boolean[]) => void;
}): Field<boolean[]> {
  let cur = o.value ? [...o.value] : o.items.map(() => false);
  const chips = o.items.map((it, i) => {
    const b = h('button', { class: 'chip', type: 'button', title: it.title ?? '' }, it.label);
    b.addEventListener('click', () => {
      cur = cur.map((v, j) => (j === i ? !v : v));
      render();
      o.onChange([...cur]);
    });
    return b;
  });
  const render = () => chips.forEach((c, i) => c.classList.toggle('on', cur[i]));
  render();
  return {
    el: h('div', { class: 'chips' }, chips),
    set(v) {
      cur = [...v];
      render();
    },
  };
}

export function colorField(o: {
  value?: string;
  onChange: (v: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
}): Field<string> {
  const input = h('input', { type: 'color', class: 'color-input' });
  const hex = h('input', { class: 'num-input hex-input', type: 'text', spellcheck: false, maxLength: 7 });
  const set = (v: string) => {
    input.value = v;
    hex.value = v;
  };
  set(o.value ?? '#ffffff');
  input.addEventListener('pointerdown', () => o.onStart?.());
  input.addEventListener('input', () => {
    hex.value = input.value;
    o.onChange(input.value);
  });
  input.addEventListener('change', () => o.onEnd?.());
  hex.addEventListener('change', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) {
      input.value = hex.value;
      o.onStart?.();
      o.onChange(hex.value);
      o.onEnd?.();
    } else hex.value = input.value;
  });
  hex.addEventListener('keydown', (e) => e.stopPropagation());
  return { el: h('div', { class: 'color-field' }, input, hex), set };
}

export function segmented<T extends string>(o: {
  options: { value: T; label?: string; icon?: string; title?: string }[];
  value?: T;
  onChange: (v: T) => void;
  compact?: boolean;
}): Field<T> & { buttons: HTMLButtonElement[] } {
  const buttons = o.options.map((op) => {
    const b = h(
      'button',
      { class: 'seg-btn', type: 'button', title: op.title ?? op.label ?? '', dataset: { value: op.value } },
      op.icon ? icon(op.icon) : null,
      op.label ? h('span', null, op.label) : null,
    );
    b.addEventListener('click', () => {
      set(op.value);
      o.onChange(op.value);
    });
    return b;
  });
  const set = (v: T) => buttons.forEach((b) => b.classList.toggle('on', b.dataset.value === v));
  if (o.value !== undefined) set(o.value);
  return { el: h('div', { class: `segmented ${o.compact ? 'compact' : ''}` }, buttons), set, buttons };
}

/** Button that captures the next key press (for motor / thruster key bindings). */
export function keyField(o: { value?: string; onChange: (code: string) => void; placeholder?: string }): Field<string> {
  let code = o.value ?? '';
  const btn = h('button', { class: 'key-btn', type: 'button', title: 'Click, then press a key. Esc clears.' });
  const show = () => {
    btn.textContent = code ? describeKey(code, keyLabel) : (o.placeholder ?? 'None');
    btn.classList.toggle('empty', !code);
  };
  show();
  // -- CM-A: capture goes through the InputMap pipeline (keyboard and gamepad buttons) --
  btn.addEventListener('click', () => {
    btn.textContent = 'Press a key or pad button…';
    btn.classList.add('listening');
    let stop: (() => void) | null = null;
    const cleanup = () => {
      btn.classList.remove('listening');
      stop?.();
      stop = null;
      btn.removeEventListener('blur', onBlur);
    };
    const onBlur = () => {
      cleanup();
      show();
    };
    stop = captureKey((c) => {
      code = c;
      cleanup();
      show();
      o.onChange(code);
    });
    btn.addEventListener('blur', onBlur);
  });
  return {
    el: btn,
    set(v) {
      code = v;
      show();
    },
  };
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    Enter: 'Enter',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    Slash: '/',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
  };
  return map[code] ?? code;
}

export function row(label: string, control: HTMLElement | HTMLElement[], hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'row' },
    h('div', { class: 'row-label', title: hint ?? '', dataset: { label } }, friendly(label)), // UI-A: dataset.label = the unfriendly name, for resets / unit keys
    h('div', { class: 'row-control' }, control),
  );
}

/** Label above a full-width control (for wide controls such as vectors). */
export function rowStack(label: string, control: HTMLElement | HTMLElement[], hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'row stack' },
    h('div', { class: 'row-label', title: hint ?? '', dataset: { label } }, friendly(label)), // UI-A: dataset.label = the unfriendly name, for resets / unit keys
    h('div', { class: 'row-control' }, control),
  );
}

export function section(
  title: string,
  body: HTMLElement | HTMLElement[],
  opts: { id?: string; open?: boolean; badge?: string } = {},
): HTMLElement {
  const key = opts.id ? `physicslab:section:${opts.id}` : '';
  let open = opts.open ?? true;
  if (key) {
    try {
      const s = localStorage.getItem(key);
      if (s !== null) open = s === '1';
    } catch {
      /* ignore */
    }
  }
  const content = h('div', { class: 'section-body' }, body);
  const head = h(
    'button',
    { class: 'section-head', type: 'button' },
    icon('chevron', 'icon section-caret'),
    h('span', null, friendly(title)),
    opts.badge ? h('span', { class: 'badge' }, opts.badge) : null,
  );
  const el = h('section', { class: `section ${open ? 'open' : ''}` }, head, content);
  // -- UI-A: Simple mode hides sections by id (src/ui/uiMode.ts) --
  if (opts.id) el.dataset.sid = opts.id;
  head.addEventListener('click', () => {
    open = !open;
    el.classList.toggle('open', open);
    if (key) {
      try {
        localStorage.setItem(key, open ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
  });
  return el;
}

export function button(
  label: string,
  onClick: () => void,
  o: { icon?: string; cls?: string; title?: string } = {},
): HTMLButtonElement {
  const b = h(
    'button',
    { class: `btn ${o.cls ?? ''}`, type: 'button', title: o.title ?? '' },
    o.icon ? icon(o.icon) : null,
    label ? h('span', null, label) : null,
  );
  b.addEventListener('click', onClick);
  return b;
}

export function iconButton(name: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${cls}`, type: 'button', title }, icon(name));
  b.addEventListener('click', onClick);
  return b;
}
