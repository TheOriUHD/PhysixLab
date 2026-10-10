/**
 * UI-A: the expression parser behind every numeric inspector field. Hand-written recursive descent — no `eval`, no
 * `Function`. Understands:
 *   numbers (`1.5`, `1e-3`, `.5`, `2,5` as a decimal comma), `+ - * / ^ **`, parentheses, unary minus, implicit
 *   multiplication before a unit, a constant or a bracket (`5 ft`, `2 pi`, `3(4+1)`), the constants `pi e tau g0`,
 *   functions (`sqrt sin cos tan asin acos atan atan2 abs min max pow exp ln log log10 floor ceil round hypot`) and the
 *   units of `UNITS` (`km/h`, `2 N·m`, `m/s^2`, `30 deg`).
 * Every value carries its dimension, so `5 ft + 2 kg` is an error and `5 ft` is known to be a length. Juxtaposition
 * binds tighter than `/`: `5 m / 2 s` is (5 m) / (2 s).
 */
import type { Dim, ParseResult, QuantityDef, UnitSystem } from './units';
import { DIMLESS, UNITS, dimEq, dimName, fromDisplay, fromSI } from './units';

export type EvalResult =
  | { ok: true; value: number; dim: Dim; /** Did the text use at least one unit or unit constant? */ united: boolean }
  | { ok: false; error: string };

interface Val {
  v: number;
  d: Dim;
  u: boolean;
}

type Tok = { t: 'num'; v: number } | { t: 'id'; s: string } | { t: 'op'; s: string } | { t: 'end' };

const MAX_LEN = 240;
const MAX_DEPTH = 48;

class ExprError extends Error {}

const fail = (msg: string): never => {
  throw new ExprError(msg);
};

const OP_ALIASES: Record<string, string> = { '×': '*', '·': '*', '÷': '/', '−': '-' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === ' ') {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+(?![A-Za-z_]))?/.exec(rest);
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_°µμ][A-Za-z_°µμ0-9]*/.exec(rest);
    if (id) {
      out.push({ t: 'id', s: id[0] });
      i += id[0].length;
      continue;
    }
    if (c === '*' && src[i + 1] === '*') {
      out.push({ t: 'op', s: '^' });
      i += 2;
      continue;
    }
    const op = OP_ALIASES[c] ?? c;
    if ('+-*/^(),²³'.includes(op)) {
      out.push({ t: 'op', s: op });
      i++;
      continue;
    }
    fail(`Unexpected "${c}"`);
  }
  out.push({ t: 'end' });
  return out;
}

const dimAdd = (a: Dim, b: Dim): Dim => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const dimSub = (a: Dim, b: Dim): Dim => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
const dimMul = (a: Dim, k: number): Dim => [a[0] * k, a[1] * k, a[2] * k, a[3] * k];
const isHalfInt = (x: number) => Math.abs(x * 2 - Math.round(x * 2)) < 1e-9;

const CONSTANTS: Record<string, Val> = {
  pi: { v: Math.PI, d: DIMLESS, u: false },
  e: { v: Math.E, d: DIMLESS, u: false },
  tau: { v: 2 * Math.PI, d: DIMLESS, u: false },
  g0: { v: 9.80665, d: [1, 0, -2, 0], u: true },
};

const TRIG: Record<string, (x: number) => number> = { sin: Math.sin, cos: Math.cos, tan: Math.tan };
const PLAIN: Record<string, (x: number) => number> = {
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
};
/** Functions that keep the unit of their argument. */
const KEEP: Record<string, (x: number) => number> = {
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};
const OTHER_FUNCTIONS = ['sqrt', 'atan2', 'min', 'max', 'pow', 'hypot'];

