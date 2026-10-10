/**
 * docs/EXTENDING.md is only worth reading if its code works. Every example in it lives as a real file in
 * `tests/examples/` — compiled by `npm run typecheck`, linted, and exercised here against the real registries and the
 * real engine — and the guide must show exactly those files (with their imports rewritten for the folder they say
 * they belong in). If the guide and an example drift apart, or an example stops working, this suite fails.
 * (The examples that need a DOM — the panel and the inspector section — are also loaded into the real app by
 * e2e/tests/registry.mjs.)
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { qrot } from '../src/core/math';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { PrefsStore } from '../src/app/prefs';
import {
  getCommand,
  getTool,
  keymap,
  listMenuEntries,
  listPanels,
  listTools,
  panelRegistry,
  resolveMenu,
  runCommand,
  toolForMode,
  unregisterCommand,
  unregisterMenuEntry,
  unregisterTool,
} from '../src/app/registry';
import { componentDef, makeComponent, registerComponent } from '../src/model/componentRegistry';
import {
  getMap,
  getPrefab,
  getTemplate,
  unregisterMap,
  unregisterPrefab,
  unregisterTemplate,
} from '../src/model/content';
import { defaultSettings, newDocument } from '../src/model/factory';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import {
  listShapes,
  makeShapeSpec,
  registerShape,
  sanitizeShapeSpec,
  shapeBoundingRadius,
  shapeColliders,
  shapeConvexPoints,
  shapeGeometry,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { SceneStore } from '../src/model/store';
import { isBody, type BodyEntity } from '../src/model/types';
import { newReport } from '../src/model/errors';
import { registerRuntime } from '../src/physics/components';
import { initRapier, PhysicsWorld } from '../src/physics/world';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import { hasIcon } from '../src/ui/icons';
import { registerUiBuiltins } from '../src/ui/builtin';
import { createBody, run, worldOf } from './helpers';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8');

beforeAll(async () => {
  await initRapier();
  registerAppBuiltins();
  registerUiBuiltins();
});

// ── the guide shows exactly the example files ──────────────────────────────────────────────────────

/** An example's `../../src/...` imports, rewritten as they would be written in the folder the example belongs in. */
function forItsHome(source: string): string {
  const home = /^\/\/ File: (\S+)/.exec(source)?.[1];
  if (!home) throw new Error('an example must start with "// File: <path it belongs at>"');
  return source.replace(/from '(\.\.\/\.\.\/src\/[^']+)'/g, (_m, spec: string) => {
    let rel = posix.relative(posix.dirname(home), spec.slice('../../'.length));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `from '${rel}'`;
  });
}

