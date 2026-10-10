/** VZ-41: the "Damage" inspector section — accumulated impact damage of the selected body, with a repair button. */
import { registerInspectorSection } from '../../app/registry';
import { isBody } from '../../model/types';
import { button, row, section } from '../controls';
import { h } from '../dom';

registerInspectorSection({
  id: 'damage',
  order: 170,
  appliesTo: (selection) => selection.length === 1 && isBody(selection[0]) && selection[0].bodyType !== 'static',
  build: (ctx, selection) => {
    const first = selection[0];
    if (!isBody(first)) return [];
    const { app } = ctx;
    const value = h('span', { class: 'mono' }, '0 %');
    const bar = h('div', { class: 'damage-bar' }, h('div', { class: 'damage-fill' }));
    const repair = button('Repair', () => app.damage.repair(first.id), { title: 'Clear the damage of this body' });
    ctx.updaters.push(() => {
      const d = app.damage.damageOf(first.id);
      value.textContent = `${Math.round(d * 100)} %`;
      (bar.firstElementChild as HTMLElement).style.width = `${d * 100}%`;
      repair.disabled = d <= 0;
    });
    return [
      section(
        'Damage',
        [row('Impact damage', [value, bar], 'Accumulated from hard impacts while simulating'), row('', repair)],
        {
          id: 'damage',
          open: false,
        },
      ),
    ];
  },
});
