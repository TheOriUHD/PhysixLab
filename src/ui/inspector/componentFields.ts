/**
 * Schema-driven editors for component parameters: one function turns a `FieldDef` (src/model/componentRegistry.ts)
 * into a control — number, bool, enum, vec3, colour, key, text, entity reference, path reference, curve. The
 * inspector's Components section calls it for every field of every component, so a new component type needs no UI code.
 */
import type { App } from '../../app/app';
import type { ComponentValue, FieldDef } from '../../model/componentRegistry';
import { fmt, colorField, keyField, numberField, toggleField, vec3Field, type Field } from '../controls';
import { namesWithRole } from '../../model/controls'; // -- CP
import { h } from '../dom';
import { icon } from '../icons';

/** What an editor needs from its surroundings. */
export interface EditorEnv {
  app: App;
  /** Called with the new value on every change (a scrub or drag produces many). */
  onChange: (value: ComponentValue) => void;
  /** Bracket a scrub / drag so the whole gesture is one undo step. */
  onStart: () => void;
  onEnd: () => void;
}

export interface FieldEditor {
  el: HTMLElement;
  /** Show `value` (does not call `onChange`; leaves a control the user is typing into alone). */
  set(value: ComponentValue): void;
}

const asNumber = (v: ComponentValue, d = 0): number => (typeof v === 'number' ? v : d);

export function buildFieldEditor(f: FieldDef, env: EditorEnv): FieldEditor {
  const wrap = <T extends ComponentValue>(field: Field<T>, fallback: T): FieldEditor => ({
    el: field.el,
    set: (v) => field.set((v ?? fallback) as T),
  });
  const grouped = { onStart: env.onStart, onEnd: env.onEnd };
  switch (f.kind) {
    case 'number':
      return wrap(
        numberField({
          step: f.step ?? 0.1,
          min: f.min,
          max: f.max,
          digits: f.digits,
          unit: f.unit,
          title: f.hint,
          ...grouped,
          onChange: (v) => env.onChange(v),
        }),
        f.default,
      );
    case 'bool':
      return wrap(toggleField({ title: f.hint, onChange: (v) => env.onChange(v) }), f.default);
    case 'enum':
      return enumEditor(f, env);
    case 'vec3':
      return wrap(
        vec3Field({
          step: f.step ?? 0.1,
          min: f.min,
          max: f.max,
          digits: f.digits,
          unit: f.unit,
          ...grouped,
          onChange: (v) => env.onChange(v),
        }),
        [...f.default],
      );
    case 'color':
      return wrap(colorField({ ...grouped, onChange: (v) => env.onChange(v) }), f.default);
    case 'key':
      return wrap(keyField({ placeholder: 'None', onChange: (v) => env.onChange(v) }), f.default);
    case 'text':
      return textEditor(f, env);
    case 'entity':
      return refEditor(
        env,
        f.default,
        () => env.app.store.all().filter((e) => (f.filter ?? 'body') === 'any' || e.kind === (f.filter ?? 'body')),
        'None',
      );
    case 'path':
      return refEditor(env, f.default, () => env.app.store.paths(), 'No path');
    case 'curve':
      return curveEditor(f, env);
  }
}

function enumEditor(f: Extract<FieldDef, { kind: 'enum' }>, env: EditorEnv): FieldEditor {
  const select = h(
    'select',
    { class: 'select', title: f.hint ?? '' },
    f.options.map((o) => h('option', { value: o.value }, o.label)),
  );
  select.addEventListener('change', () => env.onChange(select.value));
  return {
    el: h('div', { class: 'select-wrap' }, select, icon('chevronDown', 'icon select-caret')),
    set: (v) => {
      select.value = String(v);
    },
  };
}

