import { describe, expect, it } from 'vitest';
import { Builder } from '../src/model/builder';
import {
  getMap,
  getPrefab,
  getTemplate,
  listMaps,
  listPrefabs,
  listTemplates,
  mapCategories,
  onContentChange,
  registerMap,
  registerPrefab,
  registerTemplate,
  templateCategories,
  unregisterMap,
  unregisterPrefab,
  unregisterTemplate,
  type ContentChange,
  type MapInfo,
  type PrefabInfo,
  type TemplateInfo,
} from '../src/model/content';
import { BUILTIN_PREFABS } from '../src/model/prefabs';
import { BUILTIN_TEMPLATES } from '../src/model/templates';

const tiny = () => {
  const b = new Builder('Tiny');
  b.body('Cube', 'box', [1, 1, 1], [0, 0.5, 0]);
  return b.done();
};

const template = (over: Partial<TemplateInfo> = {}): TemplateInfo => ({
  id: 'test-template',
  name: 'Test template',
  category: 'Test',
  blurb: 'b',
  hint: 'h',
  build: tiny,
  ...over,
});
const prefab = (over: Partial<PrefabInfo> = {}): PrefabInfo => ({
  id: 'test-prefab',
  name: 'Test prefab',
  icon: 'box',
  blurb: 'b',
  build: () => tiny().entities,
  ...over,
});
const map = (over: Partial<MapInfo> = {}): MapInfo => ({
  id: 'test-map',
  name: 'Test map',
  description: 'd',
  category: 'Test',
  difficulty: 'easy',
  tags: ['a'],
  objective: 'o',
  spawn: { position: [0, 1, 0] },
  camera: { position: [0, 5, 5], target: [0, 0, 0] },
  build: tiny,
  ...over,
});

describe('content registries: what ships', () => {
  it('registers every built-in example scene and prefab through the registry, in list order', () => {
    // the built-ins come first; content files dropped into the folder by feature packages follow them
    expect(
      listTemplates()
        .slice(0, BUILTIN_TEMPLATES.length)
        .map((t) => t.id),
    ).toEqual(BUILTIN_TEMPLATES.map((t) => t.id));
    expect(
      listPrefabs()
        .slice(0, BUILTIN_PREFABS.length)
        .map((p) => p.id),
    ).toEqual(BUILTIN_PREFABS.map((p) => p.id));
    expect(listTemplates().length).toBeGreaterThanOrEqual(16);
    expect(listPrefabs().length).toBeGreaterThanOrEqual(12);
    expect(getTemplate('car')?.name).toBe('Drivable car');
    expect(getPrefab('pendulum')?.name).toBe('Pendulum');
  });

  it('collects files nobody imports by hand: the map files in the folder are found by the glob', () => {
    const ids = listMaps().map((m) => m.id);
    expect(ids).toContain('empty-arena');
    expect(ids).toContain('sandbox-box');
    expect(listMaps().length).toBeGreaterThanOrEqual(2);
  });

  it('knows the well-known template categories first, in their fixed order', () => {
    const cats = templateCategories();
    expect(cats.slice(0, 6)).toEqual([
      'Vehicles',
      'Mechanisms',
      'Soft bodies',
      'Physics labs',
      'Structures',
      'Playground',
    ]);
    expect(mapCategories()).toContain('Arenas');
  });
});

