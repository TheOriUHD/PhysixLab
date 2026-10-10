/* eslint-disable prefer-const -- calculator inputs refer to each other in their change handlers, so they are declared first */
/**
 * UI-A: the inspector's contextual calculators. The formulas are in `calculators.ts` (pure, tested); this file shows
 * them for the selected body / spring / rope / hinge and writes the results into the selected object through the
 * store (`ctx.edit`, so every "Set" button is one undo step).
 *
 * A calculator input follows the document until the user types into it; after that it keeps the typed value (so
 * "what if" numbers survive edits elsewhere) until the section is rebuilt or the result is applied.
 */
import { qrot } from '../../../core/math';
import type { Vec3 } from '../../../core/math';
import { compoundVolume, massEstimate } from '../../../model/compound';
import type { BodyEntity, Entity, JointEntity } from '../../../model/types';
import { isBody, isJoint } from '../../../model/types';
import { button, fmt, numberField, row, section } from '../../controls';
import { h } from '../../dom';
import type { InspectorContext } from '../shared';
import {
  dampedPeriod,
  dampingFromRatio,
  dampingRatio,
  densityFromMass,
  dragCoefficient,
  launchAngles,
  launchVelocity,
  massFromDensity,
  momentsOfInertia,
  naturalFrequency,
  naturalPeriod,
  pendulumLength,
  pendulumPeriod,
  projectile,
  reducedMass,
  springConstantFromPeriod,
  terminalVelocity,
} from './calculators';
import { followUnits } from './fieldUnits';
import { unitPrefs } from './prefsStore';
import { quantityById, toDisplay, unitLabel } from './units';
import { DEG, RAD } from '../../../core/math';

// ---- building blocks ---------------------------------------------------------------------------------------------

interface Input {
  row: HTMLElement;
  value: () => number;
  /** Put a value into the field programmatically (does not count as typing). */
  put: (v: number) => void;
  /** Forget what the user typed: follow the document again. */
  release: () => void;
}

interface Out {
  row: HTMLElement;
  set: (text: string) => void;
}

/** A value with its unit in the user's unit system ("3.28 ft"). */
export function showQ(qid: string, native: number, digits = 4): string {
  const q = quantityById(qid);
  if (!q || !Number.isFinite(native)) return '—';
  const sys = unitPrefs.system;
  return `${fmt(toDisplay(q, sys, native), digits)} ${unitLabel(q, sys)}`;
}

const sig = (v: number, d = 4): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return fmt(v, a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : d);
};

class Block {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private recompute: (() => void)[] = [];
  constructor(
    private ctx: InspectorContext,
    title: string,
    hint: string,
  ) {
    this.body = h('div', { class: 'ui-a-calc-body' });
    this.el = h(
      'div',
      { class: 'ui-a-calc' },
      h('div', { class: 'ui-a-calc-title' }, title),
      h('p', { class: 'hint-text' }, hint),
      this.body,
    );
    // outputs refresh with the document, with typing and when the user switches units
    ctx.updaters.push(() => this.run());
    followUnits(this.el, () => this.run());
  }

  run(): void {
    for (const f of this.recompute) f();
  }

  onChange(fn: () => void): void {
    this.recompute.push(fn);
  }

  /** A numeric input. `get` reads the document value it follows until the user types. */
  input(
    label: string,
    unit: string,
    get: () => number,
    o: { step?: number; min?: number; max?: number; onUser?: (v: number) => void; hint?: string } = {},
  ): Input {
    let dirty = false;
    let local = get();
    const f = numberField({
      unit,
      step: o.step ?? 0.1,
      min: o.min,
      onChange: (v) => {
        dirty = true;
        local = v;
        o.onUser?.(v);
        this.run();
      },
    });
    f.set(local);
    this.ctx.updaters.push(() => {
      if (!dirty) {
        local = get();
        f.set(local);
      }
    });
    const r = row(label, f.el, o.hint);
    this.body.append(r);
    return {
      row: r,
      value: () => local,
      put: (v) => {
        local = v;
        f.set(v);
      },
      release: () => {
        dirty = false;
        local = get();
        f.set(local);
      },
    };
  }

  output(label: string, hint?: string): Out {
    const dd = h('span', { class: 'readout ui-a-out' }, '—');
    const r = row(label, dd, hint);
    this.body.append(r);
    return { row: r, set: (t) => (dd.textContent = t) };
  }

  note(text: string): HTMLElement {
    const p = h('p', { class: 'hint-text ui-a-note' }, text);
    this.body.append(p);
    return p;
  }

