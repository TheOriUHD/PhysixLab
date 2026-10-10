/**
 * The signal catalogue of the chart widgets (DOM-free). A signal is a function of one body / joint (or of the whole
 * world) that can be read once per frame from the physics frame data: `speed(box)`, `energy_total()`. The same
 * catalogue serves the trace picker and the expression evaluator (`ExprHost`).
 *
 * Where the frame protocol carries no data for a quantity, the signal is derived honestly and says so in `note`:
 *   - acceleration is the backward difference of the sampled velocity (not an instantaneous value);
 *   - angular momentum uses an effective moment of inertia recovered from the body's rotational kinetic energy,
 *     I_eff = 2·KE_rot/|ω|², i.e. L ≈ I_eff·ω (exact for rotation about a principal axis, an approximation for a
 *     tumbling asymmetric body) — the worker does not send the inertia tensor;
 *   - contact count / force exist for the world as a whole (the contact overlay's data), not per body;
 *   - hinge torque is not reported by the engine's readback, so joints expose angle / speed / force of springs & ropes.
 */
import { B, J } from '../../physics/protocol';
import type { ExprHost } from './expr';

/** Mutable per-frame data the signals read. The host fills it (or points it at live buffers) before sampling. */
export interface SignalSource {
  /** Simulation time, seconds. */
  time(): number;
  gravity(): readonly [number, number, number];
  /** Pose record (`B` layout) of a body, or null. */
  pose(id: string): ArrayLike<number> | null;
  /** Joint record (`J` layout), or null. */
  joint(id: string): ArrayLike<number> | null;
  mass(id: string): number;
  /** Local centre-of-mass offset. */
  com(id: string): readonly [number, number, number] | null;
  gravityScale(id: string): number;
  /** World numbers: energy and contact data of the last frame. */
  world(): WorldFrame | null;
  /** Resolve a user-typed reference (name, id, alias, `selected`) to an entity id of the right kind, or null. */
  resolve(ref: string, kind: 'body' | 'joint'): string | null;
}

export interface WorldFrame {
  kinetic: number;
  rotational: number;
  potential: number;
  elastic: number;
  contacts: number;
  /** Sum of contact-point forces (N); NaN when the worker is not sending contact points. */
  contactForce: number;
  px: number;
  py: number;
  pz: number;
}

export type SignalTarget = 'body' | 'joint' | 'world';

export interface SignalDef {
  /** The function name used in expressions. */
  id: string;
  label: string;
  unit: string;
  group: string;
  target: SignalTarget;
  /** Extra explanation shown in the picker. */
  note?: string;
  /** Build a getter for entity `id` (null for world signals). The getter owns any state it needs (differencing). */
  make(src: SignalSource, id: string | null): () => number;
}

const NAN = Number.NaN;

/** A stateless body signal. */
function body(
  id: string,
  label: string,
  unit: string,
  group: string,
  f: (p: ArrayLike<number>, src: SignalSource, eid: string) => number,
  note?: string,
): SignalDef {
  return {
    id,
    label,
    unit,
    group,
    target: 'body',
    note,
    make: (src, eid) => () => {
      const p = src.pose(eid as string);
      return p ? f(p, src, eid as string) : NAN;
    },
  };
}

function comp(
  base: string,
  label: string,
  unit: string,
  group: string,
  idx: readonly [number, number, number],
  note?: string,
): SignalDef[] {
  return ['x', 'y', 'z'].map((ax, k) =>
    body(`${base}_${ax}`, `${label} ${ax.toUpperCase()}`, unit, group, (p) => p[idx[k]], note),
  );
}

/** Effective moment of inertia from the rotational energy: I = 2·KE_rot / ω². 0 when not spinning. */
function spinInertia(p: ArrayLike<number>, m: number): number {
  const w2 = p[B.wx] * p[B.wx] + p[B.wy] * p[B.wy] + p[B.wz] * p[B.wz];
  if (w2 < 1e-12) return 0;
  const v2 = p[B.vx] * p[B.vx] + p[B.vy] * p[B.vy] + p[B.vz] * p[B.vz];
  const keRot = Math.max(0, p[B.ke] - 0.5 * m * v2);
  return (2 * keRot) / w2;
}

