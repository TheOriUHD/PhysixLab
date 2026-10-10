/**
 * The built-in commands that need no DOM: editing, simulation, camera and view, adding things, world presets and
 * the scene-file actions that only talk to the document. (Commands that open dialogs live in
 * `src/ui/builtin/commands.ts`.) Each is an ordinary `CommandDef` — exactly what a package would register — and the
 * keyboard, the menus, the toolbox and the command palette are generated from them.
 *
 * The order here is the order of the shortcut help within a category.
 */
import { Vector3 } from 'three';
import type { Vec3 } from '../../core/math';
import { GRAVITY_PRESETS } from '../../model/gravityPresets';
import { listShapes } from '../../model/shapeRegistry';
import { shapeKeywords } from '../../model/shapes/keywords'; // -- SH
import { COLOR_MODE_LABELS, type ColorMode } from '../../render/bodyViews';
import type { Quality } from '../../render/viewport';
import type { App } from '../app';
import { JOINT_ITEMS, LIGHT_ITEMS, SOFT_ITEMS } from '../addCatalog';
import { pasteClaimedSince } from '../pasteClaim';
import { lightPlaceable, pathPlaceable, shapePlaceable, softPlaceable } from '../placeables'; // -- ghost placement
import type { CommandDef } from '../registry/commands';
import { registerHelp } from '../registry/help';
import { jointCommands } from './jointCommands'; // -- JT-A

const sel = (app: App) => app.store.selection;
const hasSelection = (app: App) => sel(app).length > 0;

/** Toast the result of a keyboard / palette invocation; menu and button clicks show their own state. */
const quiet = (source: string) => source === 'menu';

// ── edit ──────────────────────────────────────────────────────────────────────────────────────────

function nudgeCommand(dir: 'forward' | 'back' | 'left' | 'right', key: string): CommandDef {
  return {
    id: `edit.nudge.${dir}`,
    label: `Nudge selection ${dir}`,
    category: 'Edit',
    shortcut: [key, `Shift+${key}`],
    palette: false,
    help: false,
    // Arrow keys keep their normal action (scrolling a panel) unless there is something to nudge.
    preventDefault: 'when-enabled',
    enabled: (app) => !app.sim.active && hasSelection(app),
    run: ({ app, event }) => {
      const step = event?.shiftKey ? 1 : app.prefs.value.snap ? app.prefs.value.snapGrid : 0.1;
      const f = app.camera.getWorldDirection(new Vector3());
      f.y = 0;
      f.normalize();
      const r = new Vector3().crossVectors(f, new Vector3(0, 1, 0));
      const d = dir === 'forward' ? f : dir === 'back' ? f.clone().negate() : dir === 'right' ? r : r.clone().negate();
      // snap the push direction to the dominant world axis
      const ax: Vec3 = Math.abs(d.x) > Math.abs(d.z) ? [Math.sign(d.x), 0, 0] : [0, 0, Math.sign(d.z)];
      app.editor.translate(sel(app), [ax[0] * step, 0, ax[2] * step]);
    },
  };
}

