import { button } from '../controls';
import { h } from '../dom';

export { button };

/** A labelled number input that reports a changed, in-range value (commit on change/blur, not on every key). */
export function numberFieldRow(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (v: number) => void | Promise<unknown>,
): HTMLElement {
  const input = h('input', { type: 'number', class: 'plain', value: String(value), min, max, step: 1 });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Number(input.value)));
    if (!Number.isFinite(v)) return;
    input.value = String(v);
    void onChange(v);
  });
  return h('label', { class: 'data-row' }, h('span', null, label), input);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
