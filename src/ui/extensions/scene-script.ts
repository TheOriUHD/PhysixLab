// -- DT-32: "Scene script…" command and File-menu entry. The dialog and the sandbox load on first use (lazy chunk). --
import { lazy } from '../../core/lazy';
import { registerCommand } from '../../app/registry/commands';
import { registerMenuEntry } from '../../app/registry/menus';

const dialog = lazy(() => import('../../scripting/dialog'));

registerCommand({
  id: 'file.sceneScript',
  label: 'Scene script…',
  category: 'File',
  icon: 'component',
  description: 'Generate a scene by writing JavaScript against the Builder DSL (runs in a sandbox)',
  keywords: ['script', 'javascript', 'generate', 'procedural', 'dsl', 'code'],
  run: async ({ app }) => (await dialog()).openSceneScriptDialog(app),
});

registerMenuEntry({
  id: 'menu.file.sceneScript',
  menu: 'file',
  group: 'automation',
  order: 960,
  command: 'file.sceneScript',
});
