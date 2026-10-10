/**
 * Impact effects (FX-2, FX-6): which particles a contact produces. The inputs are real engine events — a ball dropped
 * onto the ground reports impulse and approach speed — so the energy scale is checked against ½·m·v², and the
 * material pairs against what they should look like (sparks from steel on ground, chips from a struck crate, shards
 * from glass, scuffs from rubber, dust from stone and ground).
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_PRESETS } from '../src/model/materials';
import { GROUND_ID, type ContactEvent } from '../src/physics/protocol';
import {
  dustTint,
  impactBursts,
  impactEnergy,
  impactIntensity,
  impactLevel,
  registerFxSurface,
  relativeTint,
  surfaceFor,
  type ImpactBurst,
} from '../src/render/fx/surfaces';
import { createBody, worldOf } from './helpers';

const types = (b: ImpactBurst[]) => b.map((x) => x.type);
const countOf = (b: ImpactBurst[], type: string) => b.filter((x) => x.type === type).reduce((n, x) => n + x.count, 0);

/** Drop a body from `height` metres above the ground and return its first contact event and its mass. */
async function drop(preset: string, diameter: number, height: number) {
  const body = createBody({
    shape: { type: 'sphere', size: [diameter, diameter, diameter] },
    position: [0, height + diameter / 2, 0],
    material: preset,
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
  });
  const w = await worldOf([body]);
  w.configureEvents({ contacts: true, pairInterval: 100, minImpulse: 0 });
  const t = Math.sqrt((2 * height) / 9.81) + 0.5;
  const events: ContactEvent[] = [];
  for (let i = 0; i < Math.round(t * w.settings.physicsHz); i++) {
    w.stepOnce();
    if (i % 2 === 1) for (const e of w.drainEvents()) if (e.kind === 'contact') events.push(e);
  }
  expect(events.length).toBeGreaterThan(0);
  return { ev: events[0], mass: w.builtInfo().mass[body.id], restitution: body.material.restitution };
}

const burstsFor = (ev: ContactEvent, preset: string, size = 0.5): ImpactBurst[] =>
  impactBursts({
    speed: ev.speed,
    impulse: ev.impulse,
    a: surfaceFor(preset),
    b: surfaceFor(ev.b === GROUND_ID ? 'ground' : ev.matB, '#2b3038'),
    bIsGround: ev.b === GROUND_ID,
    size,
  });

describe('impact energy and level', () => {
  it('½·J·v from the engine matches the kinetic energy of the fall (½·m·v²·(1 + e))', async () => {
    for (const [preset, d, h] of [
      ['steel', 0.3, 2],
      ['wood', 0.4, 5],
      ['rubber', 0.2, 1],
    ] as const) {
      const { ev, mass, restitution } = await drop(preset, d, h);
      const v = Math.sqrt(2 * 9.81 * h);
      const e = Math.max(restitution, 0.1); // restitution combines as a maximum with the ground's 0.1
      const expected = 0.5 * mass * v * v * (1 + e);
      expect(impactEnergy(ev.speed, ev.impulse), preset).toBeGreaterThan(expected * 0.88);
      expect(impactEnergy(ev.speed, ev.impulse), preset).toBeLessThan(expected * 1.12);
    }
  });

  it('the level is logarithmic, bounded and monotonic: 0.3 J → 0, 30 kJ → 1', () => {
    expect(impactLevel(0)).toBe(0);
    expect(impactLevel(-5)).toBe(0);
    expect(impactLevel(0.3)).toBeCloseTo(0, 6);
    expect(impactLevel(30000)).toBeCloseTo(1, 6);
    expect(impactLevel(1e9)).toBe(1);
    let last = -1;
    for (let e = 0.1; e < 1e5; e *= 1.7) {
      const l = impactLevel(e);
      expect(l).toBeGreaterThanOrEqual(last);
      last = l;
    }
    expect(impactLevel(30)).toBeCloseTo(0.4, 6); // two decades above 0.3 J out of five
  });
});