function potential(p: ArrayLike<number>, src: SignalSource, eid: string): number {
  const m = src.mass(eid);
  if (!m) return 0;
  const c = src.com(eid);
  let x = p[B.px];
  let y = p[B.py];
  let z = p[B.pz];
  if (c) {
    // centre of mass in world space: p + q·c
    const qx = p[B.qx],
      qy = p[B.qy],
      qz = p[B.qz],
      qw = p[B.qw];
    const tx = 2 * (qy * c[2] - qz * c[1]);
    const ty = 2 * (qz * c[0] - qx * c[2]);
    const tz = 2 * (qx * c[1] - qy * c[0]);
    x += c[0] + qw * tx + (qy * tz - qz * ty);
    y += c[1] + qw * ty + (qz * tx - qx * tz);
    z += c[2] + qw * tz + (qx * ty - qy * tx);
  }
  const g = src.gravity();
  return -m * src.gravityScale(eid) * (g[0] * x + g[1] * y + g[2] * z);
}

/** Backward difference of a 3-vector read from the pose (acceleration from velocity). */
function accel(axis: 0 | 1 | 2 | 3): SignalDef {
  const names = ['x', 'y', 'z', ''];
  const idx = [B.vx, B.vy, B.vz];
  return {
    id: axis === 3 ? 'accel' : `acc_${names[axis]}`,
    label: axis === 3 ? 'Acceleration (magnitude)' : `Acceleration ${names[axis].toUpperCase()}`,
    unit: 'm/s²',
    group: 'Motion',
    target: 'body',
    note: 'Backward difference of the sampled velocity between two samples (includes gravity and contact forces; noisy at impacts).',
    make(src, eid) {
      let pt = NAN;
      let px = 0,
        py = 0,
        pz = 0;
      let last = 0;
      return () => {
        const p = src.pose(eid as string);
        if (!p) return NAN;
        const t = src.time();
        const vx = p[B.vx],
          vy = p[B.vy],
          vz = p[B.vz];
        const dt = t - pt;
        if (!Number.isNaN(pt) && dt > 1e-9) {
          const ax = (vx - px) / dt,
            ay = (vy - py) / dt,
            az = (vz - pz) / dt;
          last = axis === 3 ? Math.hypot(ax, ay, az) : [ax, ay, az][axis];
          pt = t;
          px = vx;
          py = vy;
          pz = vz;
        } else if (Number.isNaN(pt) || dt < 0) {
          pt = t;
          px = vx;
          py = vy;
          pz = vz;
          last = 0;
        }
        void idx;
        return last;
      };
    },
  };
}

function joint(
  id: string,
  label: string,
  unit: string,
  group: string,
  f: (s: ArrayLike<number>) => number,
  note?: string,
): SignalDef {
  return {
    id,
    label,
    unit,
    group,
    target: 'joint',
    note,
    make: (src, eid) => () => {
      const s = src.joint(eid as string);
      return s ? f(s) : NAN;
    },
  };
}

function world(id: string, label: string, unit: string, f: (w: WorldFrame) => number, note?: string): SignalDef {
  return {
    id,
    label,
    unit,
    group: 'World',
    target: 'world',
    note,
    make: (src) => () => {
      const w = src.world();
      return w ? f(w) : NAN;
    },
  };
}

const MOTION = 'Motion';
const ENERGY = 'Energy';
const MOMENTUM = 'Momentum';

