/**
 * Runtime of the `propeller` component (definition: `src/model/components/propeller.ts`).
 *
 * With n the rotation speed in revolutions per second, D the diameter and ρ the fluid density:
 *
 *     static thrust  T₀ = C_T·ρ·n²·D⁴          load torque  Q = C_Q·ρ·n²·D⁵
 *
 * and the thrust fades linearly with the advance ratio J = V/(n·D) (V = the body's speed along the thrust direction),
 * reaching nothing at J = J₀: a propeller that is flying as fast as its pitch can take pushes no more. The load torque
 * goes onto whatever turns the propeller (a hinge or a drive-train shaft, implicitly integrated) so the engine feels
 * it; a self-driven propeller puts the opposite torque on its body instead.
 */
import { clamp, vdot, vscale, type Vec3 } from '../../core/math';
import type { BodyHandle } from './context';
import { toRpm } from './powered/common';
import { nozzleOf } from './powered/nozzle';
import { hingeCarrier, loadShaft, spinOf, type SpinState } from './powered/rotary';
import type { ComponentRuntime } from './registry';

interface State extends SpinState {
  thrust: number;
  torque: number;
  j: number;
  w: number;
}

export const propeller: ComponentRuntime<State> = {
  type: 'propeller',
  create: () => ({ w: 0, thrust: 0, torque: 0, j: 0 }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, dt, ctx) {
    s.thrust = 0;
    s.torque = 0;
    s.j = 0;
    const spin = spinOf(ctx, s, dt);
    const w = spin.w;
    const n = Math.abs(w) / (2 * Math.PI); // rev/s
    const d = ctx.num('diameter');
    const rho = ctx.num('density');
    // where the force acts and which way it points
    let body: BodyHandle | null;
    let dir: Vec3;
    let at: Vec3;
    if (ctx.ownerKind === 'joint') {
      body = hingeCarrier(ctx);
      dir = spin.hinge ? spin.hinge.axisWorld() : [0, 0, 1];
      at = spin.hinge ? spin.hinge.pivotWorld() : [0, 0, 0];
    } else {
      body = ctx.body;
      if (body) {
        const nz = nozzleOf(ctx, body);
        dir = nz.dir;
        at = nz.at;
      } else {
        dir = [0, 0, 1];
        at = [0, 0, 0];
      }
    }
    // positive rotation about `dir` pushes along +dir; `reverse` flips the pitch of the blades, not the rotation
    const swirl = w >= 0 ? 1 : -1;
    const axis = dir;
    dir = vscale(axis, swirl * (ctx.bool('reverse') ? -1 : 1));
    // advance ratio from the speed of the hub through the fluid
    const v = body ? vdot(body.velocityAt(at), dir) : 0;
    s.j = n > 1e-6 ? clamp(v / (n * d), 0, 100) : 0;
    const fade = clamp(1 - s.j / ctx.num('advance'), 0, 1);
    const thrust = ctx.num('thrustCoeff') * rho * n * n * d ** 4 * fade;
    const kq = (ctx.num('torqueCoeff') * rho * d ** 5) / (4 * Math.PI * Math.PI); // Q = kq·ω²
    s.thrust = thrust;
    s.torque = kq * w * w;
    if (body && body.type === 'dynamic' && thrust > 0) body.applyForce(vscale(dir, thrust), at);
    if (spin.shaft) loadShaft(ctx, spin.shaft, kq);
    else if (body && ctx.bool('reaction') && body.type === 'dynamic' && s.torque > 0) {
      // a self-driven propeller pushes against its own body: the opposite torque, about the rotation axis
      body.applyTorque(vscale(axis, -swirl * s.torque));
    }
    s.w = spin.shaft ? s.w : w;
  },
  poststep(s, _dt, ctx) {
    const w =
      ctx.ownerKind === 'joint'
        ? (ctx.drive.own()?.speed ?? 0)
        : ctx.str('shaft')
          ? ctx.drive.shaft(ctx.str('shaft')).omega
          : s.w;
    ctx.state.set([toRpm(w), s.thrust, s.torque, s.j, (s.torque * Math.abs(w)) / 1000]);
  },
  saveState: (s) => ({ w: s.w }),
  loadState(s, data) {
    const d = data as { w?: number } | null;
    if (d) s.w = d.w ?? 0;
  },
};
