// ── ED-A ED-1: selection tools — lasso, paint (brush) select, select similar / invert / group children / connected /
// grow / shrink, and the Select-by-condition panel ──
import {
  LASSO_MODE,
  PAINT_MODE,
  beginLasso,
  beginPaint,
  getBrushRadius,
  growSelectionCmd,
  invertSelectionCmd,
  prepareSelectOverlay,
  selectConnectedCmd,
  selectGroupChildrenCmd,
  selectSimilarCmd,
  setBrushRadius,
  shrinkSelectionCmd,
} from '../../app/edit/selectTools';
import type { App } from '../../app/app';
import { registerCommand, registerMenuEntry, registerPanel, registerTool } from '../../app/registry';
import type { SimilarCriteria } from '../../model/edit/selection';
import { isGroup } from '../../model/types';
import { buildSelectPanel } from '../edSelectPanel';

// Inline icon bodies (src/ui/icons.ts accepts SVG markup in place of a key).
const ICON_LASSO =
  '<path d="M12 4c5 0 9 2.2 9 5s-4 5-9 5-9-2.2-9-5 4-5 9-5z"/><path d="M8 14c-1.5 2-.5 4.5 1.5 5.5 1.3.7 2.5.2 2.5-1"/><circle cx="12" cy="18.5" r=".6" fill="currentColor"/>';
const ICON_BRUSH =
  '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><path d="M9 15l6-6M10 9l5 5" opacity=".0"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>';
const ICON_SIMILAR =
  '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M15 6h6M18 3v6M3 15h6M6 12v6"/>';
const ICON_INVERT = '<path d="M12 3a9 9 0 1 0 0 18z" fill="currentColor"/><circle cx="12" cy="12" r="9"/>';

const MODIFIER_HINT =
  '<kbd>Shift</kbd> adds · <kbd>Ctrl</kbd>/<kbd>⌘</kbd> subtracts · <kbd>Esc</kbd> cancels · <kbd>Alt</kbd>-drag orbits';

registerTool({
  id: 'lasso',
  group: 'select',
  order: 41,
  label: 'Lasso select',
  title: 'Lasso select — draw a freehand outline around objects',
  icon: ICON_LASSO,
  shortcut: 'O',
  keywords: ['freehand', 'select', 'outline', 'polygon'],
  mode: LASSO_MODE,
  activate: (app) => {
    prepareSelectOverlay(app);
    app.setTool(LASSO_MODE);
  },
  isActive: (app) => app.prefs.value.tool === LASSO_MODE,
  pointerDown: (app, e) => beginLasso(app, e),
  hint: () => `<b>Drag</b> a freehand outline to select what is inside · ${MODIFIER_HINT}`,
});

registerTool({
  id: 'paintselect',
  group: 'select',
  order: 42,
  label: 'Paint select',
  title: 'Paint select — brush over objects to select them ([ ] resize)',
  icon: ICON_BRUSH,
  shortcut: 'S',
  keywords: ['brush', 'select', 'paint', 'scrub'],
  mode: PAINT_MODE,
  activate: (app) => {
    prepareSelectOverlay(app);
    app.setTool(PAINT_MODE);
  },
  isActive: (app) => app.prefs.value.tool === PAINT_MODE,
  pointerDown: (app, e) => beginPaint(app, e),
  hint: () => `<b>Drag</b> the brush over objects · <kbd>[</kbd> <kbd>]</kbd> resize · ${MODIFIER_HINT}`,
});

const paintActive = (app: App) => app.prefs.value.tool === PAINT_MODE;
for (const [id, label, key, dir] of [
  ['select.brush.smaller', 'Smaller select brush', '[', -1],
  ['select.brush.larger', 'Larger select brush', ']', 1],
] as const) {
  registerCommand({
    id,
    label,
    category: 'Select',
    description: 'Resize the paint-select brush (while the Paint select tool is active)',
    keywords: ['radius', 'size', 'brush'],
    shortcut: key,
    enabled: paintActive,
    run: ({ app, source }) => {
      setBrushRadius(getBrushRadius() * (dir > 0 ? 1.15 : 1 / 1.15) + dir);
      if (source === 'shortcut') app.toast(`Brush ${getBrushRadius()} px`);
    },
  });
}

