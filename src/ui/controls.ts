/** Reusable form controls for the inspector and settings panels. */
import { captureKey, describeKey } from '../app/input/capture';
import { h } from './dom';
import { icon } from './icons';

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
}

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
    title: o.title ?? '',
  });
  const unit = o.unit ? h('span', { class: 'num-unit' }, o.unit) : null;
  const clampV = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const show = (v: number, mixed = false) => {
    input.value = mixed ? '—' : fmt(v, digits);
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
    const t = input.value.trim().replace(',', '.');
    let v = Number(t);
    if (!Number.isFinite(v)) {
      // simple a/b fractions
      const m = /^(-?[\d.]+)\s*\/\s*(-?[\d.]+)$/.exec(t);
      v = m ? Number(m[1]) / Number(m[2]) : NaN;
    }
    o.onStart?.();
    commit(v);
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
  if (label) {
    label.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
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
        label.removeEventListener('pointermove', move);
        label.removeEventListener('pointerup', up);
        label.removeEventListener('pointercancel', up);
        if (started) {
          o.onEnd?.();
          document.body.classList.remove('scrubbing');
        }
      };
      label.addEventListener('pointermove', move);
      label.addEventListener('pointerup', up);
      label.addEventListener('pointercancel', up);
    });
  }

  const el = h('label', { class: 'num-field' }, label, input, unit);
  return {
    el,
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
}): Field<[number, number, number]> {
  let cur: [number, number, number] = [0, 0, 0];
  const mk = (i: number, name: string) =>
    numberField({
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
  return {
    el: h('div', { class: 'vec3' }, fx.el, fy.el, fz.el),
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
    h('div', { class: 'row-label', title: hint ?? '' }, label),
    h('div', { class: 'row-control' }, control),
  );
}

/** Label above a full-width control (for wide controls such as vectors). */
export function rowStack(label: string, control: HTMLElement | HTMLElement[], hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'row stack' },
    h('div', { class: 'row-label', title: hint ?? '' }, label),
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
    h('span', null, title),
    opts.badge ? h('span', { class: 'badge' }, opts.badge) : null,
  );
  const el = h('section', { class: `section ${open ? 'open' : ''}` }, head, content);
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
