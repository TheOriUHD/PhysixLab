/**
 * The “World bounds” section of the World tab (ZN-34): a box around the playfield, what each of its six sides does to
 * a body that reaches it (nothing / lost / soft spring wall / water), and what “lost” means (removed, or respawned at
 * the start or the last checkpoint, with a delay, penalties and a limit). Edits go through the scene settings, so they
 * are undoable and apply to a running simulation at once.
 */
import type { App } from '../app/app';
import type { Vec3 } from '../core/math';
import { defaultBounds } from '../model/factory';
import { boundingRadius } from '../model/shapes';
import type { BoundsEdge, BoundsSettings } from '../model/types';
import { button, numberField, row, rowStack, section, selectField, toggleField, vec3Field } from './controls';
import { h } from './dom';

type FaceKey = keyof BoundsSettings['edges'];

const FACES: { key: FaceKey; label: string; hint: string }[] = [
  { key: 'ny', label: 'Floor', hint: 'The bottom of the box (−Y): a kill plane, or the sea' },
  { key: 'py', label: 'Ceiling', hint: 'The top of the box (+Y)' },
  { key: 'nx', label: 'Left (−X)', hint: 'The side at the lowest X' },
  { key: 'px', label: 'Right (+X)', hint: 'The side at the highest X' },
  { key: 'nz', label: 'Back (−Z)', hint: 'The side at the lowest Z' },
  { key: 'pz', label: 'Front (+Z)', hint: 'The side at the highest Z' },
];

const EDGE_LABELS: Record<BoundsEdge, string> = {
  open: 'Open',
  kill: 'Kill',
  soft: 'Soft wall',
  water: 'Water (drowns)',
};

export interface BoundsSection {
  el: HTMLElement;
  refresh: () => void;
}

