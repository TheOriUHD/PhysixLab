/** VZ-42: the "Skin" inspector section: pick a registered visual skin that fits the selected body's shape. */
import { registerInspectorSection } from '../../app/registry';
import { skinRegistry } from '../../render/skins/registry';
import '../../render/skins';
import type { BodyEntity } from '../../model/types';
import { isBody } from '../../model/types';
import { row, section, selectField } from '../controls';

registerInspectorSection({
  id: 'skin',
  order: 160, // after the body panel (100), before "Organise" (200)
  appliesTo: (selection) => selection.length === 1 && isBody(selection[0]),
  build: (ctx, selection) => {
    const first = selection[0];
    if (!isBody(first)) return [];
    const { store } = ctx.app;
    const fits = skinRegistry.list().filter((s) => !s.shapes || s.shapes.includes(first.shape.type));
    // Nothing to choose from and nothing set: do not clutter the inspector.
    if (!fits.length && !first.skin) return [];
    const known = new Set(fits.map((s) => s.id));
    const options = [{ value: '', label: 'None' }, ...fits.map((s) => ({ value: s.id, label: s.label }))];
    const field = selectField<string>({
      options,
      value: first.skin?.id ?? '',
      onChange: (id) =>
        ctx.edit<BodyEntity>([first.id], id ? 'Set skin' : 'Remove skin', () => ({
          skin: id ? { id } : undefined,
        })),
    });
    const select = field.el.querySelector('select');
    if (select) {
      select.dataset.skinSelect = '';
      select.title = 'Render-only model drawn in place of the body shape; the physics is unchanged';
    }
    ctx.updaters.push(() => {
      const body = store.body(first.id);
      const id = body?.skin?.id ?? '';
      // A skin id this build does not know (from a newer file) is kept as it is and shown as "Unknown".
      if (select && id && !known.has(id) && ![...select.options].some((o) => o.value === id)) {
        select.append(new Option(`Unknown skin (${id})`, id));
      }
      field.set(id);
    });
    return [section('Skin', [row('Model', field.el, 'Visual skin')], { id: 'skin' })];
  },
});
