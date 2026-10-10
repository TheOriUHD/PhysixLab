/**
 * ED-11: mirror and symmetry.
 *
 *   Mirror copy / Flip about X, Y, Z (planes through the origin) and a custom plane (point + normal dialog) —
 *   palette category "Arrange" and the Edit menu.
 *   Symmetry mode — a toggle (Y), the plane (X / Y / Z and an offset), a toolbox chip pair and a viewport plane.
 *
 * The geometry is `model/edit/mirror.ts`; the live mirroring is `app/edit/symmetry.ts`.
 */
import { vlen, type Vec3 } from '../../core/math';
import { registerCommand, registerMenuEntry, registerTool } from '../../app/registry';
import { flipSelection, mirrorBlocked, mirrorCopySelection, mirrorRoots } from '../../app/edit/mirrorOps';
import { getSymmetry } from '../../app/edit/symmetryHost';
import { AXIS_NAMES, axisPlane, makePlane, type Axis } from '../../model/edit/mirror';
import type { App } from '../../app/app';
import { vec3Field, button, segmented, row } from '../controls';
import { h } from '../dom';
import { openModal, promptText } from '../modal';

const MIRROR_ICON =
  '<path d="M12 3v18" stroke-dasharray="2 2.4"/><path d="M9 7 3.5 17H9z"/><path d="m15 7 5.5 10H15z"/>';

const AXES: readonly Axis[] = [0, 1, 2];
const LOWER = ['x', 'y', 'z'] as const;

const canMirror = (app: App): boolean => !app.sim.active && mirrorRoots(app).length > 0;

for (const i of AXES) {
  const name = AXIS_NAMES[i];
  registerCommand({
    id: `edit.mirror.copy.${LOWER[i]}`,
    label: `Mirror copy about ${name}`,
    category: 'Arrange',
    icon: MIRROR_ICON,
    description: `Copy the selection as its mirror image across the plane ${LOWER[i]} = 0 (joints and soft-body pins mirrored too)`,
    keywords: ['mirror', 'reflect', 'symmetry', 'copy', 'duplicate', 'flip', name.toLowerCase()],
    enabled: canMirror,
    run: ({ app }) => void mirrorCopySelection(app, axisPlane(i)),
  });
  registerCommand({
    id: `edit.mirror.flip.${LOWER[i]}`,
    label: `Flip about ${name}`,
    category: 'Arrange',
    icon: MIRROR_ICON,
    description: `Replace the selection by its mirror image across the plane ${LOWER[i]} = 0`,
    keywords: ['mirror', 'reflect', 'flip', 'in place', name.toLowerCase()],
    enabled: canMirror,
    run: ({ app }) => void flipSelection(app, axisPlane(i)),
  });
}

// ── custom plane dialog ─────────────────────────────────────────────────────────────────────────────────────

function openPlaneDialog(app: App): void {
  const sym = getSymmetry(app);
  const roots = mirrorRoots(app)
    .map((id) => app.store.get(id))
    .filter((e): e is NonNullable<typeof e> => !!e && e.kind !== 'joint');
  let point: Vec3 = [0, 0, 0];
  let normal: Vec3 = [1, 0, 0];
  let mode: 'copy' | 'flip' = 'copy';
  const pointField = vec3Field({ step: 0.1, onChange: (v) => (point = v) });
  const normalField = vec3Field({ step: 0.1, onChange: (v) => (normal = v) });
  pointField.set(point);
  normalField.set(normal);
  const setNormal = (n: Vec3) => {
    normal = n;
    normalField.set(n);
  };
  const presets = h(
    'div',
    { class: 'ed-mirror-presets' },
    AXES.map((i) => {
      const n: Vec3 = [0, 0, 0];
      n[i] = 1;
      return button(`${AXIS_NAMES[i]} axis`, () => setNormal(n), { title: `Normal along ${AXIS_NAMES[i]}` });
    }),
    button('Symmetry plane', () => {
      const pl = sym.plane;
      point = [...pl.point] as Vec3;
      pointField.set(point);
      setNormal([...pl.normal] as Vec3);
    }),
    button('Selection centre', () => {
      if (!roots.length) return;
      point = roots
        .reduce<Vec3>(
          (a, e) => [
            a[0] + (e as { position: Vec3 }).position[0],
            a[1] + (e as { position: Vec3 }).position[1],
            a[2] + (e as { position: Vec3 }).position[2],
          ],
          [0, 0, 0],
        )
        .map((v) => v / roots.length) as Vec3;
      pointField.set(point);
    }),
  );
  const modeSeg = segmented<'copy' | 'flip'>({
    value: mode,
    options: [
      { value: 'copy', label: 'Mirror copy', title: 'Keep the originals and add the mirror image' },
      { value: 'flip', label: 'Flip in place', title: 'Replace the originals by their mirror image' },
    ],
    onChange: (v) => (mode = v),
  });
  const modal = openModal({
    title: 'Mirror about a custom plane',
    width: '440px',
    body: [
      h(
        'p',
        { class: 'ed-mirror-help' },
        'The plane passes through the point and is perpendicular to the normal. Joints between the mirrored objects are mirrored with them.',
      ),
      row('Mode', modeSeg.el),
      row('Point on plane', pointField.el),
      row('Normal', normalField.el),
      presets,
    ],
    footer: [
      button('Cancel', () => modal.close()),
      button(
        'Apply',
        () => {
          if (vlen(normal) < 1e-6) {
            app.toast('The plane normal must not be zero.', 'warn');
            return;
          }
          const why = mirrorBlocked(app);
          if (why) {
            app.toast(why, 'warn');
            return;
          }
          const plane = makePlane(point, normal);
          if (mode === 'copy') mirrorCopySelection(app, plane);
          else flipSelection(app, plane);
          modal.close();
        },
        { cls: 'primary' },
      ),
    ],
  });
}