function textEditor(f: Extract<FieldDef, { kind: 'text' }>, env: EditorEnv): FieldEditor {
  const input = h('input', {
    class: 'plain comp-text',
    type: 'text',
    spellcheck: false,
    maxLength: f.maxLength ?? 256,
    placeholder: f.placeholder ?? '',
    title: f.hint ?? '',
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
  });
  input.addEventListener('change', () => env.onChange(input.value));
  // -- CP: a field that names an axis or a drive-train shaft suggests the names the scene already uses
  if (f.role) {
    const role = f.role;
    const list = h('datalist', { id: `names-${role}-${++nameLists}` });
    input.setAttribute('list', list.id);
    input.addEventListener('focus', () => {
      list.replaceChildren(...namesWithRole(env.app.store.all(), role).map((n) => h('option', { value: n })));
    });
    return {
      el: h('span', { class: 'comp-text-wrap' }, input, list),
      set: (v) => {
        if (document.activeElement !== input) input.value = String(v);
      },
    };
  }
  return {
    el: input,
    set: (v) => {
      if (document.activeElement !== input) input.value = String(v);
    },
  };
}
let nameLists = 0; // -- CP

/** A drop-down of scene entities by name (options follow the document); a reference to something gone shows as missing. */
function refEditor(
  env: EditorEnv,
  none: string,
  list: () => { id: string; name: string }[],
  noneLabel: string,
): FieldEditor {
  const select = h('select', { class: 'select' });
  let current = none;
  const fill = () => {
    const items = list();
    const sig = `${items.map((i) => `${i.id}=${i.name}`).join('|')}#${current}`;
    if (select.dataset.sig === sig) return;
    select.dataset.sig = sig;
    const opts = [h('option', { value: '' }, `— ${noneLabel.toLowerCase()} —`)];
    for (const i of items) opts.push(h('option', { value: i.id }, i.name));
    if (current && !items.some((i) => i.id === current)) opts.push(h('option', { value: current }, '(missing)'));
    select.replaceChildren(...opts);
    select.value = current;
  };
  select.addEventListener('change', () => env.onChange(select.value));
  // the list of entities can change while the control is on screen: refresh on focus, before the list opens
  select.addEventListener('pointerdown', fill);
  select.addEventListener('focus', fill);
  return {
    el: h('div', { class: 'select-wrap' }, select, icon('chevronDown', 'icon select-caret')),
    set: (v) => {
      current = typeof v === 'string' ? v : '';
      fill();
      select.value = current;
    },
  };
}

// ---- curve editor --------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const W = 260;
const H = 120;
const PAD = 14;

/**
 * An editable piecewise-linear curve y(x). Drag a point to move it (it stays between its neighbours), click empty
 * space to add one, double-click or right-click a point to delete it (a curve keeps at least two).
 */
