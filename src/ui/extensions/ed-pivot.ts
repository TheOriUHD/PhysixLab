// ── ED-A arrange: pivot editing — pivot mode, 3D cursor, rotate about axis, group pivots ──
import { cursorToOrigin, cursorToSelection, setGroupPivot } from '../../app/edit/arrangeOps';
import { pivotState, setCursor, setGroupPivotOnly } from '../../app/edit/pivotState';
import { registerCommand, registerMenuEntry, registerTool } from '../../app/registry';
import type { App } from '../../app/app';
import { PIVOT_MODES, type GroupPivotTarget, type PivotMode } from '../../model/edit/pivot';
import { openRotateAxisDialog, openScaleAboutDialog } from '../arrangeDialogs';

const CATEGORY = 'Arrange';
const editable = (app: App) => !app.sim.active;
const hasSelection = (app: App) => !app.sim.active && app.store.selection.length > 0;

// ── pivot mode (a preference; the gizmo, the Arrange panel and the dialogs read it) ──
const SHORT = Object.fromEntries(PIVOT_MODES.map((m) => [m.id, m.short])) as Record<PivotMode, string>;
for (const m of PIVOT_MODES) {
  registerCommand({
    id: `pivot.mode.${m.id}`,
    label: `Pivot: ${m.label}`,
    category: CATEGORY,
    icon: 'rotate',
    setting: true,
    description: `${m.hint}. Gizmo rotations and scales (and the Rotate / Scale about dialogs) are centred there.`,
    keywords: ['pivot', 'transform around', 'origin', 'median', m.id],
    checked: (app) => app.prefs.value.pivotMode === m.id,
    run: ({ app }) => app.prefs.set({ pivotMode: m.id }),
  });
}
registerCommand({
  id: 'pivot.cycle',
  label: 'Cycle pivot mode',
  category: CATEGORY,
  icon: 'rotate',
  description: 'Next transform pivot: selection centre, bounds centre, 3D cursor, individual origins, group pivot',
  keywords: ['pivot', 'transform around'],
  shortcut: 'Shift+P',
  labelFor: (app) => `Pivot mode: ${SHORT[app.prefs.value.pivotMode]}`,
  run: ({ app }) => {
    const i = PIVOT_MODES.findIndex((m) => m.id === app.prefs.value.pivotMode);
    const next = PIVOT_MODES[(i + 1) % PIVOT_MODES.length];
    app.prefs.set({ pivotMode: next.id });
    app.toast(`Pivot: ${next.label}`, 'info');
  },
});
registerTool({
  id: 'pivot',
  group: 'options',
  order: 120,
  icon: 'rotate',
  command: 'pivot.cycle',
  title: 'Transform pivot (rotate / scale about…) — click to cycle',
  text: (app) => SHORT[app.prefs.value.pivotMode],
});

// ── 3D cursor ──
registerTool({
  id: 'cursor3d',
  group: 'pivot',
  order: 85,
  label: '3D cursor',
  title: 'Place the 3D cursor on a surface (rotate / scale about it with Pivot: 3D cursor)',
  icon: 'com',
  shortcut: 'Shift+O',
  keywords: ['pivot', 'cursor', 'place'],
  category: 'Arrange',
  activate: (app) => app.setTool('cursor3d'),
  isActive: (app) => app.prefs.value.tool === 'cursor3d',
  pointerDown: (app, e) => {
    const hit = app.pickEntity(e, { joints: false });
    const p = hit?.point ?? app.picker.groundPoint(e, 0);
    if (!p) return;
    setCursor([p.x, p.y, p.z]);
    app.gizmos.refresh();
    app.effects.ping(p);
    app.toast(`3D cursor at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`, 'info');
    if (!e.shiftKey) app.setTool('select');
  },
  hint: () => 'Click a surface to place the 3D cursor · hold <kbd>Shift</kbd> to keep placing',
});
registerCommand({
  id: 'pivot.cursor.toSelection',
  label: '3D cursor to selection',
  category: CATEGORY,
  icon: 'com',
  description: 'Put the 3D cursor at the centre of the selection’s bounds',
  keywords: ['pivot', 'cursor'],
  run: ({ app }) => cursorToSelection(app),
});
registerCommand({
  id: 'pivot.cursor.toOrigin',
  label: '3D cursor to world origin',
  category: CATEGORY,
  icon: 'com',
  description: 'Reset the 3D cursor to 0, 0, 0',
  keywords: ['pivot', 'cursor', 'reset'],
  run: ({ app }) => cursorToOrigin(app),
});

