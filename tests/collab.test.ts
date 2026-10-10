import { describe, expect, it } from 'vitest';
import { DocSync } from '../src/collab/docSync';
import { OP_LIMITS, Replica, parseOp, parseOps, type Op } from '../src/collab/opLog';
import { Session, chunkOps, type SimBridge, type SimMode } from '../src/collab/session';
import { LoopbackBus, createLoopbackPair, decodeSignal, encodeSignal } from '../src/collab/transport';
import { createBody } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import type { BodyEntity } from '../src/model/types';

const box = (name: string, x = 0) => createBody({ name, shape: { type: 'box' }, position: [x, 0.5, 0] });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const shuffle = <T>(a: T[], seed: number): T[] => {
  const out = [...a];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const state = (r: Replica) => JSON.stringify(r.materialize());

describe('op log (CRDT-lite)', () => {
  it('replicas applying the same operations in different orders (with duplicates) converge', () => {
    const a = new Replica('siteAAAA');
    const b = new Replica('siteBBBB');
    const c = new Replica('siteCCCC');
    const ops: Op[] = [];
    ops.push(...a.localAdd('e1', { name: 'one', x: 1 }), ...a.localAdd('e2', { name: 'two' }));
    b.applyAll(ops); // B has seen A's creations, so its delete of e2 is causally later
    ops.push(b.localSet('e1', 'x', 2), b.localSet('e1', 'name', 'uno'), b.localDel('e2'));
    ops.push(c.localSet('e1', 'x', 3), ...c.localAdd('e3', { name: 'three' }), c.localCfg('gravity', [0, -3, 0]));
    ops.push(a.localCfg('@name', 'scene'), a.localSet('e1', 'x', undefined));
    const results = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const r = new Replica(`rep${seed}xx`);
      const order = shuffle(ops, seed);
      r.applyAll(order);
      r.applyAll(shuffle(ops, seed + 100)); // every operation delivered twice
      results.add(state(r));
    }
    expect([...results]).toHaveLength(1);
    const final = JSON.parse([...results][0]) as { entities: { id: string }[]; cfg: Record<string, unknown> };
    expect(final.entities.map((e) => e.id).sort()).toEqual(['e1', 'e3']); // e2 deleted by B
    expect(final.cfg.gravity).toEqual([0, -3, 0]);
  });

  it('duplicates and echoes change nothing and report false (this is what stops relay loops)', () => {
    const a = new Replica('siteAAAA');
    const [add, set] = a.localAdd('e1', { x: 1 });
    const b = new Replica('siteBBBB');
    expect(b.apply(add)).toBe(true);
    expect(b.apply(add)).toBe(false);
    expect(b.apply(set)).toBe(true);
    expect(b.apply(set)).toBe(false);
    expect(a.apply(set)).toBe(false); // an echo of our own operation
  });

  it('concurrent edits of one field resolve deterministically (higher clock, then site id)', () => {
    const mk = () => [new Replica('siteAAAA'), new Replica('siteBBBB')] as const;
    const [a, b] = mk();
    const base = a.localAdd('e', { v: 0 });
    b.applyAll(base);
    const oa = a.localSet('e', 'v', 'from-A');
    const ob = b.localSet('e', 'v', 'from-B'); // same clock: the larger site id wins
    a.apply(ob);
    b.apply(oa);
    expect(state(a)).toBe(state(b));
    expect((a.materialize().entities[0] as { v: string }).v).toBe('from-B');
    // a later edit (higher Lamport clock) beats an earlier one regardless of site
    const oa2 = a.localSet('e', 'v', 'late-A');
    b.apply(oa2);
    expect((b.materialize().entities[0] as { v: string }).v).toBe('late-A');
  });

  it('a delete beats a concurrent edit, and a later re-add resurrects the entity', () => {
    const a = new Replica('siteAAAA');
    const b = new Replica('siteBBBB');
    const base = a.localAdd('e', { v: 1 });
    b.applyAll(base);
    const del = a.localDel('e');
    const edit = b.localSet('e', 'v', 2);
    a.apply(edit);
    b.apply(del);
    expect(a.materialize().entities).toEqual([]);
    expect(state(a)).toBe(state(b));
    const readd = b.localAdd('e', { v: 3 });
    a.applyAll(readd);
    expect(state(a)).toBe(state(b));
    expect((a.materialize().entities[0] as { v: number }).v).toBe(3);
  });

  it('operations arriving before the entity exists are held until its add arrives', () => {
    const a = new Replica('siteAAAA');
    const ops = a.localAdd('e', { v: 1 });
    const r = new Replica('siteBBBB');
    r.applyAll(ops.slice(1)); // fields first
    expect(r.materialize().entities).toEqual([]);
    r.apply(ops[0]);
    expect(r.materialize().entities).toHaveLength(1);
  });

  it('snapshot() reproduces the state on a fresh replica', () => {
    const a = new Replica('siteAAAA');
    a.localAdd('e', { v: 1, w: [1, 2] });
    a.localDel('gone');
    a.localCfg('@name', 'n');
    const b = new Replica('siteBBBB');
    b.applyAll(a.snapshot());
    expect(state(b)).toBe(state(a));
  });
});

describe('malicious payloads are rejected (peers are untrusted)', () => {
  it('parseOp refuses malformed operations', () => {
    const good = { k: 'set', c: 1, s: 'siteAAAA', e: 'e1', f: 'x', v: 1 };
    expect(parseOp(good)).toEqual(good);
    const bad: unknown[] = [
      null,
      'x',
      42,
      [],
      { ...good, c: 0 },
      { ...good, c: 1.5 },
      { ...good, c: 2 ** 60 },
      { ...good, c: '1' },
      { ...good, s: 'a' },
      { ...good, s: 'bad site!' },
      { ...good, e: '' },
      { ...good, e: 'x'.repeat(65) },
      { ...good, f: '__proto__' },
      { ...good, f: 'constructor' },
      { ...good, f: 'a.b' },
      { ...good, f: 'x'.repeat(49) },
      { ...good, k: 'drop' },
      { ...good, v: 'x'.repeat(OP_LIMITS.maxValueChars + 1) },
      { k: 'cfg', c: 1, s: 'siteAAAA', f: '__proto__', v: { polluted: 1 } },
    ];
    for (const b of bad) expect(parseOp(b)).toBeNull();
    // extra properties are dropped
    expect(parseOp({ ...good, evil: 'x' })).toEqual(good);
  });

  it('parseOps refuses non-arrays and over-long batches, counts rejected entries', () => {
    expect(parseOps('nope').ops).toEqual([]);
    expect(
      parseOps(new Array(OP_LIMITS.maxOpsPerMessage + 1).fill({ k: 'add', c: 1, s: 'siteAAAA', e: 'e' })).ops,
    ).toEqual([]);
    const r = parseOps([{ k: 'add', c: 1, s: 'siteAAAA', e: 'e' }, { k: 'nope' }, 7]);
    expect(r.ops).toHaveLength(1);
    expect(r.rejected).toBe(2);
  });

  it('a replica never grows beyond its caps and never touches Object.prototype', () => {
    const r = new Replica('siteAAAA');
    for (let i = 0; i < OP_LIMITS.maxFieldsPerEntity + 10; i++)
      r.apply({ k: 'set', c: i + 1, s: 'siteBBBB', e: 'e', f: `f${i}`, v: i });
    r.apply({ k: 'add', c: 999, s: 'siteBBBB', e: 'e' });
    expect(Object.keys(r.materialize().entities[0]).length).toBe(OP_LIMITS.maxFieldsPerEntity + 1); // + id
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('signalling blobs are validated', () => {
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
    expect(decodeSignal(encodeSignal('offer', sdp), 'offer')).toBe(sdp);
    expect(() => decodeSignal(encodeSignal('offer', sdp), 'answer')).toThrow(/offer here|answer here|not an/);
    expect(() => decodeSignal('hello', 'offer')).toThrow(/connection code/);
    expect(() => decodeSignal('PLRTC1.@@@@', 'offer')).toThrow(/damaged/);
    expect(() => decodeSignal(encodeSignal('offer', 'not sdp'), 'offer')).toThrow(/valid session/);
    expect(() => decodeSignal('PLRTC1.' + 'A'.repeat(50_000), 'offer')).toThrow(/too long/);
  });
});

describe('transport', () => {
  it('a loopback pair delivers in order, both ways, and refuses sends after close', async () => {
    const [a, b] = createLoopbackPair();
    const got: string[] = [];
    b.on('message', (m) => got.push(m));
    const back: string[] = [];
    a.on('message', (m) => back.push(m));
    await wait(1);
    expect(a.state).toBe('open');
    a.send('1');
    a.send('2');
    b.send('x');
    await wait(1);
    expect(got).toEqual(['1', '2']);
    expect(back).toEqual(['x']);
    a.close();
    expect(() => a.send('3')).toThrow();
  });
});

describe('DocSync (store <-> replica)', () => {
  const pair = () => {
    const sa = new SceneStore();
    const sb = new SceneStore();
    const toB: Op[][] = [];
    const toA: Op[][] = [];
    const da = new DocSync(sa, new Replica('siteAAAA'), (o) => toB.push(o));
    const db = new DocSync(sb, new Replica('siteBBBB'), (o) => toA.push(o));
    da.attach();
    db.attach();
    const pump = () => {
      for (const o of toB.splice(0)) db.applyRemote(o);
      for (const o of toA.splice(0)) da.applyRemote(o);
    };
    return { sa, sb, da, db, toA, toB, pump };
  };

  it('add / edit / delete / settings / name on one store appear on the other, without echo', () => {
    const { sa, sb, pump, toA, toB } = pair();
    const b1 = box('one');
    sa.add([b1]);
    pump();
    expect(sb.body(b1.id)?.name).toBe('one');
    sa.update(b1.id, { name: 'renamed', position: [3, 1, 2] });
    sa.updateSettings({ gravity: [0, -3.7, 0] });
    sa.setName('Shared');
    pump();
    expect(sb.body(b1.id)?.name).toBe('renamed');
    expect(sb.body(b1.id)?.position).toEqual([3, 1, 2]);
    expect(sb.settings.gravity).toEqual([0, -3.7, 0]);
    expect(sb.name).toBe('Shared');
    sa.remove([b1.id]);
    pump();
    expect(sb.has(b1.id)).toBe(false);
    // nothing bounced back: after the pumps both queues are empty
    expect(toA).toHaveLength(0);
    expect(toB).toHaveLength(0);
  });

  it('a remote batch is a single "Remote edit" undo step and does not re-broadcast', () => {
    const { sa, sb, pump, toA } = pair();
    sa.transact('many', () => sa.add([box('a'), box('b', 1), box('c', 2)], 'Add three'));
    pump();
    expect(sb.size).toBe(3);
    expect(sb.undoLabel).toBe('Remote edit');
    sb.undo(); // local undo of a remote batch is a new local edit that propagates back
    pump();
    expect(sb.size).toBe(0);
    expect(sa.size).toBe(0);
    expect(toA).toHaveLength(0);
  });

  it('concurrent edits of different fields both survive; same field resolves identically on both sides', () => {
    const { sa, sb, pump } = pair();
    const b1 = box('one');
    sa.add([b1]);
    pump();
    sa.update(b1.id, { name: 'A-name' });
    sb.update(b1.id, { position: [9, 9, 9] });
    sa.update(b1.id, { layer: 'from-a' });
    sb.update(b1.id, { layer: 'from-b' });
    pump();
    const x = sa.body(b1.id) as BodyEntity;
    const y = sb.body(b1.id) as BodyEntity;
    expect(x.name).toBe('A-name');
    expect(x.position).toEqual([9, 9, 9]);
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
  });

  it('hostile entity data from a peer is sanitised before it reaches the store', () => {
    const sb = new SceneStore();
    const db = new DocSync(sb, new Replica('siteBBBB'), () => undefined);
    db.attach();
    const evil = new Replica('siteEEEE');
    const ops = evil.localAdd('evil1', {
      kind: 'body',
      name: 'x'.repeat(5000),
      position: [1e30, Number.NaN, -1e30],
      shape: { type: 'no-such-shape', size: [1e9, 1e9, 1e9] },
      mass: -5,
      __proto__: { polluted: true },
      onclick: 'alert(1)',
    });
    ops.push(...evil.localAdd('evil2', { kind: 'garbage' }));
    ops.push(evil.localCfg('gravity', 'not a vector'));
    const parsed = parseOps(JSON.parse(JSON.stringify(ops)));
    db.applyRemote(parsed.ops);
    const e = sb.body('evil1');
    expect(e).toBeDefined();
    expect(e!.name.length).toBeLessThanOrEqual(120);
    expect(Math.abs(e!.position[0])).toBeLessThanOrEqual(1_000_000);
    expect(Number.isFinite(e!.position[1])).toBe(true);
    expect((e as unknown as Record<string, unknown>).onclick).toBeUndefined();
    expect(sb.has('evil2')).toBe(false);
    expect(Array.isArray(sb.settings.gravity)).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

class FakeSim implements SimBridge {
  m: SimMode = 'edit';
  private cbs = new Set<(m: SimMode) => void>();
  mode() {
    return this.m;
  }
  set(m: SimMode) {
    this.user(m);
  }
  /** What a user pressing play / pause / reset does. */
  user(m: SimMode) {
    this.m = m;
    for (const cb of [...this.cbs]) cb(m);
  }
  onMode(cb: (m: SimMode) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
}

describe('Session over a loopback bus', () => {
  const setup = () => {
    const bus = new LoopbackBus();
    const hs = new SceneStore();
    const hostBox = box('host box');
    hs.add([hostBox]);
    const hsim = new FakeSim();
    const host = new Session({ store: hs, sim: hsim, name: 'Hana', site: 'hostSite1', flushMs: 1 });
    host.startHost();
    host.addLink(bus.link());
    const mkGuest = async (site: string, name: string) => {
      const store = new SceneStore();
      store.add([box('stale local')]);
      const sim = new FakeSim();
      const s = new Session({ store, sim, name, site, flushMs: 1, joinTimeoutMs: 500 });
      s.join(bus.link());
      await wait(40);
      return { store, sim, s };
    };
    return { bus, hs, hsim, host, hostBox, mkGuest };
  };

  it('a guest joins, receives the host document (replacing its own), and three peers stay in sync', async () => {
    const { hs, host, hostBox, mkGuest } = setup();
    const g1 = await mkGuest('guestAAA1', 'Ann');
    const g2 = await mkGuest('guestBBB2', 'Ben');
    expect(g1.s.status).toBe('live');
    expect(g1.store.all().map((e) => e.name)).toEqual(['host box']);
    expect(g2.store.size).toBe(1);
    expect(host.peers.map((p) => p.name).sort()).toEqual(['Ann', 'Ben']);
    expect(g1.s.peers.map((p) => p.name).sort()).toEqual(['Ben', 'Hana']);
    // guest edits reach host and the other guest
    const gb = box('from Ann', 4);
    g1.store.add([gb]);
    await wait(40);
    expect(hs.body(gb.id)?.name).toBe('from Ann');
    expect(g2.store.body(gb.id)?.name).toBe('from Ann');
    // host edit reaches both
    hs.update(hostBox.id, { name: 'renamed by host' });
    await wait(40);
    expect(g1.store.body(hostBox.id)?.name).toBe('renamed by host');
    expect(g2.store.body(hostBox.id)?.name).toBe('renamed by host');
    // no echo storm: operation counts stay bounded (each remote op applied once, duplicates ignored)
    expect(host.stats.appliedOps).toBeLessThan(40);
    expect(JSON.stringify(g1.store.all())).toBe(JSON.stringify(hs.all()));
    expect(JSON.stringify(g2.store.all())).toBe(JSON.stringify(hs.all()));
  });

  it('shares selections as presence and drops them when a peer leaves', async () => {
    const { host, hostBox, hs, mkGuest } = setup();
    const g1 = await mkGuest('guestAAA1', 'Ann');
    hs.setSelection([hostBox.id]);
    await wait(40);
    const hostSeenByGuest = g1.s.peers.find((p) => p.site === 'hostSite1');
    expect(hostSeenByGuest?.selection).toEqual([hostBox.id]);
    expect(hostSeenByGuest?.color).toMatch(/^hsl\(/);
    g1.store.setSelection([hostBox.id]);
    await wait(40);
    expect(host.peers.find((p) => p.site === 'guestAAA1')?.selection).toEqual([hostBox.id]);
    g1.s.leave();
    await wait(40);
    expect(host.peers.find((p) => p.site === 'guestAAA1')).toBeUndefined();
  });

  it('the host is authoritative for the simulation; guests follow and cannot override', async () => {
    const { hsim, mkGuest } = setup();
    const g = await mkGuest('guestAAA1', 'Ann');
    const notices: string[] = [];
    g.s.on('notice', (n) => notices.push(n));
    hsim.user('running');
    await wait(40);
    expect(g.sim.m).toBe('running');
    g.sim.user('paused'); // the guest tries to pause
    expect(g.sim.m).toBe('running');
    expect(notices.join(' ')).toMatch(/host controls/);
    hsim.user('paused');
    await wait(20);
    expect(g.sim.m).toBe('paused');
    hsim.user('edit'); // host reset
    await wait(20);
    expect(g.sim.m).toBe('edit');
  });

  it('a guest joining a running host starts in the host mode', async () => {
    const { hsim, mkGuest } = setup();
    hsim.user('running');
    const g = await mkGuest('guestAAA1', 'Ann');
    expect(g.sim.m).toBe('running');
  });

  it('garbage, spoofed and oversized messages are rejected without effect', async () => {
    const { bus, hs, host, mkGuest } = setup();
    await mkGuest('guestAAA1', 'Ann');
    const evil = bus.link();
    await wait(5);
    const before = JSON.stringify(hs.all());
    evil.send('not json');
    evil.send('[]');
    evil.send(JSON.stringify({ t: 'ops', from: 'bad id!', ops: [] }));
    evil.send(JSON.stringify({ t: 'whatever', from: 'evilSite1' }));
    evil.send(JSON.stringify({ t: 'sim', from: 'evilSite1', mode: 'running' }));
    evil.send(
      JSON.stringify({
        t: 'ops',
        from: 'evilSite1',
        ops: [{ k: 'set', c: 5, s: 'evilSite1', e: 'x', f: '__proto__', v: 1 }, 'x', null],
      }),
    );
    evil.send(JSON.stringify({ t: 'ops', from: 'evilSite1', ops: 'nope' }));
    await wait(30);
    expect(JSON.stringify(hs.all())).toBe(before);
    expect(host.stats.rejectedMessages).toBeGreaterThanOrEqual(5);
    expect(host.stats.rejectedOps).toBeGreaterThanOrEqual(3);
  });

  it('an unanswered join times out with a helpful notice', async () => {
    const bus = new LoopbackBus();
    const store = new SceneStore();
    const s = new Session({ store, sim: new FakeSim(), site: 'lonelyGue', flushMs: 1, joinTimeoutMs: 30 });
    const notices: string[] = [];
    s.on('notice', (n) => notices.push(n));
    s.join(bus.link());
    await wait(80);
    expect(s.status).toBe('closed');
    expect(notices.join(' ')).toMatch(/No host answered/);
  });

  it('a forged far-future clock or a spoofed author site cannot wedge or impersonate', async () => {
    const { bus, hs, host, hostBox, mkGuest } = setup();
    await mkGuest('guestAAA1', 'Ann');
    const evil = bus.link();
    await wait(5);
    const clockBefore = host.replica.lamport;
    evil.send(
      JSON.stringify({
        t: 'ops',
        from: 'evilSite1',
        ops: [
          { k: 'set', c: 2 ** 48, s: 'evilSite1', e: hostBox.id, f: 'name', v: 'wedged' },
          { k: 'set', c: clockBefore + 5, s: 'guestAAA1', e: hostBox.id, f: 'name', v: 'spoofed' },
        ],
      }),
    );
    await wait(60);
    expect(host.replica.lamport).toBe(clockBefore);
    expect(hs.body(hostBox.id)?.name).toBe('host box');
    expect(host.stats.rejectedOps).toBeGreaterThanOrEqual(2);
    // the log is still live: a normal host edit still wins and propagates
    hs.update(hostBox.id, { name: 'still works' });
    await wait(40);
    expect(hs.body(hostBox.id)?.name).toBe('still works');
  });

  it('host-only messages (sim, bye) from a non-host are ignored by guests', async () => {
    const { bus, hsim, mkGuest } = setup();
    const g = await mkGuest('guestAAA1', 'Ann');
    const evil = bus.link();
    await wait(5);
    evil.send(JSON.stringify({ t: 'sim', from: 'evilSite1', mode: 'running' }));
    evil.send(JSON.stringify({ t: 'bye', from: 'evilSite1' }));
    await wait(30);
    expect(g.sim.m).toBe(hsim.m);
    expect(g.s.status).toBe('live');
  });

  it('rate-limits a flooding peer per sender', async () => {
    let t = 0;
    const store = new SceneStore();
    const s = new Session({
      store,
      sim: new FakeSim(),
      site: 'hostSite1',
      now: () => t,
      rate: { burst: 5, perSec: 1 },
    });
    s.startHost();
    const bus = new LoopbackBus();
    s.addLink(bus.link());
    const evil = bus.link();
    await wait(5);
    for (let i = 0; i < 50; i++) evil.send(JSON.stringify({ t: 'presence', from: 'evilSite1', sel: [] }));
    await wait(30);
    expect(s.stats.rateLimited).toBe(45);
    t += 10_000; // bucket refills
    evil.send(JSON.stringify({ t: 'presence', from: 'evilSite1', sel: [] }));
    await wait(10);
    expect(s.stats.rateLimited).toBe(45);
  });

  it('coalesces a burst of remote messages into few document writes', async () => {
    const { hs, host, mkGuest } = setup();
    const g = await mkGuest('guestAAA1', 'Ann');
    let commits = 0;
    hs.on('change', () => commits++);
    const bodies = Array.from({ length: 30 }, (_, i) => box(`b${i}`, i));
    for (const b of bodies) g.store.add([b]);
    await wait(150);
    expect(hs.size).toBe(31);
    expect(commits).toBeLessThan(30);
    expect(host.stats.appliedOps).toBeGreaterThan(30);
  });
});

describe('chunkOps', () => {
  it('splits by serialized size as well as by count, never dropping an op', () => {
    const big = (i: number): Op => ({ k: 'set', c: i + 1, s: 'siteAAAA', e: 'e', f: 'x', v: 'y'.repeat(1000) });
    const ops = Array.from({ length: 50 }, (_, i) => big(i));
    const chunks = chunkOps(ops, 1000, 10_000);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.flat()).toEqual(ops);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThan(12_000);
    expect(chunkOps(ops, 7, 1e9).map((c) => c.length)).toEqual([7, 7, 7, 7, 7, 7, 7, 1]);
    expect(chunkOps([])).toEqual([]);
  });
});
