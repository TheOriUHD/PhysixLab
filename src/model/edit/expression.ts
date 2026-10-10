/**
 * Numeric entry expressions (ED-14): what a number field accepts when the user types into it.
 *
 *   42, -2.5, 1e3        a plain number, in the field's own unit (m, ° or none)
 *   1.5m 30cm 2ft 12in   lengths (m, cm, mm, km, in / ", ft / ', yd)
 *   45deg 90° 1.2rad     angles (deg / °, rad, turn)
 *   (1+2)*3  2^3  1/4    arithmetic: + - * / ^, unary minus, parentheses, pi, sqrt() abs()
 *   x  $  cur            the field's current value
 *
 * A *leading operator* makes the entry relative to the current value:
 *
 *   +0.5   current + 0.5          *2   current × 2          /4   current ÷ 4
 *   - 2    current − 2 (a space after the minus)            =3   exactly 3 (absolute, same as "3")
 *
 * The operator applies to everything after it ("+1*2" adds 2, "*2+1" multiplies by 3). A leading minus *directly
 * followed by the number* is the negative number (-2 sets −2) because that is what a position field is far more often
 * used for; subtract with a space ("- 2"), "x-2" or "$-2".
 *
 * The parser is hand-written (no eval / Function) and pure; `compileEntry` parses once so a multi-selection can apply
 * the same entry to every object's own current value.
 */

export type UnitKind = 'length' | 'angle' | 'scalar';
export type LengthUnitId = 'm' | 'cm' | 'ft' | 'in';
export type AngleUnitId = 'deg' | 'rad';

export interface EntryOptions {
  kind?: UnitKind;
  /** The unit the field shows (bare numbers and the result are in it). Default metre. */
  lengthUnit?: LengthUnitId;
  /** Default degrees. */
  angleUnit?: AngleUnitId;
}

/** metres per unit */
const LENGTH_UNITS: Record<string, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  km: 1000,
  in: 0.0254,
  '"': 0.0254,
  ft: 0.3048,
  "'": 0.3048,
  yd: 0.9144,
};
/** degrees per unit */
const ANGLE_UNITS: Record<string, number> = {
  deg: 1,
  '°': 1,
  rad: 180 / Math.PI,
  turn: 360,
  rev: 360,
};
const FIELD_LENGTH: Record<LengthUnitId, number> = { m: 1, cm: 0.01, ft: 0.3048, in: 0.0254 };
const FIELD_ANGLE: Record<AngleUnitId, number> = { deg: 1, rad: 180 / Math.PI };

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export class EntryError extends Error {}

type Node =
  | { t: 'num'; v: number }
  | { t: 'cur' }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { t: 'fn'; name: string; a: Node };

