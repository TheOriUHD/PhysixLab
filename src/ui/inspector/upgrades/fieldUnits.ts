/**
 * UI-A: the DOM side of the unit toggles — what `numberField` / `vec3Field` (src/ui/controls.ts) use to show a value in
 * the field's current unit system, to switch it with one click on the unit label, and to follow global changes.
 */
import { h } from '../../dom';
import { unitPrefs } from './prefsStore';
import type { QuantityDef, UnitSystem } from './units';
import { unitLabel } from './units';

/** The text of a row label without its "(unit)" suffix and without extra children (reset button …). */
export function rowBase(label: Element): string {
  // `row()` records the name it was given: the label text may be the friendlier Simple-mode wording
  const given = label instanceof HTMLElement ? label.dataset.label : undefined;
  const first = label.firstChild;
  const raw =
    given ?? (first && first.nodeType === Node.TEXT_NODE ? (first.textContent ?? '') : (label.textContent ?? ''));
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * A stable identity of a field for per-field unit overrides: the label of the row it sits in. `null` while the field
 * is not in the document yet (the caller then falls back to the global system).
 */
export function fieldKeyOf(el: HTMLElement, q: QuantityDef): string | null {
  if (!el.isConnected) return null;
  const label = el.closest('.row')?.querySelector('.row-label');
  return `${q.id}:${label ? rowBase(label) : ''}`;
}

interface Sub {
  el: HTMLElement;
  fn: () => void;
  seen: boolean;
}

const subs = new Set<Sub>();
let hooked = false;

/** Call `fn` whenever the unit preferences change, for as long as `el` is (or has not yet been put) in the document. */
export function followUnits(el: HTMLElement, fn: () => void): void {
  if (!hooked) {
    hooked = true;
    unitPrefs.onChange(() => {
      for (const s of [...subs]) {
        if (s.el.isConnected) s.seen = true;
        else if (s.seen) {
          subs.delete(s); // was on screen, has been discarded by a rebuild
          continue;
        }
        s.fn();
      }
    });
  }
  subs.add({ el, fn, seen: false });
  // fields that are never attached are dropped on the next sweep
  if (subs.size > 600) for (const s of subs) if (!s.el.isConnected && s.seen) subs.delete(s);
}

/** The system a field currently shows. */
export function systemOf(el: HTMLElement, q: QuantityDef | undefined): UnitSystem {
  return q ? unitPrefs.systemFor(q, fieldKeyOf(el, q)) : 'si';
}

/** Replace a trailing "(m)" of a row label with the unit now shown (only when it is one of this quantity's units). */
export function syncRowLabel(el: HTMLElement, q: QuantityDef): void {
  const label = el.closest('.row')?.querySelector('.row-label');
  const node = label?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const m = /^(.*\()([^)]*)(\)\s*)$/.exec(node.textContent ?? '');
  if (!m) return;
  const units = [q.native.symbol, q.imperial?.symbol];
  if (!units.includes(m[2])) return;
  node.textContent = `${m[1]}${unitLabel(q, systemOf(el, q))}${m[3]}`;
}

/**
 * The unit label of a field: shows the current unit and, when the quantity has an imperial form, switches this field
 * between SI and imperial on click.
 */
export function unitChip(host: () => HTMLElement, q: QuantityDef, cls = 'num-unit'): HTMLElement {
  const toggles = !!q.imperial;
  const chip = toggles
    ? h('button', { class: `${cls} unit-toggle`, type: 'button', tabIndex: -1 })
    : h('span', { class: cls });
  const paint = () => {
    const sys = systemOf(host(), q);
    chip.textContent = unitLabel(q, sys);
    if (toggles) {
      chip.title = `Showing ${sys === 'si' ? 'SI' : 'imperial'} units. Click to switch this field to ${
        sys === 'si' ? q.imperial!.symbol : q.native.symbol
      }`;
    }
    syncRowLabel(host(), q);
  };
  paint();
  if (toggles) {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      unitPrefs.toggleField(q, fieldKeyOf(host(), q));
    });
    chip.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  followUnits(chip, paint);
  // The field is not in the document when the chip is built: paint again once it is, so the right key is used.
  queueMicrotask(() => queueMicrotask(paint));
  return chip;
}
