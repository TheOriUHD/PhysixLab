/**
 * Relative numeric entry (ED-14), pure. The inspector's number fields already evaluate expressions with units
 * (`src/ui/inspector/upgrades/expr.ts`: `2*9.81`, `5 ft`, `30deg`, …); this layer adds the *leading operator* that makes
 * an entry relative to what the field currently holds:
 *
 *   +0.5   current + 0.5        *2   current × 2        /4   current ÷ 4
 *   - 2    current − 2 (a space after the minus)         =3   exactly 3 (absolute, same as "3")
 *   x  $  cur   anywhere in the entry: the current value (`x*2+1`, `$-2`)
 *
 * The operator applies to everything after it ("+1*2" adds 2, "*2+1" multiplies by 3). A leading minus *directly
 * followed by the number* is the negative number (-2 sets −2), because that is what a position field is far more often
 * used for; subtract with a space ("- 2"), "x-2" or "$-2".
 *
 * The operand itself is evaluated by the caller's `parse` (so units and the unit system stay the field's business):
 * `+50cm` adds 0.5 m to a length field, `*2` multiplies by the plain number 2.
 */

export type EntryMode = 'absolute' | 'add' | 'sub' | 'mul' | 'div';

export interface SplitEntry {
  mode: EntryMode;
  /** The entry without its operator. */
  rest: string;
}

export type ParseOutcome = { ok: true; value: number } | { ok: false; error: string };

export type EntryResult =
  | { ok: true; value: number; /** Does the result depend on the current value? */ relative: boolean; mode: EntryMode }
  | { ok: false; error: string };

const CURRENT = /(?<![A-Za-z_0-9.])(?:x|\$|cur|current)(?![A-Za-z_0-9])/gi;

/** Split off a leading operator. */
export function splitRelative(text: string): SplitEntry | { error: string } {
  const t = text.trim();
  const first = t[0];
  if (first === '=') return { mode: 'absolute', rest: t.slice(1).trim() };
  if (first === '+' || first === '*' || first === '/') {
    const rest = t.slice(1).trim();
    if (!rest) return { error: `Type a number after "${first}" (e.g. ${first}2)` };
    return { mode: first === '+' ? 'add' : first === '*' ? 'mul' : 'div', rest };
  }
  if (first === '-' && /^-\s+\S/.test(t)) return { mode: 'sub', rest: t.slice(1).trim() };
  return { mode: 'absolute', rest: t };
}

/** Does the text mention the current value (`x`, `$`, `cur`)? */
export const usesCurrent = (text: string): boolean => new RegExp(CURRENT.source, 'i').test(text);

/** Replace `x` / `$` / `cur` by `(shown)`, the current value as the field displays it. */
export function substituteCurrent(text: string, shown: number): string {
  return text.replace(CURRENT, `(${Number(shown.toPrecision(12))})`);
}

/** Combine the current value with an operand under a mode. */
export function applyMode(mode: EntryMode, current: number, operand: number): number | null {
  switch (mode) {
    case 'add':
      return current + operand;
    case 'sub':
      return current - operand;
    case 'mul':
      return current * operand;
    case 'div':
      return operand === 0 ? null : current / operand;
    default:
      return operand;
  }
}

/**
 * Evaluate an entry for a field holding `current` (stored units; `shown` is the same value in the displayed unit, used
 * for `x`). `parse(text, plain)` evaluates an expression in the field's units; `plain` asks for a unit-less number (the
 * operand of `*` and `/`).
 */
export function evaluateEntry(
  text: string,
  current: number,
  shown: number,
  parse: (text: string, plain: boolean) => ParseOutcome,
): EntryResult {
  const s = splitRelative(text);
  if ('error' in s) return { ok: false, error: s.error };
  const operandText = substituteCurrent(s.rest, shown);
  const r = parse(operandText, s.mode === 'mul' || s.mode === 'div');
  if (!r.ok) return r;
  const value = applyMode(s.mode, current, r.value);
  if (value === null) return { ok: false, error: 'Division by zero' };
  if (!Number.isFinite(value)) return { ok: false, error: 'The result is not a finite number' };
  return { ok: true, value, relative: s.mode !== 'absolute' || usesCurrent(s.rest), mode: s.mode };
}

/** Tooltip appended to a number field. */
export const ENTRY_HINT =
  'Type a value or an expression: 2.5 · 30cm · +0.5 adds · *2 multiplies · /4 divides · "- 1" subtracts · =3 sets · x is the current value';
