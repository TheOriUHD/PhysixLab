/**
 * App-level arrange / pivot operations: read the selection from the store, ask the pure builders in
 * `src/model/edit/` for patches and apply them as ONE undo step. They refuse while a simulation is live (poses then
 * belong to the engine), skip locked and hidden objects, and tell the user when there was nothing to change.
 */
import { DEG, vnorm, type Vec3 } from '../../core/math';
import {
  alignPatches,
  centreOnOriginPatches,
  DEFAULT_RANDOMISE,
  distributePatches,
  dropOntoSurfacePatches,
  dropToGroundPatches,
  randomisePatches,
  stackPatches,
  type AlignMode,
  type AlignTarget,
  type Axis,
  type RandomiseOptions,
} from '../../model/edit/arrange';
import { selectionBounds, aabbCentre } from '../../model/edit/bounds';
import { editableRoots, type Patch } from '../../model/edit/moves';
import {
  groupPivotPatches,
  rotateAboutPatches,
  scaleAboutPatches,
  type GroupPivotTarget,
  type PivotSpec,
} from '../../model/edit/pivot';
import type { Entity } from '../../model/types';
import type { App } from '../app';
import { pivotState, setCursor } from './pivotState';

/** Settings the Arrange panel edits and the commands reuse. */
export const arrangeSettings: {
  stackGap: number;
  stackOrder: 'selection' | 'height';
  stackCentre: boolean;
  alignTarget: AlignTarget;
  randomise: RandomiseOptions;
} = {
  stackGap: 0,
  stackOrder: 'selection',
  stackCentre: true,
  alignTarget: 'selection',
  randomise: {
    ...DEFAULT_RANDOMISE,
    position: [0.5, 0, 0.5],
    rotation: [0, 180, 0],
    scale: { min: [0.8, 0.8, 0.8], max: [1.25, 1.25, 1.25], uniform: true },
    seed: 1,
  },
};

type Build = (entities: readonly Entity[], ids: readonly string[]) => Patch[];

/** Run a patch builder on the selection as one undo step. Returns the number of entities changed. */
export function runArrange(app: App, label: string, build: Build, quiet = false): number {
  if (app.sim.active) {
    app.toast('Stop the simulation (Reset) to arrange objects', 'warn');
    return 0;
  }
  const ids = [...app.store.selection];
  if (!ids.length) {
    app.toast('Select something to arrange first', 'info');
    return 0;
  }
  const entities = app.store.all();
  if (!editableRoots(entities, ids).length) {
    app.toast('Everything selected is locked or hidden', 'warn');
    return 0;
  }
  const patches = build(entities, ids);
  const before = app.store.revision;
  app.store.updateMany(patches, label);
  const changed = app.store.revision !== before ? patches.length : 0;
  if (!changed && !quiet) app.toast(`${label}: nothing to change`, 'info');
  return changed;
}

const AXIS_NAME = ['X', 'Y', 'Z'] as const;
const MODE_NAME: Record<AlignMode, string> = { min: 'min', centre: 'centre', max: 'max' };

export function alignSelection(
  app: App,
  axis: Axis,
  mode: AlignMode,
  target: AlignTarget = arrangeSettings.alignTarget,
) {
  const active = app.store.selection[app.store.selection.length - 1];
  return runArrange(
    app,
    `Align ${AXIS_NAME[axis]} ${MODE_NAME[mode]}${target === 'active' ? ' to active' : ''}`,
    (es, ids) => alignPatches(es, ids, axis, mode, target, active),
  );
}

export function distributeSelection(app: App, axis: Axis, mode: 'spacing' | 'gaps') {
  if (app.store.selection.length < 3) {
    app.toast('Distribute needs three or more objects', 'info');
    return 0;
  }
  return runArrange(
    app,
    `Distribute ${AXIS_NAME[axis]} (${mode === 'gaps' ? 'even gaps' : 'even spacing'})`,
    (es, ids) => distributePatches(es, ids, axis, mode),
  );
}

