/** The Controls panel lists what the scene listens to: keys and axes are found from the components' schemas. */
import { describe, expect, it } from 'vitest';
import { listTemplates } from '../src/model/content';
import { makeComponent } from '../src/model/componentRegistry';
import { describeUse, namesWithRole, sceneControls, shortUse } from '../src/model/controls';
import { createBody, createJoint } from '../src/model/factory';
import { sanitizeDocument } from '../src/model/serialize';
import type { SceneDocument } from '../src/model/types';

const scene = (id: string): SceneDocument => {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) throw new Error(`no example scene "${id}"`);
  return sanitizeDocument(JSON.parse(JSON.stringify(t.build())));
};

describe('sceneControls', () => {
  it('finds a rocket: the F key and the throttle axis, each with where it comes from', () => {
    const c = sceneControls(scene('rocket-launch').entities);
    expect(c.keys.map((k) => k.code)).toEqual(['KeyF']);
    expect(c.axes.map((a) => a.name)).toEqual(['throttle']);
    expect(c.axes[0].uses[0].componentLabel).toBe('Thruster / rocket');
    expect(shortUse(c.keys[0].uses[0])).toBe('Fire'); // one thruster: no "· Thruster 1" suffix
    expect(describeUse(c.axes[0].uses[0])).toContain('Rocket');
  });

  it('every powered example scene has something to press, and every axis it names is a plain name', () => {
    for (const id of [
      'powertrain-car',
      'engine-stand',
      'electric-rover',
      'servo-arm',
      'stepper-dial',
      'lift-table',
      'hydraulic-crane',
      'rocket-launch',
      'jet-car',
      'propeller-cart',
      'helicopter',
    ]) {
      const c = sceneControls(scene(id).entities);
      expect(c.keys.length + c.axes.length, id).toBeGreaterThan(0);
      for (const a of c.axes) expect(a.name, id).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });

  it('the helicopter exposes its analog collective and cyclic', () => {
    const c = sceneControls(scene('helicopter').entities);
    expect(c.axes.map((a) => a.name)).toEqual(['pitch', 'roll']);
    expect(c.keys.map((k) => k.code)).toEqual(
      expect.arrayContaining(['KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE']),
    );
    // the main and the tail rotor both have a "Collective up key": the labels tell them apart
    const label = (code: string) => shortUse(c.keys.find((k) => k.code === code)!.uses[0]);
    expect(label('KeyR')).toBe('Collective up · Rotor / blade set 1');
    expect(label('KeyQ')).toBe('Collective up · Rotor / blade set 2');
    expect(describeUse(c.keys.find((k) => k.code === 'KeyQ')!.uses[0])).toContain('blade set 2');
  });

  it('skips disabled components, empty bindings and groups the users of one key', () => {
    const a = createBody({ name: 'A' });
    const b = createBody({ name: 'B' });
    const on = makeComponent('thruster', { key: 'KeyF', axis: 'push' });
    const off = { ...makeComponent('thruster', { key: 'KeyG', axis: 'other' }), enabled: false };
    const none = makeComponent('thruster', { key: '', axis: '' });
    a.components = [on, off, none];
    b.components = [makeComponent('thruster', { key: 'KeyF', axis: 'push' })];
    const c = sceneControls([a, b]);
    expect(c.keys.map((k) => k.code)).toEqual(['KeyF']);
    expect(c.keys[0].uses.map((u) => u.ownerName)).toEqual(['A', 'B']);
    expect(c.axes.map((x) => x.name)).toEqual(['push']);
  });

  it('includes the keys of a joint motor', () => {
    const j = createJoint({ type: 'hinge', name: 'Wheel hinge', bodyA: null, bodyB: null, anchorA: [0, 0, 0] });
    j.motor = { ...j.motor, mode: 'velocity', keyPos: 'KeyE', keyNeg: 'KeyQ' };
    const c = sceneControls([j]);
    expect(c.keys.map((k) => k.code).sort()).toEqual(['KeyE', 'KeyQ']);
    j.motor = { ...j.motor, mode: 'off' };
    expect(sceneControls([j]).keys).toEqual([]);
  });

  it('namesWithRole lists the axis and shaft names in use, sorted', () => {
    const doc = scene('powertrain-car');
    const shafts = namesWithRole(doc.entities, 'shaft');
    expect(shafts.length).toBeGreaterThan(0);
    expect([...shafts].sort((x, y) => x.localeCompare(y))).toEqual(shafts);
    expect(namesWithRole(scene('rocket-launch').entities, 'axis')).toEqual(['throttle']);
  });
});
