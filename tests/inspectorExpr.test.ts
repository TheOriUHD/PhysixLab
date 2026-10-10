import { describe, expect, it } from 'vitest';
import { evaluate, parseFieldInput } from '../src/ui/inspector/upgrades/expr';
import { fromDisplay, quantityById, quantityOfSymbol, toDisplay } from '../src/ui/inspector/upgrades/units';
import { PresetStore, UnitPrefs, sanitizePresets } from '../src/ui/inspector/upgrades/prefsStore';

const val = (s: string): number => {
  const r = evaluate(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.value;
};
const bad = (s: string): string => {
  const r = evaluate(s);
  if (r.ok) throw new Error(`${s} should fail, got ${r.value}`);
  return r.error;
};

describe('inspector expression parser', () => {
  it('does arithmetic with the right precedence', () => {
    expect(val('2*9.81')).toBeCloseTo(19.62, 12);
    expect(val('1+2*3')).toBe(7);
    expect(val('(1+2)*3')).toBe(9);
    expect(val('2^3^2')).toBe(512); // right associative
    expect(val('-2^2')).toBe(-4);
    expect(val('2^-1')).toBe(0.5);
    expect(val('10/4')).toBe(2.5);
    expect(val('3/4')).toBe(0.75);
    expect(val('1e3 + .5')).toBe(1000.5);
    expect(val('2,5')).toBe(2.5);
    expect(val('2**4')).toBe(16);
    expect(val('2 × 3 ÷ 4 − 1')).toBe(0.5);
  });

  it('knows constants and functions', () => {
    expect(val('pi')).toBeCloseTo(Math.PI, 14);
    expect(val('2 pi')).toBeCloseTo(2 * Math.PI, 14);
    expect(val('sqrt(2*9.81*10)')).toBeCloseTo(Math.sqrt(196.2), 12);
    expect(val('max(1,5,3)')).toBe(5);
    expect(val('sin(30 deg)')).toBeCloseTo(0.5, 12);
    expect(val('cos(0)')).toBe(1);
    expect(val('atan2(1,1)')).toBeCloseTo(Math.PI / 4, 14);
    expect(val('hypot(3,4)')).toBe(5);
    expect(val('abs(-3)')).toBe(3);
  });

  it('converts units to the SI base and tracks dimensions', () => {
    expect(val('5 ft')).toBeCloseTo(1.524, 12);
    expect(val('5ft')).toBeCloseTo(1.524, 12);
    expect(val('12 in')).toBeCloseTo(0.3048, 12);
    expect(val('1 lb')).toBeCloseTo(0.45359237, 12);
    expect(val('36 km/h')).toBeCloseTo(10, 12);
    expect(val('60 mph')).toBeCloseTo(26.8224, 4);
    expect(val('5 m / 2 s')).toBeCloseTo(2.5, 12);
    expect(val('1 ft + 12 in')).toBeCloseTo(0.6096, 12);
    expect(val('2*g0')).toBeCloseTo(19.6133, 4);
    const sq = evaluate('9 m^2');
    expect(sq.ok && sq.dim).toEqual([2, 0, 0, 0]);
    const sqrt = evaluate('sqrt(9 m^2)');
    expect(sqrt.ok && sqrt.dim).toEqual([1, 0, 0, 0]);
    const plain = evaluate('2*9.81');
    expect(plain.ok && plain.united).toBe(false);
  });

  it('rejects nonsense with a message instead of a value', () => {
    expect(bad('5 ft + 2 kg')).toMatch(/different kinds/);
    expect(bad('')).toBe('Empty');
    expect(bad('2 +')).toMatch(/Incomplete/);
    expect(bad('(1+2')).toMatch(/closing/);
    expect(bad('5 parsec')).toMatch(/Unknown unit/);
    expect(bad('1/0')).toMatch(/zero/);
    expect(bad('sqrt(-1)')).toMatch(/negative/);
    expect(bad('2 3')).toMatch(/Two numbers/);
    expect(bad('foo(1)')).toMatch(/Unknown/);
    expect(bad('1 $ 2')).toMatch(/Unexpected/);
    expect(bad('2^m')).toMatch(/exponent/);
    expect(bad('9'.repeat(300))).toMatch(/too long/);
    expect(bad('('.repeat(100) + '1' + ')'.repeat(100))).toMatch(/deeply/);
  });

  it('never executes code', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__exprPwned = false;
    for (const s of [
      'globalThis.__exprPwned = true',
      '(()=>{globalThis.__exprPwned=true})()',
      'constructor',
      '__proto__',
      'toString(1)',
      'hasOwnProperty',
      'Math.PI',
      "alert('x')",
    ]) {
      expect(evaluate(s).ok).toBe(false);
    }
    expect(g.__exprPwned).toBe(false);
  });
});

