import type { App } from '../../app/app';
import { ensureFolderSync } from '../../app/data/folderSyncService';
import { UNSUPPORTED_MESSAGE } from '../../app/storage/folderSync';
import { confirmDialog, openModal } from '../modal';
import { h } from '../dom';
import { button } from './widgets';

/** Folder sync dialog (DT-13): connect, status, scenes in the folder, auto-save switch. */
export function showFolderSync(app: App): void {
  const svc = ensureFolderSync(app);
  const body = h('div', { class: 'folder-body' });
  const modal = openModal({
    title: 'Folder sync',
    body: [body],
    width: '580px',
    onClose: () => {
      svc.onChange = null;
    },
  });
  const render = async () => {
    body.replaceChildren(
      h(
        'p',
        { class: 'hint-text' },
        'Scenes are saved into a folder as .physicslab.json files. Choose a folder your Dropbox, Google Drive, iCloud or OneDrive app syncs and your scenes follow you between computers. PhysicsLab has no server and no accounts.',
      ),
    );
    if (svc.status === 'unsupported') {
      body.appendChild(h('p', { class: 'data-warning' }, UNSUPPORTED_MESSAGE));
      return;
    }
    const wrap = (fn: () => Promise<void>) => () =>
      void fn()
        .catch((e: Error) => {
          if (e.name !== 'AbortError') app.toast(e.message, 'error');
        })
        .finally(() => void render());
    if (svc.status === 'disconnected') {
      body.appendChild(
        button(
          'Choose folder…',
          wrap(() => svc.connect()),
          { icon: 'folder', cls: 'primary' },
        ),
      );
      return;
    }
    if (svc.status === 'needs-permission') {
      body.append(
        h('p', null, `Folder “${svc.folderName}” is remembered, but the browser needs your permission again.`),
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          button(
            'Reconnect',
            wrap(() => svc.reconnect()),
            { icon: 'folder', cls: 'primary' },
          ),
          button(
            'Forget folder',
            wrap(() => svc.disconnect()),
          ),
        ),
      );
      return;
    }
    const files = (await svc.sync?.listScenes()) ?? [];
    const auto = h('input', { type: 'checkbox', checked: svc.sync?.autoSave ?? true });
    auto.addEventListener('change', () => {
      if (svc.sync) svc.sync.autoSave = auto.checked;
    });
    body.append(
      h('p', null, 'Connected to folder ', h('b', null, svc.folderName)),
      h(
        'p',
        { class: 'hint-text' },
        svc.lastSavedAt
          ? `Last saved ${new Date(svc.lastSavedAt).toLocaleTimeString()}.`
          : 'Nothing saved to the folder yet.',
        svc.lastError ? ` Problem: ${svc.lastError}` : '',
      ),
      h('label', { class: 'data-row' }, h('span', null, 'Save to the folder automatically'), auto),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', margin: '8px 0' } },
        button(
          'Save now',
          wrap(() => svc.saveNow(true)),
          { icon: 'save' },
        ),
        button(
          'Disconnect',
          () =>
            void (async () => {
              if (
                await confirmDialog(
                  'Disconnect the folder?',
                  'Files stay where they are; PhysicsLab just stops using the folder.',
                  'Disconnect',
                )
              )
                await svc.disconnect().then(() => render());
            })(),
        ),
      ),
      h('div', { class: 'group-title' }, `Scenes in the folder (${files.length})`),
      ...files.map((f) => {
        const open = button(
          'Open',
          () =>
            void (async () => {
              try {
                const doc = await svc.sync!.readScene(f.name);
                app.loadDocument(doc, 'frame');
                app.toast(`Opened “${doc.name}” from the folder`, 'success');
                modal.close();
              } catch (e) {
                app.toast((e as Error).message, 'error');
              }
            })(),
          { cls: 'small' },
        );
        return h(
          'div',
          { class: 'storage-row' },
          h('div', null, h('b', null, f.name.replace(/\.physicslab\.json$/, ''))),
          h('div', { class: 'storage-size' }, new Date(f.lastModified).toLocaleString()),
          open,
        );
      }),
    );
  };
  svc.onChange = () => void render();
  void render();
}
