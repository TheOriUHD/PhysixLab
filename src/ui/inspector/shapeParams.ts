/**
 * Generic inspector rows for a shape's parameters. The fields are generated from the `params` schema of the
 * shape's registry entry (`ShapeDef.params`), so a new shape with parameters needs no inspector code.
 */
import { coerceParam, type ParamDef, type ShapeDef } from '../../model/shapeRegistry';
import type { ParamValue } from '../../model/types';
import { numberField, row, selectField, sliderField, toggleField, type Field } from '../controls';
import type { InspectorContext } from './shared';

export function shapeParamRows(ctx: InspectorContext, id: string, def: ShapeDef): HTMLElement[] {
  const { app } = ctx;
  const get = () => app.store.body(id);
  const visible = def.params.filter((p) => !p.hidden); // -- ED-B: hidden params have no field --
  return visible.map((p) => {
    const undoLabel = `${def.label} ${p.label.toLowerCase()}`;
    const write = (v: ParamValue) => {
      const b = get();
      if (!b) return;
      const value = coerceParam(p, v);
      if (b.shape.params?.[p.key] === value) return;
      app.store.update(id, { shape: { ...b.shape, params: { ...b.shape.params, [p.key]: value } } }, undoLabel);
    };
    const field = paramField(p, write, ctx.grouped(undoLabel));
    ctx.updaters.push(() => {
      const b = get();
      if (b) field.set(b.shape.params?.[p.key] ?? p.default);
    });
    return row(p.label, field.el, p.hint);
  });
}

function paramField(
  p: ParamDef,
  write: (v: ParamValue) => void,
  group: { onStart: () => void; onEnd: () => void },
): Field<ParamValue> {
  const asNumber = (v: ParamValue) => (typeof v === 'number' ? v : Number(p.default));
  switch (p.kind) {
    case 'bool': {
      const f = toggleField({ onChange: write });
      return { el: f.el, set: (v, mixed) => f.set(v === true, mixed) };
    }
    case 'enum': {
      const f = selectField<string>({
        options: [...(p.options ?? [])],
        onChange: write,
      });
      return { el: f.el, set: (v, mixed) => f.set(String(v), mixed) };
    }
    case 'text': {
      // -- ED-B: plain text field --
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = p.maxLength ?? 1000;
      input.addEventListener('change', () => write(input.value));
      return { el: input, set: (v) => void (input.value = String(v)) };
    }
    case 'int':
    case 'float': {
      const digits = p.kind === 'int' ? 0 : undefined;
      const ranged = p.min !== undefined && p.max !== undefined;
      const f: Field<number> = ranged
        ? sliderField({
            min: p.min ?? 0,
            max: p.max ?? 1,
            step: p.step,
            digits,
            unit: p.unit,
            ...group,
            onChange: write,
          })
        : numberField({ step: p.step ?? 0.1, min: p.min, max: p.max, digits, unit: p.unit, ...group, onChange: write });
      return { el: f.el, set: (v, mixed) => f.set(asNumber(v), mixed) };
    }
  }
}
