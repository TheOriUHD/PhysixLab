import { describe, expect, it } from 'vitest';
import {
  applyMode,
  ENTRY_HINT,
  evaluateEntry,
  splitRelative,
  substituteCurrent,
  usesCurrent,
  type ParseOutcome,
} from '../src/model/edit/expression';
import { parseFieldInput } from '../src/ui/inspector/upgrades/expr';
import { quantityOfSymbol, toDisplay } from '../src/ui/inspector/upgrades/units';
import type { QuantityDef, UnitSystem } from '../src/ui/inspector/upgrades/units';

/** A field the way the inspector builds it: the real expression parser with units, for a quantity and a unit system. */
function field(symbol: string | undefined, system: UnitSystem = 'si') {
  const qd: QuantityDef | undefined = symbol ? quantityOfSymbol(symbol) : undefined;
  const parse = (t: string, plain: boolean): ParseOutcome => parseFieldInput(t, plain ? undefined : qd, system);
  return (text: string, current: number): number => {
    const shown = qd ? toDisplay(qd, system, current) : current;
    const r = evaluateEntry(text, current, shown, parse);
    if (!r.ok) throw new Error(`"${text}" failed: ${r.error}`);
    return r.value;
  };
}
const fail = (symbol: string | undefined, text: string, current = 0, system: UnitSystem = 'si'): string => {
  const qd = symbol ? quantityOfSymbol(symbol) : undefined;
  const shown = qd ? toDisplay(qd, system, current) : current;
  const r = evaluateEntry(text, current, shown, (t, plain) => parseFieldInput(t, plain ? undefined : qd, system));
  if (r.ok) throw new Error(`"${text}" should fail but gave ${r.value}`);
  return r.error;
};

describe('relative entry: splitting the operator', () => {
  it('knows + * / = and "- " (minus followed by a space)', () => {
    expect(splitRelative('+0.5')).toEqual({ mode: 'add', rest: '0.5' });
    expect(splitRelative(' *2 ')).toEqual({ mode: 'mul', rest: '2' });
    expect(splitRelative('/4')).toEqual({ mode: 'div', rest: '4' });
    expect(splitRelative('=3')).toEqual({ mode: 'absolute', rest: '3' });
    expect(splitRelative('- 2')).toEqual({ mode: 'sub', rest: '2' });
    expect(splitRelative('-  0.5')).toEqual({ mode: 'sub', rest: '0.5' });
  });
  it('a minus glued to the number is a negative number, not a subtraction', () => {
    expect(splitRelative('-2')).toEqual({ mode: 'absolute', rest: '-2' });
    expect(splitRelative('-x')).toEqual({ mode: 'absolute', rest: '-x' });
    expect(splitRelative('3')).toEqual({ mode: 'absolute', rest: '3' });
  });
  it('an operator without a number is an error', () => {
    expect(splitRelative('+')).toEqual({ error: 'Type a number after "+" (e.g. +2)' });
    expect(splitRelative('  *  ')).toEqual({ error: 'Type a number after "*" (e.g. *2)' });
  });
});

describe('relative entry: the current value', () => {
  it('finds x, $ and cur as whole words only', () => {
    expect(usesCurrent('x*2')).toBe(true);
    expect(usesCurrent('$-2')).toBe(true);
    expect(usesCurrent('cur/2')).toBe(true);
    expect(usesCurrent('2 px')).toBe(false);
    expect(usesCurrent('max(1,2)')).toBe(false);
    expect(usesCurrent('1.5')).toBe(false);
  });
  it('substitutes it in brackets', () => {
    expect(substituteCurrent('x*2+1', 4)).toBe('(4)*2+1');
    expect(substituteCurrent('$-2', -1.5)).toBe('(-1.5)-2');
    expect(substituteCurrent('max(x,2)', 3)).toBe('max((3),2)');
  });
  it('applyMode combines the way the operator says; division by zero is null', () => {
    expect(applyMode('add', 2, 0.5)).toBe(2.5);
    expect(applyMode('sub', 2, 0.5)).toBe(1.5);
    expect(applyMode('mul', 2, 3)).toBe(6);
    expect(applyMode('div', 3, 2)).toBe(1.5);
    expect(applyMode('div', 3, 0)).toBeNull();
    expect(applyMode('absolute', 99, 4)).toBe(4);
  });
});

