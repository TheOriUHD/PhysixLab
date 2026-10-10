/**
 * Zone — turns a body into a trigger volume (ZN-1, ZN-2). The body's own shape is the volume (box, sphere, cylinder,
 * a hull, a compound of sensor parts …) and its colliders must be sensors, i.e. the body is a *ghost*: bodies pass
 * through it and the world reports who entered and left. What happens then is the `action`. A body may carry several
 * zone components (a launch pad that also plays a sound) — each has its own filter, events and action.
 *
 * Runtime: `src/physics/components/zone.ts`; the shared vocabulary (actions, event names and payloads, the published
 * race state) is `src/model/zones.ts`. The Add-component menu offers this def, the Zones tools and prefabs create
 * correctly set-up zone bodies for each action.
 *
 * Import `componentRegistry` before this file when you import it on its own (the toggle action lists the registered
 * component types lazily).
 */
import * as registry from '../componentRegistry';
import type { ComponentDef, FieldDef } from '../componentRegistry';
import { ZONE_ACTIONS, ZONE_SOUNDS } from '../zones';
import type { ComponentParams } from '../types';

/** Show a field only for some actions. */
const only =
  (...actions: string[]) =>
  (p: ComponentParams): boolean =>
    actions.includes(p.action as string);

const RACE = ['checkpoint', 'start', 'finish'];
/** Actions that fire once per entering unit (as opposed to working every step while a body is inside). */
const INSTANT = ['kill', 'respawnAt', 'teleport', 'launch', 'spawn', 'sound', 'score', 'toggle', 'custom'];
/** Actions that act on a body or its whole group. */
const UNIT = ['checkpoint', 'start', 'finish', 'kill', 'respawnAt', 'teleport', 'launch'];

const yesNo = (value: string, label: string) => ({ value, label });

