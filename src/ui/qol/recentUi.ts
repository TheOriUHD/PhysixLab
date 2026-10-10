/** The "Recent" block at the top of the Scenes tab (UI-42). */
import type { App } from '../../app/app';
import { h } from '../dom';
import { icon } from '../icons';
import { attachThumb } from './favUi';
import { ago } from './recents';
import { openRecent } from './recentScenes';
import { recentScenes } from './stores';

export function recentSection(app: App, max = 5): HTMLElement | null {
  const list = recentScenes().list().slice(0, max);
  if (!list.length) return null;
  const cards = h('div', { class: 'cards', dataset: { recents: '1' }, style: { paddingBottom: '2px' } });
  for (const e of list) {
    const c = h(
      'button',
      { class: 'card', type: 'button', dataset: { recent: e.key }, title: 'Open this scene again' },
      h('h4', null, icon('folder'), e.name),
      h('p', null, `${e.bodies} bodies · ${ago(e.at)}`),
    );
    attachThumb(c, e.key);
    c.addEventListener('click', () => void openRecent(app, e));
    cards.appendChild(c);
  }
  return h('div', null, h('div', { class: 'group-title' }, 'Recent'), cards);
}