describe('content registries: registering', () => {
  it('registers a template, prefab and map at run time and removes them again', () => {
    const t0 = listTemplates().length,
      p0 = listPrefabs().length,
      m0 = listMaps().length;
    const offs = [registerTemplate(template()), registerPrefab(prefab()), registerMap(map())];
    expect(listTemplates()).toHaveLength(t0 + 1);
    expect(listPrefabs()).toHaveLength(p0 + 1);
    expect(listMaps()).toHaveLength(m0 + 1);
    expect(listTemplates().at(-1)?.id).toBe('test-template');
    expect(getMap('test-map')?.build().entities).toHaveLength(1);
    offs.forEach((off) => off());
    expect(getTemplate('test-template')).toBeUndefined();
    expect(getPrefab('test-prefab')).toBeUndefined();
    expect(getMap('test-map')).toBeUndefined();
    expect(listTemplates()).toHaveLength(t0);
    expect(unregisterTemplate('test-template')).toBe(false);
    expect(unregisterPrefab('test-prefab')).toBe(false);
    expect(unregisterMap('test-map')).toBe(false);
  });

  it('refuses a duplicate id and says which content it was', () => {
    expect(() => registerTemplate(template({ id: 'car' }))).toThrow(/template "car" is already registered/);
    expect(() => registerPrefab(prefab({ id: 'car' }))).toThrow(/prefab "car" is already registered/);
    expect(() => registerMap(map({ id: 'empty-arena' }))).toThrow(/map "empty-arena" is already registered/);
  });

  it('lists a new template category after the well-known ones', () => {
    const off = registerTemplate(template({ category: 'Zebra' }));
    const off2 = registerTemplate(template({ id: 'test-template-2', category: 'Aardvark' }));
    const cats = templateCategories();
    // new categories (this one, and those feature packages bring) are listed after the well-known ones, alphabetically
    expect(cats.indexOf('Aardvark')).toBeGreaterThanOrEqual(6);
    expect(cats.indexOf('Aardvark')).toBeLessThan(cats.indexOf('Zebra'));
    off();
    off2();
    expect(templateCategories()).not.toContain('Zebra');
  });

  it('emits a change event naming the kind', () => {
    const seen: ContentChange[] = [];
    const stop = onContentChange((c) => seen.push(c));
    const offs = [registerTemplate(template()), registerPrefab(prefab()), registerMap(map())];
    offs.forEach((off) => off());
    stop();
    registerTemplate(template())();
    expect(seen).toEqual([
      { kind: 'template', type: 'register', id: 'test-template' },
      { kind: 'prefab', type: 'register', id: 'test-prefab' },
      { kind: 'map', type: 'register', id: 'test-map' },
      { kind: 'template', type: 'unregister', id: 'test-template' },
      { kind: 'prefab', type: 'unregister', id: 'test-prefab' },
      { kind: 'map', type: 'unregister', id: 'test-map' },
    ]);
  });
});

describe('content registries: malformed definitions are programming errors, reported clearly', () => {
  const bad = <T>(label: string, register: (v: T) => unknown, value: T, message: RegExp) =>
    it(label, () => expect(() => register(value)).toThrow(message));

  bad(
    'template without a name',
    registerTemplate,
    template({ name: ' ' }),
    /template "test-template": name must not be empty/,
  );
  bad('template without a category', registerTemplate, template({ category: '' }), /category must not be empty/);
  bad('template without a hint', registerTemplate, template({ hint: '' }), /hint must not be empty/);
  bad(
    'template without build()',
    registerTemplate,
    template({ build: undefined as unknown as TemplateInfo['build'] }),
    /needs a build\(\) function/,
  );
  bad(
    'template with a broken opening camera',
    registerTemplate,
    template({ view: { position: [0, NaN, 0], target: [0, 0, 0] } }),
    /view.position must be 3 numbers/,
  );
  bad('prefab without an icon', registerPrefab, prefab({ icon: '' }), /icon must not be empty/);
  bad(
    'map with an unknown difficulty',
    registerMap,
    map({ difficulty: 'nightmare' as MapInfo['difficulty'] }),
    /difficulty must be one of sandbox, easy/,
  );
  bad('map with empty tags', registerMap, map({ tags: ['ok', ' '] }), /tags must be a list of non-empty strings/);
  bad('map without an objective', registerMap, map({ objective: '' }), /objective must not be empty/);
  bad(
    'map with a broken spawn',
    registerMap,
    map({ spawn: { position: [0, 0, Infinity] } }),
    /spawn.position must be 3 numbers/,
  );
  bad(
    'map with a broken yaw',
    registerMap,
    map({ spawn: { position: [0, 0, 0], yaw: NaN } }),
    /spawn.yaw must be a number/,
  );
  bad(
    'map with a broken camera target',
    registerMap,
    map({ camera: { position: [0, 1, 1], target: [0, 0] as unknown as [number, number, number] } }),
    /camera.target must be 3 numbers/,
  );
  bad('map with an invalid id', registerMap, map({ id: 'Not Valid' }), /Invalid map id/);

  it('does not leave a half-registered entry behind after a failed registration', () => {
    const n = listMaps().length;
    expect(() => registerMap(map({ difficulty: 'x' as MapInfo['difficulty'] }))).toThrow();
    expect(listMaps()).toHaveLength(n);
    expect(getMap('test-map')).toBeUndefined();
  });
});
