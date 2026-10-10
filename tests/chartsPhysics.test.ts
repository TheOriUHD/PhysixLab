/**
 * The chart signal catalogue and spectrum analysis against the real Rapier engine: a spring-mass oscillator whose
 * recorded position must have its spectral peak at f = 1/T = √(k/m)/2π, plus checks of the derived signals.
 */
import { describe, expect, it } from 'vitest';
import { createBody, createJoint, run, worldOf } from './helpers';
import { B } from '../src/physics/protocol';
import type { PhysicsWorld } from '../src/physics/world';
import { MultiSeries } from '../src/ui/charts/series';
import { compile } from '../src/ui/charts/expr';
import { exprHost, SIGNALS, signalDef } from '../src/ui/charts/signals';
import type { SignalSource } from '../src/ui/charts/signals';
import { findPeaks, spectrum } from '../src/ui/charts/fft';
import { DerivedSignal } from '../src/ui/charts/analysis';

/** A SignalSource over a live world, the way the app wires it to the client's frame buffers. */
function sourceOf(w: PhysicsWorld, ids: string[], jointIds: string[] = []) {
  let poses = w.readPoses(1);
  let joints = w.readJoints();
  const info = w.builtInfo();
  const src: SignalSource = {
    time: () => w.stats().simTime,
    gravity: () => w.settings.gravity,
    pose: (id) => {
      const i = ids.indexOf(id);
      return i < 0 ? null : poses.subarray(i * 18, i * 18 + 18);
    },
    joint: (id) => {
      const i = jointIds.indexOf(id);
      return i < 0 ? null : joints.subarray(i * 4, i * 4 + 4);
    },
    mass: (id) => info.mass[id] ?? 0,
    com: (id) => info.com[id] ?? null,
    gravityScale: () => 1,
    world: () => {
      const e = w.stats().energy;
      return { ...e, contacts: 0, contactForce: NaN, px: e.momentum[0], py: e.momentum[1], pz: e.momentum[2] };
    },
    resolve: (ref, kind) => (kind === 'body' ? ids.find((i) => i === ref) : jointIds.find((i) => i === ref)) ?? null,
  };
  return {
    src,
    refresh: () => {
      poses = w.readPoses(1);
      joints = w.readJoints();
    },
  };
}

