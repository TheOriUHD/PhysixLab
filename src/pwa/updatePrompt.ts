// -- DT-40: "new version available" banner --
import { h } from '../ui/dom';

/**
 * A small non-modal banner (bottom-left, role=status) with "Reload" and "Later". It never reloads by itself.
 * `apply` activates the waiting service worker and reloads the page (see register.ts).
 */
export function showUpdatePrompt(apply: () => void): HTMLElement {
  document.querySelector('.pwa-update')?.remove();
  const reload = h('button', { class: 'btn primary', type: 'button', dataset: { pwa: 'reload' } }, 'Reload');
  const later = h('button', { class: 'btn', type: 'button', dataset: { pwa: 'later' } }, 'Later');
  const banner = h(
    'div',
    { class: 'pwa-update', role: 'status', 'aria-live': 'polite' },
    h(
      'div',
      { class: 'pwa-update-text' },
      h('strong', null, 'A new version of PhysicsLab is ready.'),
      h('span', null, 'Your scene is autosaved. Reload when it suits you.'),
    ),
    h('div', { class: 'pwa-update-actions' }, later, reload),
  );
  reload.addEventListener('click', () => {
    reload.disabled = true;
    reload.textContent = 'Updating…';
    apply();
  });
  later.addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
  return banner;
}
