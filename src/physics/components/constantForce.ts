/** Runtime of the `constantForce` component (definition: `src/model/components/constantForce.ts`). */
import { qrot, vlen, vadd, type Vec3 } from '../../core/math';
import type { ComponentRuntime } from './registry';

export const constantForce: ComponentRuntime<null> = {
  type: 'constantForce',
  create: () => null,
  // Parameters are read fresh every step, so edits made while the simulation runs need no work here.
  paramsChanged: () => undefined,
  prestep(_state, _dt, ctx) {
    const body = ctx.body;
    if (!body || body.type !== 'dynamic') {
      ctx.state.set([0, 0]);
      return;
    }
    const key = ctx.str('key');
    if (key && !ctx.input.key(key)) {
      ctx.state.set([0, 0]);
      return;
    }
    const axis = ctx.str('axis');
    let scale = axis ? ctx.input.axis(axis) : 1;
    if (ctx.bool('perMass')) scale *= body.mass;
    const q = body.rotation();
    const local = ctx.str('space') === 'local';
    const f0 = ctx.vec3('force');
    const t0 = ctx.vec3('torque');
    const f: Vec3 = local ? qrot(q, f0) : [...f0];
    const t: Vec3 = local ? qrot(q, t0) : [...t0];
    for (let i = 0; i < 3; i++) {
      f[i] *= scale;
      t[i] *= scale;
    }
    const at = ctx.str('applyAt') === 'point' ? vadd(body.position(), qrot(q, ctx.vec3('point'))) : undefined;
    body.applyForce(f, at);
    body.applyTorque(t);
    ctx.state.set([vlen(f), vlen(t)]);
  },
};