export const SIGNALS: readonly SignalDef[] = [
  ...comp('pos', 'Position', 'm', MOTION, [B.px, B.py, B.pz]),
  body('height', 'Height (Y)', 'm', MOTION, (p) => p[B.py]),
  ...comp('vel', 'Velocity', 'm/s', MOTION, [B.vx, B.vy, B.vz]),
  body('speed', 'Speed', 'm/s', MOTION, (p) => Math.hypot(p[B.vx], p[B.vy], p[B.vz])),
  accel(0),
  accel(1),
  accel(2),
  accel(3),
  ...comp('angvel', 'Angular velocity', 'rad/s', MOTION, [B.wx, B.wy, B.wz]),
  body('spin', 'Spin rate (|ω|)', 'rad/s', MOTION, (p) => Math.hypot(p[B.wx], p[B.wy], p[B.wz])),
  body('mass', 'Mass', 'kg', MOTION, (_p, src, id) => src.mass(id)),
  body(
    'force',
    'Net force (magnitude)',
    'N',
    MOTION,
    (p) => Math.hypot(p[B.fx], p[B.fy], p[B.fz]),
    'm·Δv/Δt over the last frame: gravity, contacts and applied forces together.',
  ),
  ...['x', 'y', 'z'].map((ax, k) =>
    body(
      `momentum_${ax}`,
      `Linear momentum ${ax.toUpperCase()}`,
      'kg·m/s',
      MOMENTUM,
      (p, src, id) => src.mass(id) * p[[B.vx, B.vy, B.vz][k]],
    ),
  ),
  body(
    'momentum',
    'Linear momentum (magnitude)',
    'kg·m/s',
    MOMENTUM,
    (p, src, id) => src.mass(id) * Math.hypot(p[B.vx], p[B.vy], p[B.vz]),
  ),
  ...['x', 'y', 'z'].map((ax, k) =>
    body(
      `angmom_${ax}`,
      `Angular momentum ${ax.toUpperCase()}`,
      'kg·m²/s',
      MOMENTUM,
      (p, src, id) => {
        const m = src.mass(id);
        const r = [p[B.px], p[B.py], p[B.pz]];
        const v = [p[B.vx], p[B.vy], p[B.vz]];
        const orbital = m * (r[(k + 1) % 3] * v[(k + 2) % 3] - r[(k + 2) % 3] * v[(k + 1) % 3]);
        return orbital + spinInertia(p, m) * p[[B.wx, B.wy, B.wz][k]];
      },
      'About the world origin: m·(r×v) + I_eff·ω, where I_eff = 2·KE_rot/ω² (the inertia tensor is not sent by the worker; exact for spin about a principal axis).',
    ),
  ),
  body(
    'angmom',
    'Angular momentum (magnitude)',
    'kg·m²/s',
    MOMENTUM,
    (p, src, id) => {
      const m = src.mass(id);
      const I = spinInertia(p, m);
      const lx = m * (p[B.py] * p[B.vz] - p[B.pz] * p[B.vy]) + I * p[B.wx];
      const ly = m * (p[B.pz] * p[B.vx] - p[B.px] * p[B.vz]) + I * p[B.wy];
      const lz = m * (p[B.px] * p[B.vy] - p[B.py] * p[B.vx]) + I * p[B.wz];
      return Math.hypot(lx, ly, lz);
    },
    'About the world origin, with the effective-inertia approximation described for the components.',
  ),
  body(
    'spinmom',
    'Spin angular momentum (about centre)',
    'kg·m²/s',
    MOMENTUM,
    (p, src, id) => spinInertia(p, src.mass(id)) * Math.hypot(p[B.wx], p[B.wy], p[B.wz]),
    'I_eff·|ω| with I_eff = 2·KE_rot/ω²; independent of where the body is.',
  ),
  body('ke', 'Kinetic energy (total)', 'J', ENERGY, (p) => p[B.ke], 'Linear + rotational, straight from the worker.'),
  body(
    'ke_lin',
    'Kinetic energy (linear)',
    'J',
    ENERGY,
    (p, src, id) => 0.5 * src.mass(id) * (p[B.vx] ** 2 + p[B.vy] ** 2 + p[B.vz] ** 2),
  ),
  body('ke_rot', 'Kinetic energy (rotational)', 'J', ENERGY, (p, src, id) =>
    Math.max(0, p[B.ke] - 0.5 * src.mass(id) * (p[B.vx] ** 2 + p[B.vy] ** 2 + p[B.vz] ** 2)),
  ),
  body(
    'pe',
    'Potential energy (gravity)',
    'J',
    ENERGY,
    potential,
    'm·g·h of the centre of mass, zero at the world origin (the same reference as the Energy chart).',
  ),
  body(
    'energy',
    'Mechanical energy (body)',
    'J',
    ENERGY,
    (p, src, id) => p[B.ke] + potential(p, src, id),
    'Kinetic + gravitational potential of this body (springs are not included).',
  ),
  body(
    'power',
    'Power (F·v)',
    'W',
    ENERGY,
    (p) => p[B.fx] * p[B.vx] + p[B.fy] * p[B.vy] + p[B.fz] * p[B.vz],
    "Net force · velocity = rate of change of the body's translational kinetic energy. For d(E)/dt of any trace use the Derivative option.",
  ),
  joint(
    'joint_angle',
    'Hinge angle',
    '°',
    'Joints',
    (s) => (s[J.value] * 180) / Math.PI,
    'Hinge joints; accumulated turns.',
  ),
  joint('joint_angvel', 'Hinge angular speed', 'rad/s', 'Joints', (s) => s[J.speed]),
  joint('joint_pos', 'Slider position', 'm', 'Joints', (s) => s[J.value]),
  joint('joint_vel', 'Slider speed', 'm/s', 'Joints', (s) => s[J.speed]),
  joint('spring_length', 'Spring / rope length', 'm', 'Joints', (s) => s[J.value]),
  joint('spring_rate', 'Spring stretch rate', 'm/s', 'Joints', (s) => s[J.speed]),
  joint('spring_force', 'Spring force', 'N', 'Joints', (s) => s[J.force], '+ = tension.'),
  joint('rope_tension', 'Rope tension', 'N', 'Joints', (s) => s[J.force], 'Estimate from the solver.'),
  world('energy_total', 'Total mechanical energy', 'J', (w) => w.kinetic + w.rotational + w.potential + w.elastic),
  world('energy_kinetic', 'Kinetic energy (all bodies)', 'J', (w) => w.kinetic),
  world('energy_rot', 'Rotational energy (all bodies)', 'J', (w) => w.rotational),
  world('energy_potential', 'Gravitational energy (all)', 'J', (w) => w.potential),
  world('energy_elastic', 'Spring energy (all)', 'J', (w) => w.elastic),
  world('sys_momentum', 'System momentum (magnitude)', 'kg·m/s', (w) => Math.hypot(w.px, w.py, w.pz)),
  world(
    'contacts',
    'Contact points (world)',
    '',
    (w) => w.contacts,
    'Number of contact points of awake dynamic bodies. Per-body contact data is not sent by the worker. Switches the contact data on while a chart uses it.',
  ),
  world(
    'contact_force',
    'Total contact force (world)',
    'N',
    (w) => w.contactForce,
    'Sum of the contact-point forces of awake dynamic bodies (the contact overlay data).',
  ),
];

