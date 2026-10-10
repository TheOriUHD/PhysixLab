/**
 * Runtime of the `stepper` component (definition: `src/model/components/stepper.ts`).
 *
 * A two-phase stepper's torque-angle characteristic is a sine: with the rotor `e` away from the commanded position
 * the motor pulls back with T = −T_hold·sin(π/2 · e / step). It is zero at the commanded position (stable), peaks at
 * one full step of lag (the holding torque), and is zero again — but unstable — at two steps, beyond which the rotor
 * falls into the next stable position four steps further on: a *lost step*. The restoring spring and its damping are
 * integrated implicitly (the network adds `dt·k` to the shaft's inertia), so the stiff characteristic of a small
 * stepper on a light rotor is stable at any physics rate. The available torque falls off with pulse rate.
 */
import { approach, DEG, Edge } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  /** Commanded position in steps. */
  steps: number;
  /** Pulses accumulated toward the next step (axis, repeat and constant trains). */
  acc: number;
  /** Pulse rate (steps/s), smoothed, for the torque fall-off. */
  rate: number;
  fwd: Edge;
  rev: Edge;
  heldF: number;
  heldR: number;
  torque: number;
  lag: number;
}

const REPEAT_DELAY = 0.35;

export const stepper: ComponentRuntime<State> = {
  type: 'stepper',
  create: (ctx) => {
    // the commanded position starts where the rotor is
    const sh = ctx.drive.own();
    const step = ctx.num('stepAngle') * DEG;
    return {
      steps: sh ? Math.round(sh.position / step) : 0,
      acc: 0,
      rate: 0,
      fwd: new Edge(),
      rev: new Edge(),
      heldF: 0,
      heldR: 0,
      torque: 0,
      lag: 0,
    };
  },
  paramsChanged: () => undefined,
  prestep(s, dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh || sh.kind !== 'rot') return;
    const step = ctx.num('stepAngle') * DEG;
    // ---- pulses ----
    let n = 0;
    const kf = ctx.str('stepKey');
    const kr = ctx.str('stepKeyReverse');
    const df = !!kf && ctx.input.key(kf);
    const dr = !!kr && ctx.input.key(kr);
    if (s.fwd.pressed(df)) n++;
    if (s.rev.pressed(dr)) n--;
    s.heldF = df ? s.heldF + dt : 0;
    s.heldR = dr ? s.heldR + dt : 0;
    const repeat = ctx.num('repeatRate');
    if (repeat > 0) {
      if (s.heldF > REPEAT_DELAY) s.acc += repeat * dt;
      if (s.heldR > REPEAT_DELAY) s.acc -= repeat * dt;
    }
    const axis = ctx.str('axis');
    if (axis) s.acc += ctx.input.axis(axis) * ctx.num('maxRate') * dt;
    s.acc += ctx.num('pulseRate') * dt;
    while (s.acc >= 1) {
      n++;
      s.acc -= 1;
    }
    while (s.acc <= -1) {
      n--;
      s.acc += 1;
    }
    s.steps += n;
    s.rate = approach(s.rate, Math.abs(n) / dt, 0.08, dt);
    // ---- torque-angle characteristic about the commanded position ----
    const e = sh.position - s.steps * step;
    const hold = ctx.num('holdTorque') / (1 + (s.rate / ctx.num('falloffRate')) ** 2);
    const phase = (Math.PI / 2) * (e / step);
    const t = -hold * Math.sin(phase);
    const kNom = (hold * Math.PI) / 2 / step;
    const slope = -kNom * Math.cos(phase); // dT/dθ
    const c = 2 * ctx.num('damping') * Math.sqrt(kNom * Math.min(sh.effInertia, 1e6));
    ctx.drive.torque(sh, t, c + dt * Math.max(0, -slope));
    s.torque = t;
    s.lag = e / step;
  },
  poststep(s, _dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh) return ctx.state.set([0, 0, 0, 0, 0]);
    const step = ctx.num('stepAngle') * DEG;
    ctx.state.set([s.steps, (s.steps * step) / DEG, sh.position / DEG, s.lag, s.torque]);
  },
  saveState: (s) => ({ steps: s.steps, acc: s.acc, rate: s.rate, heldF: s.heldF, heldR: s.heldR }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (!d) return;
    s.steps = d.steps ?? s.steps;
    s.acc = d.acc ?? 0;
    s.rate = d.rate ?? 0;
    s.heldF = d.heldF ?? 0;
    s.heldR = d.heldR ?? 0;
  },
};
