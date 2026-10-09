import type { App } from '../app/app';
import { h } from './dom';
import { icon } from './icons';
import { Inspector } from './inspector';
import { Outliner } from './outliner';
import { buildWorldPanel } from './worldPanel';

export function buildRightPanel(app: App): HTMLElement {
  const { prefs } = app;
  const inspector = new Inspector(app);
  const outliner = new Outliner(app);
  const world = buildWorldPanel(app);
  const defs = [
    { id: 'inspector', label: 'Inspector', icon: 'settings', el: inspector.el },
    { id: 'outliner', label: 'Outliner', icon: 'layers', el: outliner.el },
    { id: 'world', label: 'World', icon: 'zap', el: world },
  ] as const;
  const tabs = h('div', { class: 'tabs' });
  const els = defs.map((d) => {
    const t = h('button', { class: 'tab', type: 'button' }, icon(d.icon), d.label);
    t.addEventListener('click', () => prefs.set({ rightTab: d.id }));
    tabs.appendChild(t);
    return t;
  });
  const host = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, ...defs.map((d) => d.el));
  const sync = () => {
    const cur = prefs.value.rightTab;
    defs.forEach((d, i) => { els[i].classList.toggle('on', d.id === cur); d.el.style.display = d.id === cur ? '' : 'none'; });
    if (cur === 'outliner') outliner.activate();
  };
  prefs.on('change', (k) => { if (k.includes('rightTab')) sync(); });
  // Selecting something while on another tab: jump to the inspector for convenience.
  app.store.on('selection', () => { if (app.store.selection.length && prefs.value.rightTab === 'world') prefs.set({ rightTab: 'inspector' }); });
  sync();
  return h('aside', { class: 'panel right' }, tabs, host);
}
