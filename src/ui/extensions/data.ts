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
  description: 'See how much browser storage PhysicsLab uses and clean it up',
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