describe('impact intensity', () => {
  it('rises with speed and with energy; a slow touch of a heavy body is weaker than a fast one', () => {
    expect(impactIntensity(0.1, 0)).toBe(0);
    expect(impactIntensity(1, 4000 * 1.1)).toBeLessThan(impactIntensity(20, 4000 * 1.1 * 20));
    let last = -1;
    for (let v = 1; v <= 30; v += 2) {
      const x = impactIntensity(v, 50 * v);
      expect(x).toBeGreaterThanOrEqual(last);
      expect(x).toBeLessThanOrEqual(1);
      last = x;
    }
  });
});

describe('surface profiles', () => {
  it('every material preset has a profile with sane numbers, and the colours follow the body', () => {
    for (const p of MATERIAL_PRESETS) {
      const s = surfaceFor(p.id);
      expect(s.hardness, p.id).toBeGreaterThanOrEqual(0);
      expect(s.hardness, p.id).toBeLessThanOrEqual(1);
      expect(s.brittle).toBeGreaterThanOrEqual(0);
      expect(s.color.every((c) => c >= 0 && c <= 1.0001)).toBe(true);
      expect(s.color).toEqual(s.base); // unpainted
    }
    const red = surfaceFor('wood', '#cc2222');
    expect(red.color[0]).toBeGreaterThan(red.base[0] * 1.2);
    expect(relativeTint(red)[0]).toBeGreaterThan(1.2); // red chips from a red-painted crate
    expect(relativeTint(surfaceFor('wood'))).toEqual([1, 1, 1]);
  });

  it('a material nobody described gets a profile from its physical numbers; a package can describe its own', () => {
    expect(surfaceFor('unobtainium').cls).toBe('plastic'); // unknown id
    const off = registerFxSurface('unobtainium', {
      cls: 'metal',
      hardness: 1,
      brittle: 0,
      dust: 0,
      spark: 1,
      chip: null,
      skid: null,
    });
    expect(surfaceFor('unobtainium').cls).toBe('metal');
    off();
    expect(surfaceFor('unobtainium').cls).toBe('plastic');
  });

  it('dust is paler than what it came off', () => {
    const t = dustTint(surfaceFor('ground', '#2b3038'));
    expect(t.every((c) => c >= 0 && c <= 1)).toBe(true);
    const ground = surfaceFor('ground', '#2b3038').color;
    expect(t[0]).toBeGreaterThan(ground[0]);
  });
});

