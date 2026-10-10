/**
 * A safe expression evaluator for custom chart traces: `speed(a) - speed(b)`, `0.5*mass(a)*speed(a)^2`.
 * No `eval` / `Function`: the text is tokenised and parsed into a small tree (numbers, + - * / % ^, unary minus,
 * parentheses, calls) and compiled into closures. Calls are either maths functions (`sin`, `sqrt`, `max` …) or
 * signal functions supplied by the host (`speed(a)`), whose single argument names a body / joint (a bare name or a
 * quoted string such as `"My box"`). `compile` resolves every reference immediately, so a bad name or function is
 * reported while the user is typing, not later while sampling.
 */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

export type Node =
  | { k: 'num'; v: number }
  | { k: 'name'; name: string; pos: number; quoted: boolean }
  | { k: 'call'; name: string; args: Node[]; pos: number }
  | { k: 'un'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

interface Tok {
  t: 'num' | 'id' | 'str' | 'op' | 'end';
  s: string;
  v: number;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError('Bad number', i);
      out.push({ t: 'num', s: m[0], v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      out.push({ t: 'id', s: src.slice(i, j), v: 0, pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new ExprError('Unterminated quote', i);
      out.push({ t: 'str', s: src.slice(i + 1, j), v: 0, pos: i });
      i = j + 1;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) {
      out.push({ t: 'op', s: c, v: 0, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected "${c}"`, i);
  }
  out.push({ t: 'end', s: '', v: 0, pos: src.length });
  return out;
}

/** Parse to a tree (throws `ExprError`). */
export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const isOp = (s: string) => toks[p].t === 'op' && toks[p].s === s;
  const expect = (s: string) => {
    if (!isOp(s)) throw new ExprError(`Expected "${s}"`, toks[p].pos);
    p++;
  };
  const additive = (): Node => {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].s;
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  };
  const term = (): Node => {
    let a = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = toks[p++].s;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      p++;
      return { k: 'un', a: unary() };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const a = atom();
    if (isOp('^')) {
      p++;
      return { k: 'bin', op: '^', a, b: unary() }; // right-associative; binds tighter than a unary minus in front
    }
    return a;
  };
  const atom = (): Node => {
    const t = toks[p];
    if (t.t === 'num') {
      p++;
      return { k: 'num', v: t.v };
    }
    if (t.t === 'str') {
      p++;
      return { k: 'name', name: t.s, pos: t.pos, quoted: true };
    }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(additive());
          while (isOp(',')) {
            p++;
            args.push(additive());
          }
        }
        expect(')');
        return { k: 'call', name: t.s, args, pos: t.pos };
      }
      return { k: 'name', name: t.s, pos: t.pos, quoted: false };
    }
    if (isOp('(')) {
      p++;
      const e = additive();
      expect(')');
      return e;
    }
    throw new ExprError(t.t === 'end' ? 'Expression ends early' : `Unexpected "${t.s}"`, t.pos);
  };
  if (toks.length === 1) throw new ExprError('Empty expression', 0);
  const e = additive();
  if (toks[p].t !== 'end') throw new ExprError(`Unexpected "${toks[p].s}"`, toks[p].pos);
  return e;
}

const MATH1: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log,
  ln: Math.log,
  log10: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  deg: (x) => (x * 180) / Math.PI,
  rad: (x) => (x * Math.PI) / 180,
};
const MATHN: Record<string, { min: number; max: number; f: (a: number[]) => number }> = {
  atan2: { min: 2, max: 2, f: (a) => Math.atan2(a[0], a[1]) },
  pow: { min: 2, max: 2, f: (a) => Math.pow(a[0], a[1]) },
  min: { min: 2, max: 8, f: (a) => Math.min(...a) },
  max: { min: 2, max: 8, f: (a) => Math.max(...a) },
  hypot: { min: 2, max: 8, f: (a) => Math.hypot(...a) },
  clamp: { min: 3, max: 3, f: (a) => Math.min(a[2], Math.max(a[1], a[0])) },
};
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E };

/** What the evaluator needs from the application. */
export interface ExprHost {
  /** Is `name` a signal function? */
  hasSignal(name: string): boolean;
  /** Number of arguments the signal takes (0 for world signals, 1 for a body / joint). */
  signalArity(name: string): number;
  /** The getter for `name(ref)`; throws an Error with a user-readable message if `ref` is unknown. */
  signal(name: string, ref: string | null): () => number;
  /** Simulation time, for the variable `t`. */
  time(): number;
}

export interface Compiled {
  eval: () => number;
  /** Body / joint references used, in order of appearance. */
  refs: string[];
  /** Signal functions used. */
  signals: string[];
}

/** Parse and compile; throws `ExprError` with the offending position. */
export function compile(src: string, host: ExprHost): Compiled {
  const tree = parse(src);
  const refs: string[] = [];
  const signals: string[] = [];
  const build = (n: Node): (() => number) => {
    switch (n.k) {
      case 'num': {
        const v = n.v;
        return () => v;
      }
      case 'name': {
        if (n.quoted)
          throw new ExprError(
            `"${n.name}" is not a number (names go inside a function, e.g. speed("${n.name}"))`,
            n.pos,
          );
        if (n.name === 't') return () => host.time();
        if (has(CONSTANTS, n.name)) {
          const v = CONSTANTS[n.name];
          return () => v;
        }
        if (host.hasSignal(n.name) && host.signalArity(n.name) === 0)
          return build({ k: 'call', name: n.name, args: [], pos: n.pos });
        throw new ExprError(`Unknown name "${n.name}"`, n.pos);
      }
      case 'un': {
        const a = build(n.a);
        return () => -a();
      }
      case 'bin': {
        const a = build(n.a);
        const b = build(n.b);
        switch (n.op) {
          case '+':
            return () => a() + b();
          case '-':
            return () => a() - b();
          case '*':
            return () => a() * b();
          case '/':
            return () => a() / b();
          case '%':
            return () => a() % b();
          default:
            return () => Math.pow(a(), b());
        }
      }
      case 'call': {
        if (host.hasSignal(n.name)) {
          const arity = host.signalArity(n.name);
          if (n.args.length !== arity)
            throw new ExprError(`${n.name}() takes ${arity === 0 ? 'no argument' : 'one body or joint name'}`, n.pos);
          let ref: string | null = null;
          if (arity === 1) {
            const arg = n.args[0];
            if (arg.k !== 'name') throw new ExprError(`${n.name}() needs a body or joint name`, n.pos);
            ref = arg.name;
            refs.push(ref);
          }
          signals.push(n.name);
          try {
            return host.signal(n.name, ref);
          } catch (e) {
            throw new ExprError(e instanceof Error ? e.message : String(e), n.pos);
          }
        }
        const f1 = has(MATH1, n.name) ? MATH1[n.name] : undefined;
        if (f1) {
          if (n.args.length !== 1) throw new ExprError(`${n.name}() takes one argument`, n.pos);
          const a = build(n.args[0]);
          return () => f1(a());
        }
        const fn = has(MATHN, n.name) ? MATHN[n.name] : undefined;
        if (fn) {
          if (n.args.length < fn.min || n.args.length > fn.max)
            throw new ExprError(
              `${n.name}() takes ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} arguments`,
              n.pos,
            );
          const args = n.args.map(build);
          const buf = new Array<number>(args.length).fill(0); // reused every evaluation
          return () => {
            for (let i = 0; i < args.length; i++) buf[i] = args[i]();
            return fn.f(buf);
          };
        }
        throw new ExprError(`Unknown function "${n.name}"`, n.pos);
      }
    }
  };
  return { eval: build(tree), refs, signals };
}

/** The maths function names, for the editor's hint line. */
export const MATH_FUNCTIONS: readonly string[] = [...Object.keys(MATH1), ...Object.keys(MATHN)];
