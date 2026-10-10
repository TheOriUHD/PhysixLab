/**
 * Runtime of the `rotor` component (definition: `src/model/components/rotor.ts`).
 *
 * With Ω the rotor speed, R the radius, ρ the air density and q = ρ·π·R²·(Ω·R)²:
 *
 *     lift  T = C_T · collective · q                 drag torque  Q = C_Q · q · R · (0.3 + 0.7·|collective|)
 *
 * Cyclic pitch tilts the rotor disc by up to `maxTilt`: the thrust vector leans toward the nose (pitch) or the right
 * (roll). The force acts at the hub, so with the hub above the centre of mass the lean also turns the body; a stiff
 * rotor head adds a moment of its own (hub stiffness × T × R × tilt). The drag torque loads whatever turns the rotor
 * (a hinge or a drive-train shaft) or, for a self-driven rotor, turns the body the opposite way. Collective follows
 * keys at a set rate or an axis; cyclic follows keys or axes directly.
 */
import { clamp, vadd, vcross, vnorm, vscale, type Vec3 } from '../../core/math';
import type { BodyHandle } from './context';
import { DEG, signed, toRpm } from './powered/common';
import { nozzleOf } from './powered/nozzle';
import { hingeCarrier, loadShaft, spinOf, type SpinState } from './powered/rotary';
import type { ComponentRuntime } from './registry';

interface State extends SpinState {
  collective: number;
  /** The `collective` field as last seen (an edit of the field sets the collective). */
  seen: number;
  lift: number;
  torque: number;
  pitch: number;
  roll: number;
  /** Disc tilt including the trim, degrees (for the gauges). */
  tiltPitch: number;
  tiltRoll: number;
}

export const rotor: ComponentRuntime<State> = {
  type: 'rotor',
  create: (ctx) => ({
    w: 0,
    collective: ctx.num('collective'),
    seen: ctx.num('collective'),
    lift: 0,
    torque: 0,
    pitch: 0,
    roll: 0,
    tiltPitch: 0,
    tiltRoll: 0,
  }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, dt, ctx) {
    s.lift = 0;
    s.torque = 0;
    // ---- controls ----
    const field = ctx.num('collective');
    if (field !== s.seen) {
      s.seen = field;
      s.collective = field;
    }
    const axis = ctx.str('collectiveAxis');
    if (axis) s.collective = clamp(ctx.input.axis(axis), -1, 1);
    else {
      const rate = signed(ctx, 'collectiveUp', 'collectiveDown', '', 0) * ctx.num('collectiveRate');
      s.collective = clamp(s.collective + rate * dt, -1, 1);
    }
    s.pitch = signed(ctx, 'pitchForward', 'pitchBack', 'pitchAxis', 0);
    s.roll = signed(ctx, 'rollRight', 'rollLeft', 'rollAxis', 0);
    // ---- speed, aerodynamics ----
    const spin = spinOf(ctx, s, dt);
    const w = spin.w;
    const radius = ctx.num('radius');
    const tip = Math.abs(w) * radius;
    const q = ctx.num('density') * Math.PI * radius * radius * tip * tip;
    s.lift = ctx.num('thrustCoeff') * s.collective * q;
    // drag torque: a profile part (30 %) that is always there and an induced part (70 %) that grows with the lift
    const drag = 0.3 + 0.7 * Math.abs(s.collective);
    s.torque = ctx.num('torqueCoeff') * q * radius * drag;
    // Q = k·Ω²: the same load, as a coefficient on the shaft that turns the rotor
    if (spin.shaft)
      loadShaft(ctx, spin.shaft, ctx.num('torqueCoeff') * ctx.num('density') * Math.PI * radius ** 5 * drag);
    // ---- forces ----
    let body: BodyHandle | null;
    let axisDir: Vec3;
    let hub: Vec3;
    if (ctx.ownerKind === 'joint') {
      body = hingeCarrier(ctx);
      axisDir = spin.hinge ? spin.hinge.axisWorld() : [0, 1, 0];
      hub = spin.hinge ? spin.hinge.pivotWorld() : [0, 0, 0];
    } else {
      body = ctx.body;
      const nz = body ? nozzleOf(ctx, body) : { dir: [0, 1, 0] as Vec3, at: [0, 0, 0] as Vec3 };
      axisDir = nz.dir;
      hub = nz.at;
    }
    if (!body || body.type !== 'dynamic') {
      s.lift = 0;
      return;
    }
    const swirl = w >= 0 ? 1 : -1;
    axisDir = vscale(axisDir, swirl); // positive rotation about the axis lifts along it
    // the nose direction, made perpendicular to the rotor axis, and the right-hand side from it
    const nose = nozzleOf(ctx, body, 'forward', 'position').dir;
    const fwd = vnorm(vcross(vcross(axisDir, nose), axisDir), [0, 0, 1]);
    const right = vnorm(vcross(fwd, axisDir), [1, 0, 0]);
    // disc tilt: the cyclic (keys, axes) scaled to the maximum tilt, plus the fixed trim
    const tp = (s.pitch * ctx.num('maxTilt') + ctx.num('trimPitch')) * DEG;
    const tr = (s.roll * ctx.num('maxTilt') + ctx.num('trimRoll')) * DEG;
    s.tiltPitch = tp / DEG;
    s.tiltRoll = tr / DEG;
    const lean: Vec3 = vadd(vscale(fwd, Math.tan(tp)), vscale(right, Math.tan(tr)));
    body.applyForce(vscale(vnorm(vadd(axisDir, lean), axisDir), s.lift), hub);
    const head = ctx.num('hubMoment') * s.lift * radius;
    if (head !== 0) body.applyTorque(vscale(vcross(axisDir, lean), head));
    if (!spin.shaft && ctx.bool('reaction') && s.torque > 0) body.applyTorque(vscale(axisDir, -s.torque));
  },
  poststep(s, _dt, ctx) {
    const w =
      ctx.ownerKind === 'joint'
        ? (ctx.drive.own()?.speed ?? 0)
        : ctx.str('shaft')
          ? ctx.drive.shaft(ctx.str('shaft')).omega
          : s.w;
    ctx.state.set([toRpm(w), s.lift, s.collective * 100, s.tiltPitch, s.tiltRoll, s.torque]);
  },
  saveState: (s) => ({ w: s.w, collective: s.collective, seen: s.seen }),
  loadState(s, data) {
    const d = data as { w?: number; collective?: number; seen?: number } | null;
    if (!d) return;
    s.w = d.w ?? 0;
    s.collective = d.collective ?? s.collective;
    s.seen = d.seen ?? s.seen;
  },
};
