/**
 * Skid marks (FX-4): the ring buffer of ground strips — continuity, capacity, restarts, clearing and fading — and the
 * mesh that draws it.
 */
import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { MAX_GAP, MIN_STEP, SkidBuffer } from '../src/render/fx/skidBuffer';
import { SKID_FADE_END, SKID_FADE_START, SkidMarkMesh } from '../src/render/fx/skidMesh';

/** Drive a source along a straight line in steps of `step` metres. */
function drive(b: SkidBuffer, key: number, from: number, to: number, step = 0.05, z = 0, width = 0.3, t0 = 0): number {
  let added = 0;
  let stamp = 0;
  for (let x = from; x <= to + 1e-9; x += step) {
    stamp++;
    if (b.extend(key, x, 0.01, z, width, 0.8, 0, t0 + x * 0.01, stamp)) added++;
  }
  return added;
}

describe('SkidBuffer', () => {
  it('adds one segment per MIN_STEP of travel, none while standing still, none for the very first point', () => {
    const b = new SkidBuffer(100);
    expect(b.extend(1, 0, 0, 0, 0.3, 1, 0, 0, 1)).toBe(false); // anchor only
    expect(b.extend(1, MIN_STEP * 0.5, 0, 0, 0.3, 1, 0, 0, 2)).toBe(false); // not far enough
    expect(b.count).toBe(0);
    expect(b.extend(1, MIN_STEP * 1.2, 0, 0, 0.3, 1, 0, 0, 3)).toBe(true);
    expect(b.count).toBe(1);
    const added = drive(b, 2, 0, 3);
    expect(added).toBeGreaterThan(20);
    expect(added).toBeLessThanOrEqual(Math.ceil(3 / MIN_STEP));
  });

  it('builds a continuous strip: each segment starts on the previous one’s end edge, the strip is as wide as asked', () => {
    const b = new SkidBuffer(100);
    drive(b, 1, 0, 2, 0.05, 1, 0.4);
    expect(b.count).toBeGreaterThan(5);
    for (let s = 1; s < b.count; s++) {
      const prev = b.vertices(s - 1);
      const cur = b.vertices(s);
      // start left/right of this segment = end left/right of the previous one
      expect(cur[0]).toEqual(prev[2]);
      expect(cur[1]).toEqual(prev[3]);
    }
    const v = b.vertices(3);
    // travelling along +x: the edge runs along z, 0.4 m across, centred on z = 1, lying on the ground strip height
    expect(Math.abs(v[2][2] - v[3][2])).toBeCloseTo(0.4, 6);
    expect((v[2][2] + v[3][2]) / 2).toBeCloseTo(1, 6);
    expect(v[2][0]).toBeCloseTo(v[3][0], 6);
  });

  it('fades a strip in from nothing and carries birth time, side and tone per vertex', () => {
    const b = new SkidBuffer(100);
    drive(b, 1, 0, 2, 0.05, 0, 0.3, 5);
    const first = b.mark.subarray(0, 16);
    expect(first[2]).toBe(0); // the first segment starts invisible …
    expect(first[10]).toBeGreaterThan(0); // … and ends visible
    expect([first[1], first[5], first[9], first[13]]).toEqual([-1, 1, -1, 1]);
    expect(first[0]).toBeGreaterThanOrEqual(5); // birth time
    const last = b.mark.subarray((b.count - 1) * 16, b.count * 16);
    expect(last[10]).toBeCloseTo(0.8, 6); // full opacity once the ramp is over
  });

  it('is a ring: when full the oldest segments are overwritten, the count never exceeds the capacity', () => {
    const b = new SkidBuffer(50);
    const added = drive(b, 1, 0, 40);
    expect(added).toBeGreaterThan(300);
    expect(b.count).toBe(50);
    expect(b.added).toBe(added);
    // the newest segments are at the head: the last one added is the farthest along
    const xs = Array.from({ length: 50 }, (_, i) => b.vertices(i)[2][0]);
    expect(Math.max(...xs)).toBeGreaterThan(39);
    expect(Math.min(...xs)).toBeGreaterThan(30); // everything old is gone
  });

  it('a lower soft limit applies at once; shrinking below the live count clears (the ring would be inconsistent)', () => {
    const b = new SkidBuffer(200);
    drive(b, 1, 0, 6);
    expect(b.count).toBeGreaterThan(30);
    b.setLimit(25);
    expect(b.count).toBe(0);
    drive(b, 1, 0, 20);
    expect(b.count).toBe(25);
    expect(b.limit).toBe(25);
  });

  it('restarts the strip after a sharp reversal or a jump, so no twisted quad bridges the gap', () => {
    const b = new SkidBuffer(100);
    drive(b, 1, 0, 1);
    const n = b.count;
    // reverse
    let stamp = 100;
    b.extend(1, 0.7, 0.01, 0, 0.3, 1, 0, 0, ++stamp);
    expect(b.count).toBe(n);
    // jump far away
    b.extend(1, 50, 0.01, 0, 0.3, 1, 0, 0, ++stamp);
    expect(b.count).toBe(n);
    expect(MAX_GAP).toBeLessThan(50);
    // and it carries on from the new place
    b.extend(1, 50.5, 0.01, 0, 0.3, 1, 0, 0, stamp + 1);
    expect(b.count).toBe(n + 1);
    const seg = b.vertices(n % 100);
    expect(seg[0][0]).toBeGreaterThan(49);
  });

  it('sources are independent; a source that stops reporting ends its strip', () => {
    const b = new SkidBuffer(200);
    for (let i = 0; i < 40; i++) {
      b.extend(1, i * 0.1, 0.01, 0, 0.3, 1, 0, 0, i + 1);
      b.extend(2, i * 0.1, 0.01, 2, 0.3, 1, 0, 0, i + 1);
      b.endStale(i + 1);
    }
    expect(b.activeStrips).toBe(2);
    expect(b.count).toBeGreaterThan(50);
    b.endStale(9999); // nobody called in this frame
    expect(b.activeStrips).toBe(0);
    // a new strip for the same key starts from scratch (no segment bridges the pause)
    const n = b.count;
    b.extend(1, 10, 0.01, 0, 0.3, 1, 0, 0, 10000);
    expect(b.count).toBe(n);
  });

  it('clear() drops everything: marks and strips in progress', () => {
    const b = new SkidBuffer(100);
    drive(b, 1, 0, 3);
    expect(b.count).toBeGreaterThan(0);
    b.clear();
    expect(b.count).toBe(0);
    expect(b.activeStrips).toBe(0);
    expect(b.takeDirty()).toEqual([0, 99]); // everything must be re-uploaded (the mesh then draws nothing)
  });

  it('reports the slot range written since the last upload', () => {
    const b = new SkidBuffer(100);
    expect(b.takeDirty()).toBeNull();
    drive(b, 1, 0, 1);
    const d = b.takeDirty()!;
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(b.count - 1);
    expect(b.takeDirty()).toBeNull();
  });
});

