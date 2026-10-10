import { h } from './dom';
import { icon } from './icons';

export interface BannerAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface BannerHandle {
  close(): void;
}

/**
 * A persistent notice at the top of the page (toasts vanish too fast for "something crashed, here is what we did").
 * Only one banner per `key` is shown at a time; showing it again replaces the old one.
 */
export function showBanner(
  key: string,
  text: string,
  actions: BannerAction[] = [],
  kind: 'info' | 'warn' | 'error' = 'info',
): BannerHandle {
  document.querySelector(`.data-banner[data-key="${CSS.escape(key)}"]`)?.remove();
  const close = () => el.remove();
  const x = h('button', { class: 'icon-btn', type: 'button', title: 'Dismiss' }, icon('close'));
  x.addEventListener('click', close);
  const buttons = actions.map((a) => {
    const b = h('button', { class: `btn small ${a.primary ? 'primary' : ''}`, type: 'button' }, a.label);
    b.addEventListener('click', () => {
      close();
      a.run();
    });
    return b;
  });
  const el = h(
    'div',
    { class: `data-banner ${kind}`, role: 'status', dataset: { key } },
    icon(kind === 'info' ? 'info' : 'zap'),
    h('span', { class: 'data-banner-text' }, text),
    h('span', { class: 'data-banner-actions' }, buttons),
    x,
  );
  document.body.appendChild(el);
  return { close };
}
