/**
 * UI-A: units for the inspector — pure tables and conversions (no DOM).
 *
 * Two layers:
 *  - `UNITS`: every unit symbol the expression parser understands (`5 ft`, `3 lb`, `2 N·m` …), with its factor to
 *    the SI base and its dimension (length, mass, time, angle exponents).
 *  - `QUANTITIES`: what an inspector field measures. A field's *native* unit is the one its value is stored in
 *    (`m`, `kg/m³`, `°` …); the display unit is the native one in SI mode and the quantity's imperial unit in
 *    imperial mode. The document is never touched: only what the field shows and accepts changes.
 */

/** Exponents of length, mass, time and angle. */
export type Dim = readonly [number, number, number, number];

export const DIMLESS: Dim = [0, 0, 0, 0];

export interface UnitDef {
  /** Value of one of this unit in the SI base (m, kg, s, rad). */
  factor: number;
  dim: Dim;
}

const L: Dim = [1, 0, 0, 0];
const M: Dim = [0, 1, 0, 0];
const T: Dim = [0, 0, 1, 0];
const A: Dim = [0, 0, 0, 1];
const FORCE: Dim = [1, 1, -2, 0];
const ENERGY: Dim = [2, 1, -2, 0];
const SPEED: Dim = [1, 0, -1, 0];

const FT = 0.3048;
const LB = 0.45359237;
const LBF = 4.4482216152605;

export const UNITS: Readonly<Record<string, UnitDef>> = {
  m: { factor: 1, dim: L },
  km: { factor: 1000, dim: L },
  cm: { factor: 0.01, dim: L },
  mm: { factor: 0.001, dim: L },
  in: { factor: 0.0254, dim: L },
  ft: { factor: FT, dim: L },
  yd: { factor: 0.9144, dim: L },
  mi: { factor: 1609.344, dim: L },
  kg: { factor: 1, dim: M },
  g: { factor: 0.001, dim: M },
  mg: { factor: 1e-6, dim: M },
  lb: { factor: LB, dim: M },
  lbs: { factor: LB, dim: M },
  oz: { factor: LB / 16, dim: M },
  s: { factor: 1, dim: T },
  ms: { factor: 0.001, dim: T },
  min: { factor: 60, dim: T },
  h: { factor: 3600, dim: T },
  Hz: { factor: 1, dim: [0, 0, -1, 0] },
  N: { factor: 1, dim: FORCE },
  kN: { factor: 1000, dim: FORCE },
  lbf: { factor: LBF, dim: FORCE },
  J: { factor: 1, dim: ENERGY },
  kJ: { factor: 1000, dim: ENERGY },
  W: { factor: 1, dim: [2, 1, -3, 0] },
  deg: { factor: Math.PI / 180, dim: A },
  '°': { factor: Math.PI / 180, dim: A },
  rad: { factor: 1, dim: A },
  rpm: { factor: (2 * Math.PI) / 60, dim: [0, 0, -1, 1] },
  mph: { factor: 1609.344 / 3600, dim: SPEED },
  kph: { factor: 1 / 3.6, dim: SPEED },
  kmh: { factor: 1 / 3.6, dim: SPEED },
  kn: { factor: 1852 / 3600, dim: SPEED },
  L: { factor: 0.001, dim: [3, 0, 0, 0] },
};

export function dimEq(a: Dim, b: Dim): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

const NAMES: [Dim, string][] = [
  [L, 'a length'],
  [M, 'a mass'],
  [T, 'a time'],
  [A, 'an angle'],
  [SPEED, 'a speed'],
  [[1, 0, -2, 0], 'an acceleration'],
  [FORCE, 'a force'],
  [ENERGY, 'an energy or torque'],
  [[-3, 1, 0, 0], 'a density'],
  [[2, 0, 0, 0], 'an area'],
  [[3, 0, 0, 0], 'a volume'],
];

/** Human wording of a dimension for error messages ("a length"). */
export function dimName(d: Dim): string {
  if (dimEq(d, DIMLESS)) return 'a plain number';
  const n = NAMES.find(([x]) => dimEq(x, d));
  if (n) return n[1];
  return 'a different kind of quantity';
}

export type UnitSystem = 'si' | 'imperial';

export interface QuantityUnit {
  symbol: string;
  /** Value of one of this unit in the SI base. */
  factor: number;
}

export interface QuantityDef {
  id: string;
  dim: Dim;
  /** The unit the field's value is stored in. */
  native: QuantityUnit;
  /** The unit shown in imperial mode (absent: the quantity has no imperial form, the field never switches). */
  imperial?: QuantityUnit;
}

