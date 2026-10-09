import type { App } from '../app/app';
import { fmt } from './controls';
import { h } from './dom';

export function buildStatusbar(app: App): HTMLElement {
  const mk = (label: string) => {
    const v = h('b', null, '—');
    const el = h('span', { class: 'stat' }, `${label} `, v);
    return { el, v };
  };
  const bodies = mk('bodies'), joints = mk('joints'), awake = mk('awake'), contacts = mk('contacts');
  const step = mk('step'), rtf = mk('speed'), fps = mk('fps'), g = mk('g'), sel = mk('selected');
  const grow = h('span', { class: 'grow' });
  const bar = h('footer', { class: 'statusbar' }, bodies.el, joints.el, sel.el, grow, awake.el, contacts.el, step.el, rtf.el, g.el, fps.el);
  let last = 0;
  app.on('frame', () => {
    const now = performance.now();
    if (now - last < 250) return;
    last = now;
    const st = app.sim.client.active ? app.sim.client.stats : null;
    bodies.v.textContent = String(app.store.bodies().length + (app.sim.ephemeral.size || 0));
    joints.v.textContent = String(app.store.joints().length);
    sel.v.textContent = String(app.store.selection.length);
    awake.v.textContent = st ? `${st.awake}/${st.bodies}` : '—';
    contacts.v.textContent = st ? String(st.contacts) : '—';
    step.v.textContent = st && st.stepMs > 0 ? `${fmt(st.stepMs, 2)} ms` : '—';
    step.el.classList.toggle('warn', !!st && st.stepMs > 1000 / app.store.settings.physicsHz * 0.8);
    rtf.v.textContent = st && app.sim.mode === 'running' ? `${Math.round(Math.min(1.5, st.realtimeFactor) * 100)}%` : '—';
    rtf.el.classList.toggle('warn', !!st && app.sim.mode === 'running' && st.realtimeFactor < 0.9);
    g.v.textContent = fmt(Math.hypot(...app.store.settings.gravity), 2);
    fps.v.textContent = String(Math.round(app.framesPerSecond));
  });
  return bar;
}
