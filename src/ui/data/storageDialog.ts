import type { App } from '../../app/app';
import { getStorageStatus, storageUsage, COLLECTIONS, type Collection } from '../../app/storage';
import { confirmDialog, openModal } from '../modal';
import { h } from '../dom';
import { button, formatBytes } from './widgets';

const LABELS: Record<Collection, { name: string; hint: string; clearable: boolean }> = {
  scenes: { name: 'Saved scenes', hint: 'Your library (File → Save to library).', clearable: false },
  assets: { name: 'Assets', hint: 'Imported meshes, textures and sounds kept outside scenes.', clearable: true },
  thumbnails: { name: 'Thumbnails', hint: 'Preview images; they are recreated when needed.', clearable: true },
  prefabs: { name: 'Prefabs', hint: 'Your own prefabs.', clearable: false },
  replays: { name: 'Replays', hint: 'Recorded simulations.', clearable: true },
  settings: { name: 'Settings snapshots', hint: 'Restore-point limits and other saved settings.', clearable: false },
  snapshots: { name: 'Restore points', hint: 'Automatic and manual snapshots of your scene.', clearable: true },
  meta: { name: 'Autosave & bookkeeping', hint: 'The current autosave and migration markers.', clearable: false },
};

/** Storage dialog: where the bytes are, the browser quota, cleanup per collection (DT-10). */
export function showStorageDialog(app: App): void {
  const body = h('div', { class: 'storage-body' });
  const modal = openModal({ title: 'Storage', body: [body], width: '600px' });
  const render = async () => {
    const [status, usage] = await Promise.all([getStorageStatus(), storageUsage()]);
    body.replaceChildren();
    if (status.degraded)
      body.appendChild(
        h(
          'p',
          { class: 'data-warning' },
          status.warning ?? 'Persistent storage is unavailable; your work is kept in memory only.',
        ),
      );
    const quota = usage.originQuota;
    const used = usage.originUsage ?? usage.bytes;
    if (quota) {
      const pct = Math.min(100, (used / quota) * 100);
      body.appendChild(
        h(
          'div',
          { class: 'quota' },
          h(
            'div',
            { class: 'quota-label' },
            `Browser storage used: ${formatBytes(used)} of ${formatBytes(quota)} (${pct.toFixed(1)} %)`,
          ),
          h(
            'div',
            {
              class: 'quota-bar',
              role: 'meter',
              'aria-valuenow': pct.toFixed(1),
              'aria-valuemin': '0',
              'aria-valuemax': '100',
            },
            h('i', { style: { width: `${Math.max(1, pct)}%` } }),
          ),
        ),
      );
    }
    body.appendChild(h('div', { class: 'group-title' }, `PhysicsLab data: ${formatBytes(usage.bytes)}`));
    for (const c of COLLECTIONS) {
      const u = usage.perCollection[c];
      const info = LABELS[c];
      const row = h(
        'div',
        { class: 'storage-row' },
        h('div', null, h('b', null, info.name), h('div', { class: 'hint-text' }, info.hint)),
        h('div', { class: 'storage-size' }, `${u.count} · ${formatBytes(u.bytes)}`),
        info.clearable && u.count
          ? button(
              'Clear',
              () => {
                void (async () => {
                  if (
                    !(await confirmDialog(`Clear ${info.name.toLowerCase()}?`, 'This cannot be undone.', 'Clear', true))
                  )
                    return;
                  await status.backend.clear(c);
                  app.toast(`${info.name} cleared`, 'success');
                  await render();
                })();
              },
              { cls: 'small', icon: 'trash' },
            )
          : h('span'),
      );
      body.appendChild(row);
    }
    const persist = typeof navigator.storage?.persist === 'function';
    if (persist) {
      body.appendChild(
        h(
          'div',
          { style: { marginTop: '10px' } },
          button(
            'Ask the browser to keep my data',
            () => {
              void navigator.storage.persist().then((ok) => {
                app.toast(
                  ok ? 'Storage is now persistent.' : 'The browser declined; it may clear data when space runs low.',
                  ok ? 'success' : 'warn',
                );
              });
            },
            { cls: 'small' },
          ),
        ),
      );
    }
  };
  render().catch((e: Error) =>
    body.replaceChildren(h('p', { class: 'data-warning' }, `Could not read storage: ${e.message}`)),
  );
  void modal;
}
