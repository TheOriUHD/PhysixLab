// -- DT-31: plugin manager command + start-up of installed plugins. Everything heavy loads lazily. --
import { lazy } from '../../core/lazy';
import { registerCommand } from '../../app/registry/commands';
import { registerMenuEntry } from '../../app/registry/menus';
import type { App } from '../../app/app';

const manager = lazy(() => import('../../plugins/manager'));

registerCommand({
  id: 'file.plugins',
  label: 'Plugins…',
  category: 'File',
  icon: 'component',
  description: 'Install, enable and remove sandboxed plugins',
  keywords: ['plugin', 'extension', 'addon', 'extend'],
  run: async ({ app }) => (await manager()).openPluginManager(app),
});
registerMenuEntry({ id: 'menu.file.plugins', menu: 'file', group: 'automation', order: 965, command: 'file.plugins' });

// Start the plugins the user installed once the app exists. The check is a cheap localStorage read, so nothing
// plugin-related is downloaded unless there is something to start.
window.addEventListener('physicslab:ready', () => {
  let any = false;
  try {
    const list = JSON.parse(localStorage.getItem('physicslab.plugins.v1') ?? '[]') as { enabled?: boolean }[];
    any = Array.isArray(list) && list.some((p) => p.enabled);
  } catch {
    /* unreadable: treat as none */
  }
  if (!any) return;
  const app = (window as unknown as { physicslab: App }).physicslab;
  void manager().then((m) => m.pluginHost(app).startAll());
});
