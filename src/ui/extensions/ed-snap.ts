/**
 * ED-14 / ED-15 registrations: the snap switches as commands (palette, View menu, the "Snap" popover of the toolbox)
 * and rotate-by-angle commands. The behaviour lives in `src/app/edit/` (snapDrag, surfaceDrop, transformEntry) and the
 * pure logic in `src/model/edit/` (snap, expression, rotateBy).
 */
import { openMenu } from '../menu';
import { registerCommand, registerMenu, registerMenuEntry, registerTool, resolveMenu } from '../../app/registry';
import { rotateSelectionBy } from '../../app/edit/transformEntry';
import type { Prefs } from '../../app/prefs';
import type { App } from '../../app/app';

type SnapPref = 'snapVertex' | 'snapEdge' | 'snapFace' | 'snapBounds' | 'snapSurface' | 'snapAlignNormal';

const SWITCHES: { pref: SnapPref; id: string; label: string; description: string; keywords: string[] }[] = [
  {
    pref: 'snapVertex',
    id: 'view.snapVertex',
    label: 'Snap to vertices',
    description: 'While dragging, corners of the moved objects snap onto the corners of nearby objects',
    keywords: ['corner', 'point'],
  },
  {
    pref: 'snapEdge',
    id: 'view.snapEdge',
    label: 'Snap to edge midpoints',
    description: 'While dragging, snap to the middle of an edge of a nearby object',
    keywords: ['middle', 'midpoint', 'edge'],
  },
  {
    pref: 'snapFace',
    id: 'view.snapFace',
    label: 'Snap to face centres',
    description: 'While dragging, snap to the centre of a face of a nearby object',
    keywords: ['centre', 'center', 'face'],
  },
  {
    pref: 'snapBounds',
    id: 'view.snapBounds',
    label: 'Snap to object bounds',
    description: 'While dragging, snap to the corners, face centres and centre of other objects’ bounding boxes',
    keywords: ['bounding box', 'aabb', 'bounds'],
  },
  {
    pref: 'snapSurface',
    id: 'view.snapSurface',
    label: 'Snap to surfaces',
    description: 'Dragging or dropping puts the object flush on the surface under the pointer',
    keywords: ['surface', 'flush', 'place', 'drop', 'slope'],
  },
  {
    pref: 'snapAlignNormal',
    id: 'view.snapAlignNormal',
    label: 'Align to surface normal',
    description: 'With surface snapping, also turn the object so its up axis follows the surface normal',
    keywords: ['normal', 'align', 'orient', 'tilt'],
  },
];

for (const s of SWITCHES) {
  registerCommand({
    id: s.id,
    label: s.label,
    category: 'View',
    icon: 'magnet',
    description: s.description,
    keywords: ['snap', ...s.keywords],
    setting: true,
    checked: (app) => app.prefs.value[s.pref as keyof Prefs] === true,
    run: ({ app }) => app.prefs.set({ [s.pref]: !app.prefs.value[s.pref] }),
  });
}

registerMenu({ id: 'snap', label: 'Snap', order: 900, bar: false });
registerMenuEntry({
  id: 'menu.snap.grid',
  menu: 'snap',
  group: 'grid',
  order: 10,
  command: 'view.snap',
  label: 'Grid',
});
registerMenuEntry({ id: 'menu.snap.gridSize', menu: 'snap', group: 'grid', order: 20, command: 'view.snapGrid' });
registerMenuEntry({ id: 'menu.snap.objHead', menu: 'snap', group: 'objects', order: 30, heading: 'Other objects' });
SWITCHES.slice(0, 4).forEach((s, i) =>
  registerMenuEntry({ id: `menu.snap.${s.pref}`, menu: 'snap', group: 'objects', order: 40 + i, command: s.id }),
);
registerMenuEntry({ id: 'menu.snap.surfHead', menu: 'snap', group: 'surface', order: 60, heading: 'Surfaces' });
SWITCHES.slice(4).forEach((s, i) =>
  registerMenuEntry({ id: `menu.snap.${s.pref}`, menu: 'snap', group: 'surface', order: 70 + i, command: s.id }),
);
// The same switches in the View menu, after the overlays.
registerMenuEntry({ id: 'menu.view.snapHeading', menu: 'view', group: 'snapping', order: 300, heading: 'Snapping' });
registerMenuEntry({ id: 'menu.view.snapGrid', menu: 'view', group: 'snapping', order: 310, command: 'view.snap' });
SWITCHES.forEach((s, i) =>
  registerMenuEntry({ id: `menu.view.${s.pref}`, menu: 'view', group: 'snapping', order: 320 + i, command: s.id }),
);

/** How many object / surface snaps are on, for the toolbox chip. */
const activeCount = (app: App): number => {
  const p = app.prefs.value;
  return [p.snapVertex, p.snapEdge, p.snapFace, p.snapBounds, p.snapSurface].filter(Boolean).length;
};

// One compact "Snap" chip in the view bar (the toolbox column is full) opens the popover with every switch (the toolbox stays short).
registerTool({
  id: 'snapMenu',
  region: 'viewbar',
  group: 'snapping',
  order: 5,
  icon: 'magnet',
  label: 'Snap options',
  title: 'Snap modes: grid, vertices, edges, faces, bounds, surfaces (hold Ctrl while dragging to invert)',
  shortcut: 'Shift+G',
  category: 'View',
  keywords: ['snap', 'vertex', 'surface', 'magnet'],
  text: () => 'Snap',
  isActive: (app) => activeCount(app) > 0,
  activate: (app) => {
    const anchor = document.querySelector<HTMLElement>('[data-tool="snapMenu"]');
    const items = resolveMenu(app, 'snap');
    openMenu(items, anchor ?? { x: 60, y: 120 });
  },
  hint: () => null,
});

// Rotate the selection by the snap angle about an axis (undoable as one step).
for (const [axis, name] of [
  [0, 'X'],
  [1, 'Y'],
  [2, 'Z'],
] as const) {
  registerCommand({
    id: `edit.rotateBy${name}`,
    label: `Rotate selection about ${name}`,
    labelFor: (app) => `Rotate selection ${app.prefs.value.snapAngle}° about ${name}`,
    category: 'Edit',
    icon: 'rotate',
    description: `Turn the selection by the snap angle about the ${name} axis (world or local, as the gizmo space); Rotate by in the inspector takes any angle`,
    keywords: ['rotate', 'turn', 'angle', name.toLowerCase()],
    enabled: (app) => app.store.selection.length > 0,
    run: ({ app }) => {
      if (!rotateSelectionBy(app, app.store.selection, axis, app.prefs.value.snapAngle)) {
        app.toast('Nothing to rotate (locked, hidden or empty)', 'warn');
      }
    },
  });
  registerMenuEntry({
    id: `menu.edit.rotateBy${name}`,
    menu: 'edit',
    group: 'select',
    order: 340 + axis,
    command: `edit.rotateBy${name}`,
  });
}