type Tok =
  { k: 'num'; v: number; pos: number } | { k: 'id'; v: string; pos: number } | { k: 'op'; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: Number(num[0]), pos: i });
      i += num[0].length;
      continue;
    }
    if (/[a-zA-Z_$°'"]/.test(c)) {
      let j = i + 1;
      if (/[a-zA-Z_]/.test(c)) while (j < src.length && /[a-zA-Z_0-9]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ('+-*/^()='.includes(c)) {
      out.push({ k: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new EntryError(`Unexpected "${c}" at position ${i + 1}`);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private o: Required<EntryOptions>,
  ) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  parseAll(): Node {
    if (!this.toks.length) throw new EntryError('Enter a number or an expression');
    const n = this.expr();
    const t = this.peek();
    if (t) {
      if (t.k === 'op' && t.v === ')') throw new EntryError(`Unmatched ")" at position ${t.pos + 1}`);
      throw new EntryError(`Unexpected "${t.k === 'num' ? String(t.v) : t.v}" at position ${t.pos + 1}`);
    }
    return n;
  }

  private expr(): Node {
    let a = this.term();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && (t.v === '+' || t.v === '-')) {
        this.i++;
        a = { t: 'bin', op: t.v, a, b: this.term() };
      } else return a;
    }
  }

  private term(): Node {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && (t.v === '*' || t.v === '/')) {
        this.i++;
        a = { t: 'bin', op: t.v, a, b: this.unary() };
      } else return a;
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t?.k === 'op' && (t.v === '-' || t.v === '+')) {
      this.i++;
      const a = this.unary();
      return t.v === '-' ? { t: 'neg', a } : a;
    }
    return this.power();
  }

  private power(): Node {
    const a = this.atom();
    const t = this.peek();
    if (t?.k === 'op' && t.v === '^') {
      this.i++;
      return { t: 'bin', op: '^', a, b: this.unary() }; // right associative: 2^3^2 = 2^9, 2^-1 = 0.5
    }
    return a;
  }

  private close(): void {
    const close = this.toks[this.i++];
    if (!close || close.k !== 'op' || close.v !== ')') throw new EntryError('Missing closing ")"');
  }

  private atom(): Node {
    const t = this.toks[this.i++];
    if (!t) throw new EntryError('The expression ends too early — a value is missing after the last operator');
    if (t.k === 'num') return this.withUnit(t);
    if (t.k === 'op') {
      if (t.v === '(') {
        const inner = this.expr();
        this.close();
        return inner;
      }
      throw new EntryError(`Unexpected "${t.v}" at position ${t.pos + 1}`);
    }
    const name = t.v.toLowerCase();
    if (name === 'x' || name === '$' || name === 'cur' || name === 'current') return { t: 'cur' };
    if (name === 'pi') return { t: 'num', v: Math.PI };
    if (name === 'sqrt' || name === 'abs') {
      const open = this.toks[this.i++];
      if (!open || open.k !== 'op' || open.v !== '(') throw new EntryError(`${t.v} needs parentheses, e.g. ${t.v}(2)`);
      const a = this.expr();
      this.close();
      return { t: 'fn', name, a };
    }
    if (has(LENGTH_UNITS, t.v) || has(LENGTH_UNITS, name) || has(ANGLE_UNITS, t.v) || has(ANGLE_UNITS, name)) {
      throw new EntryError(`"${t.v}" is a unit — put a number in front of it (e.g. 2${t.v})`);
    }
    throw new EntryError(`Unknown name "${t.v}" at position ${t.pos + 1} (use x or $ for the current value)`);
  }

  /** A number, optionally followed by a unit (directly or after spaces). */
  private withUnit(n: Extract<Tok, { k: 'num' }>): Node {
    const nxt = this.peek();
    if (nxt?.k !== 'id') return { t: 'num', v: n.v };
    const lower = nxt.v.toLowerCase();
    const key = has(LENGTH_UNITS, nxt.v) || has(ANGLE_UNITS, nxt.v) ? nxt.v : lower;
    const lf = has(LENGTH_UNITS, key) ? LENGTH_UNITS[key] : undefined;
    const af = has(ANGLE_UNITS, key) ? ANGLE_UNITS[key] : undefined;
    if (lf === undefined && af === undefined) {
      if (['x', '$', 'cur', 'current', 'pi', 'sqrt', 'abs'].includes(lower)) {
        throw new EntryError(`Write "${n.v}*${nxt.v}" to multiply (position ${nxt.pos + 1})`);
      }
      throw new EntryError(`Unknown unit "${nxt.v}" after ${n.v} (use m, cm, mm, km, in, ft, yd, deg, rad or turn)`);
    }
    this.i++;
    const { kind } = this.o;
    if (kind === 'scalar') throw new EntryError(`This field has no unit — remove "${nxt.v}"`);
    if (lf !== undefined) {
      if (kind === 'angle') throw new EntryError(`"${nxt.v}" is a length, but this field takes an angle (deg or rad)`);
      return { t: 'num', v: (n.v * lf) / FIELD_LENGTH[this.o.lengthUnit] };
    }
    if (kind === 'length')
      throw new EntryError(`"${nxt.v}" is an angle, but this field takes a length (m, cm, ft, in)`);
    return { t: 'num', v: (n.v * (af ?? 1)) / FIELD_ANGLE[this.o.angleUnit] };
  }
}