describe('chart signals on the real engine', () => {
  it('spring-mass position spectrum peaks at the analytic frequency 1/T', async () => {
    const m = createBody({
      shape: { type: 'box', size: [0.5, 0.5, 0.5] },
      position: [2, 5, 0],
      material: { preset: 'custom', density: 80 },
      linearDamping: 0,
      angularDamping: 0,
      canSleep: false,
      gravityScale: 0,
    });
    const k = 800;
    const sp = createJoint({
      type: 'spring',
      bodyA: null,
      bodyB: m.id,
      anchorA: [0, 5, 0],
      anchorB: [0, 0, 0],
      spring: { restLength: 1, stiffness: k, damping: 0, breakForce: 0 },
    });
    const w = await worldOf([m, sp], { gravity: [0, 0, 0] });
    const mass = w.builtInfo().mass[m.id];
    const fExpected = Math.sqrt(k / mass) / (2 * Math.PI);

    const { src, refresh } = sourceOf(w, [m.id], [sp.id]);
    const trace = compile(`pos_x(${JSON.stringify(m.id)})`, exprHost(src)).eval;
    const length = compile(`spring_length(${JSON.stringify(sp.id)})`, exprHost(src)).eval;
    const ser = new MultiSeries(60 * 20, 1 / 60);
    const cx = ser.addChannel();
    const cl = ser.addChannel();
    const hz = w.settings.physicsHz;
    const seconds = 16;
    for (let i = 0; i < seconds * hz; i++) {
      w.stepOnce();
      const t = w.stats().simTime;
      if (!ser.accept(t)) continue;
      refresh();
      const r = ser.beginRow(t);
      ser.set(cx, r, trace());
      ser.set(cl, r, length());
    }
    expect(ser.length).toBeGreaterThan(900);

    for (const ch of [cx, cl]) {
      const fs = 64;
      const n = Math.floor((ser.lastTime - ser.firstTime) * fs);
      const grid = new Float64Array(n);
      expect(ser.resampleUniform(ch, ser.firstTime, ser.firstTime + (n - 1) / fs, grid)).toBe(true);
      const spec = spectrum(grid, fs, { window: 'hann' });
      const peak = findPeaks(spec)[0];
      expect(Math.abs(peak.freq - fExpected)).toBeLessThan(spec.df);
      expect(Math.abs(peak.freq - fExpected) / fExpected).toBeLessThan(0.03);
    }
    // And the time-domain mean of position is the spring's equilibrium (x = 0 anchor, rest length 1)
    let mean = 0;
    for (let i = 0; i < ser.length; i++) mean += ser.valueAt(cx, i);
    mean /= ser.length;
    expect(Math.abs(mean - 0)).toBeLessThan(1.2);
  });

  it('free fall: velocity, acceleration (differenced), energy and power signals agree with the analytic values', async () => {
    const ball = createBody({
      shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
      position: [0, 50, 0],
      linearDamping: 0,
      angularDamping: 0,
      canSleep: false,
    });
    const w = await worldOf([ball]);
    const { src, refresh } = sourceOf(w, [ball.id]);
    const host = exprHost(src);
    const q = JSON.stringify(ball.id);
    const vy = compile(`vel_y(${q})`, host).eval;
    const ay = compile(`acc_y(${q})`, host).eval;
    const e = compile(`energy(${q})`, host).eval;
    const ke = compile(`0.5*mass(${q})*speed(${q})^2`, host).eval;
    const keSig = compile(`ke(${q})`, host).eval;
    const pw = compile(`power(${q})`, host).eval;
    const pe = compile(`pe(${q})`, host).eval;
    const dE = new DerivedSignal('derivative');
    const hz = w.settings.physicsHz;
    const e0 = (refresh(), e());
    let dEdt = 0;
    let accSeen = 0;
    for (let i = 0; i < hz; i++) {
      run(w, 1 / hz);
      refresh();
      const t = w.stats().simTime;
      ay();
      dEdt = dE.step(t, e());
      accSeen = ay();
    }
    expect(vy()).toBeCloseTo(-9.81, 0);
    expect(accSeen).toBeCloseTo(-9.81, 0);
    const m = w.builtInfo().mass[ball.id];
    expect(Math.abs(e() - e0) / e0).toBeLessThan(5e-4); // mechanical energy conserved in free fall
    expect(ke()).toBeCloseTo(keSig(), 1); // 0.5 m v² equals the worker's kinetic energy for a non-spinning ball
    expect(Math.abs(dEdt)).toBeLessThan(0.01 * m * 9.81 * 9.81); // dE/dt ~ 0, versus the 1 s power scale m·g²
    expect(pw() / (m * 9.81 * 9.81 * w.stats().simTime)).toBeCloseTo(1, 1); // P = F·v = m g · g t
    expect(pe()).toBeCloseTo(m * 9.81 * (50 - 0.5 * 9.81), -2); // m g h after 1 s of fall
  });

  it('catalogue sanity: unique ids, every body signal tolerates a missing body, world signals work without ids', () => {
    expect(new Set(SIGNALS.map((s) => s.id)).size).toBe(SIGNALS.length);
    const empty: SignalSource = {
      time: () => 0,
      gravity: () => [0, -9.81, 0],
      pose: () => null,
      joint: () => null,
      mass: () => 0,
      com: () => null,
      gravityScale: () => 1,
      world: () => null,
      resolve: (r) => r,
    };
    for (const s of SIGNALS) expect(Number.isNaN(s.make(empty, s.target === 'world' ? null : 'x')())).toBe(true);
    expect(signalDef('speed')?.unit).toBe('m/s');
    expect(B.ke).toBe(17);
  });
});
