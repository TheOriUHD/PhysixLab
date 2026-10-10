// -- DT-40: "Install PhysixLab as an app…" command + Help-menu entry (only offered while the browser says it can install) --
import { registerCommand, registerMenuEntry } from '../../app/registry';
import { canInstall, promptInstall } from '../../pwa/install';

registerCommand({
  id: 'pwa.install',
  label: 'Install PhysixLab as an app…',
  category: 'Help',
  icon: 'download',
  description: 'Add PhysixLab to your desktop or home screen: its own window, works offline',
  keywords: ['install', 'pwa', 'desktop', 'app', 'offline', 'standalone'],
  enabled: () => canInstall(),
  run: async ({ app }) => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') app.toast('PhysixLab was installed.', 'success');
    else if (outcome === null)
      app.toast('Install is not available here. Use your browser’s menu (see docs/DESKTOP.md).', 'info');
  },
});

registerMenuEntry({
  id: 'menu.help.install',
  menu: 'help',
  group: 'app',
  order: 200,
  command: 'pwa.install',
  icon: 'download',
  when: () => canInstall(),
});
