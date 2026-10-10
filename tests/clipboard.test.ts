/**
 * ED-21: the clipboard envelope (build / parse / paste planning) and its app layer (localStorage persistence,
 * scene loads, hostile payloads).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../src/core/math';
import {
  CLIPBOARD_FORMAT,
  MAX_CLIPBOARD_CHARS,
  buildClipboard,
  parseClipboard,
  planPaste,
  serializeClipboard,
} from '../src/model/edit/clipboard';
import {
  CLIPBOARD_KEY,
  copyToClipboard,
  pasteEnvelope,
  pasteStored,
  pasteText,
  readClipboardText,
  resetClipboardMemory,
  setClipboardNotifier,
} from '../src/app/edit/clipboard';
import { makeMeshAsset } from '../src/model/assets';
import { createBody, createGroup, createJoint, newDocument } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import type { BodyEntity, Entity, JointEntity } from '../src/model/types';
import { isBody, isJoint } from '../src/model/types';

const box = (name: string, position: Vec3, over: Partial<BodyEntity> = {}) =>
  createBody({ name, shape: { type: 'box', size: [1, 1, 1] }, position, ...over });

const TRI = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

class MemoryStorage {
  data = new Map<string, string>();
  quota = Infinity;
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  resetClipboardMemory();
  setClipboardNotifier(null);
});

function sceneWithRig() {
  const s = new SceneStore();
  const a = box('A', [0, 0.5, 0]);
  const b = box('B', [2, 0.5, 0]);
  const out = box('Out', [6, 0.5, 0]);
  const inner = createJoint({
    type: 'hinge',
    bodyA: a.id,
    bodyB: b.id,
    anchorA: [1, 0, 0],
    anchorB: [-1, 0, 0],
    name: 'Hinge',
  });
  const tie = createJoint({
    type: 'spring',
    bodyA: b.id,
    bodyB: out.id,
    anchorA: [0.5, 0, 0],
    anchorB: [-0.5, 0, 0],
    name: 'Tie',
  });
  s.add([a, b, out, inner, tie]);
  return { s, a, b, out, inner, tie };
}

describe('clipboard envelope', () => {
  it('round-trips bodies, the joint between them and nothing else', () => {
    const { s, a, b, inner } = sceneWithRig();
    const env = buildClipboard(s.all(), {}, [a.id, b.id], 'My scene')!;
    expect(env.format).toBe(CLIPBOARD_FORMAT);
    expect(env.sceneName).toBe('My scene');
    expect(
      env.entities
        .filter(isBody)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['A', 'B']);
    expect(env.entities.filter(isJoint).map((j) => j.name)).toEqual(['Hinge', 'Tie']); // Tie is the stand-in below
    expect(env.connections.length).toBe(1);
    const parsed = parseClipboard(serializeClipboard(env))!;
    expect(parsed.report.warnings).toEqual([]);
    expect(parsed.envelope.entities.length).toBe(env.entities.length);
    expect(parsed.envelope.origin).toEqual([1, 0.5, 0]);
    void inner;
  });

  it('the connection stand-in hangs on the world at the far end original anchor', () => {
    const { s, a, b, out } = sceneWithRig();
    const env = buildClipboard(s.all(), {}, [a.id, b.id], 's')!;
    const j = env.entities.find((e) => e.id === env.connections[0]) as JointEntity;
    expect(j.bodyB).toBeNull();
    // out is at x=6 with local anchor (-0.5,0,0) -> world (5.5, 0.5, 0)
    expect(j.anchorB).toEqual([5.5, 0.5, 0]);
    expect(j.bodyA).not.toBe(b.id); // re-pointed at the clipboard's own copy of B
    void out;
  });

  it('plain paste leaves the connections out, "with connections" keeps them, ids are fresh, names unique', () => {
    const { s, a, b } = sceneWithRig();
    const env = buildClipboard(s.all(), {}, [a.id, b.id], 's')!;
    const names = s.all().map((e) => e.name);
    const plain = planPaste(env, names, {});
    expect(plain.entities.filter(isJoint).map((j) => j.name)).toEqual(['Hinge 2']);
    const withConn = planPaste(env, names, { withConnections: true });
    expect(withConn.entities.filter(isJoint).length).toBe(2);
    const ids = new Set(s.all().map((e) => e.id));
    expect(plain.entities.every((e) => !ids.has(e.id))).toBe(true);
    expect(
      plain.entities
        .filter(isBody)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['A 2', 'B 2']);
    // the pasted hinge is attached to the pasted bodies, not the originals
    const copyIds = new Set(plain.entities.filter(isBody).map((e) => e.id));
    const hinge = plain.entities.find(isJoint)!;
    expect(copyIds.has(hinge.bodyA!) && copyIds.has(hinge.bodyB!)).toBe(true);
  });

  it('offsets: in place = 0, at = centre moved to the target (height kept), default = beside the original', () => {
    const { s, a, b } = sceneWithRig();
    const env = buildClipboard(s.all(), {}, [a.id, b.id], 's')!;
    const pos = (o: Parameters<typeof planPaste>[2]) =>
      planPaste(env, [], o)
        .entities.filter(isBody)
        .map((e) => e.position);
    expect(pos({ inPlace: true })).toEqual([
      [0, 0.5, 0],
      [2, 0.5, 0],
    ]);
    expect(pos({ at: [10, 0, 4], inPlace: false })).toEqual([
      [9, 0.5, 4],
      [11, 0.5, 4],
    ]);
    expect(pos({})[0]).toEqual([0.8, 0.5, 0.8]);
    // the world-anchored stand-in moves with the copy
    const conn = planPaste(env, [], { withConnections: true, at: [10, 0, 4] }).entities.filter(isJoint);
    expect(conn.find((j) => j.bodyB === null)!.anchorB).toEqual([5.5 + 9, 0.5, 4]);
  });

  it('copying a group brings its members and keeps the hierarchy', () => {
    const s = new SceneStore();
    const g = createGroup({ name: 'G' });
    const a = box('A', [0, 0.5, 0], { parent: g.id });
    s.add([g, a]);
    const env = buildClipboard(s.all(), {}, [g.id], 's')!;
    const plan = planPaste(env, ['G', 'A']);
    const ng = plan.entities.find((e) => e.kind === 'group')!;
    expect((plan.entities.find(isBody) as BodyEntity).parent).toBe(ng.id);
  });

  it('carries only referenced assets', () => {
    const s = new SceneStore();
    const used = s.addAsset(makeMeshAsset('tri', TRI));
    s.addAsset(makeMeshAsset('other', { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] }));
    const a = box('A', [0, 0.5, 0], { meshId: used });
    const b = box('B', [2, 0.5, 0]);
    s.add([a, b]);
    const env = buildClipboard(s.all(), s.toDocument().assets, [a.id, b.id], 's')!;
    expect(Object.keys(env.assets)).toEqual([used]);
    expect(Object.keys(buildClipboard(s.all(), s.toDocument().assets, [b.id], 's')!.assets)).toEqual([]);
  });

  it('rejects text that is not ours, refuses a newer version and an oversized payload, repairs the rest', () => {
    expect(parseClipboard('hello world')).toBeNull();
    expect(parseClipboard('{"format":"other"}')).toBeNull();
    expect(parseClipboard(`{"format":"${CLIPBOARD_FORMAT}", broken`)).toBeNull();
    expect(() => parseClipboard(JSON.stringify({ format: CLIPBOARD_FORMAT, version: 99, entities: [] }))).toThrow(
      /newer/,
    );
    expect(() =>
      parseClipboard(
        JSON.stringify({ format: CLIPBOARD_FORMAT, version: 1, entities: [], pad: 'x'.repeat(MAX_CLIPBOARD_CHARS) }),
      ),
    ).toThrow(/too large/);
  });

  it('a hostile payload is sanitised like a scene: bad numbers clamped, unknown kinds and dangling joints dropped', () => {
    const good = box('Good', [0, 0.5, 0]);
    const hostile = {
      format: CLIPBOARD_FORMAT,
      version: 1,
      sceneVersion: 1,
      entities: [
        { ...good, position: [1e300, 'x', null], mass: 'evil', __proto__: { polluted: true } },
        { kind: 'virus', id: 'v1' },
        { kind: 'joint', id: 'j1', type: 'hinge', bodyA: 'ghost', bodyB: null },
        'string',
        null,
      ],
      assets: { as1: { kind: 'texture', dataUrl: 'javascript:alert(1)' } },
      connections: ['j1', 42, 'nothere'],
    };
    const parsed = parseClipboard(JSON.stringify(hostile))!;
    const env = parsed.envelope;
    expect(env.entities.length).toBe(1);
    const b = env.entities[0] as BodyEntity;
    expect(b.position.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.abs(b.position[0])).toBeLessThan(1e7);
    expect(env.connections).toEqual([]);
    expect(Object.keys(env.assets)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('an envelope with only unusable content yields nothing to paste', () => {
    expect(
      parseClipboard(JSON.stringify({ format: CLIPBOARD_FORMAT, version: 1, entities: [{ kind: 'virus' }] })),
    ).toBeNull();
  });
});

describe('clipboard app layer', () => {
  it('copy writes localStorage and the paste survives loading another scene and a "reload" (memory cleared)', () => {
    const { s, a, b } = sceneWithRig();
    const res = copyToClipboard({ store: s }, [a.id, b.id])!;
    expect(res.persisted).toBe(true);
    expect(storage.getItem(CLIPBOARD_KEY)).toBe(res.text);
    // open a different scene
    const other = new SceneStore();
    other.load(newDocument('Other'));
    other.add([box('A', [0, 0.5, 0])]);
    resetClipboardMemory(); // a reload / a fresh tab: only localStorage remains
    const r = pasteStored({ store: other }, { inPlace: true })!;
    expect(r.ids.length).toBe(3 - 1); // two bodies (the hinge is not a top-level id)
    expect(
      other
        .bodies()
        .map((x) => x.name)
        .sort(),
    ).toEqual(['A', 'A 2', 'B']);
    expect(other.joints().length).toBe(1);
    // one undo removes the whole paste
    expect(other.undoLabel).toBe('Paste');
    other.undo();
    expect(other.size).toBe(1);
    expect(other.selection).not.toContain(a.id);
  });

  it('a quota error keeps the copy pasteable in this tab and does not leave a stale older copy behind', () => {
    const { s, a } = sceneWithRig();
    copyToClipboard({ store: s }, [a.id]);
    const old = storage.getItem(CLIPBOARD_KEY);
    expect(old).not.toBeNull();
    storage.quota = 10;
    const res = copyToClipboard({ store: s }, [s.all()[1].id])!;
    expect(res.persisted).toBe(false);
    expect(storage.getItem(CLIPBOARD_KEY)).toBeNull();
    const target = new SceneStore();
    const r = pasteStored({ store: target })!;
    expect(r.ids.length).toBe(1);
    expect(target.bodies()[0].name).toBe('B');
  });

  it('works without any storage at all', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    });
    const { s, a } = sceneWithRig();
    const res = copyToClipboard({ store: s }, [a.id])!;
    expect(res.persisted).toBe(false);
    expect(pasteStored({ store: new SceneStore() })!.ids.length).toBe(1);
  });

  it('pasteText takes our envelope from the system clipboard, ignores other text and falls back to the stored copy', () => {
    const { s, a, b } = sceneWithRig();
    const text = serializeClipboard(buildClipboard(s.all(), {}, [a.id, b.id], 'x')!);
    const t1 = new SceneStore();
    expect(pasteText({ store: t1 }, text, { inPlace: true })!.ids.length).toBe(2);
    expect(t1.bodies().length).toBe(2);
    const t2 = new SceneStore();
    copyToClipboard({ store: s }, [s.all()[2].id]);
    expect(pasteText({ store: t2 }, 'just some words')!.ids.length).toBe(1);
    expect(t2.bodies()[0].name).toBe('Out');
    expect(pasteText({ store: new SceneStore() }, null)).not.toBeNull();
    storage.data.clear();
    resetClipboardMemory();
    expect(pasteText({ store: new SceneStore() }, 'nothing here')).toBeNull();
  });

  it('reports repairs and refusals through the notifier', () => {
    const msgs: string[] = [];
    setClipboardNotifier((m) => msgs.push(m));
    expect(readClipboardText(JSON.stringify({ format: CLIPBOARD_FORMAT, version: 7, entities: [] }))).toBeNull();
    expect(msgs.join(' ')).toMatch(/newer/);
    const good = box('Good', [0, 0.5, 0]);
    const env = readClipboardText(
      JSON.stringify({
        format: CLIPBOARD_FORMAT,
        version: 1,
        entities: [good, { kind: 'joint', id: 'j', type: 'hinge', bodyA: 'gone', bodyB: null }],
      }),
    );
    expect(env).not.toBeNull();
    expect(msgs.length).toBeGreaterThan(1);
  });

  it('pastes assets through the store (deduplicated) and re-points the mesh reference', () => {
    const src = new SceneStore();
    const meshId = src.addAsset(makeMeshAsset('tri', TRI));
    const a = box('Meshy', [0, 0.5, 0], { meshId });
    src.add([a]);
    const env = buildClipboard(src.all(), src.toDocument().assets, [a.id], 's')!;
    const parsed = parseClipboard(serializeClipboard(env))!;
    expect(Object.keys(parsed.envelope.assets).length).toBe(1);
    const dst = new SceneStore();
    pasteEnvelope({ store: dst }, parsed.envelope);
    pasteEnvelope({ store: dst }, parsed.envelope);
    const ids = dst.bodies().map((b) => b.meshId);
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]); // same content: one asset
    expect(dst.getAsset(ids[0])?.kind).toBe('mesh');
    expect(Object.keys(dst.toDocument().assets).length).toBe(1);
    dst.undo();
    dst.undo();
    expect(dst.bodies().length).toBe(0);
  });
});

describe('entities untouched by copy', () => {
  it('copy does not change the source scene or its history', () => {
    const { s, a } = sceneWithRig();
    const label = s.undoLabel;
    const before = JSON.stringify(s.all());
    copyToClipboard({ store: s }, [a.id]);
    expect(JSON.stringify(s.all())).toBe(before);
    expect(s.undoLabel).toBe(label);
  });

  it('nothing copyable gives null', () => {
    const { s, inner } = sceneWithRig();
    expect(copyToClipboard({ store: s }, [inner.id])).toBeNull();
    expect(copyToClipboard({ store: s }, [])).toBeNull();
    const e: Entity[] = [];
    expect(buildClipboard(e, {}, [], 'x')).toBeNull();
  });
});
