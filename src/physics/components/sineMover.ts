/**
 * Runtime of the `sineMover` component (definition: `src/model/components/sineMover.ts`): x(t) = A·sin(2π·f·t + φ)
 * along a world axis from the body's authored position. The kinematic body is moved by velocity so that it is on the
 * curve at the end of every fixed step — contacts see the true velocity, hence friction carries riders.
 */
import { vdot, vnorm, type Vec3 } from '../../core/math';
import type { ComponentRuntime } from './registry';

interface State {
  /** The authored (document) position the offset is measured from. */
  center: Vec3;
}

const offsetAt = (amp: number, freq: number, phaseDeg: number, t: number): number =>
  amp * Math.sin(2 * Math.PI * freq * t + (phaseDeg * Math.PI) / 180);

export const sineMover: ComponentRuntime<State | null> = {
  type: 'sineMover',
  create(ctx) {
    const body = ctx.body;
    if (!body || body.type !== 'kinematic') return null; // the inspector warns; nothing to drive
    const center: Vec3 = [...body.def.position];
    // Start on the curve, so a non-zero phase (or a component added mid-run) does not launch riders.
    const ax = vnorm(ctx.vec3('axis'), [1, 0, 0]);
    const off = offsetAt(ctx.num('amplitude'), ctx.num('frequency'), ctx.num('phase'), ctx.time);
    body.teleport([center[0] + ax[0] * off, center[1] + ax[1] * off, center[2] + ax[2] * off]);
    return { center };
  },
  paramsChanged: () => undefined, // the curve is evaluated from the live parameters every step
  prestep(state, dt, ctx) {
    const body = ctx.body;
    if (!state || !body) return;
    const ax = vnorm(ctx.vec3('axis'), [1, 0, 0]);
    const off = offsetAt(ctx.num('amplitude'), ctx.num('frequency'), ctx.num('phase'), ctx.time + dt);
    body.driveTo([state.center[0] + ax[0] * off, state.center[1] + ax[1] * off, state.center[2] + ax[2] * off]);
  },
  poststep(state, _dt, ctx) {
    const body = ctx.body;
    if (!state || !body) return;
    const ax = vnorm(ctx.vec3('axis'), [1, 0, 0]);
    const p = body.position();
    const d: Vec3 = [p[0] - state.center[0], p[1] - state.center[1], p[2] - state.center[2]];
    ctx.state.set([vdot(d, ax), vdot(body.linvel(), ax)]);
  },
};