// ── commands ──

const hasSelection = (app: App) => app.store.selection.length > 0;
const report = (app: App, n: number, what: string) =>
  app.toast(n ? `${n} selected${what ? ` ${what}` : ''}` : 'Nothing matched', n ? 'info' : 'warn');

const SIMILAR: [string, string, string, SimilarCriteria][] = [
  ['shape', 'Shape', 'Select every object with the same shape as the selection', { shape: true }],
  ['material', 'Material', 'Select every body made of the same material (preset and colour)', { material: true }],
  ['size', 'Size', 'Select every body with the same size (within 1 %)', { size: true }],
  ['tag', 'Tag', 'Select every body that shares a tag with the selection', { tag: true }],
  ['kind', 'Kind', 'Select every entity of the same kind (body, light, group, joint …)', { kind: true }],
  ['layer', 'Layer', 'Select every body on the same layer', { layer: true }],
];
SIMILAR.forEach(([key, label, description, criteria], i) => {
  registerCommand({
    id: `select.similar.${key}`,
    label: `Select similar: ${label}`,
    category: 'Select',
    icon: ICON_SIMILAR,
    description,
    keywords: ['same', 'match', 'similar', key],
    enabled: hasSelection,
    run: ({ app }) => report(app, selectSimilarCmd(app, criteria), `(same ${label.toLowerCase()})`),
  });
  registerMenuEntry({
    id: `menu.edit.select.similar.${key}`,
    menu: 'edit',
    group: 'select',
    order: 350 + i,
    command: `select.similar.${key}`,
  });
});

registerCommand({
  id: 'select.invert',
  label: 'Invert selection',
  category: 'Select',
  icon: ICON_INVERT,
  description: 'Select everything that is not selected (hidden objects stay out)',
  keywords: ['inverse', 'reverse', 'opposite'],
  shortcut: 'Mod+I',
  run: ({ app }) => report(app, invertSelectionCmd(app), ''),
});
registerCommand({
  id: 'select.groupChildren',
  label: 'Select group children',
  category: 'Select',
  icon: 'group',
  description: 'Replace the selected groups by their members',
  keywords: ['members', 'contents', 'folder'],
  enabled: (app) => app.store.selection.some((id) => isGroup(app.store.get(id))),
  run: ({ app }) => {
    const n = selectGroupChildrenCmd(app);
    if (n) report(app, n, 'group members');
    else app.toast('The selected groups are empty', 'warn');
  },
});
registerCommand({
  id: 'select.connected',
  label: 'Select connected (joints)',
  category: 'Select',
  icon: 'joint',
  description: 'Select everything linked to the selection through joints, however far',
  keywords: ['linked', 'assembly', 'chain', 'flood'],
  enabled: hasSelection,
  run: ({ app }) => report(app, selectConnectedCmd(app), 'connected'),
});
registerCommand({
  id: 'select.grow',
  label: 'Grow selection (one joint)',
  category: 'Select',
  icon: 'joint',
  description: 'Add the bodies joined directly to the selection',
  keywords: ['expand', 'neighbours', 'adjacent'],
  enabled: hasSelection,
  run: ({ app }) => report(app, growSelectionCmd(app), ''),
});
registerCommand({
  id: 'select.shrink',
  label: 'Shrink selection (one joint)',
  category: 'Select',
  icon: 'joint',
  description: 'Drop the selected bodies that are joined to something outside the selection',
  keywords: ['contract', 'erode', 'boundary'],
  enabled: hasSelection,
  run: ({ app }) => report(app, shrinkSelectionCmd(app), ''),
});

const MENU: [string, number][] = [
  ['select.invert', 360],
  ['select.groupChildren', 361],
  ['select.connected', 362],
  ['select.grow', 363],
  ['select.shrink', 364],
  ['panel.select-by', 365],
];
for (const [command, order] of MENU)
  registerMenuEntry({ id: `menu.edit.${command}`, menu: 'edit', group: 'select', order, command });

registerPanel({
  id: 'select-by',
  label: 'Select',
  icon: 'search',
  region: 'right',
  order: 45,
  title: 'Select by name, tag, kind, shape, layer or body type',
  build: (app) => buildSelectPanel(app),
});