describe('docs/EXTENDING.md shows the tested examples', () => {
  const guide = read('docs/EXTENDING.md');
  const blocks = [...guide.matchAll(/<!-- example: (\S+) -->\r?\n```ts\r?\n([\s\S]*?)\r?\n```/g)].map((m) => ({
    file: m[1],
    code: m[2],
  }));
  const files = readdirSync(`${ROOT}tests/examples`).filter((f) => f.endsWith('.ts'));

  it('has every example file exactly once, and nothing else is claimed as an example', () => {
    expect(blocks.map((b) => b.file).sort()).toEqual([...files].sort());
  });

  it('has no TypeScript block that is not one of the tested examples (use another fence for sketches)', () => {
    const fences = (guide.match(/^```ts\b/gm) ?? []).length;
    expect(fences).toBe(blocks.length);
  });

  for (const f of files)
    it(`${f}: the code in the guide is the file, with imports for its home folder`, () => {
      const block = blocks.find((b) => b.file === f);
      expect(block, `${f} appears in the guide`).toBeDefined();
      expect(block!.code.trimEnd()).toBe(forItsHome(read(`tests/examples/${f}`)).trimEnd());
    });
});

// ── a new shape ─────────────────────────────────────────────────────────────────────────────────────

describe('example: a new shape (spire)', () => {
  it('registers, and the engine integrates the mass the definition promises', async () => {
    const { spire } = await import('./examples/spire-shape');
    registerShape(spire);
    expect(listShapes().at(-1)?.id).toBe('spire');
    expect(hasIcon(spire.icon)).toBe(true);

    const spec = makeShapeSpec('spire', [2, 3, 2]);
    expect(shapeVolume(spec)).toBeCloseTo(4, 12); // base × height / 3
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    for (const c of shapeColliders(RAPIER, spec)) world.createCollider(c.desc.setDensity(500), rb);
    expect(rb.mass()).toBeGreaterThan(500 * 4 * 0.98);
    expect(rb.mass()).toBeLessThan(500 * 4 * 1.02);
    world.free();
    // The hull encloses the apex, and the bounding sphere encloses the hull.
    const pts = shapeConvexPoints(spec)!;
    expect(pts).toHaveLength(5);
    for (const p of pts) expect(Math.hypot(...p)).toBeLessThanOrEqual(shapeBoundingRadius(spec) + 1e-9);
  });

  it('is simulated like the built-ins: the centre of mass is a quarter of the height above the base, and it lands on its base', async () => {
    const body = createBody({
      shape: { type: 'spire', size: [2, 3, 2] },
      material: { preset: 'custom', density: 500, friction: 0.8 },
      position: [0, 3, 0],
    });
    const w = await worldOf([body]);
    expect(w.builtInfo().mass[body.id]).toBeCloseTo(2000, -1);
    expect(w.builtInfo().com[body.id][1]).toBeCloseTo(-0.75, 2);
    run(w, 3);
    const p = w.getPose(body.id)!;
    expect(p.position[1]).toBeCloseTo(1.5, 1); // half the height: standing on its base
    expect(Math.abs(p.rotation[3])).toBeGreaterThan(0.999); // and upright
  });

  it('has a mesh that fills its size box, survives saving, and an unknown shape still falls back to a box', () => {
    const spec = makeShapeSpec('spire');
    const g = shapeGeometry(GEOMETRY_KIT, spec);
    g.computeBoundingBox();
    // The shared mesh is built at unit size (the renderer scales it by the body size): base at −½, apex at +½.
    g.boundingBox!.min.toArray().forEach((v) => expect(v).toBeCloseTo(-0.5, 6));
    g.boundingBox!.max.toArray().forEach((v) => expect(v).toBeCloseTo(0.5, 6));
    expect(g.getAttribute('position').count).toBeGreaterThan(8);
    const body = createBody({ shape: { type: 'spire', size: [1, 2, 3] } });
    const loaded = parseDocument(serializeDocument({ ...makeDoc(), entities: [body] }), newReport())
      .entities[0] as BodyEntity;
    expect(loaded.shape.type).toBe('spire');
    expect(loaded.shape.size).toEqual([1, 2, 3]);
    expect(sanitizeShapeSpec({ type: 'nope', size: [1, 1, 1] }).type).toBe('box');
  });
});

const makeDoc = () => newDocument('spire test');

// ── a new component ─────────────────────────────────────────────────────────────────────────────────

describe('example: a new component (spin)', () => {
  it('has a schema that sanitises, a warning for a static owner, and a runtime that does what it says', async () => {
    const { spin: def } = await import('./examples/spin-component-def');
    const { spin: runtime } = await import('./examples/spin-component-runtime');
    registerComponent(def);
    registerRuntime(runtime);
    expect(componentDef('spin')?.label).toBe('Spin');
    expect(makeComponent('spin', { speed: 1e9 }).params.speed).toBe(100); // clamped to the declared range
    expect(makeComponent('spin').params.axis).toEqual([0, 1, 0]);
    const staticBody = createBody({ bodyType: 'static' });
    expect(def.check?.(staticBody, makeComponent('spin').params)).toMatch(/static body cannot spin/);
    expect(def.check?.(createBody({}), makeComponent('spin').params)).toBeNull();

    const body: BodyEntity = {
      ...createBody({
        shape: { type: 'box', size: [1, 1, 1] },
        material: { preset: 'custom', density: 2 },
        gravityScale: 0,
        angularDamping: 0,
        linearDamping: 0,
      }),
      components: [makeComponent('spin', { axis: [0, 0, 1], speed: 3 })],
    };
    const w = await worldOf([body], { gravity: [0, 0, 0], ground: { ...defaultSettings().ground, enabled: false } });
    run(w, 0.5);
    const p = w.getPose(body.id)!;
    expect(p.angvel[2]).toBeCloseTo(3, 4);
    expect(Math.abs(p.angvel[0]) + Math.abs(p.angvel[1])).toBeLessThan(1e-6);
    // The runtime publishes the spin rate for the inspector's gauge.
    const published = Object.values(w.drainComponentState().changed);
    expect(published).toHaveLength(1);
    expect(published[0].values![0]).toBeCloseTo(3, 4);
    // Turning the speed down while running takes effect without a rebuild.
    const layout = w.builtInfo();
    w.applyOp({
      op: 'updateBody',
      body: { ...body, components: [{ ...body.components[0], params: { ...body.components[0].params, speed: -2 } }] },
    });
    run(w, 0.2);
    expect(w.getPose(body.id)!.angvel[2]).toBeCloseTo(-2, 4);
    expect(w.builtInfo()).toEqual(layout);
  });
});

// ── commands, menu entries, tools ───────────────────────────────────────────────────────────────────

/** An app with just enough in it for the examples' `run` functions. */
function fakeApp() {
  const translate = vi.fn();
  const addShape = vi.fn();
  const setTool = vi.fn();
  const app = {
    store: new SceneStore(),
    prefs: new PrefsStore(),
    sim: { active: false, mode: 'edit' },
    editor: { translate, addShape },
    picker: { groundPoint: vi.fn(() => new Vector3(3, 0, -2)) },
    setTool,
    toast: vi.fn(),
  };
  return { app: app as unknown as App, translate, addShape, setTool, raw: app };
}

describe('example: a new command with a shortcut and a menu entry', () => {
  it('registers itself, answers its shortcut, shows in the Edit menu, and acts on the selection', async () => {
    await import('./examples/lift-command');
    const cmd = getCommand('demo.liftSelection')!;
    expect(cmd.label).toBe('Lift selection by 1 m');
    expect(hasIcon(cmd.icon!)).toBe(true);
    expect(keymap.find({ key: 'U', code: 'KeyU', ctrlKey: true, metaKey: false, shiftKey: true })?.id).toBe(
      'demo.liftSelection',
    );

    const { app, translate, raw } = fakeApp();
    expect(runCommand('demo.liftSelection', app), 'nothing selected → not enabled').toBe(false);
    const b = createBody({});
    raw.store.add([b], 'Add');
    raw.store.setSelection([b.id]);
    expect(runCommand('demo.liftSelection', app, 'shortcut')).toBe(true);
    expect(translate).toHaveBeenCalledWith([b.id], [0, 1, 0]);
    raw.sim.active = true;
    expect(runCommand('demo.liftSelection', app), 'not while simulating').toBe(false);
    raw.sim.active = false;

    const edit = resolveMenu(app, 'edit');
    const entry = edit.find((i) => 'label' in i && i.label === 'Lift selection by 1 m');
    expect(entry && 'kbd' in entry ? entry.kbd : null).toBe('Ctrl+Shift+U');
    const labels = edit.map((i) => ('label' in i ? i.label : null));
    expect(labels.indexOf('Lift selection by 1 m')).toBe(labels.indexOf('Rotate selection 90° about Y') + 1);

    unregisterMenuEntry('menu.edit.lift');
    unregisterCommand('demo.liftSelection');
    expect(listMenuEntries('edit').some((e) => e.id === 'menu.edit.lift')).toBe(false);
    expect(getCommand('demo.liftSelection')).toBeUndefined();
  });
});

describe('example: a new tool', () => {
  it('registers a button, a command with its key, and the pointer handler of its mode', async () => {
    await import('./examples/dropper-tool');
    const tool = getTool('dropper')!;
    expect(listTools('toolbox').map((t) => t.id)).toContain('dropper');
    expect(hasIcon(tool.icon)).toBe(true);
    expect(getCommand('tool.dropper')?.shortcut).toBe('D');
    expect(keymap.find({ key: 'd', code: 'KeyD', ctrlKey: false, metaKey: false, shiftKey: false })?.id).toBe(
      'tool.dropper',
    );

    const { app, addShape, setTool, raw } = fakeApp();
    runCommand('tool.dropper', app, 'shortcut');
    expect(setTool).toHaveBeenCalledWith('dropper');
    raw.prefs.set({ tool: 'dropper' });
    expect(getCommand('tool.dropper')?.checked?.(app)).toBe(true);
    // The viewport hands the pointer press to the tool of the active mode.
    toolForMode('dropper')!.pointerDown!(app, { clientX: 10, clientY: 20 } as PointerEvent, {} as never);
    expect(addShape).toHaveBeenCalledWith('sphere', [3, 2, -2]);
    expect(tool.hint?.(app)).toMatch(/drop a ball/i);

    unregisterTool('dropper');
    expect(getCommand('tool.dropper')).toBeUndefined();
    expect(toolForMode('dropper')).toBeUndefined();
  });
});

// ── panel and inspector section (their DOM is exercised by e2e/tests/registry.mjs) ─────────────────

describe('example: a new panel and a new inspector section', () => {
  it('register at import (a panel also gets its "Show …" command)', async () => {
    await import('./examples/stats-panel');
    expect(listPanels('right').map((p) => p.id)).toContain('stats');
    expect(getCommand('panel.stats')?.label).toBe('Show Stats');
    expect(hasIcon(panelRegistry.get('stats')!.icon)).toBe(true);

    await import('./examples/volume-section');
    const { inspectorSectionRegistry, sectionsFor } = await import('../src/app/registry');
    const { app } = fakeApp();
    const body = createBody({ shape: { type: 'box', size: [1, 1, 1] } });
    expect(sectionsFor([body], app).map((s) => s.id)).toEqual(['body', 'volume', 'organise', 'components']);
    expect(sectionsFor([body, createBody({})], app).map((s) => s.id)).toEqual(['body', 'organise']);
    expect(inspectorSectionRegistry.has('volume')).toBe(true);
  });
});

// ── content: template, prefab, map ──────────────────────────────────────────────────────────────────

describe('example: a new template, prefab and map (dropped into src/model/content)', () => {
  it('the template registers itself and its physics shows what its text promises (ice slides, wood creeps, rubber holds)', async () => {
    await import('./examples/ramps-template');
    const t = getTemplate('three-ramps')!;
    expect(t.name).toBe('Three ramps');
    const doc = t.build();
    expect(doc.entities.filter(isBody).filter((b) => b.bodyType === 'static')).toHaveLength(3);
    const loaded = parseDocument(serializeDocument(doc), newReport());
    expect(loaded.entities).toHaveLength(6);

    const w = await PhysicsWorld.create(doc);
    for (let i = 0; i < w.settings.physicsHz; i++) w.stepOnce();
    const slid = (material: string) => {
      const b = doc.entities.filter(isBody).find((x) => x.name === `${material} block`)!;
      const p = w.getPose(b.id)!.position;
      return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]);
    };
    const g = 9.81;
    const a = (mu: number) => g * (Math.sin(Math.PI / 6) - mu * Math.cos(Math.PI / 6));
    // s = ½·a·t² with a = g(sin θ − μ cos θ), the pair friction of equal materials being their own coefficient.
    expect(slid('ice')).toBeGreaterThan(0.5 * a(0.03) * 0.95);
    expect(slid('ice')).toBeLessThan(0.5 * a(0.03) * 1.05);
    expect(slid('wood')).toBeGreaterThan(0.5 * a(0.5) * 0.8);
    expect(slid('wood')).toBeLessThan(0.5 * a(0.5) * 1.2);
    expect(slid('rubber')).toBeLessThan(0.005);
    unregisterTemplate('three-ramps');
  });

  it('the prefab inserts three dominoes and a ball that knocks them over', async () => {
    await import('./examples/domino-prefab');
    const p = getPrefab('domino-trio')!;
    const entities = p.build();
    expect(entities.filter(isBody).map((b) => b.name)).toEqual(['Domino', 'Domino', 'Domino', 'Ball']);
    const w = await worldOf(entities);
    run(w, 2);
    const dominoes = entities.filter(isBody).filter((b) => b.name === 'Domino');
    // The ball topples the first domino, which topples the next, and so on: all three are tilted away from
    // upright (the last lies flat, the others lean on their neighbour).
    const uprightness = dominoes.map((d) => qrot(w.getPose(d.id)!.rotation, [0, 1, 0])[1]);
    expect(
      uprightness.every((u) => u < 0.95),
      `still standing: ${uprightness.join(', ')}`,
    ).toBe(true);
    expect(uprightness[2]).toBeLessThan(0.2);
    unregisterPrefab('domino-trio');
  });

  it('the map registers with its thumbnail, loads clean, and a ball dropped in stays in the court', async () => {
    await import('./examples/court-map');
    const m = getMap('step-court')!;
    expect(m.category).toBe('Arenas');
    const doc = m.build();
    const report = newReport();
    parseDocument(serializeDocument(doc), report);
    expect(report.warnings).toEqual([]);
    expect(doc.entities.filter(isBody).map((b) => b.name)).toEqual(
      expect.arrayContaining(['North wall', 'Tier 1', 'Tier 2', 'Tier 3']),
    );
    const url = typeof m.thumbnail === 'function' ? await m.thumbnail() : m.thumbnail!;
    expect(decodeURIComponent(url)).toContain('<polygon');
    const ball = createBody({
      shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
      position: [1, 4, 1],
      material: 'rubber',
    });
    doc.entities.push(ball);
    const w = await PhysicsWorld.create(doc);
    for (let i = 0; i < 4 * w.settings.physicsHz; i++) w.stepOnce();
    const p = w.getPose(ball.id)!.position;
    expect(Math.abs(p[0]) < 8 && Math.abs(p[2]) < 8 && p[1] > 0).toBe(true);
    unregisterMap('step-court');
  });
});