export function buildBoundsSection(app: App): BoundsSection {
  const { store } = app;
  const cur = (): BoundsSettings => store.settings.bounds;
  const write = (patch: Partial<BoundsSettings>, label: string) =>
    store.updateSettings({ bounds: { ...cur(), ...patch } }, label);
  const writeRespawn = (patch: Partial<BoundsSettings['respawn']>, label: string) =>
    write({ respawn: { ...cur().respawn, ...patch } }, label);
  const writeSoft = (patch: Partial<BoundsSettings['soft']>, label: string) =>
    write({ soft: { ...cur().soft, ...patch } }, label);
  const grouped = (label: string) => ({ onStart: () => store.begin(label), onEnd: () => store.end() });
  const upd: (() => void)[] = [];

  const enabled = toggleField({
    label: 'Keep bodies inside a box',
    title: 'Bodies that leave the box are removed or respawned; soft walls push them back',
    onChange: (v) => write({ enabled: v }, v ? 'Enable world bounds' : 'Disable world bounds'),
  });
  upd.push(() => enabled.set(cur().enabled));

  const fit = button(
    'Fit to scene',
    () => {
      const bodies = store.bodies();
      if (!bodies.length) return write({ min: defaultBounds().min, max: defaultBounds().max }, 'Reset world bounds');
      const lo: Vec3 = [Infinity, Infinity, Infinity];
      const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const b of bodies) {
        const r = boundingRadius(b.shape);
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], b.position[i] - r);
          hi[i] = Math.max(hi[i], b.position[i] + r);
        }
      }
      const pad = 12;
      const round = (v: number, up: boolean) => (up ? Math.ceil(v) : Math.floor(v));
      write(
        {
          min: [round(lo[0] - pad, false), round(Math.min(lo[1], 0) - pad, false), round(lo[2] - pad, false)],
          max: [round(hi[0] + pad, true), round(hi[1] + pad * 2, true), round(hi[2] + pad, true)],
        },
        'Fit world bounds to the scene',
      );
    },
    { icon: 'frame', title: 'Set the box around every body, with 12 m to spare' },
  );
  const reset = button(
    'Reset box',
    () => write({ min: defaultBounds().min, max: defaultBounds().max }, 'Reset world bounds'),
    { title: 'Back to the default 200 m box' },
  );

  const lo = vec3Field({
    step: 1,
    digits: 1,
    unit: 'm',
    ...grouped('Edit bounds corner'),
    onChange: (v) => write({ min: v }, 'Edit bounds corner'),
  });
  const hi = vec3Field({
    step: 1,
    digits: 1,
    unit: 'm',
    ...grouped('Edit bounds corner'),
    onChange: (v) => write({ max: v }, 'Edit bounds corner'),
  });
  upd.push(() => {
    lo.set(cur().min);
    hi.set(cur().max);
  });

  // one select per face
  const faceRows = FACES.map((f) => {
    const options: { value: BoundsEdge; label: string }[] = (['open', 'kill', 'soft'] as const).map((v) => ({
      value: v,
      label: EDGE_LABELS[v],
    }));
    if (f.key === 'ny') options.push({ value: 'water', label: EDGE_LABELS.water });
    const sel = selectField<BoundsEdge>({
      options,
      onChange: (v) => write({ edges: { ...cur().edges, [f.key]: v } }, `World bounds: ${f.label} ${EDGE_LABELS[v]}`),
    });
    upd.push(() => {
      const v = cur().edges[f.key];
      // a water edge exists on the floor only: elsewhere an old file's value shows as the kill it acts as
      sel.set(f.key !== 'ny' && v === 'water' ? 'kill' : v);
    });
    return row(f.label, sel.el, f.hint);
  });

  const policy = selectField<BoundsSettings['policy']>({
    options: [
      { value: 'kill', label: 'Remove the body' },
      { value: 'respawn', label: 'Respawn the body' },
    ],
    onChange: (v) => write({ policy: v }, `World bounds: ${v === 'kill' ? 'remove' : 'respawn'}`),
  });
  upd.push(() => policy.set(cur().policy));

  const respawnTo = selectField<BoundsSettings['respawn']['to']>({
    options: [
      { value: 'start', label: 'Starting pose' },
      { value: 'checkpoint', label: 'Last checkpoint (else start)' },
    ],
    onChange: (v) => writeRespawn({ to: v }, 'Respawn place'),
  });
  const delay = numberField({
    step: 0.1,
    min: 0,
    max: 600,
    unit: 's',
    ...grouped('Respawn delay'),
    onChange: (v) => writeRespawn({ delay: v }, 'Respawn delay'),
  });
  const penSec = numberField({
    step: 0.5,
    min: 0,
    max: 3600,
    unit: 's',
    ...grouped('Respawn time penalty'),
    onChange: (v) => writeRespawn({ penaltySeconds: v }, 'Respawn time penalty'),
  });
  const penPts = numberField({
    step: 1,
    min: 0,
    max: 1_000_000,
    digits: 0,
    unit: 'pts',
    ...grouped('Respawn score penalty'),
    onChange: (v) => writeRespawn({ penaltyPoints: Math.round(v) }, 'Respawn score penalty'),
  });
  const limit = numberField({
    step: 1,
    min: 0,
    max: 9999,
    digits: 0,
    ...grouped('Respawn limit'),
    onChange: (v) => writeRespawn({ max: Math.round(v) }, 'Respawn limit'),
  });
  const groups = toggleField({
    label: 'Respawn groups together',
    title: 'Bodies that share a group (a vehicle) are lost and come back as one',
    onChange: (v) => writeRespawn({ wholeGroups: v }, 'Respawn groups together'),
  });
  const respawnRows = [
    row('Respawn at', respawnTo.el),
    row('Delay', delay.el, 'Seconds the body stays out of the world'),
    row('Time penalty', penSec.el, 'Seconds added to the racer’s lap and total time'),
    row('Score penalty', penPts.el, 'Points taken off the score'),
    row('Respawn limit', limit.el, 'After this many respawns the body is removed for good (0 = no limit)'),
    groups.el,
  ];
  upd.push(() => {
    const r = cur().respawn;
    respawnTo.set(r.to);
    delay.set(r.delay);
    penSec.set(r.penaltySeconds);
    penPts.set(r.penaltyPoints);
    limit.set(r.max);
    groups.set(r.wholeGroups);
    for (const el of respawnRows) el.style.display = cur().policy === 'respawn' ? '' : 'none';
  });

  const margin = numberField({
    step: 0.5,
    min: 0.1,
    max: 1000,
    unit: 'm',
    ...grouped('Soft wall width'),
    onChange: (v) => writeSoft({ margin: v }, 'Soft wall width'),
  });
  const stiff = numberField({
    step: 5,
    min: 0,
    max: 10000,
    digits: 0,
    unit: '1/s²',
    ...grouped('Soft wall stiffness'),
    onChange: (v) => writeSoft({ stiffness: v }, 'Soft wall stiffness'),
  });
  const damp = numberField({
    step: 0.5,
    min: 0,
    max: 1000,
    unit: '1/s',
    ...grouped('Soft wall damping'),
    onChange: (v) => writeSoft({ damping: v }, 'Soft wall damping'),
  });
  const softRows = [
    row('Wall width', margin.el, 'The wall starts this far inside the side'),
    row('Stiffness', stiff.el, 'Push-back acceleration per metre of depth. A body at speed v stops v/√k metres in.'),
    row('Damping', damp.el, 'Slows a body that is moving into the wall'),
  ];
  upd.push(() => {
    margin.set(cur().soft.margin);
    stiff.set(cur().soft.stiffness);
    damp.set(cur().soft.damping);
    const anySoft = Object.values(cur().edges).includes('soft');
    for (const el of softRows) el.style.display = anySoft ? '' : 'none';
  });

  const body = [
    enabled.el,
    h('div', { class: 'row-actions' }, fit, reset),
    rowStack('Lowest corner', lo.el),
    rowStack('Highest corner', hi.el),
    h('div', { class: 'sub-title' }, 'At each side'),
    ...faceRows,
    ...softRows,
    h('div', { class: 'sub-title' }, 'A lost body'),
    row('Is', policy.el),
    ...respawnRows,
    h(
      'p',
      { class: 'hint-text' },
      'Checked for dynamic bodies, by their centre. Kill sides lose a body that crosses them; a soft wall pushes it back like a spring and never loses it; “water” is a kill side at the floor that reports the body as drowned (floating water volumes are separate). The box is drawn in the editor while bounds are on. Bodies are always switched off 400 m below the origin.',
    ),
  ];
  const el = section('World bounds', body, { id: 'world-bounds', open: false });
  const sync = () => {
    for (const u of upd) u();
    for (const r of faceRows) r.classList.toggle('muted', !cur().enabled);
  };
  return { el, refresh: sync };
}
