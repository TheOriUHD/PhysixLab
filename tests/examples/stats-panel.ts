// File: src/ui/extensions/stats-panel.ts
import { registerPanel } from '../../src/app/registry';
import { h } from '../../src/ui/dom';

registerPanel({
  id: 'stats',
  label: 'Stats',
  icon: 'info',
  region: 'right',
  order: 40,
  build: (app) => {
    const el = h('div', { class: 'panel-body' });
    const render = () => {
      const text = `${app.store.bodies().length} bodies, ${app.store.joints().length} joints`;
      el.replaceChildren(h('div', { class: 'empty-state' }, h('h4', null, text)));
    };
    app.store.on('change', render);
    render();
    return { el, onShow: render };
  },
});