const BY_ID = new Map(SIGNALS.map((s) => [s.id, s]));
export const signalDef = (id: string): SignalDef | undefined => BY_ID.get(id);

/** Signals grouped for the picker, in catalogue order. */
export function signalGroups(): { group: string; signals: SignalDef[] }[] {
  const out: { group: string; signals: SignalDef[] }[] = [];
  for (const s of SIGNALS) {
    let g = out.find((x) => x.group === s.group);
    if (!g) out.push((g = { group: s.group, signals: [] }));
    g.signals.push(s);
  }
  return out;
}

/** Quote a reference for an expression if it is not a plain identifier. */
export const quoteRef = (name: string): string => (/^[A-Za-z_]\w*$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`);

/** The expression for a catalogue signal on an entity. */
export function signalExpr(def: SignalDef, ref: string | null): string {
  return def.target === 'world' ? `${def.id}()` : `${def.id}(${quoteRef(ref ?? 'selected')})`;
}

/** Adapt a `SignalSource` to the expression evaluator. */
export function exprHost(src: SignalSource): ExprHost {
  return {
    hasSignal: (n) => BY_ID.has(n),
    signalArity: (n) => (BY_ID.get(n)?.target === 'world' ? 0 : 1),
    time: () => src.time(),
    signal(name, ref) {
      const def = BY_ID.get(name);
      if (!def) throw new Error(`Unknown signal "${name}"`);
      if (def.target === 'world') return def.make(src, null);
      const kind = def.target;
      const id = src.resolve(ref ?? '', kind);
      if (!id)
        throw new Error(`No ${kind} called "${ref}"${ref === 'selected' ? ' (nothing suitable is selected)' : ''}`);
      return def.make(src, id);
    },
  };
}