  actions(...btns: HTMLElement[]): void {
    this.body.append(h('div', { class: 'ui-a-calc-actions' }, btns));
  }
}

// ---- helpers over the app ----------------------------------------------------------------------------------------

const gravityOf = (ctx: InspectorContext): number => Math.hypot(...ctx.app.store.settings.gravity);

/** Mass of a body: from the running engine when available, else from the document; 0 when it is not dynamic. */
function massOf(ctx: InspectorContext, id: string | null): number {
  if (!id) return 0;
  const b = ctx.app.store.body(id);
  if (!b || b.bodyType !== 'dynamic') return 0;
  const live = ctx.app.sim.client.active ? ctx.app.sim.client.info.mass[id] : undefined;
  return live && live > 0 ? live : massEstimate(b);
}

/** Cross-section and drag coefficient guesses by shape; they are only the starting values of editable inputs. */
function dragDefaults(b: BodyEntity): { cd: number; area: number } {
  const [sx, sy, sz] = b.shape.size;
  switch (b.shape.type) {
    case 'sphere':
      return { cd: 0.47, area: (Math.PI / 4) * sx * sz };
    case 'cylinder':
    case 'capsule':
      return { cd: 0.82, area: (Math.PI / 4) * sx * sz };
    case 'box':
      return { cd: 1.05, area: sx * sz };
    default:
      return { cd: 1.0, area: Math.max(sx * sz, sx * sy * 0.5) };
  }
}

// ---- body calculators --------------------------------------------------------------------------------------------

function densityBlock(ctx: InspectorContext, id: string): HTMLElement {
  const get = () => ctx.app.store.body(id);
  const volume = () => {
    const b = get();
    return b ? compoundVolume(b) : 0;
  };
  const blk = new Block(
    ctx,
    'Mass · density · volume',
    'Mass = density × volume. Type a density to get the mass, or the mass you want to get the density it needs.',
  );
  let density: Input, mass: Input;
  density = blk.input('Density', 'kg/m³', () => get()?.material.density ?? 0, {
    step: 10,
    min: 1,
    onUser: (d) => mass.put(massFromDensity(d, volume())),
  });
  mass = blk.input('Mass', 'kg', () => (get() ? massEstimate(get()!) : 0), {
    step: 0.1,
    min: 0.0001,
    onUser: (m) => density.put(densityFromMass(m, volume())),
  });
  const vol = blk.output('Volume', 'Volume of the shape (sum of the parts of a compound body)');
  blk.onChange(() => vol.set(showQ('volume', volume())));
  blk.actions(
    button(
      'Set density',
      () => {
        const d = density.value();
        if (!(d >= 1)) return;
        ctx.edit<BodyEntity>([id], 'Set density', (b) => ({
          material: { ...b.material, preset: 'custom', density: Math.round(d * 1000) / 1000 },
        }));
        density.release();
        mass.release();
      },
      { title: 'Write this density into the material (the preset becomes Custom)' },
    ),
    button(
      'Set mass',
      () => {
        const m = mass.value();
        if (!(m > 0)) return;
        ctx.edit<BodyEntity>([id], 'Set mass', () => ({ massOverride: m }));
        density.release();
        mass.release();
      },
      { title: 'Override the mass directly (density × volume is then ignored; the shape proportions stay)' },
    ),
    button(
      'Clear override',
      () => {
        ctx.edit<BodyEntity>([id], 'Clear mass override', () => ({ massOverride: undefined }));
        density.release();
        mass.release();
      },
      { title: 'Back to density × volume' },
    ),
  );
  blk.run();
  return blk.el;
}

function inertiaBlock(ctx: InspectorContext, id: string): HTMLElement {
  const blk = new Block(
    ctx,
    'Moment of inertia',
    'Principal moments about the centre of mass, in the body’s local axes (read-only).',
  );
  const outs = ['X', 'Y', 'Z'].map((a) => blk.output(`I${a.toLowerCase()}`, `About the local ${a} axis`));
  const eff = blk.output('Inertia scale');
  const note = blk.note('');
  blk.onChange(() => {
    const b = ctx.app.store.body(id);
    if (!b) return;
    const m = massOf(ctx, id) || massEstimate(b);
    const inertia = momentsOfInertia(m, b.shape);
    inertia.moments.forEach((v, i) => outs[i].set(showQ('inertia', v * b.inertiaScale)));
    eff.set(b.inertiaScale === 1 ? '× 1 (unscaled)' : `× ${sig(b.inertiaScale)} (applied)`);
    note.textContent =
      (b.parts?.length ?? 0) > 0
        ? 'Compound body: approximated by the box of its bounding shape.'
        : inertia.exact
          ? `Exact for a ${inertia.note} of uniform density.`
          : `Not exact: ${inertia.note}.`;
    if (b.bodyType !== 'dynamic') note.textContent += ' Static and kinematic bodies do not respond to torque.';
  });
  blk.run();
  return blk.el;
}