const q = (id: string, dim: Dim, native: QuantityUnit, imperial?: QuantityUnit): QuantityDef => ({
  id,
  dim,
  native,
  imperial,
});

export const QUANTITIES: readonly QuantityDef[] = [
  q('length', L, { symbol: 'm', factor: 1 }, { symbol: 'ft', factor: FT }),
  q('mass', M, { symbol: 'kg', factor: 1 }, { symbol: 'lb', factor: LB }),
  q('density', [-3, 1, 0, 0], { symbol: 'kg/m³', factor: 1 }, { symbol: 'lb/ft³', factor: LB / FT ** 3 }),
  q('speed', SPEED, { symbol: 'm/s', factor: 1 }, { symbol: 'ft/s', factor: FT }),
  q('accel', [1, 0, -2, 0], { symbol: 'm/s²', factor: 1 }, { symbol: 'ft/s²', factor: FT }),
  q('force', FORCE, { symbol: 'N', factor: 1 }, { symbol: 'lbf', factor: LBF }),
  q('torque', ENERGY, { symbol: 'N·m', factor: 1 }, { symbol: 'lbf·ft', factor: LBF * FT }),
  q('energy', ENERGY, { symbol: 'J', factor: 1 }, { symbol: 'ft·lbf', factor: LBF * FT }),
  q('momentum', [1, 1, -1, 0], { symbol: 'kg·m/s', factor: 1 }, { symbol: 'lb·ft/s', factor: LB * FT }),
  q('stiffness', [0, 1, -2, 0], { symbol: 'N/m', factor: 1 }, { symbol: 'lbf/ft', factor: LBF / FT }),
  q('damping', [0, 1, -1, 0], { symbol: 'N·s/m', factor: 1 }, { symbol: 'lbf·s/ft', factor: LBF / FT }),
  q('area', [2, 0, 0, 0], { symbol: 'm²', factor: 1 }, { symbol: 'ft²', factor: FT ** 2 }),
  q('volume', [3, 0, 0, 0], { symbol: 'm³', factor: 1 }, { symbol: 'ft³', factor: FT ** 3 }),
  q('inertia', [2, 1, 0, 0], { symbol: 'kg·m²', factor: 1 }, { symbol: 'lb·ft²', factor: LB * FT ** 2 }),
  q('angleDeg', A, { symbol: '°', factor: Math.PI / 180 }),
  q('angleRad', A, { symbol: 'rad', factor: 1 }),
  q('angSpeed', [0, 0, -1, 1], { symbol: 'rad/s', factor: 1 }),
  q('time', T, { symbol: 's', factor: 1 }),
  q('rate', [0, 0, -1, 0], { symbol: '1/s', factor: 1 }),
];

const BY_ID = new Map(QUANTITIES.map((x) => [x.id, x]));
const BY_SYMBOL = new Map(QUANTITIES.map((x) => [x.native.symbol, x]));

export const quantityById = (id: string | undefined | null): QuantityDef | undefined =>
  id ? BY_ID.get(id) : undefined;

/** The quantity a field measures, from the unit text its number field shows (`'kg/m³'` → density). */
export const quantityOfSymbol = (symbol: string | undefined | null): QuantityDef | undefined =>
  symbol ? BY_SYMBOL.get(symbol) : undefined;

export function displayUnit(qd: QuantityDef, system: UnitSystem): QuantityUnit {
  return system === 'imperial' && qd.imperial ? qd.imperial : qd.native;
}

export const unitLabel = (qd: QuantityDef, system: UnitSystem): string => displayUnit(qd, system).symbol;

/** A stored (native-unit) value as shown in the given system. */
export function toDisplay(qd: QuantityDef, system: UnitSystem, native: number): number {
  const u = displayUnit(qd, system);
  return (native * qd.native.factor) / u.factor;
}

/** A value typed in the given system's display unit, as the stored (native-unit) value. */
export function fromDisplay(qd: QuantityDef, system: UnitSystem, shown: number): number {
  const u = displayUnit(qd, system);
  return (shown * u.factor) / qd.native.factor;
}

/** A value in SI base units (`3 ft` → 0.9144) as the stored (native-unit) value. */
export const fromSI = (qd: QuantityDef, si: number): number => si / qd.native.factor;
export const toSI = (qd: QuantityDef, native: number): number => native * qd.native.factor;

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };
