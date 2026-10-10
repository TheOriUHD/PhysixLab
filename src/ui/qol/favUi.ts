/** Star toggles and thumbnails for the library tabs (UI-42). */
import { h } from '../dom';
import type { FavKind } from './favourites';
import { favouriteStore, thumbStore } from './stores';

/**
 * A star the library cards and tiles carry. It lives inside a button, so it is a `span role=button` that swallows
 * the click (the card underneath must not open). The panel re-renders on `favouriteStore().onChange`.
 */
export function favStar(kind: FavKind, id: string, label: string): HTMLElement {
  const on = favouriteStore().has(kind, id);
  const star = h('span', {
    class: `fav-star ${on ? 'on' : ''}`,
    role: 'button',
    tabindex: 0,
    'aria-pressed': on ? 'true' : 'false',
    'aria-label': `${on ? 'Remove from' : 'Add to'} favourites: ${label}`,
    title: on ? 'Remove from favourites' : 'Add to favourites',
    dataset: { fav: `${kind}:${id}` },
  }); // the glyph is drawn by CSS (::before), so the star never changes a card's or tile's text
  const toggle = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    favouriteStore().toggle(kind, id);
  };
  star.addEventListener('click', toggle);
  star.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') toggle(e);
  });
  return star;
}

/** The cached thumbnail of a scene as an <img>, or null when none was taken yet. */
export function sceneThumb(key: string): HTMLElement | null {
  const url = thumbStore().get(key);
  return url ? h('img', { class: 'scene-thumb', src: url, alt: '', draggable: false }) : null;
}

/** Put a scene's cached thumbnail at the left of a library card (nothing happens when there is none yet). */
export function attachThumb(card: HTMLElement, key: string): void {
  const img = sceneThumb(key);
  if (!img) return;
  const text = h('span', { class: 'qol-card-text' });
  text.append(...Array.from(card.childNodes));
  card.append(img, text);
  card.classList.add('has-thumb');
}
