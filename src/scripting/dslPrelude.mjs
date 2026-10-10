/*
 * DT-32: the Builder DSL as seen by a scene script. This text runs INSIDE the sandbox worker (see
 * src/sandbox/workerRuntime.mjs): it only RECORDS calls; src/scripting/replay.ts replays them on the real
 * `Builder` on the main thread, which validates everything. A script therefore cannot do anything a hand-written
 * scene file could not.
 */
// eslint-disable-next-line no-unused-vars -- called by the host through `return build(api)`
function build(api) {
  const MAX_OPS = 20000;
  const ops = [];
  let refCount = 0;
  let sceneName = null;
  const settingsPatch = {};
  const DEG = Math.PI / 180;

  // Deterministic random numbers: the same script always builds the same scene.
  let state = 1;
  function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function seed(n) {
    state = Number(n) >>> 0;
  }
  const SafeMath = Object.create(null);
  for (const k of Object.getOwnPropertyNames(Math)) SafeMath[k] = Math[k];
  SafeMath.random = random;
  Object.freeze(SafeMath);

  function plain(v, what) {
    try {
      return JSON.parse(JSON.stringify(v === undefined ? null : v));
    } catch (e) {
      throw new Error(what + ': arguments must be plain data (numbers, strings, arrays, objects)', { cause: e });
    }
  }
  function enc(v) {
    return v && typeof v === 'object' && typeof v.__ref === 'number' ? { __ref: v.__ref } : v;
  }
  function record(fn, args) {
    if (ops.length >= MAX_OPS)
      throw new Error('Too many objects: a scene script may make at most ' + MAX_OPS + ' calls');
    ops.push({ f: fn, a: plain(args.map(enc), fn) });
  }
  function ref(extra) {
    return Object.assign({ __ref: refCount++ }, extra);
  }

  function body(name, type, size, position, opts) {
    record('body', [name, type, size, position, opts || {}]);
    return ref({ kind: 'body', name, type, size, position, opts: opts || {} });
  }
  function soft(name, type, position, opts) {
    record('soft', [name, type, position, opts || {}]);
    return ref({ kind: 'soft', name, type, position });
  }
  function joint(type, a, b, point, axis, opts) {
    record('joint', [type, a || null, b || null, point, axis === undefined ? [0, 0, 1] : axis, opts || {}]);
    return ref({ kind: 'joint', type, point });
  }
  function tether(type, a, pa, b, pb, opts) {
    record('tether', [type, a || null, pa, b || null, pb, opts || {}]);
    return ref({ kind: 'joint', type });
  }
  function array(n, fn) {
    n = Math.floor(Number(n));
    if (!(n >= 0 && n <= MAX_OPS)) throw new Error('array(n, fn): n must be between 0 and ' + MAX_OPS);
    const out = [];
    for (let i = 0; i < n; i++) out.push(fn(i));
    return out;
  }
  function grid(nx, ny, dx, dy, fn) {
    const out = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out.push(fn(i * dx, j * dy, i, j));
    return out;
  }
  function ring(n, radius, fn) {
    return array(n, (i) => {
      const a = (i / n) * 2 * Math.PI;
      return fn(Math.cos(a) * radius, Math.sin(a) * radius, a, i);
    });
  }
  function range(a, b, step) {
    const out = [];
    const s = step || 1;
    if (!(s !== 0) || !(Math.abs((b - a) / s) <= MAX_OPS)) throw new Error('range(): too many values');
    for (let v = a; s > 0 ? v < b : v > b; v += s) out.push(v);
    return out;
  }
  const quat = (x, y, z, deg) => {
    const h = (deg * DEG) / 2;
    const s = Math.sin(h);
    return [x * s, y * s, z * s, Math.cos(h)];
  };
  const rotX = (deg) => quat(1, 0, 0, deg);
  const rotY = (deg) => quat(0, 1, 0, deg);
  const rotZ = (deg) => quat(0, 0, 1, deg);
  function settings(patch) {
    Object.assign(settingsPatch, plain(patch, 'settings'));
  }
  function name(n) {
    sceneName = String(n).slice(0, 120);
  }

  const scope = {
    body,
    soft,
    joint,
    tether,
    array,
    grid,
    ring,
    range,
    rotX,
    rotY,
    rotZ,
    settings,
    name,
    random,
    seed,
    DEG,
    Math: SafeMath,
    console: api.console,
    print: api.console.log,
  };
  return {
    scope,
    finish() {
      return { ops, name: sceneName, settings: settingsPatch };
    },
  };
}