describe('SkidMarkMesh', () => {
  it('draws the live segments, uploads only what changed, fades by the effects clock and hides when empty', () => {
    const parent = new Group();
    const b = new SkidBuffer(64);
    const m = new SkidMarkMesh(parent, b);
    expect(parent.children).toContain(m.mesh);
    m.sync(0);
    expect(m.mesh.visible).toBe(false);
    drive(b, 1, 0, 2);
    m.sync(3);
    expect(m.mesh.visible).toBe(true);
    expect((m.mesh.material as unknown as { uniforms: { uTime: { value: number } } }).uniforms.uTime.value).toBe(3);
    // The marks fade between the two ages on the shader's uniforms (40 s … 70 s of effects time).
    expect(SKID_FADE_START).toBeLessThan(SKID_FADE_END);
    b.clear();
    m.sync(4);
    expect(m.mesh.visible).toBe(false);
    m.dispose();
    expect(parent.children).not.toContain(m.mesh);
  });

  it('draws no instances while a normal / depth pre-pass overrides the materials', () => {
    const parent = new Group();
    const b = new SkidBuffer(64);
    const m = new SkidMarkMesh(parent, b);
    drive(b, 1, 0, 2);
    m.sync(0);
    const call = (override: object | null) =>
      m.mesh.onBeforeRender(
        {} as never,
        { overrideMaterial: override } as never,
        {} as never,
        m.mesh.geometry,
        m.mesh.material as never,
        null as never,
      );
    call(null);
    expect(m.mesh.geometry.drawRange.count).toBe(b.count * 6);
    call({});
    expect(m.mesh.geometry.drawRange.count).toBe(0);
    call(null);
    expect(m.mesh.geometry.drawRange.count).toBe(b.count * 6);
  });
});
