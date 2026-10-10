/**
 * Package ED-B tools: paint (ED-42), pin (ED-43), and the option bars of the blast (ED-40), throw / aim (ED-44) and
 * grab (ED-45) tools. The tools themselves are registered like any other (`registerTool` also registers the command
 * `tool.<id>` with its shortcut for the palette and the shortcut help); their pointer logic is in `src/app/edTools.ts`.
 */
import { PAINT_PALETTES } from '../../app/edTools';
import { PROJECTILE_TYPES } from '../../app/projectileTypes';
import { registerTool } from '../../app/registry/tools';
import { registerToolOptions } from '../../app/toolOptions';
import { MATERIAL_PRESETS } from '../../model/materials';
import { BLAST_KINDS, FALLOFF_KINDS } from '../../physics/world/blast';

const BLAST_LABELS: Record<string, string> = {
  radial: 'Explosion',
  directional: 'Directional blast',
  implosion: 'Implosion',
  ring: 'Shockwave ring',
  gust: 'Gust (hold)',
};
const FALLOFF_LABELS: Record<string, string> = {
  quadratic: 'Quadratic',
  linear: 'Linear',
  smooth: 'Smooth',
  constant: 'Constant',
  steep: 'Steep',
};

registerTool({
  id: 'paint',
  group: 'build',
  order: 62,
  label: 'Paint tool',
  title: 'Paint — recolour or re-material bodies by clicking or dragging over them',
  icon: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M9.5 15a2.8 2.8 0 0 0 2.5 2"/>',
  shortcut: 'P',
  keywords: ['colour', 'color', 'brush', 'material', 'eyedropper', 'recolor'],
  activate: (app) => app.setTool('paint'),
  isActive: (app) => app.prefs.value.tool === 'paint',
  pointerDown: (_app, e, input) => input.downPaint(e),
  hint: () => '<b>Click or drag</b> over bodies to paint them · <kbd>Shift</kbd>+click picks a colour from a body',
});

registerTool({
  id: 'pin',
  group: 'build',
  order: 65,
  label: 'Pin tool',
  title: 'Pin — nail a body to the world at the clicked point (works while simulating)',
  icon: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/>',
  shortcut: 'N',
  keywords: ['nail', 'anchor', 'attach', 'fix', 'unpin', 'hinge'],
  activate: (app) => app.setTool('pin'),
  isActive: (app) => app.prefs.value.tool === 'pin',
  pointerDown: (_app, e, input) => input.downPin(e),
  hint: (app) =>
    `<b>Click</b> a body to pin it with a ${app.prefs.value.pinJoint} joint · <kbd>Shift</kbd>+click removes the pin nearest the cursor`,
});

registerToolOptions({
  mode: 'blast',
  options: [
    {
      kind: 'select',
      key: 'blastKind',
      label: 'Blast',
      title:
        'Explosion pushes outwards; directional pushes along the view ray; implosion pulls in; shockwave ring pushes a ring outwards; gust blows while you hold',
      options: BLAST_KINDS.map((k) => ({ value: k, label: BLAST_LABELS[k] })),
    },
    {
      kind: 'select',
      key: 'blastFalloff',
      label: 'Falloff',
      title: 'How the push weakens with distance from the centre',
      options: FALLOFF_KINDS.map((k) => ({ value: k, label: FALLOFF_LABELS[k] })),
    },
    { kind: 'range', key: 'blastRadius', label: 'Radius', min: 1, max: 30, step: 0.5, unit: 'm', digits: 1 },
    {
      kind: 'range',
      key: 'blastStrength',
      label: 'Strength',
      min: 5,
      max: 300,
      step: 5,
      digits: 0,
      title: 'Impulse scale (a gust applies this per second)',
    },
  ],
});

registerToolOptions({
  mode: 'shoot',
  options: [
    {
      kind: 'select',
      key: 'shootType',
      label: 'Projectile',
      title: PROJECTILE_TYPES.map((t) => `${t.label}: ${t.blurb}`).join('\n'),
      options: PROJECTILE_TYPES.map((t) => ({ value: t.id, label: t.label })),
    },
    {
      kind: 'range',
      key: 'shootSpeed',
      label: 'Speed',
      min: 4,
      max: 120,
      step: 1,
      unit: 'm/s',
      digits: 0,
      title: 'Launch speed at 1× charge (the projectile type scales it); hold the button to charge up to 2.5×',
    },
    {
      kind: 'range',
      key: 'shootSize',
      label: 'Size',
      min: 0.05,
      max: 1.5,
      step: 0.05,
      unit: 'm',
      digits: 2,
      title: 'Radius at 1× (the projectile type scales it)',
    },
    {
      kind: 'range',
      key: 'shootMass',
      label: 'Mass',
      min: 0,
      max: 2000,
      step: 5,
      unit: 'kg',
      digits: 0,
      title: '0 = the projectile type’s own mass',
    },
  ],
});

registerToolOptions({
  mode: 'paint',
  options: [
    {
      kind: 'select',
      key: 'paintMode',
      label: 'Paint',
      options: [
        { value: 'color', label: 'Colour' },
        { value: 'material', label: 'Material' },
      ],
    },
    {
      kind: 'select',
      key: 'paintPalette',
      label: 'Palette',
      options: Object.keys(PAINT_PALETTES).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
      when: (p) => p.paintMode === 'color',
    },
    {
      kind: 'swatches',
      key: 'paintColor',
      label: 'Colours',
      colors: (p) => PAINT_PALETTES[p.paintPalette] ?? PAINT_PALETTES.vivid,
      when: (p) => p.paintMode === 'color',
    },
    { kind: 'color', key: 'paintColor', label: 'Custom', when: (p) => p.paintMode === 'color' },
    {
      kind: 'select',
      key: 'paintMaterial',
      label: 'Material',
      title: 'Replaces the body’s material (density, friction, bounciness and look)',
      options: MATERIAL_PRESETS.map((m) => ({ value: m.id, label: m.label })),
      when: (p) => p.paintMode === 'material',
    },
  ],
});

registerToolOptions({
  mode: 'pin',
  options: [
    {
      kind: 'select',
      key: 'pinJoint',
      label: 'Pin as',
      options: [
        { value: 'hinge', label: 'Hinge' },
        { value: 'ball', label: 'Ball joint' },
        { value: 'fixed', label: 'Fixed' },
      ],
    },
  ],
});

// Grab options belong to the select tool and only matter while the simulation runs.
registerToolOptions({
  mode: 'select',
  options: [
    {
      kind: 'range',
      key: 'grabStrength',
      label: 'Grab strength',
      min: 0.25,
      max: 4,
      step: 0.25,
      unit: '×',
      digits: 2,
      title: 'Stiffness of the hand that holds a body',
      when: (_p, app) => app.sim.active,
    },
    {
      kind: 'range',
      key: 'grabThrow',
      label: 'Throw',
      min: 0,
      max: 2,
      step: 0.25,
      unit: '×',
      digits: 2,
      title: 'How much of the hand’s velocity a released body keeps (0 drops it, 1 throws it)',
      when: (_p, app) => app.sim.active,
    },
  ],
});
