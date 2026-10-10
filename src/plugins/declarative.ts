/**
 * DT-31: declarative plugin UI. A plugin panel's `render()` returns a tree of plain objects; this module validates it
 * (types, sizes, depth — the plugin is untrusted) and builds DOM from it using only `textContent` and the app's
 * own controls. A plugin therefore cannot inject markup, styles or scripts.
 */
import { h } from '../ui/dom';

export type UiNode =
  | { type: 'column' | 'row'; children: UiNode[] }
  | { type: 'heading' | 'text' | 'muted'; text: string }
  | { type: 'divider' }
  | { type: 'button'; label: string; primary: boolean; onClick: number }
  | { type: 'number'; label: string; value: number; min: number; max: number; step: number; onChange: number }
  | { type: 'checkbox'; label: string; value: boolean; onChange: number }
  | { type: 'select'; label: string; value: string; options: { value: string; label: string }[]; onChange: number }
  | { type: 'progress'; label: string; value: number }
  | { type: 'table'; columns: string[]; rows: string[][] };

export const UI_LIMITS = { nodes: 400, depth: 8, text: 500, options: 60, rows: 100, columns: 8 } as const;

export class UiError extends Error {}

const str = (v: unknown, max: number = UI_LIMITS.text): string =>
  (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').slice(0, max);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cbId = (v: unknown): number => {
  if (typeof v === 'object' && v !== null && typeof (v as { __cb?: unknown }).__cb === 'number')
    return (v as { __cb: number }).__cb;
  return 0;
};

/** Validate + normalise a tree from the sandbox. Throws `UiError` when it is not a usable tree. */
export function validateTree(root: unknown): UiNode {
  let count = 0;
  const walk = (n: unknown, depth: number): UiNode => {
    if (++count > UI_LIMITS.nodes) throw new UiError(`A panel may have at most ${UI_LIMITS.nodes} elements`);
    if (depth > UI_LIMITS.depth) throw new UiError(`Panels may be nested at most ${UI_LIMITS.depth} deep`);
    if (typeof n === 'string') return { type: 'text', text: str(n) };
    if (typeof n !== 'object' || n === null)
      throw new UiError('Every panel element must be an object like { type: "text", text: "…" }');
    const o = n as Record<string, unknown>;
    switch (o['type']) {
      case 'column':
      case 'row': {
        const kids = Array.isArray(o['children']) ? (o['children'] as unknown[]) : [];
        return {
          type: o['type'],
          children: kids.filter((k) => k !== null && k !== false && k !== undefined).map((k) => walk(k, depth + 1)),
        };
      }
      case 'heading':
      case 'text':
      case 'muted':
        return { type: o['type'], text: str(o['text']) };
      case 'divider':
        return { type: 'divider' };
      case 'button':
        return {
          type: 'button',
          label: str(o['label'], 80),
          primary: o['primary'] === true,
          onClick: cbId(o['onClick']),
        };
      case 'number':
        return {
          type: 'number',
          label: str(o['label'], 80),
          value: num(o['value']),
          min: num(o['min'], -1e9),
          max: num(o['max'], 1e9),
          step: num(o['step'], 0.1) || 0.1,
          onChange: cbId(o['onChange']),
        };
      case 'checkbox':
        return {
          type: 'checkbox',
          label: str(o['label'], 80),
          value: o['value'] === true,
          onChange: cbId(o['onChange']),
        };
      case 'select': {
        const opts = (Array.isArray(o['options']) ? (o['options'] as unknown[]) : [])
          .slice(0, UI_LIMITS.options)
          .map((x) => {
            const p = (typeof x === 'object' && x !== null ? x : { value: x }) as Record<string, unknown>;
            return { value: str(p['value'], 80), label: str(p['label'] ?? p['value'], 80) };
          });
        return {
          type: 'select',
          label: str(o['label'], 80),
          value: str(o['value'], 80),
          options: opts,
          onChange: cbId(o['onChange']),
        };
      }
      case 'progress':
        return { type: 'progress', label: str(o['label'], 80), value: Math.min(1, Math.max(0, num(o['value']))) };
      case 'table': {
        const columns = (Array.isArray(o['columns']) ? (o['columns'] as unknown[]) : [])
          .slice(0, UI_LIMITS.columns)
          .map((c) => str(c, 60));
        const rows = (Array.isArray(o['rows']) ? (o['rows'] as unknown[]) : [])
          .slice(0, UI_LIMITS.rows)
          .map((r) => (Array.isArray(r) ? (r as unknown[]) : []).slice(0, UI_LIMITS.columns).map((c) => str(c, 120)));
        return { type: 'table', columns, rows };
      }
      default:
        throw new UiError(`Unknown panel element type "${str(o['type'], 30)}"`);
    }
  };
  return walk(root, 0);
}