function groundOptions(app: App) {
  const g = app.store.settings.ground;
  return { ground: g.enabled, groundY: 0 };
}

export function dropSelectionToGround(app: App) {
  if (!app.store.settings.ground.enabled) {
    app.toast('The ground is switched off in the World panel', 'warn');
    return 0;
  }
  return runArrange(app, 'Drop to ground', (es, ids) => dropToGroundPatches(es, ids, groundOptions(app)));
}

export function dropSelectionOntoSurface(app: App) {
  return runArrange(app, 'Drop onto surface', (es, ids) => dropOntoSurfacePatches(es, ids, groundOptions(app)));
}

export function stackSelection(app: App) {
  if (app.store.selection.length < 2) {
    app.toast('Stack needs two or more objects', 'info');
    return 0;
  }
  const s = arrangeSettings;
  return runArrange(app, 'Stack', (es, ids) =>
    stackPatches(es, ids, { gap: s.stackGap, order: s.stackOrder, centreXZ: s.stackCentre }),
  );
}

export function centreSelectionOnOrigin(app: App, axes: readonly [boolean, boolean, boolean] = [true, true, true]) {
  return runArrange(app, 'Centre on origin', (es, ids) => centreOnOriginPatches(es, ids, axes));
}

let lastRandomise = -1;

/** Randomise the selection with the panel's ranges; `reroll` first takes back the previous randomise with a new seed. */
export function randomiseSelection(app: App, reroll = false): number {
  const s = arrangeSettings.randomise;
  if (reroll) {
    s.seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    if (app.store.revision === lastRandomise && app.store.undoLabel === 'Randomise') app.store.undo();
  }
  const n = runArrange(app, 'Randomise', (es, ids) => randomisePatches(es, ids, { ...s }));
  lastRandomise = app.store.revision;
  return n;
}

// ── pivot ───────────────────────────────────────────────────────────────────────────────────────────

export function pivotSpec(app: App): PivotSpec {
  return { mode: app.prefs.value.pivotMode, cursor: pivotState.cursor };
}

/** Rotate the selection `angleDeg` about an axis through the current pivot (world axis, or the active object's local axis). */
export function rotateSelectionAbout(app: App, axis: Vec3, angleDeg: number, space: 'world' | 'local' = 'world') {
  if (Math.hypot(...axis) < 1e-9) {
    app.toast('The rotation axis must not be zero', 'warn');
    return 0;
  }
  const active = app.store.selection[app.store.selection.length - 1];
  return runArrange(app, 'Rotate about axis', (es, ids) =>
    rotateAboutPatches(es, ids, {
      axis: vnorm(axis),
      angle: angleDeg * DEG,
      space,
      pivot: pivotSpec(app),
      activeId: active,
    }),
  );
}

export function scaleSelectionAbout(app: App, factor: Vec3) {
  return runArrange(app, 'Scale about pivot', (es, ids) =>
    scaleAboutPatches(es, ids, { factor, pivot: pivotSpec(app) }),
  );
}

/** Put the 3D cursor at the centre of the selection's bounds (the world origin with nothing selected). */
export function cursorToSelection(app: App): void {
  const box = selectionBounds(app.store.all(), app.store.selection);
  setCursor(box ? aabbCentre(box) : [0, 0, 0]);
  app.gizmos.refresh();
}

export function cursorToOrigin(app: App): void {
  setCursor([0, 0, 0]);
  app.gizmos.refresh();
}

/** Re-pivot the selected groups (members stay put). */
export function setGroupPivot(app: App, target: GroupPivotTarget, resetRotation = false): number {
  const groups = app.store.selection.filter((id) => app.store.group(id));
  if (!groups.length) {
    app.toast('Select a group to edit its pivot', 'info');
    return 0;
  }
  return runArrange(app, 'Set group pivot', (es) =>
    groups.flatMap((g) => groupPivotPatches(es, g, target, pivotState.cursor, resetRotation)),
  );
}