describe('field input with units', () => {
  const len = quantityById('length')!;
  const dens = quantityOfSymbol('kg/m³')!;
  const deg = quantityOfSymbol('°')!;
  it('reads unit-less text in the displayed unit', () => {
    expect(parseFieldInput('2*3', len, 'si')).toEqual({ ok: true, value: 6 });
    const r = parseFieldInput('10', len, 'imperial');
    expect(r.ok && r.value).toBeCloseTo(3.048, 12);
  });
  it('converts united text and checks the kind of quantity', () => {
    const r = parseFieldInput('5 ft', len, 'si');
    expect(r.ok && r.value).toBeCloseTo(1.524, 12);
    const r2 = parseFieldInput('3 m', len, 'imperial');
    expect(r2.ok && r2.value).toBe(3);
    const kg = parseFieldInput('5 kg', len, 'si');
    expect(kg.ok).toBe(false);
    expect(!kg.ok && kg.error).toMatch(/length/);
    expect(parseFieldInput('1 lb/ft^3', dens, 'si')).toMatchObject({ ok: true });
    const d = parseFieldInput('1 lb/ft^3', dens, 'si');
    expect(d.ok && d.value).toBeCloseTo(16.0185, 3);
  });
  it('angles: radians typed into a degrees field', () => {
    const r = parseFieldInput('pi rad', deg, 'si');
    expect(r.ok && r.value).toBeCloseTo(180, 10);
    const r2 = parseFieldInput('90', deg, 'si');
    expect(r2.ok && r2.value).toBe(90);
  });
  it('a plain-number field refuses units', () => {
    expect(parseFieldInput('5 ft', undefined, 'si').ok).toBe(false);
    expect(parseFieldInput('1/4', undefined, 'si')).toEqual({ ok: true, value: 0.25 });
  });
  it('display conversions round-trip', () => {
    for (const id of ['length', 'mass', 'density', 'speed', 'force', 'torque', 'stiffness', 'energy']) {
      const q = quantityById(id)!;
      for (const v of [0.01, 1, 123.456]) {
        expect(fromDisplay(q, 'imperial', toDisplay(q, 'imperial', v))).toBeCloseTo(v, 9);
        expect(toDisplay(q, 'si', v)).toBe(v);
      }
    }
    expect(toDisplay(len, 'imperial', 1)).toBeCloseTo(3.28084, 5);
    expect(toDisplay(quantityById('mass')!, 'imperial', 1)).toBeCloseTo(2.20462, 5);
  });
});

describe('inspector preference stores', () => {
  it('unit overrides win over the global system, and a global change clears them', () => {
    const u = new UnitPrefs(false);
    const len = quantityById('length')!;
    expect(u.systemFor(len, 'k')).toBe('si');
    u.toggleField(len, 'length:Radius');
    expect(u.systemFor(len, 'length:Radius')).toBe('imperial');
    expect(u.systemFor(len, 'length:Other')).toBe('si');
    u.toggleField(len, 'length:Radius');
    expect(u.systemFor(len, 'length:Radius')).toBe('si');
    u.toggleField(len, 'length:Radius');
    u.setSystem('imperial');
    expect(u.systemFor(len, 'length:Radius')).toBe('imperial');
    expect(u.systemFor(quantityById('angleDeg')!, null)).toBe('si'); // no imperial form
  });
  it('presets are sanitised', () => {
    const stored = {
      presets: [
        { id: 'a', name: 'Rubbery', snapshot: { material: { density: 1e12, friction: -4, evil: 1 }, junk: 1 } },
        { id: 'b', name: '', snapshot: { material: { density: 5 } } },
        { id: 'c', name: 'Empty', snapshot: {} },
        { id: 'd', name: 'NaN', snapshot: { damping: { linearDamping: 'x', gravityScale: NaN } } },
        'nope',
      ],
    };
    const out = sanitizePresets(stored);
    expect(out).toHaveLength(1);
    expect(out[0].snapshot).toEqual({ material: { density: 1e6, friction: 0 } });
    const s = new PresetStore(false);
    expect(s.save('  ', { material: { density: 3 } })).toBe(false);
    expect(s.save('A', { material: { density: 3 } })).toBe(true);
    expect(s.save('a', { material: { density: 4 } })).toBe(true); // same name replaces
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].snapshot.material?.density).toBe(4);
    s.remove(s.list()[0].id);
    expect(s.list()).toHaveLength(0);
  });
});