const fields: FieldDef[] = [
  {
    kind: 'enum',
    key: 'action',
    label: 'Action',
    default: 'none',
    hint: 'What the zone does with the bodies that enter it',
    options: ZONE_ACTIONS.map((a) => ({ value: a.id, label: a.label })),
  },

  // ── race ──
  {
    kind: 'text',
    key: 'race',
    label: 'Race',
    default: 'race',
    maxLength: 40,
    placeholder: 'race',
    hint: 'Start line, checkpoints and finish line with the same race name belong together',
    showIf: only(...RACE),
  },
  {
    kind: 'number',
    key: 'index',
    label: 'Checkpoint no.',
    default: 1,
    min: 1,
    max: 999,
    step: 1,
    digits: 0,
    hint: 'Checkpoints are passed in ascending order; zones with the same number are alternatives',
    showIf: only('checkpoint'),
  },
  {
    kind: 'number',
    key: 'laps',
    label: 'Laps',
    default: 1,
    min: 1,
    max: 99,
    step: 1,
    digits: 0,
    hint: 'The race is finished when this many laps are completed',
    showIf: only('finish'),
  },
  {
    kind: 'bool',
    key: 'requireAll',
    label: 'All checkpoints',
    default: true,
    hint: 'A crossing only completes a lap when every checkpoint was passed in order',
    showIf: only('finish'),
  },
  {
    kind: 'bool',
    key: 'startsClock',
    label: 'Also the start',
    default: false,
    hint: 'The first crossing starts the clock (a circuit’s start / finish line); later ones complete laps',
    showIf: only('finish'),
  },

  // ── kill ──
  {
    kind: 'enum',
    key: 'killMode',
    label: 'When entered',
    default: 'remove',
    options: [yesNo('remove', 'Remove the body'), yesNo('respawn', 'Respawn the body')],
    hint: 'Removed bodies vanish until Reset; respawned bodies come back',
    showIf: only('kill'),
  },
  {
    kind: 'enum',
    key: 'respawnTo',
    label: 'Respawn at',
    default: 'checkpoint',
    options: [yesNo('start', 'Starting pose'), yesNo('checkpoint', 'Last checkpoint (else start)')],
    showIf: (p) => p.action === 'kill' && p.killMode === 'respawn',
  },
  {
    kind: 'number',
    key: 'respawnDelay',
    label: 'Respawn delay',
    default: 0,
    min: 0,
    max: 60,
    step: 0.1,
    unit: 's',
    showIf: (p) => p.action === 'kill' && p.killMode === 'respawn',
  },
  {
    kind: 'number',
    key: 'maxRespawns',
    label: 'Respawn limit',
    default: 0,
    min: 0,
    max: 999,
    step: 1,
    digits: 0,
    hint: 'After this many respawns the body is removed for good (0 = unlimited)',
    showIf: (p) => p.action === 'kill' && p.killMode === 'respawn',
  },
  {
    kind: 'number',
    key: 'penalty',
    label: 'Time penalty',
    default: 0,
    min: 0,
    max: 600,
    step: 0.5,
    unit: 's',
    hint: 'Seconds added to the racer’s lap and total time',
    showIf: only('kill'),
  },
  {
    kind: 'number',
    key: 'penaltyPoints',
    label: 'Score penalty',
    default: 0,
    min: 0,
    max: 1_000_000,
    step: 1,
    digits: 0,
    unit: 'pts',
    showIf: only('kill'),
  },

  // ── respawn point / teleport ──
  {
    kind: 'entity',
    key: 'target',
    label: 'Target body',
    default: '',
    filter: 'body',
    hint: 'A body to go to / to switch. Use a small ghost marker body as a destination.',
    showIf: only('respawnAt', 'teleport', 'toggle'),
  },
  {
    kind: 'vec3',
    key: 'offset',
    label: 'Position',
    default: [0, 0, 0],
    min: -1_000_000,
    max: 1_000_000,
    step: 0.1,
    unit: 'm',
    hint: 'With a target body: the offset in its frame. Without one: the world position.',
    showIf: only('respawnAt', 'teleport'),
  },
  {
    kind: 'bool',
    key: 'moveNow',
    label: 'Move there now',
    default: false,
    hint: 'Also move the body to the respawn point as soon as it enters',
    showIf: only('respawnAt'),
  },
  {
    kind: 'enum',
    key: 'mapping',
    label: 'Arrive',
    default: 'center',
    options: [yesNo('center', 'At the target'), yesNo('relative', 'Same place in the target')],
    hint: 'Same place keeps the body’s offset inside the portal, turned with the portal',
    showIf: only('teleport'),
  },
  {
    kind: 'enum',
    key: 'velocity',
    label: 'Velocity',
    default: 'keep',
    options: [yesNo('keep', 'Keep'), yesNo('rotate', 'Turn with the portal'), yesNo('stop', 'Stop')],
    showIf: only('teleport'),
  },
  {
    kind: 'enum',
    key: 'orientation',
    label: 'Orientation',
    default: 'keep',
    options: [yesNo('keep', 'Keep'), yesNo('rotate', 'Turn with the portal'), yesNo('match', 'Match the target')],
    showIf: only('teleport'),
  },

  // ── launch ──
  {
    kind: 'enum',
    key: 'launchMode',
    label: 'Launch as',
    default: 'deltaV',
    options: [yesNo('deltaV', 'Velocity change (m/s)'), yesNo('impulse', 'Impulse (N·s)')],
    hint: 'A velocity change launches every body equally; an impulse is split by mass',
    showIf: only('launch'),
  },
  {
    kind: 'vec3',
    key: 'launch',
    label: 'Launch',
    default: [0, 8, 0],
    min: -100_000,
    max: 100_000,
    step: 0.5,
    showIf: only('launch'),
  },

  // ── gravity / force ──
  {
    kind: 'vec3',
    key: 'gravity',
    label: 'Gravity',
    default: [0, 0, 0],
    min: -1000,
    max: 1000,
    step: 0.1,
    unit: 'm/s²',
    hint: 'Replaces the scene’s gravity for bodies inside (0, 0, 0 = weightless)',
    showIf: only('gravity'),
  },
  {
    kind: 'number',
    key: 'priority',
    label: 'Priority',
    default: 0,
    min: -100,
    max: 100,
    step: 1,
    digits: 0,
    hint: 'Where gravity zones overlap, the highest priority rules (the newer body wins a tie)',
    showIf: only('gravity'),
  },
  {
    kind: 'enum',
    key: 'forceMode',
    label: 'Field',
    default: 'uniform',
    options: [
      yesNo('uniform', 'Uniform'),
      yesNo('attract', 'Toward the centre'),
      yesNo('repel', 'Away from the centre'),
    ],
    showIf: only('force'),
  },
  {
    kind: 'vec3',
    key: 'force',
    label: 'Force',
    default: [0, 10, 0],
    min: -1_000_000,
    max: 1_000_000,
    step: 0.5,
    showIf: (p) => p.action === 'force' && p.forceMode === 'uniform',
  },
  {
    kind: 'number',
    key: 'strength',
    label: 'Strength',
    default: 10,
    min: 0,
    max: 1_000_000,
    step: 0.5,
    showIf: (p) => p.action === 'force' && p.forceMode !== 'uniform',
  },
  {
    kind: 'enum',
    key: 'falloff',
    label: 'Falloff',
    default: 'linear',
    options: [yesNo('none', 'None'), yesNo('linear', 'Linear to the edge'), yesNo('inverse', 'Inverse square')],
    hint: 'Strength at the zone’s radius; linear fades to nothing at the edge',
    showIf: (p) => p.action === 'force' && p.forceMode !== 'uniform',
  },
  {
    kind: 'bool',
    key: 'perMass',
    label: 'Per unit mass',
    default: true,
    hint: 'Read the strength as an acceleration (m/s²): every body speeds up alike, like gravity',
    showIf: only('force'),
  },
  {
    kind: 'enum',
    key: 'space',
    label: 'Axes',
    default: 'zone',
    options: [yesNo('zone', 'Zone axes'), yesNo('world', 'World axes')],
    showIf: (p) => p.action === 'launch' || (p.action === 'force' && p.forceMode === 'uniform'),
  },

  // ── spawn ──
  {
    kind: 'entity',
    key: 'template',
    label: 'Template body',
    default: '',
    filter: 'body',
    hint: 'The body to copy. It keeps its shape, material, velocity and components.',
    showIf: only('spawn'),
  },
  {
    kind: 'enum',
    key: 'when',
    label: 'Spawn',
    default: 'enter',
    options: [yesNo('enter', 'When a body enters'), yesNo('timer', 'At a steady rate')],
    showIf: only('spawn'),
  },
  {
    kind: 'number',
    key: 'interval',
    label: 'Every',
    default: 1,
    min: 0.05,
    max: 3600,
    step: 0.05,
    unit: 's',
    showIf: (p) => p.action === 'spawn' && p.when === 'timer',
  },
  {
    kind: 'number',
    key: 'maxAlive',
    label: 'Max alive',
    default: 10,
    min: 1,
    max: 500,
    step: 1,
    digits: 0,
    hint: 'No more copies are made while this many are in the world',
    showIf: only('spawn'),
  },
  {
    kind: 'number',
    key: 'lifetime',
    label: 'Lifetime',
    default: 0,
    min: 0,
    max: 3600,
    step: 1,
    unit: 's',
    hint: 'A copy is removed after this long (0 = never)',
    showIf: only('spawn'),
  },
  {
    kind: 'vec3',
    key: 'spawnOffset',
    label: 'Spawn at',
    default: [0, 0, 0],
    min: -1000,
    max: 1000,
    step: 0.1,
    unit: 'm',
    hint: 'Where copies appear, relative to the zone',
    showIf: only('spawn'),
  },
  {
    kind: 'vec3',
    key: 'spawnVelocity',
    label: 'Spawn velocity',
    default: [0, 0, 0],
    min: -1000,
    max: 1000,
    step: 0.1,
    unit: 'm/s',
    hint: 'Initial velocity of a copy, in the zone’s axes',
    showIf: only('spawn'),
  },
  {
    kind: 'bool',
    key: 'consume',
    label: 'Hide the template',
    default: true,
    hint: 'The template body leaves the scene when the simulation starts (it is only a pattern)',
    showIf: only('spawn'),
  },

  // ── sound ──
  {
    kind: 'enum',
    key: 'sound',
    label: 'Sound',
    default: 'chime',
    options: ZONE_SOUNDS.map((s) => ({ value: s.id, label: s.label })),
    showIf: only('sound'),
  },
  {
    kind: 'number',
    key: 'volume',
    label: 'Volume',
    default: 0.6,
    min: 0,
    max: 1,
    step: 0.05,
    digits: 2,
    showIf: only('sound'),
  },
  {
    kind: 'number',
    key: 'pitch',
    label: 'Pitch',
    default: 1,
    min: 0.25,
    max: 4,
    step: 0.05,
    digits: 2,
    unit: '×',
    showIf: only('sound'),
  },

  // ── score / label ──
  {
    kind: 'number',
    key: 'points',
    label: 'Points',
    default: 10,
    min: -1_000_000,
    max: 1_000_000,
    step: 1,
    digits: 0,
    hint: 'Added to the score (negative takes points away)',
    showIf: only('score'),
  },
  {
    kind: 'text',
    key: 'message',
    label: 'Message',
    default: '',
    maxLength: 80,
    placeholder: 'Shown on screen',
    showIf: only('score'),
  },

  // ── enable / disable ──
  {
    kind: 'enum',
    key: 'componentType',
    label: 'Component',
    default: '',
    hint: 'Which component of the target to switch (zones are only switched when named)',
    // Lazy: the list follows the registry, including components registered after this file loaded.
    get options() {
      return [
        yesNo('', 'Every component'),
        ...registry
          .listComponents()
          .filter((d) => d.appliesTo !== 'joint')
          .map((d) => yesNo(d.type, d.label)),
      ];
    },
    showIf: only('toggle'),
  },
  {
    kind: 'enum',
    key: 'switchTo',
    label: 'Switch',
    default: 'toggle',
    options: [yesNo('enable', 'On'), yesNo('disable', 'Off'), yesNo('toggle', 'Toggle')],
    showIf: only('toggle'),
  },
  {
    kind: 'bool',
    key: 'revertOnExit',
    label: 'Undo on exit',
    default: false,
    hint: 'When the last body leaves, switch the components back (a pressure plate)',
    showIf: only('toggle'),
  },

  // ── custom event ──
  {
    kind: 'text',
    key: 'customEvent',
    label: 'Event name',
    default: 'custom',
    maxLength: 48,
    hint: 'Raised as a zone event named "custom" with this name in its data, for logic and scripts',
    showIf: only('custom'),
  },
  {
    kind: 'text',
    key: 'payload',
    label: 'Payload',
    default: '',
    maxLength: 200,
    showIf: only('custom'),
  },

  // ── unit ──
  {
    kind: 'enum',
    key: 'unit',
    label: 'Acts on',
    default: 'body',
    options: [yesNo('body', 'The body that enters'), yesNo('group', 'Its whole group (a vehicle)')],
    hint: 'A vehicle built from several bodies in a group is one racer, is respawned or teleported as a whole',
    showIf: only(...UNIT),
  },

  // ── which bodies ──
  {
    kind: 'enum',
    key: 'types',
    label: 'Bodies',
    default: 'dynamic',
    options: [yesNo('dynamic', 'Dynamic'), yesNo('kinematic', 'Kinematic'), yesNo('any', 'Dynamic and kinematic')],
    hint: 'Static bodies never enter a zone',
  },
  {
    kind: 'text',
    key: 'tags',
    label: 'Only tags',
    default: '',
    maxLength: 120,
    placeholder: 'any body',
    hint: 'Comma-separated: only bodies with one of these tags',
  },
  {
    kind: 'text',
    key: 'notTags',
    label: 'Not tags',
    default: '',
    maxLength: 120,
    placeholder: 'none',
    hint: 'Comma-separated: bodies with one of these tags are ignored',
  },
  {
    kind: 'text',
    key: 'layers',
    label: 'Only layers',
    default: '',
    maxLength: 120,
    placeholder: 'any layer',
    hint: 'Comma-separated: only bodies on one of these layers',
  },

  // ── events ──
  {
    kind: 'bool',
    key: 'emitEnter',
    label: 'Enter events',
    default: true,
    hint: 'Raise an "enter" event for logic, scripts and the game layer',
  },
  {
    kind: 'bool',
    key: 'emitExit',
    label: 'Exit events',
    default: true,
    hint: 'Raise an "exit" event',
  },
  {
    kind: 'number',
    key: 'stayInterval',
    label: 'Stay events',
    default: 0,
    min: 0,
    max: 60,
    step: 0.1,
    unit: 's',
    hint: 'Raise a "stay" event this often for every body inside (0 = off)',
  },

  // ── limits ──
  {
    kind: 'number',
    key: 'cooldown',
    label: 'Cooldown',
    default: 0,
    min: 0,
    max: 3600,
    step: 0.1,
    unit: 's',
    hint: 'Per body: do not act again this soon after the last time (teleporters ignore a body for at least 0.5 s)',
    showIf: only(...INSTANT),
  },
  {
    kind: 'number',
    key: 'maxTriggers',
    label: 'Max triggers',
    default: 0,
    min: 0,
    max: 1_000_000,
    step: 1,
    digits: 0,
    hint: 'The zone acts at most this many times in total (0 = unlimited)',
    showIf: only(...INSTANT),
  },

  // ── display ──
  {
    kind: 'text',
    key: 'label',
    label: 'Label',
    default: '',
    maxLength: 60,
    placeholder: 'Zone',
    hint: 'Shown above the zone in the editor and in events',
  },
  {
    kind: 'bool',
    key: 'customColor',
    label: 'Custom colour',
    default: false,
    hint: 'Otherwise the colour of the action is used',
  },
  { kind: 'color', key: 'color', label: 'Colour', default: '#38bdf8', showIf: (p) => p.customColor === true },
  {
    kind: 'bool',
    key: 'showInRun',
    label: 'Show while running',
    default: false,
    hint: 'Draw the volume while the simulation runs (it is always drawn in the editor)',
  },
];

