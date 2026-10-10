import { describe, expect, it } from 'vitest';
import { compileEntry, entryHint, evaluateEntry, type EntryOptions } from '../src/model/edit/expression';

const val = (text: string, cur = 0, o: EntryOptions = {}): number => {
  const r = evaluateEntry(text, cur, o);
  if (!r.ok) throw new Error(`"${text}" failed: ${r.error}`);
  return r.value;
};
const err = (text: string, cur = 0, o: EntryOptions = {}): string => {
  const r = evaluateEntry(text, cur, o);
  if (r.ok) throw new Error(`"${text}" should fail but gave ${r.value}`);
  return r.error;
};

describe('numeric entry: plain numbers', () => {
  it('parses integers, decimals, exponents, comma decimals and a negative literal as absolute', () => {
    expect(val('3', 9)).toBe(3);
    expect(val('  2.5 ', 9)).toBe(2.5);
    expect(val('.5', 9)).toBe(0.5);
    expect(val('1e3', 0)).toBe(1000);
    expect(val('1,5', 0)).toBe(1.5);
    expect(val('-2', 7)).toBe(-2);
    expect(val('-2', 7)).not.toBe(5);
  });
  it('reports absolute entries as not relative', () => {
    const r = evaluateEntry('3', 5);
    expect(r.ok && r.relative).toBe(false);
    const a = evaluateEntry('=3', 5);
    expect(a.ok && a.relative === false && a.value === 3).toBe(true);
  });
});

describe('numeric entry: relative operators', () => {
  it('+ adds to the current value', () => expect(val('+0.5', 2)).toBeCloseTo(2.5, 12));
  it('"- 2" subtracts, "-2" sets -2', () => {
    expect(val('- 2', 5)).toBe(3);
    expect(val('-2', 5)).toBe(-2);
    expect(val('-  0.5', 1)).toBe(0.5);
  });
  it('* multiplies, / divides', () => {
    expect(val('*2', 3.5)).toBe(7);
    expect(val('/4', 10)).toBe(2.5);
  });
  it('= is absolute', () => expect(val('=3', 99)).toBe(3));
  it('applies the operator to the whole rest: +1*2 adds 2, *2+1 multiplies by 3', () => {
    expect(val('+1*2', 10)).toBe(12);
    expect(val('*2+1', 10)).toBe(30);
  });
  it('marks relative entries relative', () => {
    for (const t of ['+1', '*2', '/2', '- 1', 'x+1', '$*2']) {
      const c = compileEntry(t);
      expect(c.ok && c.relative).toBe(true);
    }
  });
  it('compiled entries evaluate against each object’s own current value', () => {
    const c = compileEntry('+0.5');
    if (!c.ok) throw new Error(c.error);
    expect([1, 2, -3].map((v) => c.eval(v))).toEqual([1.5, 2.5, -2.5]);
  });
});

describe('numeric entry: arithmetic and the current value', () => {
  it('respects precedence and parentheses', () => {
    expect(val('1+2*3')).toBe(7);
    expect(val('(1+2)*3')).toBe(9);
    expect(val('10/4')).toBe(2.5);
    expect(val('2^3^2')).toBe(512);
    expect(val('2^-1')).toBe(0.5);
    expect(val('-(1+2)')).toBe(-3);
    expect(val('--3')).toBe(3);
    expect(val('2*-3')).toBe(-6);
  });
  it('x, $ and cur are the current value', () => {
    expect(val('x*2+1', 4)).toBe(9);
    expect(val('$-2', 5)).toBe(3);
    expect(val('cur/2', 5)).toBe(2.5);
    expect(val('x', 4.25)).toBe(4.25);
  });
  it('pi, sqrt and abs', () => {
    expect(val('pi')).toBeCloseTo(Math.PI, 12);
    expect(val('sqrt(16)+abs(-1)')).toBe(5);
    expect(val('2*pi', 0, { kind: 'scalar' })).toBeCloseTo(2 * Math.PI, 12);
  });
});