function dragBlock(ctx: InspectorContext, id: string): HTMLElement {
  const get = () => ctx.app.store.body(id);
  const blk = new Block(
    ctx,
    'Terminal velocity',
    'Fall speed where air drag ½·ρ·Cd·A·v² balances the weight. “Set” writes the body’s quadratic air drag so the engine reproduces it.',
  );
  const cd = blk.input('Drag Cd', '', () => (get() ? dragDefaults(get()!).cd : 1), { step: 0.05, min: 0.01 });
  const area = blk.input('Area A', 'm²', () => (get() ? dragDefaults(get()!).area : 1), { step: 0.01, min: 1e-6 });
  const rho = blk.input('Air density ρ', 'kg/m³', () => 1.225, {
    step: 0.05,
    min: 0,
    hint: 'Sea-level air 1.225, water 1000',
  });
  const mass = blk.input('Mass', 'kg', () => (get() ? massOf(ctx, id) || massEstimate(get()!) : 1), {
    step: 0.1,
    min: 0.0001,
  });
  const vt = blk.output('Terminal v', 'Terminal velocity');
  const coef = blk.output('Drag c', 'F = c·|v|·v, the engine’s quadratic drag setting');
  const t95 = blk.output('Time to 95 %', 'Time to reach 95 % of the terminal velocity falling from rest');
  const g = () => gravityOf(ctx) * (get()?.gravityScale ?? 1);
  let c = NaN;
  blk.onChange(() => {
    c = dragCoefficient(rho.value(), cd.value(), area.value());
    const v = terminalVelocity(mass.value(), g(), c);
    vt.set(Number.isFinite(v) ? showQ('speed', v) : 'none (no drag or no gravity)');
    coef.set(Number.isFinite(c) && c > 0 ? `${sig(c, 5)} N·s²/m²` : '—');
    t95.set(Number.isFinite(v) ? `${sig((v / g()) * Math.atanh(0.95))} s` : '—');
  });
  blk.actions(
    button(
      'Set air drag',
      () => {
        if (!(c > 0)) return;
        ctx.edit<BodyEntity>([id], 'Set air drag', (b) => ({ drag: { ...b.drag, linear2: Math.min(c, 1e6) } }));
      },
      { title: 'Write c into the body’s quadratic drag (Physics ▸ air resistance)' },
    ),
  );
  blk.run();
  return blk.el;
}

function projectileBlock(ctx: InspectorContext, id: string): HTMLElement {
  const get = () => ctx.app.store.body(id);
  const launch = () => launchAngles(get()?.velocity ?? [0, 0, 0]);
  const blk = new Block(
    ctx,
    'Projectile range',
    'Flight without air resistance over level ground. Starts from the body’s initial velocity; “Set” writes a new launch velocity (keeping its heading).',
  );
  const speed = blk.input('Launch speed', 'm/s', () => (launch().speed > 0 ? launch().speed : 10), {
    step: 0.5,
    min: 0,
  });
  const angle = blk.input('Elevation', '°', () => (launch().speed > 0 ? launch().elevation * RAD : 45), { step: 1 });
  const height = blk.input('Launch height', 'm', () => get()?.position[1] ?? 0, {
    step: 0.1,
    hint: 'Height above the landing level (y = 0)',
  });
  const range = blk.output('Range');
  const time = blk.output('Flight time');
  const apex = blk.output('Apex height');
  blk.onChange(() => {
    const p = projectile(speed.value(), angle.value() * DEG, height.value(), gravityOf(ctx));
    range.set(Number.isFinite(p.range) ? showQ('length', p.range) : '—');
    time.set(Number.isFinite(p.time) ? `${sig(p.time)} s` : '—');
    apex.set(Number.isFinite(p.apex) ? showQ('length', p.apex) : '—');
  });
  blk.actions(
    button(
      'Set launch velocity',
      () => {
        const v0 = get()?.velocity ?? [0, 0, 0];
        const heading = Math.hypot(v0[0], v0[2]) > 1e-6 ? launchAngles(v0).heading : 0;
        const v = launchVelocity(speed.value(), angle.value() * DEG, heading);
        ctx.edit<BodyEntity>([id], 'Set launch velocity', () => ({
          velocity: v.map((x) => Math.round(x * 1e6) / 1e6) as Vec3,
        }));
        speed.release();
        angle.release();
      },
      { title: 'Write the initial velocity (starts when the simulation begins)' },
    ),
  );
  blk.run();
  return blk.el;
}

