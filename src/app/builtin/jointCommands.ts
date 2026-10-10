/**
 * Joint commands (JT-22): copy settings between selected joints and mirror joints with their bodies. Plain
 * `CommandDef`s like every other built-in; `builtinCommands()` includes them.
 */
import { MIRROR_PLANES, type MirrorPlane } from '../../model/jointMirror';
import { isBody, isJoint } from '../../model/types';
import { copyJointSettings, copySettingsPlan, mirrorSelection } from '../jointOps';
import type { App } from '../app';
import type { CommandDef } from '../registry/commands';

const selected = (app: App) => app.store.selection.map((id) => app.store.get(id));
/** Run a mirror and report what happened. */
export function runMirror(app: App, plane: MirrorPlane, name: string): void {
  const r = mirrorSelection(app, plane);
  const made = [r.bodies ? `${r.bodies} body(ies)` : '', r.joints ? `${r.joints} joint(s)` : ''].filter(Boolean);
  if (made.length) app.toast(`Mirrored ${made.join(' and ')} across ${name}`);
  if (r.skipped.length)
    app.toast(
      `${made.length ? 'Some joints were' : 'Nothing was'} mirrored — ${r.skipped.slice(0, 2).join('; ')}${r.skipped.length > 2 ? ` (+${r.skipped.length - 2} more)` : ''}`,
      'warn',
    );
  if (!made.length && !r.skipped.length) app.toast('Select bodies or joints to mirror', 'warn');
}

const mirrorCommand = (axis: 'x' | 'y' | 'z', label: string): CommandDef => ({
  id: axis === 'x' ? 'joint.mirror' : `joint.mirror.${axis}`,
  label: `Mirror joints with bodies: ${label}`,
  category: 'Edit',
  icon: 'copy',
  description:
    'Mirror the selected bodies and the joints between them across a world plane. A selected joint whose bodies are not selected attaches to their existing mirrored twins. Shapes that are not mirror-symmetric are copied, not reflected.',
  keywords: ['mirror', 'symmetry', 'reflect', 'flip', 'joint'],
  enabled: (app) => !app.sim.active && selected(app).some((e) => isJoint(e) || isBody(e)),
  run: ({ app }) => runMirror(app, MIRROR_PLANES[axis], `${axis.toUpperCase()} = 0`),
});

export const jointCommands: CommandDef[] = [
  {
    id: 'joint.copySettings',
    label: 'Copy joint settings to the other selected joints',
    category: 'Edit',
    icon: 'copy',
    description:
      'Select joints of one type; the first selected joint’s limits, motor, spring and behaviour settings are copied to the others (not their position or axis).',
    keywords: ['joint', 'paste', 'settings', 'limits', 'motor', 'match'],
    enabled: (app) => !!copySettingsPlan(app),
    run: ({ app }) => {
      if (!copyJointSettings(app)) app.toast('Select two or more joints of the same type', 'warn');
    },
  },
  mirrorCommand('x', 'left–right (X = 0)'),
  mirrorCommand('y', 'up–down (Y = 0)'),
  mirrorCommand('z', 'front–back (Z = 0)'),
];
