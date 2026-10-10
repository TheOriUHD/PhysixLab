// ── ED-A path (ED-23): the Path tool (P), the Path commands (reverse, close, respace, subdivide, simplify, flatten,
//    snap, remove point, path through selection), their Edit-menu entries and the "Path tools" inspector section ──
import {
  registerCommand,
  registerInspectorSection,
  registerMenuEntry,
  registerTool,
  type CommandDef,
} from '../../app/registry';
import {
  flattenPaths,
  hasEditablePath,
  pathThroughSelection,
  removeActivePoint,
  resamplePaths,
  reversePaths,
  simplifyPaths,
  snapPathsToGrid,
  subdividePaths,
  toggleClosed,
} from '../../app/edit/pathOps';
import { activatePathTool, PATH_TOOL, pathToolHint, pathToolPointerDown } from '../../app/edit/pathTool';
import { isPath, isPosed } from '../../model/types';
import { button, fmt, numberField, rowStack, section } from '../controls';
import { h } from '../dom';

// ── the tool ──
registerTool({
  id: PATH_TOOL,
  group: 'build',
  order: 65,
  label: 'Path tool',
  title: 'Draw and edit paths and splines — click points on the ground or a surface',
  icon: 'path',
  shortcut: 'P',
  keywords: ['spline', 'curve', 'track', 'rail', 'route', 'waypoint', 'draw'],
  activate: (app) => activatePathTool(app),
  isActive: (app) => app.prefs.value.tool === PATH_TOOL,
  pointerDown: (app, e, input) => pathToolPointerDown(app, e, input),
  hint: (app) => pathToolHint(app),
});

// ── commands ──
const idle = (app: { sim: { active: boolean } }): boolean => !app.sim.active;

const COMMANDS: CommandDef[] = [
  {
    id: 'path.reverse',
    label: 'Reverse path direction',
    category: 'Path',
    icon: 'path',
    description: 'Swap the start and the end: movers and cameras then travel the other way',
    keywords: ['flip', 'direction', 'spline'],
    enabled: hasEditablePath,
    run: ({ app }) => void reversePaths(app),
  },
  {
    id: 'path.toggleClosed',
    label: 'Close or open path loop',
    category: 'Path',
    icon: 'path',
    description: 'Connect the last point back to the first (needs three points)',
    keywords: ['loop', 'closed', 'circuit'],
    shortcut: 'Shift+C',
    enabled: hasEditablePath,
    run: ({ app }) => void toggleClosed(app),
  },
  {
    id: 'path.resample',
    label: 'Respace path points evenly',
    category: 'Path',
    icon: 'path',
    description: 'Redistribute the points at equal arc length along the curve (same count)',
    keywords: ['resample', 'smooth', 'equal', 'even'],
    enabled: hasEditablePath,
    run: ({ app }) => void resamplePaths(app),
  },
  {
    id: 'path.subdivide',
    label: 'Subdivide path',
    category: 'Path',
    icon: 'path',
    description: 'Add a point on the curve in the middle of every segment',
    keywords: ['denser', 'more points', 'split'],
    enabled: hasEditablePath,
    run: ({ app }) => void subdividePaths(app),
  },
  {
    id: 'path.simplify',
    label: 'Simplify path',
    category: 'Path',
    icon: 'path',
    description: 'Remove points that sit within 5 cm of the line through their neighbours',
    keywords: ['reduce', 'decimate', 'fewer points'],
    enabled: hasEditablePath,
    run: ({ app }) => void simplifyPaths(app),
  },
  {
    id: 'path.flatten',
    label: 'Flatten path to ground plane',
    category: 'Path',
    icon: 'path',
    description: 'Put every point at the same height just above the ground',
    keywords: ['level', 'horizontal', 'ground'],
    enabled: hasEditablePath,
    run: ({ app }) => void flattenPaths(app),
  },
  {
    id: 'path.snapGrid',
    label: 'Snap path points to grid',
    category: 'Path',
    icon: 'magnet',
    description: 'Round every point to the snap grid',
    keywords: ['align', 'round'],
    enabled: hasEditablePath,
    run: ({ app }) => void snapPathsToGrid(app),
  },
  {
    id: 'path.removePoint',
    label: 'Remove active path point',
    category: 'Path',
    icon: 'trash',
    description: 'Delete the control point the gizmo is on (Delete in the Path tool)',
    enabled: (app) => idle(app) && !!app.pathPoint,
    run: ({ app }) => void removeActivePoint(app),
  },
  {
    id: 'path.fromSelection',
    label: 'Path through selection',
    category: 'Path',
    icon: 'path',
    description: 'A new path through the selected objects, in the order they were selected',
    keywords: ['connect', 'route', 'waypoints', 'from selection'],
    enabled: (app) => idle(app) && app.store.selection.filter((id) => isPosed(app.store.get(id))).length >= 2,
    run: ({ app }) => void pathThroughSelection(app),
  },
];
for (const c of COMMANDS) registerCommand(c);