const editCommands: CommandDef[] = [
  {
    id: 'edit.undo',
    label: 'Undo',
    labelFor: (app) => (app.store.canUndo ? `Undo ${app.store.undoLabel}` : 'Undo'),
    category: 'Edit',
    icon: 'undo',
    shortcut: 'Mod+Z',
    enabled: (app) => app.store.canUndo,
    run: ({ app, source }) => {
      const label = app.store.undo();
      if (label && !quiet(source) && source !== 'button') app.toast(`Undo: ${label}`);
    },
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    labelFor: (app) => (app.store.canRedo ? `Redo ${app.store.redoLabel}` : 'Redo'),
    category: 'Edit',
    icon: 'redo',
    shortcut: ['Mod+Shift+Z', 'Mod+Y'],
    enabled: (app) => app.store.canRedo,
    run: ({ app, source }) => {
      const label = app.store.redo();
      if (label && !quiet(source) && source !== 'button') app.toast(`Redo: ${label}`);
    },
  },
  {
    id: 'edit.duplicate',
    label: 'Duplicate',
    category: 'Edit',
    icon: 'copy',
    description: 'Copy the selection, with the joints between the copied bodies',
    shortcut: 'Mod+D',
    enabled: hasSelection,
    run: ({ app }) => app.editor.duplicateSelection(),
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    category: 'Edit',
    shortcut: 'Mod+C',
    preventDefault: false,
    enabled: hasSelection,
    run: ({ app }) => app.editor.copy(),
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    category: 'Edit',
    shortcut: 'Mod+V',
    // -- UI-B: the browser's paste event must fire so a scene on the clipboard can be offered instead (qol/clipboard.ts) --
    preventDefault: false,
    run: ({ app, source }) => {
      if (source !== 'shortcut') return app.editor.paste();
      const t = performance.now();
      setTimeout(() => {
        if (!pasteClaimedSince(t)) app.editor.paste();
      }, 0);
    },
  },
  {
    id: 'edit.delete',
    label: 'Delete',
    category: 'Edit',
    icon: 'trash',
    shortcut: ['Delete', 'Backspace'],
    enabled: hasSelection,
    run: ({ app }) => app.editor.deleteSelection(),
  },
  {
    id: 'edit.selectAll',
    label: 'Select all',
    category: 'Edit',
    shortcut: 'Mod+A',
    run: ({ app }) => app.editor.selectAll(),
  },
  {
    id: 'edit.group',
    label: 'Group selection',
    category: 'Edit',
    icon: 'group',
    description: 'Fold the selection into a group that moves as one; with nothing selected, add an empty group',
    keywords: ['folder', 'parent'],
    shortcut: 'Mod+G',
    run: ({ app }) => app.addGroup(),
  },
  {
    id: 'edit.ungroup',
    label: 'Ungroup',
    category: 'Edit',
    shortcut: 'Mod+Shift+G',
    enabled: (app) => sel(app).some((id) => app.store.group(id)),
    run: ({ app }) => {
      app.editor.ungroup();
    },
  },
  {
    id: 'edit.rotate90',
    label: 'Rotate selection 90° about Y',
    category: 'Edit',
    enabled: (app) => hasSelection(app) && !app.sim.active,
    run: ({ app }) => app.editor.rotateSelection90(),
  },
  {
    id: 'edit.hide',
    label: 'Hide / show selection',
    category: 'Edit',
    icon: 'eye',
    shortcut: 'H',
    enabled: hasSelection,
    run: ({ app }) => app.editor.toggleFlag(sel(app), 'hidden'),
  },
  {
    id: 'edit.lock',
    label: 'Lock / unlock selection',
    category: 'Edit',
    icon: 'lock',
    description: 'Locked objects cannot be moved in the editor',
    shortcut: 'L',
    enabled: hasSelection,
    run: ({ app }) => app.editor.toggleFlag(sel(app), 'locked'),
  },
  {
    id: 'edit.cancel',
    label: 'Cancel tool / deselect',
    category: 'Edit',
    shortcut: 'Escape',
    palette: false,
    preventDefault: false,
    run: ({ app }) => {
      if (app.pathPoint) app.setPathPoint(null);
      else if (app.jointDraft) {
        app.cancelJointDraft();
        app.updateToolHint();
      } else if (app.prefs.value.tool !== 'select') app.setTool('select');
      else if (app.measure) app.clearMeasure();
      else app.store.setSelection([]);
    },
  },
  nudgeCommand('forward', 'ArrowUp'),
  nudgeCommand('back', 'ArrowDown'),
  nudgeCommand('left', 'ArrowLeft'),
  nudgeCommand('right', 'ArrowRight'),
  {
    id: 'edit.capture',
    label: 'Use current simulation state as the starting layout',
    category: 'Edit',
    description: 'Promote the live poses into the document, so Reset returns to this state',
    keywords: ['capture', 'keep'],
    enabled: (app) => app.sim.active,
    run: ({ app }) => {
      const n = app.editor.captureLivePose();
      app.toast(`Captured ${n} body poses. Reset now returns to this state.`, 'success');
    },
  },
];