// ---- joint calculators -------------------------------------------------------------------------------------------

function springBlocks(ctx: InspectorContext, id: string): HTMLElement[] {
  const get = () => ctx.app.store.joint(id);
  const effMass = (): number => {
    const j = get();
    return j ? reducedMass(massOf(ctx, j.bodyA), massOf(ctx, j.bodyB)) : 0;
  };
  const k0 = new Block(
    ctx,
    'Spring constant',
    'k = m·(2π/T)² = m·(2πf)² for the period T or frequency f you want. The mass is what hangs on the spring (two free bodies: their reduced mass).',
  );
  let period: Input, freq: Input, mass: Input;
  const kOf = () => springConstantFromPeriod(mass.value(), period.value());
  mass = k0.input('Mass', 'kg', () => effMass() || 1, { step: 0.1, min: 0.0001 });
  period = k0.input(
    'Period T',
    's',
    () => {
      const j = get();
      return j ? naturalPeriod(j.spring.stiffness, effMass() || 1) : 1;
    },
    { step: 0.05, min: 0.001, onUser: (T) => freq.put(1 / T) },
  );
  freq = k0.input(
    'Frequency f',
    'Hz',
    () => {
      const j = get();
      return j ? naturalFrequency(j.spring.stiffness, effMass() || 1) : 1;
    },
    { step: 0.05, min: 0.001, onUser: (f) => period.put(1 / f) },
  );
  const kOut = k0.output('Stiffness k');
  const cur = k0.output('Current k');
  k0.onChange(() => {
    const k = kOf();
    kOut.set(Number.isFinite(k) ? showQ('stiffness', k) : '—');
    cur.set(get() ? showQ('stiffness', get()!.spring.stiffness) : '—');
  });
  k0.actions(
    button(
      'Set stiffness',
      () => {
        const k = kOf();
        if (!(k > 0)) return;
        ctx.edit<JointEntity>([id], 'Set spring stiffness', (j) => ({
          spring: { ...j.spring, stiffness: Math.min(k, 1e9) },
        }));
        period.release();
        freq.release();
      },
      { title: 'Write k into the spring' },
    ),
  );
  k0.run();

  const d0 = new Block(
    ctx,
    'Damping ratio',
    'ζ = c / (2√(k·m)): below 1 the spring rings, 1 is critical damping, above 1 it creeps back.',
  );
  const zeta = d0.input(
    'Target ζ',
    '',
    () => {
      const j = get();
      const z = j ? dampingRatio(j.spring.damping, j.spring.stiffness, effMass() || 1) : 0.1;
      return Number.isFinite(z) ? Math.round(z * 1000) / 1000 : 0.1;
    },
    { step: 0.05, min: 0 },
  );
  const nowZ = d0.output('Current ζ');
  const cOut = d0.output('Damping c for ζ');
  const per = d0.output('Damped period');
  d0.onChange(() => {
    const j = get();
    if (!j) return;
    const m = effMass() || 1;
    const z = dampingRatio(j.spring.damping, j.spring.stiffness, m);
    nowZ.set(
      Number.isFinite(z) ? `${sig(z, 3)} (${z < 0.999 ? 'underdamped' : z < 1.001 ? 'critical' : 'overdamped'})` : '—',
    );
    const c = dampingFromRatio(zeta.value(), j.spring.stiffness, m);
    cOut.set(Number.isFinite(c) ? showQ('damping', c) : '—');
    const tp = dampedPeriod(j.spring.stiffness, m, zeta.value());
    per.set(Number.isFinite(tp) ? `${sig(tp)} s` : 'no oscillation (ζ ≥ 1)');
  });
  d0.actions(
    button(
      'Set damping',
      () => {
        const j = get();
        if (!j) return;
        const c = dampingFromRatio(zeta.value(), j.spring.stiffness, effMass() || 1);
        if (!Number.isFinite(c) || c < 0) return;
        ctx.edit<JointEntity>([id], 'Set spring damping', (jj) => ({
          spring: { ...jj.spring, damping: Math.min(c, 1e9) },
        }));
        zeta.release();
      },
      { title: 'Write c into the spring damping' },
    ),
  );
  d0.run();
  return [k0.el, d0.el];
}

