/**
 * The built-in tools: the toolbox (select / move / rotate / scale, joint, measure, blast, fire projectiles, then the
 * snapping options) and the view bar (overlay toggles, joints, follow, frame). The interaction tools keep their
 * pointer behaviour in `InputController`; this module only declares them to the registry, which is what the
 * toolbox, the keyboard, the palette and the pointer dispatch read.
 */
import type { App } from '../app';
import type { ToolDef } from '../registry/tools';

const selectMode = (app: App, gizmo: 'none' | 'translate' | 'rotate' | 'scale') => {
  const p = app.prefs.value;
  return p.tool === 'select' && p.gizmo === gizmo;
};

export const BUILTIN_TOOLS: readonly ToolDef[] = [
  // ── transform ──
  {
    id: 'select',
    group: 'transform',
    order: 10,
    label: 'Select',
    title: 'Select',
    icon: 'select',
    shortcut: 'Q',
    mode: 'select',
    activate: (app) => app.setGizmo('none'),
    isActive: (app) => selectMode(app, 'none'),
    pointerDown: (_app, e, input) => input.downSelect(e),
    hint: (app) =>
      app.sim.active
        ? '<b>Drag</b> a body to throw it · <b>Scroll</b> pushes / pulls it · <kbd>Q</kbd><kbd>E</kbd> spin · <kbd>R</kbd>+drag turn · <kbd>F</kbd> freeze'
        : null,
  },
  {
    id: 'move',
    group: 'transform',
    order: 20,
    label: 'Move',
    title: 'Move',
    icon: 'move',
    shortcut: 'W',
    mode: 'select',
    activate: (app) => app.setGizmo('translate'),
    isActive: (app) => selectMode(app, 'translate'),
  },
  {
    id: 'rotate',
    group: 'transform',
    order: 30,
    label: 'Rotate',
    title: 'Rotate',
    icon: 'rotate',
    shortcut: 'E',
    mode: 'select',
    activate: (app) => app.setGizmo('rotate'),
    isActive: (app) => selectMode(app, 'rotate'),
  },
  {
    id: 'scale',
    group: 'transform',
    order: 40,
    label: 'Scale',
    title: 'Scale (resize)',
    icon: 'scale',
    shortcut: 'R',
    mode: 'select',
    activate: (app) => app.setGizmo('scale'),
    isActive: (app) => selectMode(app, 'scale'),
  },
  // ── build ──
  {
    id: 'joint',
    group: 'build',
    order: 50,
    label: 'Joint tool',
    title: 'Connect with a joint — click two bodies',
    icon: 'joint',
    shortcut: 'J',
    keywords: ['connect', 'constraint'],
    activate: (app) => app.setTool('joint'),
    isActive: (app) => app.prefs.value.tool === 'joint',
    pointerDown: (_app, e, input) => input.downJoint(e),
    hint: (app) => `<b>${app.prefs.value.jointType}</b> — click the first body (or the ground to pin it to the world)`,
  },
  {
    id: 'measure',
    group: 'build',
    order: 60,
    label: 'Measure distance',
    title: 'Measure distance',
    icon: 'measure',
    shortcut: 'M',
    keywords: ['ruler', 'length'],
    activate: (app) => app.setTool('measure'),
    isActive: (app) => app.prefs.value.tool === 'measure',
    pointerDown: (_app, e, input) => input.downMeasure(e),
    hint: () => 'Click two points to measure the distance between them',
  },
  // ── interact (while simulating) ──
  {
    id: 'blast',
    group: 'interact',
    order: 70,
    label: 'Blast tool',
    title: 'Blast — explosion, directional, implosion, shockwave ring or gust (while simulating)',
    icon: 'blast',
    shortcut: 'B',
    keywords: ['explosion', 'explode'],
    activate: (app) => app.setTool('blast'),
    isActive: (app) => app.prefs.value.tool === 'blast',
    pointerDown: (_app, e, input) => input.downBlast(e),
    hint: (app) =>
      app.sim.active
        ? `Click anywhere to set off a blast (${app.prefs.value.blastKind}) · change kind, falloff and radius in the bar below`
        : 'Start the simulation, then click to set off blasts',
  },
  {
    id: 'shoot',
    group: 'interact',
    order: 80,
    label: 'Fire projectiles',
    title: 'Throw / aim — fire projectiles with a trajectory preview (while simulating)',
    icon: 'shoot',
    shortcut: 'T',
    keywords: ['shoot', 'ball', 'cannon', 'throw', 'aim', 'trajectory', 'projectile'],
    activate: (app) => app.setTool('shoot'),
    isActive: (app) => app.prefs.value.tool === 'shoot',
    pointerDown: (_app, e, input) => input.downShoot(e),
    hint: (app) =>
      app.sim.active
        ? '<b>Click</b> to fire along the view ray · <b>hold</b> to charge power and see the predicted path'
        : 'Start the simulation, then click to fire (hold to preview the path)',
  },
  // ── options ──
  { id: 'snap', group: 'options', order: 90, icon: 'magnet', command: 'view.snap', title: 'Grid snapping' },
  {
    id: 'snapGrid',
    group: 'options',
    order: 100,
    icon: 'magnet',
    command: 'view.snapGrid',
    title: 'Snap grid size — click to cycle',
    text: (app) => `${app.prefs.value.snapGrid}`,
    isActive: (app) => app.prefs.value.snap,
  },
  {
    id: 'space',
    group: 'options',
    order: 110,
    icon: 'move',
    command: 'view.space',
    title: 'Gizmo space: world / local',
    text: (app) => (app.prefs.value.space === 'world' ? 'World' : 'Local'),
  },

  // ── view bar ──
  {
    id: 'viewVelocity',
    region: 'viewbar',
    group: 'overlays',
    order: 10,
    icon: 'velocity',
    command: 'view.overlay.velocity',
    title: 'Velocity vectors',
  },
  {
    id: 'viewForce',
    region: 'viewbar',
    group: 'overlays',
    order: 20,
    icon: 'force',
    command: 'view.overlay.force',
    title: 'Net force vectors (m·Δv/Δt)',
  },
  {
    id: 'viewContacts',
    region: 'viewbar',
    group: 'overlays',
    order: 30,
    icon: 'contact',
    command: 'view.overlay.contacts',
    title: 'Contact points & forces',
  },
  {
    id: 'viewCom',
    region: 'viewbar',
    group: 'overlays',
    order: 40,
    icon: 'com',
    command: 'view.overlay.com',
    title: 'Centres of mass',
  },
  {
    id: 'viewTrails',
    region: 'viewbar',
    group: 'overlays',
    order: 50,
    icon: 'trail',
    command: 'view.overlay.trails',
    title: 'Motion trails (selected → all → off)',
    isActive: (app) => app.prefs.value.overlays.trails !== 'off',
  },
  {
    id: 'viewJoints',
    region: 'viewbar',
    group: 'scene',
    order: 60,
    icon: 'joints',
    command: 'view.joints',
    title: 'Show joints & constraints',
  },
  {
    id: 'viewFollow',
    region: 'viewbar',
    group: 'scene',
    order: 70,
    icon: 'follow',
    command: 'view.follow',
    title: 'Camera follows selection',
  },
  {
    id: 'viewFrame',
    region: 'viewbar',
    group: 'camera',
    order: 80,
    icon: 'frame',
    command: 'view.frameSelection',
    title: 'Frame selection / everything (F · Home)',
    showShortcut: false,
  },
];