describe('numeric entry: length units', () => {
  const L: EntryOptions = { kind: 'length' };
  it('converts to metres', () => {
    expect(val('1.5m', 0, L)).toBe(1.5);
    expect(val('30cm', 0, L)).toBeCloseTo(0.3, 12);
    expect(val('250 mm', 0, L)).toBeCloseTo(0.25, 12);
    expect(val('2ft', 0, L)).toBeCloseTo(0.6096, 12);
    expect(val('12in', 0, L)).toBeCloseTo(0.3048, 12);
    expect(val('1yd', 0, L)).toBeCloseTo(0.9144, 12);
    expect(val('0.002km', 0, L)).toBeCloseTo(2, 12);
    expect(val("5'", 0, L)).toBeCloseTo(1.524, 12);
    expect(val('6"', 0, L)).toBeCloseTo(0.1524, 12);
    expect(val('2FT', 0, L)).toBeCloseTo(0.6096, 12);
  });
  it('mixes units in arithmetic and with relative operators', () => {
    expect(val('1m+30cm', 0, L)).toBeCloseTo(1.3, 12);
    expect(val('+50cm', 2, L)).toBeCloseTo(2.5, 12);
    expect(val('2*30cm', 0, L)).toBeCloseTo(0.6, 12);
    expect(val('- 1ft', 1, L)).toBeCloseTo(1 - 0.3048, 12);
  });
  it('bare numbers and results use the field unit when it is not metres', () => {
    expect(val('5', 0, { kind: 'length', lengthUnit: 'cm' })).toBe(5);
    expect(val('1m', 0, { kind: 'length', lengthUnit: 'cm' })).toBeCloseTo(100, 9);
    expect(val('12in', 0, { kind: 'length', lengthUnit: 'ft' })).toBeCloseTo(1, 12);
  });
});

describe('numeric entry: angle units', () => {
  const A: EntryOptions = { kind: 'angle' };
  it('bare numbers are degrees; rad and turn convert', () => {
    expect(val('45', 0, A)).toBe(45);
    expect(val('45deg', 0, A)).toBe(45);
    expect(val('90°', 0, A)).toBe(90);
    expect(val('1.2rad', 0, A)).toBeCloseTo((1.2 * 180) / Math.PI, 10);
  });
  it('relative rotation entries', () => {
    expect(val('+15', 30, A)).toBe(45);
    expect(val('+0.5rad', 0, A)).toBeCloseTo(28.6479, 3);
    expect(val('*2', 40, A)).toBe(80);
    expect(val('0.25turn', 0, A)).toBe(90);
  });
  it('a field in radians returns radians', () => {
    expect(val('180deg', 0, { kind: 'angle', angleUnit: 'rad' })).toBeCloseTo(Math.PI, 12);
    expect(val('1.5', 0, { kind: 'angle', angleUnit: 'rad' })).toBe(1.5);
  });
});

describe('numeric entry: errors', () => {
  it('rejects wrong-kind units with a precise message', () => {
    expect(err('45deg', 0, { kind: 'length' })).toMatch(/angle, but this field takes a length/);
    expect(err('2m', 0, { kind: 'angle' })).toMatch(/length, but this field takes an angle/);
    expect(err('2m', 0, { kind: 'scalar' })).toMatch(/no unit/);
  });
  it('explains unknown names and units', () => {
    expect(err('2 foo')).toMatch(/Unknown unit "foo"/);
    expect(err('foo+1')).toMatch(/Unknown name "foo" at position 1/);
    expect(err('2x')).toMatch(/Write "2\*x"/);
    expect(err('cm')).toMatch(/is a unit/);
    expect(err('constructor+1')).toMatch(/Unknown name/);
  });
  it('explains syntax errors with positions', () => {
    expect(err('')).toMatch(/Enter a number/);
    expect(err('   ')).toMatch(/Enter a number/);
    expect(err('+')).toMatch(/Type a number after "\+"/);
    expect(err('*')).toMatch(/Type a number after "\*"/);
    expect(err('(1+2')).toMatch(/Missing closing/);
    expect(err('1+2)')).toMatch(/Unmatched "\)" at position 4/);
    expect(err('1+')).toMatch(/ends too early/);
    expect(err('1 2')).toMatch(/Unexpected "2" at position 3/);
    expect(err('1 # 2')).toMatch(/Unexpected "#" at position 3/);
    expect(err('sqrt 4')).toMatch(/needs parentheses/);
    expect(err('1**2')).toMatch(/Unexpected "\*"/);
  });
  it('rejects division by zero and non-finite results', () => {
    expect(err('1/0')).toBe('Division by zero');
    expect(err('/0', 5)).toBe('Division by zero');
    expect(err('x/0', 5)).toBe('Division by zero');
    expect(err('sqrt(-1)')).toMatch(/negative/);
    expect(err('10^1000')).toMatch(/not a finite/);
  });
  it('never evaluates code', () => {
    expect(err('alert(1)')).toMatch(/Unknown name/);
    expect(err('process.exit()')).toMatch(/Unknown name|Unexpected/);
  });
});

describe('numeric entry: hint', () => {
  it('mentions the operators and the units of the kind', () => {
    expect(entryHint('length')).toMatch(/\+0\.5/);
    expect(entryHint('length')).toMatch(/cm/);
    expect(entryHint('angle')).toMatch(/rad/);
    expect(entryHint()).not.toMatch(/units:/);
  });
});