registerCommand({
  id: 'edit.mirror.custom',
  label: 'Mirror about custom plane…',
  category: 'Arrange',
  icon: MIRROR_ICON,
  description: 'Mirror copy or flip the selection across any plane given by a point and a normal',
  keywords: ['mirror', 'reflect', 'plane', 'normal', 'oblique'],
  enabled: canMirror,
  run: ({ app }) => openPlaneDialog(app),
});

// ── symmetry mode ───────────────────────────────────────────────────────────────────────────────────────────

registerCommand({
  id: 'edit.symmetry.toggle',
  label: 'Symmetry mode',
  category: 'Arrange',
  icon: MIRROR_ICON,
  description: 'Edits to an object are mirrored live to its mirror-image partner across the symmetry plane',
  keywords: ['mirror', 'symmetric', 'symmetry', 'reflect', 'both sides'],
  shortcut: 'Y',
  checked: (app) => getSymmetry(app).enabled,
  setting: true,
  run: ({ app, source }) => {
    const sym = getSymmetry(app);
    sym.setEnabled(!sym.enabled);
    if (!sym.enabled) {
      app.toast('Symmetry mode off', 'info');
      return;
    }
    const n = sym.pairCount;
    app.toast(
      n
        ? `Symmetry on (${sym.label} plane): ${n} mirrored pair(s) linked — edits to one half follow on the other.`
        : `Symmetry on (${sym.label} plane): no mirror-image pairs yet. Objects you add are mirrored as you go; use "Mirror copy" to make the other half of what exists.`,
      'success',
    );
    void source;
  },
});

for (const i of AXES) {
  registerCommand({
    id: `edit.symmetry.axis.${LOWER[i]}`,
    label: `Symmetry plane: ${AXIS_NAMES[i]}`,
    category: 'Arrange',
    description: `Mirror across the plane ${LOWER[i]} = 0 (through the origin)`,
    keywords: ['symmetry', 'plane', 'axis', AXIS_NAMES[i].toLowerCase()],
    checked: (app) => getSymmetry(app).axis === i,
    setting: true,
    run: ({ app }) => getSymmetry(app).setPlane(i, 0),
  });
}

registerCommand({
  id: 'edit.symmetry.cycleAxis',
  label: 'Symmetry plane: next axis',
  category: 'Arrange',
  description: 'Cycle the symmetry plane through X, Y and Z',
  keywords: ['symmetry', 'plane', 'axis'],
  run: ({ app }) => {
    const sym = getSymmetry(app);
    sym.setPlane(((sym.axis + 1) % 3) as Axis, 0);
  },
});

registerCommand({
  id: 'edit.symmetry.offset',
  label: 'Symmetry plane offset…',
  category: 'Arrange',
  description: 'Move the symmetry plane away from the origin (metres along its axis)',
  keywords: ['symmetry', 'plane', 'offset', 'distance'],
  run: async ({ app }) => {
    const sym = getSymmetry(app);
    const text = await promptText(
      'Symmetry plane offset',
      `Position of the ${AXIS_NAMES[sym.axis]} plane along its axis (m)`,
      String(sym.offset),
      'Set',
    );
    if (text === null) return;
    const v = Number(text.replace(',', '.'));
    if (!Number.isFinite(v)) {
      app.toast('That is not a number.', 'warn');
      return;
    }
    sym.setPlane(sym.axis, Math.max(-1e5, Math.min(1e5, v)));
  },
});

registerTool({
  id: 'symmetry',
  group: 'options',
  order: 120,
  icon: MIRROR_ICON,
  command: 'edit.symmetry.toggle',
  title: 'Symmetry mode — mirror every edit to the partner object (paused while the simulation is running)',
  text: (app) => (app.sim.active && getSymmetry(app).enabled ? 'Sym (paused)' : 'Sym'),
});
registerTool({
  id: 'symmetryAxis',
  group: 'options',
  order: 121,
  icon: MIRROR_ICON,
  command: 'edit.symmetry.cycleAxis',
  title: 'Symmetry plane — click to cycle X / Y / Z',
  text: (app) => AXIS_NAMES[getSymmetry(app).axis],
  showShortcut: false,
});

// ── menus ───────────────────────────────────────────────────────────────────────────────────────────────────

registerMenuEntry({ id: 'menu.edit.mirror.heading', menu: 'edit', group: 'mirror', order: 600, heading: 'Mirror' });
let order = 601;
for (const i of AXES) {
  registerMenuEntry({
    id: `menu.edit.mirror.copy.${LOWER[i]}`,
    menu: 'edit',
    group: 'mirror',
    order: order++,
    command: `edit.mirror.copy.${LOWER[i]}`,
    icon: MIRROR_ICON,
  });
}
for (const i of AXES) {
  registerMenuEntry({
    id: `menu.edit.mirror.flip.${LOWER[i]}`,
    menu: 'edit',
    group: 'mirror',
    order: order++,
    command: `edit.mirror.flip.${LOWER[i]}`,
  });
}
registerMenuEntry({
  id: 'menu.edit.mirror.custom',
  menu: 'edit',
  group: 'mirror',
  order: order++,
  command: 'edit.mirror.custom',
});
registerMenuEntry({
  id: 'menu.edit.mirror.symmetry',
  menu: 'edit',
  group: 'mirror',
  order: order++,
  command: 'edit.symmetry.toggle',
});
registerMenuEntry({
  id: 'menu.edit.mirror.symmetryOffset',
  menu: 'edit',
  group: 'mirror',
  order,
  command: 'edit.symmetry.offset',
});