export const zone: ComponentDef = {
  type: 'zone',
  label: 'Zone',
  icon: 'zone',
  category: 'Zones',
  blurb:
    'A trigger volume: reports who enters and leaves, and can time a race, launch, teleport, kill, spawn, play a sound and more.',
  appliesTo: 'body',
  fields,
  state: [
    { label: 'Inside', digits: 0 },
    { label: 'Entered', digits: 0 },
    { label: 'Fired', digits: 0 },
  ],
  sanitise: (p) => ({ ...p, index: Math.round(p.index as number), laps: Math.round(p.laps as number) }),
  check(owner, p) {
    if (owner.kind !== 'body') return null;
    const sensor = owner.ghost || (owner.parts?.some((part) => part.sensor) ?? false);
    if (!sensor)
      return 'This body is solid, so nothing is reported. Tick “Ghost” on the body (Physics section) so bodies can enter it — the Zone tools do this for you.';
    if (owner.bodyType === 'dynamic')
      return 'A dynamic zone body falls and is pushed around. Set the body type to Static (or Kinematic to move it).';
    const action = p.action as string;
    const thin = Math.min(...owner.shape.size);
    if (RACE.includes(action) && thin < 0.3)
      return 'This zone is very thin: a fast body can cross it between two steps without being noticed. Make it at least 0.5 m deep.';
    if (action === 'spawn' && !p.template) return 'Choose the template body to copy.';
    if (action === 'toggle' && !p.target) return 'Choose the body whose components this zone switches.';
    if (action === 'teleport' && !p.target && !(p.offset as number[]).some((v) => v !== 0))
      return 'Choose a target body, or set the world position to teleport to.';
    return null;
  },
};
