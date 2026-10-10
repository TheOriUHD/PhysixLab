import { dataPlatform } from '../../app/data/platform';
import { captureThumbnail } from '../../app/data/thumbnail';
import type { App } from '../../app/app';
import type { RestorePointMeta } from '../../app/storage/restorePoints';
import { diffDocuments } from '../../app/storage/docDiff';
import { button, numberFieldRow } from './widgets';
import { confirmDialog, openModal, promptText } from '../modal';
import { h } from '../dom';
import { icon } from '../icons';

const KIND_LABEL = { auto: 'Automatic', before: 'Before change', manual: 'Manual' } as const;

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleString();
}

export function showRestorePoints(app: App): void {
  const dp = dataPlatform();
  const body = h('div', { class: 'rp-body' });
  if (!dp) {
    body.appendChild(h('p', { class: 'hint-text' }, 'Restore points are not available (storage did not start).'));
    openModal({ title: 'Restore points', body, width: '640px' });
    return;
  }
  const rp = dp.restore;
  const list = h('div', { class: 'rp-list' });
  const settings = h('div', { class: 'rp-settings' });
  const modal = openModal({ title: 'Restore points', body: [body], width: '680px' });

  const render = async () => {
    const points = await rp.list();
    list.replaceChildren();
    if (!points.length)
      list.appendChild(
        h(
          'p',
          { class: 'hint-text' },
          'No restore points yet. They are taken automatically while you work and before risky changes such as opening another scene. You can also create one now.',
        ),
      );
    const current = app.store.toDocument();
    for (const p of points) list.appendChild(await card(p, current));
  };

  const card = async (p: RestorePointMeta, current: ReturnType<App['store']['toDocument']>) => {
    const thumb = await rp.thumbnail(p.id);
    const old = await rp.load(p.id);
    const diff = old ? diffDocuments(old, current).summary : 'damaged';
    const restore = button(
      'Restore',
      () => {
        void (async () => {
          if (!old) return;
          if (
            !(await confirmDialog(
              'Restore this point?',
              'The current scene is saved as a new restore point first, so you can come back to it.',
              'Restore',
            ))
          )
            return;
          await dp.snapshot('Before restoring “' + p.label + '”', 'before');
          app.loadDocument(old, 'frame');
          app.toast(`Restored “${p.label}”`, 'success');
          modal.close();
        })();
      },
      { cls: 'small primary', icon: 'reset' },
    );
    const del = button(
      '',
      () => {
        void rp.delete(p.id).then(render);
      },
      { cls: 'small', icon: 'trash', title: 'Delete this restore point' },
    );
    return h(
      'div',
      { class: 'rp-card' },
      thumb
        ? h('img', { src: thumb, alt: '', class: 'rp-thumb' })
        : h('div', { class: 'rp-thumb empty' }, icon('camera')),
      h(
        'div',
        { class: 'rp-info' },
        h('div', { class: 'rp-title' }, p.label),
        h(
          'div',
          { class: 'rp-meta' },
          `${KIND_LABEL[p.kind]} · ${ago(p.at)} · ${p.entities} objects · ${(p.bytes / 1000).toFixed(0)} kB`,
        ),
        h('div', { class: 'rp-diff' }, `vs. now: ${diff}`),
      ),
      h('div', { class: 'rp-actions' }, restore, del),
    );
  };

  const renderSettings = () => {
    settings.replaceChildren(
      h('div', { class: 'group-title' }, 'Limits'),
      numberFieldRow('Automatic snapshot every (min)', rp.settings.autoMinutes, 1, 120, (v) =>
        rp.saveSettings({ autoMinutes: v }).then(() => {
          dp.restore.startAuto(
            () => app.store.toDocument(),
            () => app.store.revision,
            () => captureThumbnail(app.viewport),
          );
        }),
      ),
      numberFieldRow('Keep automatic points', rp.settings.maxAuto, 1, 200, (v) =>
        rp.saveSettings({ maxAuto: v }).then(render),
      ),
      numberFieldRow('Keep “before change” points', rp.settings.maxBefore, 1, 100, (v) =>
        rp.saveSettings({ maxBefore: v }).then(render),
      ),
      numberFieldRow('Total size limit (MB)', Math.round(rp.settings.maxBytes / 1e6), 1, 1024, (v) =>
        rp.saveSettings({ maxBytes: v * 1e6 }).then(render),
      ),
    );
  };

  const create = button(
    'Create restore point…',
    () => {
      void (async () => {
        const label = await promptText('New restore point', 'Label', 'Manual snapshot', 'Create');
        if (label === null) return;
        await dp.snapshot(label, 'manual');
        await render();
      })();
    },
    { icon: 'save', cls: 'primary' },
  );
  const clear = button(
    'Delete all',
    () => {
      void (async () => {
        if (await confirmDialog('Delete all restore points?', 'This cannot be undone.', 'Delete all')) {
          await rp.clear();
          await render();
        }
      })();
    },
    { icon: 'trash' },
  );
  body.append(h('div', { class: 'rp-toolbar' }, create, clear), list, settings);
  renderSettings();
  void render();
}