describe('impact recipes from real contacts', () => {
  it('gentle contacts make no effect, however heavy the body', async () => {
    const { ev } = await drop('steel', 1, 0.02); // a 4 t ball dropped 2 cm: slow, heavy
    // free fall gives 0.63 m/s; the 2 mm contact prediction distance (SH) reports the contact a step or two later
    expect(ev.speed).toBeLessThan(0.8);
    expect(burstsFor(ev, 'steel')).toEqual([]);
  });

  it('a steel ball on the ground throws sparks and dust, both upward', async () => {
    const { ev } = await drop('steel', 0.3, 3);
    const b = burstsFor(ev, 'steel');
    expect(types(b)).toContain('spark');
    expect(types(b)).toContain('dust');
    expect(b.every((x) => x.dir === 1)).toBe(true); // ground: everything goes up the normal
  });

  it('rubber on the ground scuffs and puffs, but never sparks', async () => {
    const { ev } = await drop('rubber', 0.4, 3);
    const t = types(burstsFor(ev, 'rubber'));
    expect(t).toContain('scuff.rubber');
    expect(t).not.toContain('spark');
  });

  it('a wooden crate landing hard sheds wood chips; dropped gently it does not', async () => {
    const hard = await drop('wood', 0.5, 6);
    expect(types(burstsFor(hard.ev, 'wood'))).toContain('chip.wood');
    const soft = await drop('wood', 0.5, 0.4);
    expect(types(burstsFor(soft.ev, 'wood'))).not.toContain('chip.wood');
  });

  it('glass shatters into shards with glints; steel does not', async () => {
    const { ev } = await drop('glass', 0.3, 4);
    const t = types(burstsFor(ev, 'glass'));
    expect(t).toContain('shard.glass');
    expect(t).toContain('glint');
    expect(types(burstsFor((await drop('steel', 0.3, 4)).ev, 'steel'))).not.toContain('shard.glass');
  });

  it('concrete and ice shed their own fragments; foam only crumbs at speed', async () => {
    expect(types(burstsFor((await drop('concrete', 0.5, 6)).ev, 'concrete'))).toContain('chip.stone');
    expect(types(burstsFor((await drop('ice', 0.4, 5)).ev, 'ice'))).toContain('shard.ice');
    expect(types(burstsFor((await drop('foam', 0.5, 0.5)).ev, 'foam'))).not.toContain('crumb.foam');
  });

  it('effects scale with the impulse: more energy, more particles — and never past the cap', async () => {
    const counts: number[] = [];
    for (const h of [1, 2, 4, 8, 16, 32]) {
      const { ev } = await drop('steel', 0.4, h);
      counts.push(countOf(burstsFor(ev, 'steel'), 'spark') + countOf(burstsFor(ev, 'steel'), 'dust'));
    }
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0] * 1.5);
    for (const b of impactBursts({
      speed: 80,
      impulse: 1e7,
      a: surfaceFor('steel'),
      b: surfaceFor('ground'),
      bIsGround: true,
    }))
      expect(b.count).toBeLessThanOrEqual(36);
  });

  it('sizes follow the body: a big body makes bigger puffs than a small one', () => {
    const mk = (size: number) =>
      impactBursts({
        speed: 5,
        impulse: 200,
        a: surfaceFor('steel'),
        b: surfaceFor('ground'),
        bIsGround: true,
        size,
      }).find((x) => x.type === 'dust')!;
    expect(mk(2).scale).toBeGreaterThan(mk(0.1).scale);
  });

  it('body against body: sparks fly from both sides, chips from the struck one in its own direction', () => {
    const b = impactBursts({
      speed: 8,
      impulse: 3000,
      a: surfaceFor('steel'),
      b: surfaceFor('steel'),
      bIsGround: false,
      size: 0.5,
    });
    const sparks = b.filter((x) => x.type === 'spark');
    expect(sparks.map((s) => s.dir).sort()).toEqual([-1, 1]);
    // steel on wood: the wood sheds chips, the steel does not
    const w = impactBursts({
      speed: 9,
      impulse: 3000,
      a: surfaceFor('steel'),
      b: surfaceFor('wood'),
      bIsGround: false,
      size: 0.5,
    });
    const chip = w.find((x) => x.type === 'chip.wood')!;
    expect(chip.from).toBe('b');
    expect(chip.dir).toBe(-1);
    expect(w.some((x) => x.type === 'chip.wood' && x.from === 'a')).toBe(false);
  });

  it('only very hard hits on brittle materials throw debris chunks, flagged as candidates for physical fragments (FX-6)', () => {
    const glass = surfaceFor('glass');
    const hit = (speed: number, impulse: number) =>
      impactBursts({ speed, impulse, a: surfaceFor('steel'), b: glass, bIsGround: false, size: 0.5 });
    expect(types(hit(3, 40))).not.toContain('debris'); // a tap: shards, no chunks
    const big = hit(12, 20000).find((x) => x.type === 'debris');
    expect(big).toBeDefined();
    expect(big!.physical).toBe(true);
    expect(big!.count).toBeLessThanOrEqual(14);
    // metal is not brittle: no debris however hard
    expect(
      types(
        impactBursts({ speed: 20, impulse: 1e5, a: surfaceFor('steel'), b: surfaceFor('steel'), bIsGround: false }),
      ),
    ).not.toContain('debris');
  });
});
