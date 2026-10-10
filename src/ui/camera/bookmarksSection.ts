/** Camera panel: saved views (bookmarks) with thumbnails, stored in the scene. */
import type { App } from '../../app/app';
import { saveBookmarkSlot } from '../../app/camera/builtin';
import { button, section } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import { promptText } from '../modal';
import { registerCameraSection } from './sections';

registerCameraSection({
  id: 'bookmarks',
  order: 30,
  build(app: App) {
    const list = h('div', { class: 'cam-bookmarks', role: 'list', 'aria-label': 'Camera bookmarks' });
    const empty = h(
      'p',
      { class: 'hint-text' },
      'Save a view, then come back to it with one click or Shift+1…9. Ctrl+Shift+1…9 saves straight into a slot.',
    );
    const render = () => {
      const marks = app.store.cameras.bookmarks;
      list.replaceChildren();
      marks.forEach((b, i) => {
        const thumb = b.thumb
          ? h('img', { class: 'cam-thumb', src: b.thumb, alt: '', draggable: false })
          : h('div', { class: 'cam-thumb empty' }, icon('camera'));
        const slot = i < 9 ? h('span', { class: 'cam-slot', title: `Shift+${i + 1}` }, String(i + 1)) : null;
        const open = h(
          'button',
          { class: 'cam-card-open', type: 'button', title: `Go to “${b.name}”${i < 9 ? ` (Shift+${i + 1})` : ''}` },
          thumb,
          slot,
        );
        open.addEventListener('click', () => app.cameraRig.recall(b));
        const name = h('span', { class: 'cam-card-name', title: b.name }, b.name);
        const rename = h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Rename', 'aria-label': `Rename ${b.name}` },
          icon('settings'),
        );
        rename.addEventListener('click', () => {
          void promptText('Rename bookmark', 'Name', b.name, 'Rename').then((v) => {
            if (!v) return;
            app.store.setCameras(
              {
                ...app.store.cameras,
                bookmarks: app.store.cameras.bookmarks.map((x) => (x.id === b.id ? { ...x, name: v.slice(0, 60) } : x)),
              },
              'Rename camera bookmark',
            );
          });
        });
        const update = h(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Replace with the current view',
            'aria-label': `Update ${b.name} to the current view`,
          },
          icon('frame'),
        );
        update.addEventListener('click', () => void saveBookmarkSlot(app, i));
        const del = h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Delete', 'aria-label': `Delete ${b.name}` },
          icon('trash'),
        );
        del.addEventListener('click', () =>
          app.store.setCameras(
            { ...app.store.cameras, bookmarks: app.store.cameras.bookmarks.filter((x) => x.id !== b.id) },
            'Delete camera bookmark',
          ),
        );
        list.appendChild(
          h(
            'div',
            { class: 'cam-card', role: 'listitem', dataset: { id: b.id } },
            open,
            h('div', { class: 'cam-card-bar' }, name, rename, update, del),
          ),
        );
      });
      empty.style.display = marks.length ? 'none' : '';
    };
    app.store.on('meta', render);
    render();
    const add = button('Save current view', () => void saveBookmarkSlot(app, app.store.cameras.bookmarks.length), {
      icon: 'plus',
      title: 'Save the camera position, lens and projection as a bookmark',
    });
    return { el: section('Bookmarks', [add, empty, list], { id: 'cam-bookmarks' }), refresh: render };
  },
});