describe('relative entry on a length field (metres)', () => {
  const len = field('m');
  it('+ adds, * and / use plain numbers, "- " subtracts, = and bare numbers set', () => {
    expect(len('+0.5', 2)).toBeCloseTo(2.5, 12);
    expect(len('*2', 3.5)).toBe(7);
    expect(len('/4', 10)).toBe(2.5);
    expect(len('- 2', 5)).toBe(3);
    expect(len('-2', 5)).toBe(-2);
    expect(len('=3', 99)).toBe(3);
    expect(len('7', 99)).toBe(7);
  });
  it('the operator covers the whole rest: +1*2 adds 2, *2+1 multiplies by 3', () => {
    expect(len('+1*2', 10)).toBe(12);
    expect(len('*2+1', 10)).toBe(30);
  });
  it('units in the operand are converted: +50cm, - 1ft, 2ft', () => {
    expect(len('+50cm', 2)).toBeCloseTo(2.5, 12);
    expect(len('- 1ft', 1)).toBeCloseTo(1 - 0.3048, 12);
    expect(len('2ft', 0)).toBeCloseTo(0.6096, 12);
    expect(len('30 cm', 0)).toBeCloseTo(0.3, 12);
  });
  it('x is the current value and makes the entry relative', () => {
    expect(len('x*2+1', 4)).toBe(9);
    expect(len('$-2', 5)).toBe(3);
    const r = evaluateEntry('x+1', 1, 1, (t) => parseFieldInput(t, quantityOfSymbol('m'), 'si'));
    expect(r.ok && r.relative).toBe(true);
    const a = evaluateEntry('3', 1, 1, (t) => parseFieldInput(t, quantityOfSymbol('m'), 'si'));
    expect(a.ok && !a.relative).toBe(true);
  });
  it('a multiplier is not read in the display unit: *2 doubles even when the field shows feet', () => {
    const ft = field('m', 'imperial');
    expect(ft('*2', 3)).toBe(6); // stored metres, plain factor
    expect(ft('+1', 3)).toBeCloseTo(3 + 0.3048, 12); // 1 in the displayed unit (feet) is added
    expect(ft('x+1', 3)).toBeCloseTo(3 + 0.3048, 9);
  });
});

describe('relative entry on an angle field (degrees)', () => {
  const ang = field('°');
  it('relative and absolute angle entries', () => {
    expect(ang('+15', 30)).toBe(45);
    expect(ang('+0.5rad', 0)).toBeCloseTo(28.6479, 3);
    expect(ang('*2', 40)).toBe(80);
    expect(ang('90', 0)).toBe(90);
    expect(ang('180deg/2', 0)).toBe(90);
  });
});

describe('relative entry: errors', () => {
  it('explains operator mistakes and arithmetic errors', () => {
    expect(fail('m', '+')).toMatch(/Type a number after "\+"/);
    expect(fail('m', '/0', 5)).toBe('Division by zero');
    expect(fail('m', 'x/0', 5)).toMatch(/zero|finite|Division/i);
    expect(fail('m', '+abc')).toBeTruthy();
  });
  it('rejects the wrong kind of unit through the field parser', () => {
    expect(fail('m', '+45deg')).toMatch(/length/);
    expect(fail('°', '+2m')).toMatch(/angle/);
    expect(fail(undefined, '+2m')).toMatch(/plain number/);
  });
  it('never evaluates code', () => {
    expect(fail('m', 'alert(1)')).toBeTruthy();
    expect(fail('m', '+process.exit()')).toBeTruthy();
  });
});

describe('relative entry: hint', () => {
  it('mentions the operators', () => {
    expect(ENTRY_HINT).toMatch(/\+0\.5/);
    expect(ENTRY_HINT).toMatch(/\*2/);
  });
});
