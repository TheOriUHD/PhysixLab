/**
 * The ready-made zones (Add tab, commands, prefabs, examples): every preset builds a valid zone body that survives the
 * sanitiser unchanged, runs in the engine and does what its action says.
 */
import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/factory';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { newReport } from '../src/model/errors';
import { buildZone, zoneActionOf, ZONE_PRESETS } from '../src/model/zonePresets';
import { ZONE_ACTIONS, type ZoneAction } from '../src/model/zones';
import { PhysicsWorld } from '../src/physics/world';
import { docOf } from './helpers';
import { ball, runCollect, SPACE } from './zonesHelpers';

describe('zone presets', () => {
  it('there is a preset for every action, with the right action, and a tile colour from the action table', () => {
    expect(Object.keys(ZONE_PRESETS).sort()).toEqual(ZONE_ACTIONS.map((a) => a.id).sort());
    for (const a of ZONE_ACTIONS) {
      const [zone] = buildZone(a.id);
      expect(zoneActionOf(zone), a.id).toBe(a.id);
      expect(zone.ghost && zone.bodyType === 'static', `${a.id}: a static ghost body`).toBe(true);
      expect(zone.material.color).toBe(a.color);
    }
  });

  it('every preset round-trips through the sanitiser without a single repair', () => {
    for (const a of ZONE_ACTIONS) {
      const doc = newDocument(a.id);
      doc.entities = buildZone(a.id, { at: [4, 0, -2] });
      const report = newReport();
      const back = sanitizeDocument(JSON.parse(serializeDocument(doc)), report);
      expect(report.warnings, a.id).toEqual([]);
      expect(back.entities, a.id).toEqual(doc.entities);
    }
  });

  it('helpers are wired: the teleporter points at its marker, the spawner at its template, the plate at its updraft', () => {
    const [tp, marker] = buildZone('teleport', { at: [0, 0, 0] });
    expect(tp.components[0].params.target).toBe(marker.id);
    const [sp, template] = buildZone('spawn');
    expect(sp.components[0].params.template).toBe(template.id);
    expect(template.bodyType).toBe('dynamic');
    const [plate, fan] = buildZone('toggle');
    expect(plate.components[0].params.target).toBe(fan.id);
    expect(fan.components[0].enabled).toBe(false); // starts switched off, the plate turns it on
    expect(fan.components[0].params.action).toBe('force');
    const [rp] = buildZone('respawnAt', { at: [5, 0, 5] });
    expect(rp.components[0].params.offset).toEqual([5, 1.2, 5]);
  });

  it('checkpoints are numbered and named by their number; names stay unique through the editor’s hook', () => {
    const [c3] = buildZone('checkpoint', { index: 3 });
    expect(c3.name).toBe('Checkpoint 3');
    expect(c3.components[0].params.index).toBe(3);
    const names = new Set<string>();
    const unique = (b: string) => {
      let n = b;
      for (let i = 2; names.has(n); i++) n = `${b} ${i}`;
      names.add(n);
      return n;
    };
    expect([
      buildZone('kill', { uniqueName: unique })[0].name,
      buildZone('kill', { uniqueName: unique })[0].name,
    ]).toEqual(['Kill zone', 'Kill zone 2']);
  });

  it('a zone sits on the ground: its lower face is at y = 0 (the bubble and the coin float at their own height)', () => {
    for (const a of ['checkpoint', 'kill', 'launch', 'teleport'] as ZoneAction[]) {
      const [z] = buildZone(a, { at: [0, 0, 0] });
      expect(z.position[1] - z.shape.size[1] / 2, a).toBeCloseTo(0, 9);
    }
    expect(buildZone('gravity')[0].position[1]).toBe(5);
  });

  it('every preset runs in the engine; the ones that react to a body do so', async () => {
    for (const a of ZONE_ACTIONS) {
      const entities = buildZone(a.id, { at: [0, 0, 0] });
      const zone = entities[0];
      // a ball dropped into the middle of the zone
      const b = ball([zone.position[0], zone.position[1], zone.position[2]]);
      const w = await PhysicsWorld.create(docOf([...entities, b], SPACE));
      const ev = runCollect(w, 0.6);
      expect(w.missingRuntimes(), a.id).toEqual([]);
      expect(
        ev.some((e) => e.name === 'enter'),
        `${a.id}: enter event`,
      ).toBe(true);
    }
  });

  it('the launch pad launches, the kill zone kills, the coin scores, the teleporter teleports, the spawner spawns', async () => {
    const run = async (a: ZoneAction, seconds = 0.6) => {
      const entities = buildZone(a, { at: [0, 0, 0] });
      const z = entities[0];
      const b = ball([z.position[0], z.position[1], z.position[2]]);
      const w = await PhysicsWorld.create(docOf([...entities, b], SPACE));
      return runCollect(w, seconds).map((e) => e.name);
    };
    expect(await run('launch')).toContain('launch');
    expect(await run('kill')).toContain('kill');
    expect(await run('score')).toContain('score');
    expect(await run('teleport')).toContain('teleport');
    expect(await run('spawn', 2)).toContain('spawn');
    expect(await run('toggle')).toContain('toggle');
    expect(await run('sound')).toContain('sound');
    expect(await run('custom')).toContain('custom');
  });

  it('survives a file round trip with its references intact', () => {
    const doc = newDocument('t');
    doc.entities = [...buildZone('teleport'), ...buildZone('spawn', { at: [20, 0, 0] })];
    const back = parseDocument(serializeDocument(doc));
    const zone = back.entities[0];
    expect(zone.kind === 'body' && zone.components[0].params.target).toBe(back.entities[1].id);
  });
});