const isFunction = (name: string): boolean =>
  Object.hasOwn(TRIG, name) ||
  Object.hasOwn(PLAIN, name) ||
  Object.hasOwn(KEEP, name) ||
  OTHER_FUNCTIONS.includes(name);

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isOp(s: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.s === s;
  }

  parseAll(): Val {
    const v = this.sum();
    if (this.peek().t !== 'end') fail(this.describeUnexpected());
    return v;
  }

  private describeUnexpected(): string {
    const t = this.peek();
    if (t.t === 'num') return 'Two numbers in a row: put an operator between them';
    if (t.t === 'id') return `Unknown unit or word "${t.s}"`;
    if (t.t === 'op') return `Unexpected "${t.s}"`;
    return 'Incomplete expression';
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) fail('Expression is nested too deeply');
  }
  private leave(): void {
    this.depth--;
  }

  private sum(): Val {
    let a = this.product();
    while (this.isOp('+') || this.isOp('-')) {
      const sub = (this.next() as { s: string }).s === '-';
      const b = this.product();
      if (!dimEq(a.d, b.d)) fail('Cannot add or subtract quantities of different kinds (check the units)');
      a = { v: sub ? a.v - b.v : a.v + b.v, d: a.d, u: a.u || b.u };
    }
    return a;
  }

  private product(): Val {
    let a = this.juxta();
    while (this.isOp('*') || this.isOp('/')) {
      const div = (this.next() as { s: string }).s === '/';
      const b = this.juxta();
      if (div && b.v === 0) fail('Division by zero');
      a = { v: div ? a.v / b.v : a.v * b.v, d: div ? dimSub(a.d, b.d) : dimAdd(a.d, b.d), u: a.u || b.u };
    }
    return a;
  }

  /** `5 ft`, `2 pi`, `3(4)`: a factor directly followed by a name or a bracket multiplies. */
  private juxta(): Val {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (!(t.t === 'id' || (t.t === 'op' && t.s === '('))) break;
      const b = this.unary();
      a = { v: a.v * b.v, d: dimAdd(a.d, b.d), u: a.u || b.u };
    }
    return a;
  }

  private unary(): Val {
    if (this.isOp('-')) {
      this.next();
      this.enter();
      const a = this.unary();
      this.leave();
      return { ...a, v: -a.v };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  private power(): Val {
    let base = this.atom();
    while (this.isOp('²') || this.isOp('³')) {
      const k = (this.next() as { s: string }).s === '²' ? 2 : 3;
      base = this.pow(base, { v: k, d: DIMLESS, u: false });
    }
    if (this.isOp('^')) {
      this.next();
      this.enter();
      const exp = this.unary(); // right associative, allows 2^-1
      this.leave();
      return this.pow(base, exp);
    }
    return base;
  }

  private pow(base: Val, exp: Val): Val {
    if (!dimEq(exp.d, DIMLESS)) fail('An exponent must be a plain number');
    const dim = dimMul(base.d, exp.v);
    if (dim.some((x) => !isHalfInt(x))) fail('That power gives a unit that cannot be expressed');
    const v = Math.pow(base.v, exp.v);
    if (!Number.isFinite(v)) fail('That power is not a real number');
    return { v, d: dim, u: base.u };
  }

  private atom(): Val {
    const t = this.next();
    if (t.t === 'num') return { v: t.v, d: DIMLESS, u: false };
    if (t.t === 'op' && t.s === '(') {
      this.enter();
      const v = this.sum();
      this.leave();
      if (!this.isOp(')')) fail('Missing closing bracket');
      this.next();
      return v;
    }
    if (t.t === 'id') {
      if (this.isOp('(') && isFunction(t.s)) return this.call(t.s);
      if (Object.hasOwn(CONSTANTS, t.s)) return { ...CONSTANTS[t.s] };
      if (Object.hasOwn(UNITS, t.s)) {
        const u = UNITS[t.s];
        return { v: u.factor, d: u.dim, u: true };
      }
      return fail(`Unknown unit or word "${t.s}"`);
    }
    if (t.t === 'end') return fail('Incomplete expression');
    return fail(`Unexpected "${t.s}"`);
  }

  private call(name: string): Val {
    this.next(); // (
    this.enter();
    const args: Val[] = [];
    if (!this.isOp(')')) {
      args.push(this.sum());
      while (this.isOp(',')) {
        this.next();
        args.push(this.sum());
      }
    }
    this.leave();
    if (!this.isOp(')')) fail('Missing closing bracket');
    this.next();
    const need = (n: number) => {
      if (args.length !== n) fail(`${name}() takes ${n} argument${n === 1 ? '' : 's'}`);
    };
    const finite = (v: number, u = false): Val => {
      if (!Number.isFinite(v)) fail(`${name}() is not defined there`);
      return { v, d: DIMLESS, u };
    };
    if (Object.hasOwn(TRIG, name)) {
      need(1);
      if (!(dimEq(args[0].d, DIMLESS) || dimEq(args[0].d, [0, 0, 0, 1])))
        fail(`${name}() needs a plain number (radians) or an angle`);
      return finite(TRIG[name](args[0].v), args[0].u);
    }
    if (Object.hasOwn(PLAIN, name)) {
      need(1);
      if (!dimEq(args[0].d, DIMLESS)) fail(`${name}() needs a plain number`);
      return finite(PLAIN[name](args[0].v));
    }
    if (Object.hasOwn(KEEP, name)) {
      need(1);
      return { v: KEEP[name](args[0].v), d: args[0].d, u: args[0].u };
    }
    const same = () => {
      if (args.length < 1) fail(`${name}() needs arguments`);
      if (args.some((a) => !dimEq(a.d, args[0].d))) fail(`${name}() needs quantities of the same kind`);
    };
    switch (name) {
      case 'sqrt': {
        need(1);
        if (args[0].v < 0) fail('sqrt() of a negative number');
        const dim = dimMul(args[0].d, 0.5);
        if (dim.some((x) => !isHalfInt(x))) fail('sqrt() gives a unit that cannot be expressed');
        return { v: Math.sqrt(args[0].v), d: dim, u: args[0].u };
      }
      case 'atan2':
        need(2);
        if (!dimEq(args[0].d, args[1].d)) fail('atan2() needs two quantities of the same kind');
        return { v: Math.atan2(args[0].v, args[1].v), d: [0, 0, 0, 1], u: true };
      case 'min':
      case 'max': {
        same();
        const vs = args.map((a) => a.v);
        return { v: name === 'min' ? Math.min(...vs) : Math.max(...vs), d: args[0].d, u: args.some((a) => a.u) };
      }
      case 'pow':
        need(2);
        return this.pow(args[0], args[1]);
      case 'hypot':
        same();
        return { v: Math.hypot(...args.map((a) => a.v)), d: args[0].d, u: args.some((a) => a.u) };
      default:
        return fail(`Unknown function "${name}"`);
    }
  }
}

/** Evaluate an expression. Never throws. */
export function evaluate(text: string): EvalResult {
  let src = text.trim();
  if (!src) return { ok: false, error: 'Empty' };
  if (src.length > MAX_LEN) return { ok: false, error: 'Expression is too long' };
  // A decimal comma (`2,5`) — but not the argument separator of `min(1,2)`.
  if (/^[+-]?\d+,\d+$/.test(src)) src = src.replace(',', '.');
  try {
    const val = new Parser(tokenize(src)).parseAll();
    if (!Number.isFinite(val.v)) return { ok: false, error: 'Not a finite number' };
    return { ok: true, value: val.v, dim: val.d, united: val.u };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: e.message };
    return { ok: false, error: 'Could not read that' };
  }
}

/**
 * What a field's text means as the field's stored value. Text without a unit is in the unit the field currently
 * shows (`system`); text with units (`5 ft`, `2*9.81 m/s^2`) must be the field's kind of quantity and is converted.
 * A field without a quantity accepts only plain numbers.
 */
export function parseFieldInput(text: string, qd: QuantityDef | undefined, system: UnitSystem): ParseResult {
  const r = evaluate(text);
  if (!r.ok) return r;
  if (!r.united) {
    if (!dimEq(r.dim, DIMLESS)) return { ok: false, error: 'Unexpected unit' };
    return { ok: true, value: qd ? fromDisplay(qd, system, r.value) : r.value };
  }
  if (!qd) {
    return dimEq(r.dim, DIMLESS)
      ? { ok: true, value: r.value }
      : { ok: false, error: 'This field takes a plain number, without units' };
  }
  if (!dimEq(r.dim, qd.dim)) return { ok: false, error: `This field takes ${dimName(qd.dim)}, not ${dimName(r.dim)}` };
  return { ok: true, value: fromSI(qd, r.value) };
}