/** Collect every callback id in a tree (so the host can tell the sandbox which ones are stale). */
export function callbackIds(n: UiNode, out: number[] = []): number[] {
  switch (n.type) {
    case 'column':
    case 'row':
      n.children.forEach((c) => callbackIds(c, out));
      break;
    case 'button':
      if (n.onClick) out.push(n.onClick);
      break;
    case 'number':
    case 'checkbox':
    case 'select':
      if (n.onChange) out.push(n.onChange);
      break;
    default:
      break;
  }
  return out;
}

export function renderTree(n: UiNode, fire: (cb: number, args: unknown[]) => void): HTMLElement {
  switch (n.type) {
    case 'column':
    case 'row':
      return h('div', { class: `plg-${n.type}` }, ...n.children.map((c) => renderTree(c, fire)));
    case 'heading':
      return h('h4', { class: 'plg-heading' }, n.text);
    case 'text':
      return h('p', { class: 'plg-text' }, n.text);
    case 'muted':
      return h('p', { class: 'plg-text plg-muted' }, n.text);
    case 'divider':
      return h('hr', { class: 'plg-divider' });
    case 'button': {
      const b = h('button', { class: `btn${n.primary ? ' primary' : ''}`, type: 'button' }, n.label);
      b.addEventListener('click', () => fire(n.onClick, []));
      return b;
    }
    case 'number': {
      const input = h('input', {
        class: 'plain',
        type: 'number',
        value: String(n.value),
        min: String(n.min),
        max: String(n.max),
        step: String(n.step),
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) fire(n.onChange, [Math.min(n.max, Math.max(n.min, v))]);
      });
      return h('label', { class: 'plg-field' }, h('span', null, n.label), input);
    }
    case 'checkbox': {
      const input = h('input', { type: 'checkbox', checked: n.value });
      input.addEventListener('change', () => fire(n.onChange, [input.checked]));
      return h('label', { class: 'plg-field plg-check' }, input, h('span', null, n.label));
    }
    case 'select': {
      const sel = h(
        'select',
        { class: 'plain' },
        ...n.options.map((o) => h('option', { value: o.value, selected: o.value === n.value }, o.label)),
      );
      sel.addEventListener('change', () => fire(n.onChange, [sel.value]));
      return h('label', { class: 'plg-field' }, h('span', null, n.label), sel);
    }
    case 'progress': {
      const bar = h(
        'div',
        { class: 'plg-bar' },
        h('div', { class: 'plg-bar-fill', style: { width: `${Math.round(n.value * 100)}%` } }),
      );
      return h('div', { class: 'plg-progress' }, n.label ? h('span', null, n.label) : null, bar);
    }
    case 'table':
      return h(
        'table',
        { class: 'plg-table' },
        h('thead', null, h('tr', null, ...n.columns.map((c) => h('th', null, c)))),
        h('tbody', null, ...n.rows.map((r) => h('tr', null, ...r.map((c) => h('td', null, c))))),
      );
    default:
      return h('span');
  }
}