function pendulumBlock(ctx: InspectorContext, id: string): HTMLElement {
  const get = () => ctx.app.store.joint(id);
  const rope = get()?.type === 'rope';
  /** Length from the pivot to the swinging body, for a hinge (a point-mass approximation). */
  const hingeLength = (): number => {
    const j = get();
    if (!j) return 1;
    const dynA = massOf(ctx, j.bodyA) > 0;
    const bob = dynA && !(massOf(ctx, j.bodyB) > 0) ? j.bodyA : j.bodyB;
    const other = bob === j.bodyA ? j.bodyB : j.bodyA;
    const bobPose = bob ? ctx.app.store.body(bob) : undefined;
    if (!bobPose) return 1;
    const anchorOwner = other ? ctx.app.store.body(other) : undefined;
    const anchor: Vec3 = anchorOwner
      ? (() => {
          const a = qrot(anchorOwner.rotation, bob === j.bodyA ? j.anchorB : j.anchorA);
          return [anchorOwner.position[0] + a[0], anchorOwner.position[1] + a[1], anchorOwner.position[2] + a[2]];
        })()
      : bob === j.bodyA
        ? j.anchorB
        : j.anchorA;
    return (
      Math.hypot(bobPose.position[0] - anchor[0], bobPose.position[1] - anchor[1], bobPose.position[2] - anchor[2]) || 1
    );
  };
  const blk = new Block(
    ctx,
    'Pendulum period',
    rope
      ? 'T = 2π√(L/g) for a small swing; the exact period for a larger amplitude is shown below. “Set” changes the rope length.'
      : 'A point mass on a massless rod of the pivot-to-body distance. A real body (inertia about the pivot) swings slower.',
  );
  let length: Input, period: Input;
  length = blk.input('Length L', 'm', () => (rope ? (get()?.ropeLength ?? 1) : hingeLength()), {
    step: 0.05,
    min: 0.01,
    onUser: (L) => period.put(pendulumPeriod(L, gravityOf(ctx))),
  });
  period = blk.input('Period T (small)', 's', () => pendulumPeriod(length.value(), gravityOf(ctx)), {
    step: 0.05,
    min: 0.01,
    onUser: (T) => length.put(pendulumLength(T, gravityOf(ctx))),
  });
  const amp = blk.input('Amplitude θ₀', '°', () => 0, { step: 5, min: 0 });
  const exact = blk.output('Period at θ₀', '0° = the small-angle formula');
  blk.onChange(() => {
    const g = gravityOf(ctx);
    const t = pendulumPeriod(length.value(), g, Math.min(amp.value(), 179) * DEG);
    exact.set(Number.isFinite(t) ? `${sig(t)} s` : '—');
  });
  if (rope) {
    blk.actions(
      button(
        'Set rope length',
        () => {
          const L = length.value();
          if (!(L > 0)) return;
          ctx.edit<JointEntity>([id], 'Set rope length', () => ({ ropeLength: Math.round(L * 1e5) / 1e5 }));
          length.release();
          period.release();
        },
        { title: 'Write the length into the rope' },
      ),
    );
  }
  blk.run();
  return blk.el;
}

// ---- section -----------------------------------------------------------------------------------------------------

/** Does the section have anything for this selection? */
export function calculatorsApply(sel: readonly Entity[]): boolean {
  if (sel.length !== 1) return false;
  const e = sel[0];
  if (isBody(e)) return true;
  return isJoint(e) && (e.type === 'spring' || e.type === 'rope' || e.type === 'hinge');
}

export function buildCalculators(ctx: InspectorContext, sel: Entity[]): HTMLElement[] {
  const e = sel[0];
  const blocks: HTMLElement[] = [];
  if (isBody(e)) {
    blocks.push(densityBlock(ctx, e.id), inertiaBlock(ctx, e.id));
    if (e.bodyType === 'dynamic') blocks.push(dragBlock(ctx, e.id), projectileBlock(ctx, e.id));
  } else if (isJoint(e)) {
    if (e.type === 'spring') blocks.push(...springBlocks(ctx, e.id));
    else blocks.push(pendulumBlock(ctx, e.id));
  }
  if (!blocks.length) return [];
  return [section('Calculators', blocks, { id: 'calculators', open: false })];
}
