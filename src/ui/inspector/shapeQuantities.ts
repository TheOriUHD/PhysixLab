/**
 * Inspector rows for a shape's derived quantities (`ShapeDef.quantities`): numbers computed from its size and
 * parameters that are easier to think in — a gear's module, a rounded box's corner radius in metres. Editing one is
 * an ordinary shape edit (the registry works out the size and parameters), so undo, live resizing, the scale gizmo
 * and saving behave as for any other field.
 */
import { applyQuantity, completeSpec, type ShapeDef } from '../../model/shapeRegistry';
import { numberField, row } from '../controls';
import type { InspectorContext } from './shared';

export function shapeQuantityRows(ctx: InspectorContext, id: string, def: ShapeDef): HTMLElement[] {
  const { app } = ctx;
  const get = () => app.store.body(id);
  return (def.quantities ?? []).map((q) => {
    const label = `${def.label} ${q.label.toLowerCase()}`;
    const field = numberField({
      step: q.step ?? 0.01,
      min: q.min,
      max: q.max,
      digits: q.digits,
      unit: q.unit,
      ...ctx.grouped(label),
      onChange: (v) => {
        const b = get();
        if (!b) return;
        const next = applyQuantity(b.shape, q, v);
        app.store.update(
          id,
          { shape: { ...b.shape, size: next.size, ...(next.params ? { params: next.params } : {}) } },
          label,
        );
      },
    });
    ctx.updaters.push(() => {
      const b = get();
      if (b) field.set(q.get(completeSpec(b.shape)));
    });
    return row(q.label, field.el, q.hint);
  });
}
