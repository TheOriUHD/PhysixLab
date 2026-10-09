import type { App } from '../app/app';
import { h } from './dom';

export function mountToasts(app: App): void {
  const host = h('div', { class: 'toasts' });
  document.body.appendChild(host);
  app.on('toast', ({ text, kind }) => {
    const t = h('div', { class: `toast ${kind}` }, text);
    host.appendChild(t);
    while (host.children.length > 3) host.firstElementChild?.remove();
    const ms = Math.min(9000, 2600 + text.length * 45);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, ms);
  });
}