// ── simulation ──────────────────────────────────────────────────────────────────────────────────

const simCommands: CommandDef[] = [
  {
    id: 'sim.toggle',
    label: 'Start / pause simulation',
    labelFor: (app) =>
      app.sim.mode === 'running' ? 'Pause simulation' : app.sim.mode === 'paused' ? 'Resume simulation' : 'Simulate',
    category: 'Simulation',
    icon: 'play',
    keywords: ['play', 'run', 'start', 'stop', 'pause'],
    shortcut: 'Space',
    run: ({ app }) => app.sim.toggle(),
  },
  {
    id: 'sim.reset',
    label: 'Stop and return to the editable layout',
    category: 'Simulation',
    icon: 'reset',
    keywords: ['reset', 'stop', 'rewind'],
    shortcut: 'Shift+Space',
    enabled: (app) => app.sim.mode !== 'edit',
    run: ({ app }) => app.sim.reset(),
  },
  {
    id: 'sim.step',
    label: 'Advance one physics step',
    category: 'Simulation',
    icon: 'step',
    keywords: ['single', 'frame'],
    shortcut: 'Period',
    run: ({ app }) => app.sim.step(1),
  },
];

// ── view and camera ─────────────────────────────────────────────────────────────────────────────

const SNAP_GRIDS = [0.05, 0.1, 0.25, 0.5, 1];
const TRAILS: readonly ('off' | 'selected' | 'all')[] = ['off', 'selected', 'all'];

function overlayToggle(
  key: 'velocity' | 'force' | 'contacts' | 'com' | 'stress',
  label: string,
  description: string,
  icon: string,
): CommandDef {
  return {
    id: `view.overlay.${key}`,
    label,
    description,
    category: 'View',
    icon,
    setting: true,
    keywords: ['overlay', 'show', 'hide'],
    checked: (app) => app.prefs.value.overlays[key],
    run: ({ app }) => app.prefs.setOverlay({ [key]: !app.prefs.value.overlays[key] }),
  };
}

const QUALITY_LABELS: Record<Quality, string> = {
  auto: 'Auto — adapts to GPU',
  low: 'Low — fastest',
  medium: 'Medium — shadows + FXAA',
  high: 'High — shadows + AO + bloom + MSAA',
  ultra: 'Ultra — reflections, shafts, blur',
};

/** Menu labels of the graphics-quality choices (the command labels are the palette-friendly short forms). */
export const QUALITY_MENU_LABELS = QUALITY_LABELS;