function curveEditor(f: Extract<FieldDef, { kind: 'curve' }>, env: EditorEnv): FieldEditor {
  const [x0, x1] = f.xRange;
  const [y0, y1] = f.yRange;
  let pts: number[][] = f.default.map((p) => [...p]);
  let selected = -1;
  let lastPress: { index: number; at: number } | null = null;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'curve-svg', role: 'img', 'aria-label': f.label });
  const grid = svgEl('g', { class: 'curve-grid' });
  for (let i = 0; i <= 4; i++) {
    const gx = PAD + ((W - 2 * PAD) * i) / 4;
    const gy = PAD + ((H - 2 * PAD) * i) / 4;
    grid.append(
      svgEl('line', { x1: gx, y1: PAD, x2: gx, y2: H - PAD }),
      svgEl('line', { x1: PAD, y1: gy, x2: W - PAD, y2: gy }),
    );
  }
  const line = svgEl('polyline', { class: 'curve-line', fill: 'none' });
  const dots = svgEl('g', { class: 'curve-dots' });
  svg.append(grid, line, dots);
  const readout = h('div', { class: 'curve-readout' });
  const labels = h(
    'div',
    { class: 'curve-labels' },
    h('span', null, `${f.yLabel ?? 'y'} ${fmt(y0, 2)}…${fmt(y1, 2)}`),
    h('span', null, `${f.xLabel ?? 'x'} ${fmt(x0, 2)}…${fmt(x1, 2)}`),
  );

  const px = (x: number) => PAD + ((x - x0) / (x1 - x0)) * (W - 2 * PAD);
  const py = (y: number) => H - PAD - ((y - y0) / (y1 - y0)) * (H - 2 * PAD);
  const fromX = (cx: number) => x0 + ((cx - PAD) / (W - 2 * PAD)) * (x1 - x0);
  const fromY = (cy: number) => y0 + ((H - PAD - cy) / (H - 2 * PAD)) * (y1 - y0);
  const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const round = (v: number) => Math.round(v * 1000) / 1000;

  const draw = () => {
    line.setAttribute('points', pts.map((p) => `${px(p[0])},${py(p[1])}`).join(' '));
    dots.replaceChildren(
      ...pts.flatMap((p, i) => [
        svgEl('circle', {
          cx: px(p[0]),
          cy: py(p[1]),
          r: i === selected ? 5.5 : 4.5,
          class: `curve-dot ${i === selected ? 'sel' : ''}`,
        }),
        // an invisible, larger target so a point is easy to grab at any panel width
        svgEl('circle', { cx: px(p[0]), cy: py(p[1]), r: 11, class: 'curve-hit', 'data-index': i }),
      ]),
    );
    const p = pts[selected];
    readout.textContent = p
      ? `${f.xLabel ?? 'x'} = ${fmt(p[0], 3)}   ${f.yLabel ?? 'y'} = ${fmt(p[1], 3)}`
      : 'Click to add a point · drag to move · double-click to delete';
  };

  const local = (ev: PointerEvent): [number, number] => {
    const r = svg.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  };
  const commit = () => env.onChange(pts.map((p) => [p[0], p[1]]));

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const target = ev.target as Element;
    const [cx, cy] = local(ev);
    let index = target.classList.contains('curve-hit') ? Number(target.getAttribute('data-index')) : -1;
    // A second press on the same point within 400 ms deletes it (`dblclick` is not reliable once a press redraws the points).
    const now = performance.now();
    if (index >= 0 && lastPress && lastPress.index === index && now - lastPress.at < 400 && pts.length > 2) {
      lastPress = null;
      env.onStart();
      pts = pts.filter((_, j) => j !== index);
      selected = -1;
      draw();
      commit();
      env.onEnd();
      ev.preventDefault();
      return;
    }
    lastPress = index >= 0 ? { index, at: now } : null;
    env.onStart();
    if (index < 0) {
      // a new point where the pointer is, keeping x strictly increasing
      const x = round(clampTo(fromX(cx), x0, x1));
      if (pts.some((p) => Math.abs(p[0] - x) < 1e-6)) {
        env.onEnd();
        return;
      }
      pts = [...pts, [x, round(clampTo(fromY(cy), y0, y1))]].sort((a, b) => a[0] - b[0]);
      index = pts.findIndex((p) => p[0] === x);
      commit();
    }
    selected = index;
    draw();
    svg.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const [mx, my] = local(e);
      const lo = index > 0 ? pts[index - 1][0] + 1e-3 : x0;
      const hi = index < pts.length - 1 ? pts[index + 1][0] - 1e-3 : x1;
      pts[index] = [round(clampTo(fromX(mx), lo, hi)), round(clampTo(fromY(my), y0, y1))];
      draw();
      commit();
    };
    const up = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
      env.onEnd();
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    ev.preventDefault();
  });
  const remove = (ev: MouseEvent) => {
    // Hit-test by position: a press redraws the points, so the element under the pointer may be a new one by now.
    const r = svg.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W;
    const my = ((ev.clientY - r.top) / r.height) * H;
    let i = -1;
    let best = 11;
    pts.forEach((p, k) => {
      const d = Math.hypot(px(p[0]) - mx, py(p[1]) - my);
      if (d < best) {
        best = d;
        i = k;
      }
    });
    if (i < 0) return;
    ev.preventDefault();
    if (pts.length <= 2) return;
    env.onStart();
    pts = pts.filter((_, j) => j !== i);
    selected = -1;
    draw();
    commit();
    env.onEnd();
  };
  svg.addEventListener('dblclick', remove);
  svg.addEventListener('contextmenu', remove);

  draw();
  return {
    el: h('div', { class: 'curve-editor', title: f.hint ?? '' }, svg, labels, readout),
    set: (v) => {
      if (!Array.isArray(v) || !Array.isArray(v[0])) return;
      const next = (v as number[][]).map((p) => [asNumber(p[0]), asNumber(p[1])]);
      if (JSON.stringify(next) === JSON.stringify(pts)) return;
      pts = next;
      selected = Math.min(selected, pts.length - 1);
      draw();
    },
  };
}