// ── menu (the Edit menu; path operations appear only while a path is selected) ──
const hasPathSelected = (app: { store: { selection: string[]; get: (id: string) => unknown } }): boolean =>
  app.store.selection.some((id) => isPath(app.store.get(id) as never));
let order = 500;
registerMenuEntry({
  id: 'menu.edit.pathFromSelection',
  menu: 'edit',
  group: 'path',
  order: order++,
  command: 'path.fromSelection',
});
for (const id of ['reverse', 'toggleClosed', 'resample', 'subdivide', 'simplify', 'flatten', 'snapGrid'])
  registerMenuEntry({
    id: `menu.edit.path.${id}`,
    menu: 'edit',
    group: 'path',
    order: order++,
    command: `path.${id}`,
    when: hasPathSelected,
  });

// ── inspector: operations for the selected path (the point list, closed, tension and colour are in the Path panel) ──
registerInspectorSection({
  id: 'path-tools',
  order: 110,
  appliesTo: (sel) => sel.length === 1 && isPath(sel[0]),
  build: (ctx, sel) => {
    const { app } = ctx;
    const id = sel[0].id;
    let count = 0;
    let tolerance = 0.05;
    const countField = numberField({
      step: 1,
      min: 2,
      max: 1024,
      digits: 0,
      onChange: (v) => (count = Math.round(v)),
      title: 'Number of points after respacing',
    });
    const tolField = numberField({
      step: 0.01,
      min: 0,
      max: 100,
      digits: 2,
      unit: 'm',
      value: tolerance,
      onChange: (v) => (tolerance = v),
      title: 'Points closer than this to the line through their neighbours are removed',
    });
    const status = h('span', { class: 'readout' });
    ctx.updaters.push(() => {
      const p = app.store.path(id);
      if (!p) return;
      status.textContent = app.sim.active
        ? 'Stop the simulation to edit'
        : p.locked
          ? 'Locked'
          : `${fmt(p.points.length, 0)} points`;
    });
    countField.set(app.store.path(id)?.points.length ?? 2);
    count = app.store.path(id)?.points.length ?? 2;
    const run = (fn: () => unknown) => () => void fn();
    return [
      section(
        'Path tools',
        [
          rowStack(
            'Draw',
            button('Path tool (P)', () => activatePathTool(app), {
              icon: 'path',
              title: 'Draw new paths, insert points by clicking the curve, move handles',
            }),
          ),
          rowStack(
            'Direction',
            h(
              'div',
              { class: 'ed-path-actions' },
              button(
                'Reverse',
                run(() => reversePaths(app)),
                { title: 'Swap start and end (Path › Reverse path direction)' },
              ),
              button(
                'Close / open',
                run(() => toggleClosed(app)),
                { title: 'Toggle the closed loop (Shift+C)' },
              ),
            ),
          ),
          rowStack(
            'Respace',
            h(
              'div',
              { class: 'ed-path-actions' },
              countField.el,
              button(
                'Apply',
                run(() => resamplePaths(app, count)),
                {
                  title: 'Redistribute N points at equal arc length along the curve',
                },
              ),
            ),
            'Resample the curve into N evenly spaced points',
          ),
          rowStack(
            'Simplify',
            h(
              'div',
              { class: 'ed-path-actions' },
              tolField.el,
              button(
                'Apply',
                run(() => simplifyPaths(app, tolerance)),
                {
                  title: 'Remove points within the tolerance of the line through their neighbours',
                },
              ),
            ),
            'Ramer–Douglas–Peucker over the control points',
          ),
          rowStack(
            'Shape',
            h(
              'div',
              { class: 'ed-path-actions' },
              button(
                'Subdivide',
                run(() => subdividePaths(app)),
                { title: 'Add a point in the middle of every segment' },
              ),
              button(
                'Flatten',
                run(() => flattenPaths(app)),
                { title: 'Put all points at the same height above the ground' },
              ),
              button(
                'Snap',
                run(() => snapPathsToGrid(app)),
                { title: 'Round the points to the snap grid' },
              ),
            ),
          ),
          status,
        ],
        { id: 'path-tools' },
      ),
    ];
  },
});