// ── numeric operations about the pivot ──
registerCommand({
  id: 'pivot.rotateAxis',
  label: 'Rotate about axis…',
  category: CATEGORY,
  icon: 'rotate',
  description: 'Rotate the selection by an angle about X, Y, Z or any axis through the current pivot',
  keywords: ['rotate', 'axis', 'angle', 'around', 'pivot', 'turn'],
  enabled: hasSelection,
  run: ({ app }) => openRotateAxisDialog(app),
});
registerCommand({
  id: 'pivot.scaleAbout',
  label: 'Scale about pivot…',
  category: CATEGORY,
  icon: 'scale',
  description: 'Scale the selection (positions and sizes) about the current pivot',
  keywords: ['scale', 'resize', 'around', 'pivot', 'grow', 'shrink'],
  enabled: hasSelection,
  run: ({ app }) => openScaleAboutDialog(app),
});

// ── custom pivot per group ──
const GROUP_TARGETS: [GroupPivotTarget, string, string][] = [
  ['centre', 'Group pivot to members’ centre', 'Median of the members’ origins'],
  ['bounds', 'Group pivot to bounds centre', 'Centre of the members’ bounding box'],
  ['bottom', 'Group pivot to bounds bottom', 'Bottom centre of the members’ bounding box'],
  ['cursor', 'Group pivot to 3D cursor', 'Where the 3D cursor is'],
  ['origin', 'Group pivot to world origin', '0, 0, 0'],
];
for (const [target, label, what] of GROUP_TARGETS) {
  registerCommand({
    id: `pivot.group.${target}`,
    label,
    category: CATEGORY,
    icon: 'group',
    description: `${what}. The members stay where they are; later moves, turns and scales of the group centre on the new pivot.`,
    keywords: ['group', 'pivot', 'origin', 'set origin'],
    enabled: (app) => editable(app) && app.store.selection.some((id) => !!app.store.group(id)),
    run: ({ app }) => void setGroupPivot(app, target),
  });
}
registerCommand({
  id: 'pivot.group.resetRotation',
  label: 'Group pivot: straighten to world axes',
  category: CATEGORY,
  icon: 'group',
  description: 'Reset the selected groups’ pivot orientation to the world axes (members stay where they are)',
  keywords: ['group', 'pivot', 'rotation', 'reset'],
  enabled: (app) => editable(app) && app.store.selection.some((id) => !!app.store.group(id)),
  run: ({ app }) => {
    const groups = app.store.selection.filter((id) => app.store.group(id));
    app.store.updateMany(
      groups.map((id) => [id, { rotation: [0, 0, 0, 1] }]),
      'Set group pivot',
    );
  },
});
registerCommand({
  id: 'pivot.groupOnly',
  label: 'Edit group pivot only',
  category: CATEGORY,
  icon: 'group',
  setting: true,
  description:
    'While on, dragging a selected group with the gizmo moves or turns only its pivot; the members stay where they are',
  keywords: ['group', 'pivot', 'origin', 'move origin only'],
  checked: () => pivotState.groupPivotOnly,
  run: ({ app }) => {
    setGroupPivotOnly(!pivotState.groupPivotOnly);
    app.toast(
      pivotState.groupPivotOnly ? 'Gizmo edits only the group pivot' : 'Gizmo moves groups with their members',
      'info',
    );
  },
});

[
  'pivot.cycle',
  'pivot.rotateAxis',
  'pivot.scaleAbout',
  'tool.cursor3d',
  'pivot.cursor.toSelection',
  'pivot.groupOnly',
].forEach((command, i) =>
  registerMenuEntry({ id: `menu.edit.${command}`, menu: 'edit', group: 'arrange', order: 600 + i * 10, command }),
);
