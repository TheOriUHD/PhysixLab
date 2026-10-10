/** Data platform (package DT): restore points, storage manager. Further data commands register here too. */
import { registerCommand, registerMenuEntry } from '../../app/registry';

registerCommand({
  id: 'file.restorePoints',
  label: 'Restore points…',
  category: 'File',
  icon: 'folder',
  description: 'Browse automatic and manual snapshots of your scene and go back to one',
  keywords: ['snapshot', 'backup', 'recover', 'history', 'undo', 'version'],
  run: async ({ app }) => (await import('../data/restorePointsDialog')).showRestorePoints(app),
});

registerCommand({
  id: 'file.restorePoint.create',
  label: 'Create restore point',
  category: 'File',
  icon: 'save',
  description: 'Keep a labelled snapshot of the scene right now',
  keywords: ['snapshot', 'backup', 'checkpoint'],
  run: async ({ app }) => {
    const { dataPlatform } = await import('../../app/data/platform');
    const dp = dataPlatform();
    if (!dp) return;
    await dp.snapshot('Manual snapshot', 'manual');
    app.toast('Restore point created', 'success');
  },
});

registerCommand({
  id: 'file.storage',
  label: 'Storage…',
  category: 'File',
  icon: 'settings',
  description: 'See how much browser storage PhysixLab uses and clean it up',
  keywords: ['quota', 'space', 'clear', 'cache', 'indexeddb', 'disk'],
  run: async ({ app }) => (await import('../data/storageDialog')).showStorageDialog(app),
});

registerCommand({
  id: 'file.folderSync',
  label: 'Folder sync…',
  category: 'File',
  icon: 'folder',
  description: 'Save scenes into a folder that Dropbox, Drive, iCloud or OneDrive syncs (the cloud-save alternative)',
  keywords: ['cloud', 'dropbox', 'drive', 'icloud', 'onedrive', 'sync', 'folder', 'backup'],
  run: async ({ app }) => (await import('../data/folderSyncDialog')).showFolderSync(app),
});

registerMenuEntry({
  id: 'menu.file.restorePoints',
  menu: 'file',
  group: 'library',
  order: 220,
  command: 'file.restorePoints',
  icon: 'folder',
});
registerMenuEntry({
  id: 'menu.file.storage',
  menu: 'file',
  group: 'library',
  order: 230,
  command: 'file.storage',
  icon: 'settings',
});
registerMenuEntry({
  id: 'menu.file.folderSync',
  menu: 'file',
  group: 'library',
  order: 240,
  command: 'file.folderSync',
  icon: 'folder',
});

registerCommand({
  id: 'file.exportData',
  label: 'Export recorded data…',
  category: 'File',
  icon: 'download',
  description: 'Save the recorded telemetry (energy, selection) as CSV or JSON, or copy it for a spreadsheet',
  keywords: ['csv', 'json', 'telemetry', 'table', 'spreadsheet', 'clipboard', 'data'],
  run: async ({ app }) => {
    const { listDataSources, exportTable } = await import('../../app/export/dataExport');
    const { openMenu } = await import('../menu');
    const items = listDataSources().flatMap((src) =>
      (['csv', 'json', 'clipboard'] as const).map((fmt) => ({
        label: `${src.label}: ${fmt === 'csv' ? 'save CSV' : fmt === 'json' ? 'save JSON' : 'copy for spreadsheet'}`,
        action: async () => {
          const t = src.table(app);
          if (!t) return app.toast('Nothing recorded yet - press Play first.', 'warn');
          try {
            app.toast(await exportTable(t, fmt), 'success');
          } catch (e) {
            app.toast((e as Error).message, 'error');
          }
        },
      })),
    );
    openMenu(items, { x: window.innerWidth / 2 - 120, y: 120 });
  },
});

registerCommand({
  id: 'file.exportReport',
  label: 'Export lab report (HTML)…',
  category: 'File',
  icon: 'download',
  description: 'One standalone page with a screenshot, the scene parameters, an object table and the recorded charts',
  keywords: ['report', 'lab', 'html', 'print', 'pdf', 'homework'],
  run: async ({ app }) => {
    const { buildReport } = await import('../../app/export/reportData');
    const { saveTextFile, fileSafe } = await import('../../app/export/dataExport');
    saveTextFile(`${fileSafe(app.store.name)} - report.html`, await buildReport(app), 'text/html');
    app.toast('Report saved - open it in a browser and print it to PDF if you need one.', 'success');
  },
});

registerMenuEntry({
  id: 'menu.file.exportData',
  menu: 'file',
  group: 'io',
  order: 330,
  command: 'file.exportData',
  icon: 'download',
});
registerMenuEntry({
  id: 'menu.file.exportReport',
  menu: 'file',
  group: 'io',
  order: 340,
  command: 'file.exportReport',
  icon: 'download',
});
