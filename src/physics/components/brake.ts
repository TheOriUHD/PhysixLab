/**
 * Runtime of the `brake` component (definition: `src/model/components/brake.ts`).
 *
 * A friction brake is a bounded row `ω = 0, |T| ≤ T_max·pedal` in the drive network: while the load torque is smaller
 * than the brake's the shaft is stopped *exactly* and held (no creep from a damper that needs a speed to work
 * against), and when the load is larger the shaft slides with the full brake torque opposing it. The parking brake
 * latches with a key press and stays on until pressed again.
 */
import { clamp } from '../../core/math';
import type { Row } from './drive/network';
import { approach, Edge, pedal } from './powered/common';
import type { ComponentRuntime } from './registry';

interface State {
  pedal: number;
  parked: boolean;
  edge: Edge;
  row: Row | null;
}

export const brake: ComponentRuntime<State> = {
  type: 'brake',
  create: (ctx) => ({ pedal: 0, parked: ctx.bool('parked'), edge: new Edge(), row: null }),
  paramsChanged: (_s, ctx) => ctx.drive.releaseAll(),
  prestep(s, dt, ctx) {
    s.row = null;
    const sh = ctx.ownerKind === 'joint' ? ctx.drive.own() : ctx.drive.shaft(ctx.str('shaft'));
    if (!sh) return;
    s.pedal = approach(s.pedal, clamp(pedal(ctx, 'key', 'axis', 0), 0, 1), ctx.num('response'), dt);
    const park = ctx.str('parkKey');
    if (park && s.edge.pressed(ctx.input.key(park))) s.parked = !s.parked;
    const t = Math.max(s.pedal * ctx.num('torque'), s.parked ? ctx.num('parkTorque') : 0);
    if (t > 0) s.row = ctx.drive.drive(sh, 0, t);
  },
  poststep(s, _dt, ctx) {
    const sh = ctx.ownerKind === 'joint' ? ctx.drive.own() : ctx.drive.shaft(ctx.str('shaft'));
    ctx.state.set([Math.abs(s.row?.torque ?? 0), s.pedal * 100, s.parked ? 1 : 0, sh?.speed ?? 0]);
  },
  saveState: (s) => ({ pedal: s.pedal, parked: s.parked }),
  loadState(s, data) {
    const d = data as Partial<State> | null;
    if (d) {
      s.pedal = d.pedal ?? 0;
      s.parked = d.parked ?? s.parked;
    }
  },
};