const viewCommands: CommandDef[] = [
  {
    id: 'view.frameSelection',
    label: 'Frame selection',
    category: 'Camera',
    icon: 'frame',
    description: 'Move the camera to look at the selection (everything when nothing is selected)',
    keywords: ['focus', 'zoom'],
    shortcut: ['F', 'NumpadDecimal'],
    run: ({ app }) => app.frameSelection(),
  },
  {
    id: 'view.frameAll',
    label: 'Frame everything',
    category: 'Camera',
    icon: 'frame',
    keywords: ['fit', 'zoom', 'home'],
    shortcut: 'Home',
    run: ({ app }) => app.frameAll(),
  },
  {
    id: 'view.follow',
    label: 'Camera follows selection',
    category: 'Camera',
    icon: 'follow',
    setting: true,
    shortcut: 'C',
    checked: (app) => app.prefs.value.followSelection,
    run: ({ app }) => app.prefs.set({ followSelection: !app.prefs.value.followSelection }),
  },
  {
    id: 'view.snap',
    label: 'Grid snapping',
    category: 'View',
    icon: 'magnet',
    setting: true,
    keywords: ['snap', 'grid'],
    shortcut: 'G',
    checked: (app) => app.prefs.value.snap,
    run: ({ app, source }) => {
      app.prefs.set({ snap: !app.prefs.value.snap });
      if (source === 'shortcut') app.toast(app.prefs.value.snap ? 'Snapping on' : 'Snapping off');
    },
  },
  {
    id: 'view.snapGrid',
    label: 'Snap grid size',
    labelFor: (app) => `Snap grid size: ${app.prefs.value.snapGrid} m`,
    category: 'View',
    setting: true,
    description: 'Cycle through 0.05, 0.1, 0.25, 0.5 and 1 m',
    keywords: ['snap', 'grid'],
    run: ({ app }) => {
      const i = SNAP_GRIDS.indexOf(app.prefs.value.snapGrid);
      app.prefs.set({ snapGrid: SNAP_GRIDS[(i + 1) % SNAP_GRIDS.length] });
    },
  },
  {
    id: 'view.space',
    label: 'Gizmo space: world / local',
    labelFor: (app) => `Gizmo space: ${app.prefs.value.space === 'world' ? 'World' : 'Local'}`,
    category: 'View',
    setting: true,
    keywords: ['transform', 'local', 'world'],
    shortcut: 'X',
    run: ({ app }) => app.prefs.set({ space: app.prefs.value.space === 'world' ? 'local' : 'world' }),
  },
  overlayToggle('velocity', 'Velocity vectors', 'Arrows showing how fast each body moves', 'velocity'),
  overlayToggle('force', 'Net force vectors', 'Arrows showing the net force m·Δv/Δt on each body', 'force'),
  overlayToggle('contacts', 'Contact points & forces', 'Where bodies touch, coloured by force', 'contact'),
  overlayToggle('com', 'Centres of mass', 'A marker at each body’s centre of mass', 'com'),
  // -- JT-B --
  overlayToggle(
    'stress',
    'Joint stress',
    'Colour joints green → red by the load they carry (against their break threshold, or the most loaded joint)',
    'joints',
  ),
  {
    id: 'view.overlay.trails',
    label: 'Motion trails',
    labelFor: (app) => `Motion trails: ${app.prefs.value.overlays.trails}`,
    category: 'View',
    icon: 'trail',
    setting: true,
    description: 'Cycle through no trails, trails of the selected bodies and trails of all bodies',
    keywords: ['overlay', 'path'],
    run: ({ app, source }) => {
      const t = app.prefs.value.overlays.trails;
      const next = TRAILS[(TRAILS.indexOf(t) + 1) % TRAILS.length];
      app.prefs.setOverlay({ trails: next });
      if (!quiet(source)) app.toast(`Trails: ${next}`);
    },
  },
  {
    id: 'view.joints',
    label: 'Show joints & constraints',
    category: 'View',
    icon: 'joints',
    setting: true,
    checked: (app) => app.prefs.value.showJoints,
    run: ({ app }) => app.prefs.set({ showJoints: !app.prefs.value.showJoints }),
  },
  ...(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((m): CommandDef => ({
    id: `view.color.${m}`,
    label: `Colour bodies by: ${COLOR_MODE_LABELS[m]}`,
    category: 'View',
    setting: true,
    keywords: ['color', 'heat map'],
    checked: (app) => app.prefs.value.colorMode === m,
    run: ({ app }) => app.prefs.set({ colorMode: m }),
  })),
  ...(['auto', 'low', 'medium', 'high', 'ultra'] as const).map((q): CommandDef => ({
    id: `view.quality.${q}`,
    label: `Graphics quality: ${q[0].toUpperCase()}${q.slice(1)}`,
    category: 'View',
    description: QUALITY_LABELS[q],
    setting: true,
    keywords: ['graphics', 'shadows', 'performance'],
    checked: (app) => app.prefs.value.quality === q,
    run: ({ app }) => app.prefs.set({ quality: q }),
  })),
  {
    id: 'view.panel.left',
    label: 'Library panel',
    category: 'View',
    icon: 'panelLeft',
    setting: true,
    description: 'Show or hide the Add / Prefabs / Maps / Scenes panel',
    checked: (app) => app.prefs.value.showLeft,
    run: ({ app }) => app.prefs.set({ showLeft: !app.prefs.value.showLeft }),
  },
  {
    id: 'view.panel.right',
    label: 'Inspector panel',
    category: 'View',
    icon: 'panelRight',
    setting: true,
    description: 'Show or hide the Inspector / Outliner / World panel',
    checked: (app) => app.prefs.value.showRight,
    run: ({ app }) => app.prefs.set({ showRight: !app.prefs.value.showRight }),
  },
  {
    id: 'view.panel.bottom',
    label: 'Telemetry dock',
    category: 'View',
    icon: 'panelBottom',
    setting: true,
    description: 'Show or hide the energy and selection charts',
    checked: (app) => app.prefs.value.showBottom,
    run: ({ app }) => app.prefs.set({ showBottom: !app.prefs.value.showBottom }),
  },
];

// ── world ───────────────────────────────────────────────────────────────────────────────────────

const worldCommands: CommandDef[] = GRAVITY_PRESETS.map((p): CommandDef => ({
  id: `world.gravity.${p.id}`,
  label: `Gravity: ${p.label}`,
  category: 'World',
  icon: 'zap',
  setting: true,
  keywords: ['gravity', 'planet', 'weightless', 'zero-g'],
  checked: (app) => {
    const g = app.store.settings.gravity;
    return g[0] === 0 && g[2] === 0 && Math.abs(-g[1] - p.g) < 1e-6;
  },
  run: ({ app }) => app.store.updateSettings({ gravity: [0, -p.g, 0] }, `Gravity: ${p.label}`),
}));

// ── file (document only) ─────────────────────────────────────────────────────────────────────────

const fileCommands: CommandDef[] = [
  {
    id: 'file.save',
    label: 'Save to library',
    category: 'File',
    icon: 'save',
    description: 'Keep a named copy of the scene in this browser',
    shortcut: 'Mod+S',
    run: ({ app }) => {
      const e = app.persistence.saveToLibrary();
      if (e) app.toast(`Saved “${e.name}” to your scene library`, 'success');
    },
  },
  {
    id: 'file.library',
    label: 'Open scene library…',
    category: 'File',
    icon: 'folder',
    keywords: ['scenes', 'saved', 'open'],
    run: ({ app }) => app.prefs.set({ leftTab: 'scenes', showLeft: true }),
  },
  {
    id: 'file.export',
    label: 'Export scene file…',
    category: 'File',
    icon: 'download',
    keywords: ['download', 'json'],
    run: ({ app }) => app.persistence.exportFile(),
  },
];

// ── add ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * "Add Box", "Add Jelly", "Add Spot light", "Joint tool: Hinge" … generated from the shape registry and the add
 * catalogue. The first nine shapes also answer to the 1–9 keys (the palette order is the registry order).
 */
function addCommands(): CommandDef[] {
  const out: CommandDef[] = [];
  listShapes().forEach((def, i) => {
    out.push({
      id: `add.shape.${def.id}`,
      label: `Add ${def.label}`,
      category: 'Add',
      icon: def.icon,
      description: def.blurb,
      keywords: ['new', 'create', 'shape', 'body', ...shapeKeywords(def)], // -- SH: the palette's search words too
      shortcut: i < 9 ? String(i + 1) : undefined,
      help: false,
      // -- ghost placement: the number keys and the palette arm a ghost that follows the pointer (placementGhost.ts);
      // programmatic calls (`api`) still add at the view centre at once
      run: ({ app, source }) => {
        if (source === 'api') app.addShape(def.id);
        else app.placement.ghost.arm(shapePlaceable(def.id));
      },
    });
  });
  for (const s of SOFT_ITEMS)
    out.push({
      id: `add.soft.${s.type}`,
      label: `Add ${s.label}`,
      category: 'Add',
      icon: s.icon,
      description: s.blurb,
      keywords: ['new', 'create', 'soft body', 'deformable'],
      run: ({ app, source }) =>
        source === 'api' ? app.addSoft(s.type) : app.placement.ghost.arm(softPlaceable(s.type)),
    });
  for (const l of LIGHT_ITEMS)
    out.push({
      id: `add.light.${l.type}`,
      label: `Add ${l.label} light`,
      category: 'Add',
      icon: l.icon,
      description: l.blurb,
      keywords: ['new', 'create', 'lamp'],
      run: ({ app, source }) =>
        source === 'api' ? app.addLight(l.type) : app.placement.ghost.arm(lightPlaceable(l.type)),
    });
  out.push({
    id: 'add.path',
    label: 'Add Path',
    category: 'Add',
    icon: 'path',
    description: 'A spline through points — a track for movers and cameras',
    keywords: ['new', 'create', 'spline', 'track'],
    run: ({ app, source }) => (source === 'api' ? app.addPath() : app.placement.ghost.arm(pathPlaceable())),
  });
  for (const j of JOINT_ITEMS)
    out.push({
      id: `add.joint.${j.type}`,
      label: `Joint tool: ${j.label}`,
      category: 'Add',
      icon: j.icon,
      description: `${j.blurb}. Then click two bodies in the scene.`,
      keywords: ['connect', 'constraint', 'joint'],
      checked: (app) => app.prefs.value.tool === 'joint' && app.prefs.value.jointType === j.type,
      run: ({ app }) => app.startJointTool(j.type),
    });
  return out;
}

/** Everything registered at start-up, in help order. Call once. */
export function builtinCommands(): CommandDef[] {
  return [
    ...simCommands,
    ...editCommands,
    ...addCommands(),
    ...viewCommands,
    ...worldCommands,
    ...fileCommands,
    ...jointCommands,
  ];
}

/** Help rows for what is not a command: pointer gestures and the number keys. */
export function registerBuiltinHelp(): (() => void)[] {
  const n = Math.min(9, listShapes().length);
  const rows: [string, string, string, string][] = [
    ['gesture.throw', 'Simulation', 'Throw a body while running', 'Drag'],
    ['gesture.drive', 'Simulation', 'Drive / actuate', 'Bound motor keys'],
    ['gesture.select', 'Edit', 'Select / add to selection', 'Click · Shift Click'],
    ['gesture.box', 'Edit', 'Box select', 'Drag on empty space'],
    ['gesture.vertical', 'Edit', 'Vertical drag-move', 'Shift drag'],
    ['gesture.nudge', 'Edit', 'Nudge selection (1 m with Shift)', 'Arrow keys'],
    ['gesture.addAtView', 'Add', 'Pick a shape, then click where it goes', `1 – ${n}`],
    // -- ghost placement --
    ['gesture.placeDrag', 'Add', 'Drag a tile into the scene (a ghost shows where it lands)', 'Drag · Esc cancels'],
    ['gesture.placeKeys', 'Add', 'While placing: turn · lower / raise · align · no snap', 'Q E R · [ ] · X · Alt'],
    ['gesture.placeMany', 'Add', 'Place several in a row', 'Shift Click'],
    ['gesture.orbit', 'Camera', 'Orbit', 'Right drag · Alt drag'],
    ['gesture.pan', 'Camera', 'Pan', 'Middle drag · Shift Right drag'],
    ['gesture.zoom', 'Camera', 'Zoom', 'Scroll'],
    ['gesture.frame', 'Camera', 'Frame the object under the pointer', 'Double-click'],
  ];
  return rows.map(([id, group, label, keys], i) => registerHelp({ id, group, label, keys, order: i }));
}
