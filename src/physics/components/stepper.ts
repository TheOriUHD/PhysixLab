/**
 * Runtime of the `stepper` component (definition: `src/model/components/stepper.ts`).
 *
 * Every pulse (a key press, an axis pulse train, a constant rate) moves the commanded position by one step angle. The
 * rotor is pulled toward the nearest stable position with a spring that saturates at the holding torque (reached at one
 * step of displacement, as in a real motor): it holds against loads up to that torque, settles after a step with a
 * damping set by the damping ratio, and — pushed beyond two steps of lag by an overload or by pulses it cannot follow —
 * falls into the next stable position, four full steps along: a *lost step*. The available torque falls off with the
 * pulse rate. The spring and damper are realised by the engine's own implicit joint motor, so they move whatever the
 * joint is attached to.
 */
import { clamp } from '../../core/math';
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
  /** What the motor was told this step (to estimate the torque it delivered). */
  cmd: number;
  hold: number;
  gain: number;
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
      cmd: 0,
      hold: 0,
      gain: 0,
    };
  },
  paramsChanged: () => undefined,
  dispose(_s, ctx) {
    ctx.drive.own()?.motorOff();
  },
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
    // The rotor is pulled toward the nearest stable position — the commanded one, or one a whole electrical cycle (four
    // full steps) away from it, which is where a rotor that is overloaded past two steps of lag falls to: a lost step.
    const cycle = 4 * step;
    const target = s.steps * step;
    const equilibrium = target + cycle * Math.round((sh.position - target) / cycle);
    const e = sh.position - equilibrium;
    const hold = ctx.num('holdTorque') / (1 + (s.rate / ctx.num('falloffRate')) ** 2);
    const k = hold / step; // the pull rises to the holding torque at one step of displacement
    // spring + damper as the engine's velocity motor: force = clamp(c·(−(k/c)·e − v), ±hold) = clamp(−k·e − c·v)
    const c = Math.max(2 * ctx.num('damping') * Math.sqrt(k * Math.min(sh.effInertia, 1e6)), k * dt);
    s.cmd = -(k / c) * e;
    s.hold = hold;
    s.gain = c;
    sh.motorVelocity(s.cmd, c, hold);
    s.lag = (sh.position - target) / step;
  },
  poststep(s, _dt, ctx) {
    const sh = ctx.drive.own();
    if (!sh) return ctx.state.set([0, 0, 0, 0, 0]);
    const step = ctx.num('stepAngle') * DEG;
    s.torque = clamp(s.gain * (s.cmd - sh.speed), -s.hold, s.hold);
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
