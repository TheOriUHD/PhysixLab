/**
 * Runtime of the `driveShaft` component (definition: `src/model/components/driveShaft.ts`): a rigid row between a named
 * virtual shaft and the shaft of the hinge it sits on, `ω_shaft = ±ratio·ω_hinge`. Torque arriving on the shaft is
 * delivered to the hinge (and its reaction to the body on the other side).
 */
import type { Row } from './drive/network';
import { toRpm } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  row: Row | null;
}

export const driveShaft: ComponentRuntime<State> = {
  type: 'driveShaft',
  create: () => ({ row: null }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, _dt, ctx) {
    s.row = null;
    const own = ctx.drive.own();
    if (!own || own.kind !== 'rot') return;
    const shaft = ctx.drive.shaft(ctx.str('shaft'));
    const ratio = ctx.num('ratio') * (ctx.bool('invert') ? -1 : 1);
    ctx.drive.inertia(shaft, ctx.num('inertia'));
    s.row = ctx.drive.gear(shaft, own, ratio);
  },
  poststep(s, _dt, ctx) {
    if (!ctx.drive.own()) return ctx.state.set([0, 0]); // not on a hinge: the inspector warns
    const shaft = ctx.drive.shaft(ctx.str('shaft'));
    ctx.state.set([toRpm(shaft.omega), s.row ? s.row.torqueOn(1) : 0]);
  },
};