function evalNode(n: Node, cur: number): number {
  switch (n.t) {
    case 'num':
      return n.v;
    case 'cur':
      return cur;
    case 'neg':
      return -evalNode(n.a, cur);
    case 'fn': {
      const a = evalNode(n.a, cur);
      if (n.name === 'sqrt') {
        if (a < 0) throw new EntryError('Square root of a negative number');
        return Math.sqrt(a);
      }
      return Math.abs(a);
    }
    case 'bin': {
      const a = evalNode(n.a, cur),
        b = evalNode(n.b, cur);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) throw new EntryError('Division by zero');
          return a / b;
        case '^': {
          const r = Math.pow(a, b);
          if (!Number.isFinite(r)) throw new EntryError('The power is not a finite number');
          return r;
        }
      }
    }
  }
}

function usesCurrent(n: Node): boolean {
  switch (n.t) {
    case 'cur':
      return true;
    case 'num':
      return false;
    case 'neg':
    case 'fn':
      return usesCurrent(n.a);
    case 'bin':
      return usesCurrent(n.a) || usesCurrent(n.b);
  }
}

export type EntryMode = 'absolute' | 'add' | 'sub' | 'mul' | 'div';

export interface CompiledEntry {
  ok: true;
  /** True when the result depends on the field's current value ("+0.5", "*2", "x+1"). */
  relative: boolean;
  mode: EntryMode;
  /** Result for a given current value. Throws `EntryError` (division by zero …); `evaluateEntry` catches it. */
  eval(current: number): number;
}
export interface EntryFailure {
  ok: false;
  error: string;
}
export type EntryResult = { ok: true; value: number; relative: boolean; mode: EntryMode } | EntryFailure;

/** Parse an entry once. */
export function compileEntry(text: string, options: EntryOptions = {}): CompiledEntry | EntryFailure {
  const o: Required<EntryOptions> = {
    kind: options.kind ?? 'scalar',
    lengthUnit: options.lengthUnit ?? 'm',
    angleUnit: options.angleUnit ?? 'deg',
  };
  try {
    let src = text.trim().replace(/,/g, '.');
    let mode: EntryMode = 'absolute';
    const first = src[0];
    if (first === '=') {
      src = src.slice(1);
    } else if (first === '+' || first === '*' || first === '/') {
      mode = first === '+' ? 'add' : first === '*' ? 'mul' : 'div';
      src = src.slice(1);
      if (!src.trim()) throw new EntryError(`Type a number after "${first}" (e.g. ${first}2)`);
    } else if (first === '-' && /^-\s+\S/.test(src)) {
      mode = 'sub';
      src = src.slice(1);
    }
    const ast = new Parser(tokenize(src), o).parseAll();
    const relative = mode !== 'absolute' || usesCurrent(ast);
    return {
      ok: true,
      relative,
      mode,
      eval(current: number): number {
        const v = evalNode(ast, current);
        let r: number;
        switch (mode) {
          case 'add':
            r = current + v;
            break;
          case 'sub':
            r = current - v;
            break;
          case 'mul':
            r = current * v;
            break;
          case 'div':
            if (v === 0) throw new EntryError('Division by zero');
            r = current / v;
            break;
          default:
            r = v;
        }
        if (!Number.isFinite(r)) throw new EntryError('The result is not a finite number');
        return r;
      },
    };
  } catch (e) {
    if (e instanceof EntryError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Evaluate an entry against the field's current value. */
export function evaluateEntry(text: string, current: number, options: EntryOptions = {}): EntryResult {
  const c = compileEntry(text, options);
  if (!c.ok) return c;
  try {
    return { ok: true, value: c.eval(current), relative: c.relative, mode: c.mode };
  } catch (e) {
    if (e instanceof EntryError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Tooltip text for a number field that accepts entries. */
export function entryHint(kind: UnitKind = 'scalar'): string {
  const unit =
    kind === 'length' ? ' · units: 30cm 2ft 12in' : kind === 'angle' ? ' · units: 45deg 1.2rad 0.25turn' : '';
  return `Type a value or an expression: 2.5 · +0.5 adds · *2 multiplies · /4 divides · "- 1" subtracts · =3 sets · (1+2)*3 · x is the current value${unit}`;
}
