/**
 * The component registry (src/model/componentRegistry.ts): registration rules, defaults, coercion of every field
 * kind, sanitising of components read from files, references between entities (cleared on delete, followed by
 * clones, repaired on load) and the document round trip.
 */
import { describe, expect, it } from 'vitest';
import { newReport } from '../src/model/errors';
import {
  cloneComponents,
  coerceField,
  componentCategories,
  componentDef,
  componentsFor,
  dedupeComponentIds,
  defaultParams,
  hasComponent,
  listComponents,
  makeComponent,
  registerComponent,
  repairComponentRefs,
  sanitizeComponents,
  sanitizeParams,
  type ComponentDef,
  type FieldDef,
} from '../src/model/componentRegistry';
import { LIMITS } from '../src/model/limits';
import { createBody, createJoint, newDocument } from '../src/model/factory';
import { SCENE_VERSION } from '../src/model/migrations';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { cloneEntities, SceneStore } from '../src/model/store';
import type { BodyEntity, ComponentSpec, Entity, JointEntity, SceneDocument } from '../src/model/types';

/** A def that uses every field kind, registered for these tests only. */
const ALL: ComponentDef = {
  type: 'testAllFields',
  label: 'All fields',
  icon: 'component',
  category: 'Tests',
  blurb: 'every field kind',
  appliesTo: 'body',
  fields: [
    { kind: 'number', key: 'n', label: 'N', default: 5, min: 0, max: 10 },
    { kind: 'bool', key: 'b', label: 'B', default: true },
    {
      kind: 'enum',
      key: 'e',
      label: 'E',
      default: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    { kind: 'vec3', key: 'v', label: 'V', default: [1, 2, 3], min: -10, max: 10 },
    { kind: 'color', key: 'c', label: 'C', default: '#112233' },
    { kind: 'key', key: 'k', label: 'K', default: 'KeyW' },
    { kind: 'text', key: 't', label: 'T', default: 'hi', maxLength: 5 },
    { kind: 'entity', key: 'who', label: 'Who', default: '' },
    { kind: 'entity', key: 'joint', label: 'Joint', default: '', filter: 'joint' },
    { kind: 'path', key: 'route', label: 'Route', default: '' },
    {
      kind: 'curve',
      key: 'curve',
      label: 'Curve',
      default: [
        [0, 0],
        [1, 1],
      ],
      xRange: [0, 1],
      yRange: [-1, 1],
    },
  ],
};
registerComponent(ALL);
registerComponent({
  type: 'testSolo',
  label: 'Solo',
  icon: 'component',
  category: 'Tests',
  blurb: 'only one per owner, joints only',
  appliesTo: 'joint',
  unique: true,
  fields: [{ kind: 'number', key: 'x', label: 'X', default: 1 }],
  sanitise: (p) => ({ ...p, x: Math.min(p.x as number, 100) }),
});

const body = (name: string, over: Partial<BodyEntity> = {}) => createBody({ name, shape: { type: 'box' }, ...over });

describe('registry', () => {
  it('ships the two reference components, in menu order, with categories', () => {
    const types = listComponents().map((d) => d.type);
    expect(types.slice(0, 2)).toEqual(['constantForce', 'sineMover']);
    expect(componentDef('constantForce')?.category).toBe('Forces');
    expect(componentDef('sineMover')?.category).toBe('Movers');
    expect(hasComponent('nope')).toBe(false);
    expect(componentCategories('body')).toEqual(expect.arrayContaining(['Forces', 'Movers', 'Tests']));
    expect(componentsFor('joint').map((d) => d.type)).toContain('testSolo');
    expect(componentsFor('joint').map((d) => d.type)).not.toContain('constantForce');
    expect(componentsFor('body').map((d) => d.type)).not.toContain('testSolo');
  });

  const bad = (over: Partial<ComponentDef>, msg: RegExp) =>
    expect(() => registerComponent({ ...ALL, type: 'badDef', ...over })).toThrow(msg);

  it('rejects malformed definitions with a message that names the problem', () => {
    bad({ type: 'testAllFields' }, /already registered/);
    bad({ type: '9bad' }, /identifier/);
    bad({ label: '' }, /label, icon and category/);
    bad({ fields: [ALL.fields[0], ALL.fields[0]] }, /duplicated/);
    bad({ fields: [{ kind: 'number', key: 'n', label: 'N', default: 5, min: 9, max: 1 }] }, /min > max/);
    bad({ fields: [{ kind: 'number', key: 'n', label: 'N', default: Number.NaN }] }, /not a number/);
    bad(
      {
        fields: [{ kind: 'enum', key: 'e', label: 'E', default: 'zzz', options: [{ value: 'a', label: 'A' }] }],
      },
      /not one of its options/,
    );
    bad(
      { fields: [{ kind: 'vec3', key: 'v', label: 'V', default: [1, 2] as unknown as [number, number, number] }] },
      /not a vec3/,
    );
    bad(
      { fields: [{ kind: 'curve', key: 'c', label: 'C', default: [[0, 0]], xRange: [0, 1], yRange: [0, 1] }] },
      /two default points/,
    );
    bad({ fields: [{ kind: 'key', key: 'k', label: 'K', default: 'Not A Key!' }] }, /key code/);
  });
});

describe('field coercion', () => {
  const f = (key: string) => ALL.fields.find((x) => x.key === key) as FieldDef;

  it('coerces every kind to something the field allows', () => {
    expect(coerceField(f('n'), 99)).toBe(10);
    expect(coerceField(f('n'), -3)).toBe(0);
    expect(coerceField(f('n'), 'x')).toBe(5);
    expect(coerceField(f('n'), Number.NaN)).toBe(5);
    expect(coerceField(f('b'), 'yes')).toBe(true);
    expect(coerceField(f('b'), false)).toBe(false);
    expect(coerceField(f('e'), 'b')).toBe('b');
    expect(coerceField(f('e'), 'zzz')).toBe('a');
    expect(coerceField(f('v'), [100, -100, 0.5])).toEqual([10, -10, 0.5]);
    expect(coerceField(f('v'), [1, 2])).toEqual([1, 2, 3]);
    expect(coerceField(f('v'), 'x')).toEqual([1, 2, 3]);
    expect(coerceField(f('c'), '#abcdef')).toBe('#abcdef');
    expect(coerceField(f('c'), 'red')).toBe('#112233');
    expect(coerceField(f('k'), 'Space')).toBe('Space');
    expect(coerceField(f('k'), '')).toBe('');
    expect(coerceField(f('k'), 'a b')).toBe('KeyW');
    expect(coerceField(f('t'), 'abcdefgh')).toBe('abcde');
    expect(coerceField(f('t'), 5)).toBe('hi');
    expect(coerceField(f('who'), 'b_123')).toBe('b_123');
    expect(coerceField(f('who'), 7)).toBe('');
    expect(coerceField(f('route'), 'p_1')).toBe('p_1');
  });

  it('a curve is clamped to its ranges, sorted by x, made a function, and falls back when unusable', () => {
    expect(
      coerceField(f('curve'), [
        [0.5, 5],
        [0, -5],
        [0.5, 0],
        [2, 0.25],
        ['a', 1],
      ]),
    ).toEqual([
      [0, -1],
      [0.5, 1],
      [1, 0.25],
    ]);
    expect(coerceField(f('curve'), [[0, 0]])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(coerceField(f('curve'), 'nope')).toEqual([
      [0, 0],
      [1, 1],
    ]);
    const many = Array.from({ length: LIMITS.maxCurvePoints + 40 }, (_, i) => [i / 1000, 0]);
    expect((coerceField(f('curve'), many) as number[][]).length).toBe(LIMITS.maxCurvePoints);
  });

  it('sanitizeParams drops unknown keys, fills the missing ones and runs the def’s own repair', () => {
    const p = sanitizeParams(ALL, { n: 3, zzz: 1 });
    expect(Object.keys(p).sort()).toEqual(ALL.fields.map((x) => x.key).sort());
    expect(p.n).toBe(3);
    expect(p.e).toBe('a');
    const solo = componentDef('testSolo')!;
    expect(sanitizeParams(solo, { x: 1000 }).x).toBe(100);
    expect(sanitizeParams(solo, null).x).toBe(1);
  });

  it('defaultParams hands out fresh arrays (editing one component never edits the def)', () => {
    const a = defaultParams(ALL);
    (a.v as number[])[0] = 99;
    (a.curve as number[][])[0][0] = 99;
    const b = defaultParams(ALL);
    expect(b.v).toEqual([1, 2, 3]);
    expect(b.curve).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('makeComponent', () => {
  it('creates a component with defaults, a unique id and the overrides sanitised', () => {
    const a = makeComponent('constantForce');
    const b = makeComponent('constantForce', { force: [0, 0, 5], space: 'bogus' });
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ type: 'constantForce', enabled: true });
    expect(a.params.force).toEqual([0, 10, 0]);
    expect(b.params.force).toEqual([0, 0, 5]);
    expect(b.params.space).toBe('world'); // invalid enum value repaired
    expect(makeComponent('constantForce', {}, false).enabled).toBe(false);
    expect(() => makeComponent('nope')).toThrow(/unknown component type/);
  });
});

describe('sanitizeComponents', () => {
  it('keeps order, repairs params and warns about what it drops', () => {
    const report = newReport();
    const out = sanitizeComponents(
      [
        { id: 'c1', type: 'constantForce', enabled: false, params: { force: [1, 2, 3], junk: 1 } },
        { type: 'sineMover', params: { amplitude: -5 } },
        { type: 'sineMover', params: {} }, // unique: the second one goes
        { type: 'teleporter9000' },
        { type: 'testSolo' }, // joints only
        'garbage',
        null,
      ],
      'body',
      report,
      '"Crate"',
    );
    expect(out.map((c) => c.type)).toEqual(['constantForce', 'sineMover']);
    expect(out[0]).toMatchObject({ id: 'c1', enabled: false });
    expect(out[0].params.force).toEqual([1, 2, 3]);
    expect('junk' in out[0].params).toBe(false);
    expect(out[1].enabled).toBe(true);
    expect(out[1].params.amplitude).toBe(0);
    expect(out[1].id).toMatch(/^c_/);
    const w = report.warnings.join('\n');
    expect(w).toMatch(/Unknown component "teleporter9000" on "Crate"/);
    expect(w).toMatch(/cannot be attached to a body/);
    expect(w).toMatch(/two "Sine mover" components/);
  });

  it('is empty for anything that is not a list, and limits the list', () => {
    expect(sanitizeComponents(undefined, 'body', undefined, 'x')).toEqual([]);
    expect(sanitizeComponents({ 0: 1 }, 'body', undefined, 'x')).toEqual([]);
    const report = newReport();
    const many = Array.from({ length: LIMITS.maxComponentsPerEntity + 10 }, () => ({ type: 'constantForce' }));
    expect(sanitizeComponents(many, 'body', report, 'x').length).toBe(LIMITS.maxComponentsPerEntity);
    expect(report.warnings.join()).toMatch(/more than 32 components/);
  });

  it('repeated ids inside one entity are made unique', () => {
    const out = sanitizeComponents(
      [
        { id: 'same', type: 'constantForce' },
        { id: 'same', type: 'constantForce' },
      ],
      'body',
      undefined,
      'x',
    );
    expect(new Set(out.map((c) => c.id)).size).toBe(2);
  });
});

describe('references between entities', () => {
  const withRefs = () => {
    const target = body('Target');
    const owner = body('Owner', {
      components: [makeComponent('testAllFields', { who: target.id, route: 'p_missing', joint: target.id })],
    });
    return { target, owner };
  };

  it('are repaired on load: missing entities, paths that are not paths, wrong entity kinds', () => {
    const { target, owner } = withRefs();
    const doc: SceneDocument = { ...newDocument('t'), entities: [target, owner] };
    const report = newReport();
    const back = sanitizeDocument(JSON.parse(serializeDocument(doc)) as unknown, report);
    const o = back.entities.find((e) => e.id === owner.id) as BodyEntity;
    expect(o.components[0].params.who).toBe(target.id); // fine: a body
    expect(o.components[0].params.route).toBe(''); // no such path
    expect(o.components[0].params.joint).toBe(''); // a body is not a joint
    expect(report.warnings.join()).toMatch(/2 component reference\(s\)/);
  });

  it('repairComponentRefs counts what it clears and keeps good references', () => {
    const { target, owner } = withRefs();
    const list: Entity[] = [target, owner];
    expect(repairComponentRefs(list)).toBe(2);
    expect(repairComponentRefs(list)).toBe(0);
  });

  it('deleting the entity a component points at clears the reference in the same undo step', () => {
    const { target, owner } = withRefs();
    const s = new SceneStore();
    s.add([target, owner]);
    s.remove([target.id]);
    expect(s.body(owner.id)!.components[0].params.who as string).toBe('');
    s.undo();
    expect(s.body(owner.id)!.components[0].params.who).toBe(target.id);
    expect(s.size).toBe(2);
  });

  it('a clone gets new component ids and its references follow the copies cloned with it', () => {
    const target = body('Target');
    const owner = body('Owner', { components: [makeComponent('testAllFields', { who: target.id })] });
    const lone = body('Lone', { components: [makeComponent('testAllFields', { who: target.id })] });
    const copies = cloneEntities([target, owner, lone], [target.id, owner.id]);
    const [tc, oc] = copies as BodyEntity[];
    expect(oc.components[0].id).not.toBe(owner.components[0].id);
    expect(oc.components[0].params.who).toBe(tc.id); // follows the copy of its target
    const lc = cloneEntities([target, owner, lone], [lone.id])[0] as BodyEntity;
    expect(lc.components[0].params.who).toBe(target.id); // the target was not copied: keeps pointing at the original
    expect(lone.components[0].params.who).toBe(target.id);
  });

  it('cloneComponents does not touch its input', () => {
    const c = makeComponent('testAllFields', { who: 'b_1' });
    const copy = cloneComponents([c], new Map([['b_1', 'b_2']]));
    expect(c.params.who).toBe('b_1');
    expect(copy[0].params.who).toBe('b_2');
    expect(copy[0].params).not.toBe(c.params);
  });

  it('component ids are unique across the whole scene after loading', () => {
    const a = body('A', { components: [makeComponent('constantForce')] });
    const b = body('B', { components: [{ ...a.components[0] }] });
    const list: Entity[] = [a, b];
    expect(dedupeComponentIds(list)).toBe(1);
    expect(
      new Set([...(list[0] as BodyEntity).components, ...(list[1] as BodyEntity).components].map((c) => c.id)).size,
    ).toBe(2);
  });
});

describe('documents', () => {
  it('bodies and joints keep their components through JSON, in order, with their enabled flags', () => {
    const a = body('A', {
      components: [
        makeComponent('constantForce', { force: [0, 3, 0] }),
        makeComponent('sineMover', { amplitude: 2 }, false),
      ],
    });
    const j: JointEntity = createJoint({ type: 'hinge', bodyA: a.id, bodyB: null, anchorA: [0, 0, 0] });
    j.components = [makeComponent('testSolo', { x: 7 })];
    const doc: SceneDocument = { ...newDocument('c'), entities: [a, j] };
    const back = parseDocument(serializeDocument(doc));
    expect(back.version).toBe(SCENE_VERSION);
    expect(back.entities).toEqual([a, j]);
  });

  it('a v2 file without components loads with empty lists; an unknown type is dropped with a warning', () => {
    const raw = JSON.parse(serializeDocument({ ...newDocument('v'), entities: [body('A')] })) as {
      version: number;
      entities: { components?: unknown }[];
    };
    raw.version = 2;
    delete raw.entities[0].components;
    const upgraded = sanitizeDocument(raw);
    expect((upgraded.entities[0] as BodyEntity).components).toEqual([]);
    raw.entities[0].components = [{ type: 'warpDrive', params: {} }, { type: 'constantForce' }];
    const report = newReport();
    const b = sanitizeDocument(raw, report).entities[0] as BodyEntity;
    expect(b.components.map((c: ComponentSpec) => c.type)).toEqual(['constantForce']);
    expect(report.warnings.join()).toMatch(/Unknown component "warpDrive"/);
  });

  it('every store edit of a component list is undoable', () => {
    const s = new SceneStore();
    const a = body('A');
    s.add([a]);
    const c = makeComponent('constantForce');
    s.update(a.id, { components: [c] }, 'Add component');
    expect(s.body(a.id)!.components).toEqual([c]);
    s.update(a.id, { components: [{ ...c, enabled: false }] }, 'Toggle');
    expect(s.body(a.id)!.components[0].enabled).toBe(false);
    s.undo();
    expect(s.body(a.id)!.components[0].enabled).toBe(true);
    s.undo();
    expect(s.body(a.id)!.components).toEqual([]);
  });
});
