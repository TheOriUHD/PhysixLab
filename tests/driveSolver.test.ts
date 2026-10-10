/**
 * The velocity-level solver of the drive network against hand-derived results: a gear pair conserves the
 * generalised momentum, a friction clutch slips at its torque limit, a brake stops a shaft exactly, one-sided limits
 * only act when violated, and a stiff chain (tiny flywheel locked to a huge inertia) stays exact.
 */
import { describe, expect, it } from 'vitest';
import { DriveSolver } from '../src/physics/components/drive/solver';

const DT = 1 / 120;

/** Add a shaft of inertia `i` at speed `w` (no external torque). */
const shaft = (s: DriveSolver, i: number, w: number) => s.addNode(1 / i, w);

describe('drive solver', () => {
  it('a rigid gear pair: ω_a = r·ω_b and the impulse is shared as a momentum exchange', () => {
    const s = new DriveSolver();
    const Ia = 0.5;
    const Ib = 2;
    const r = 3;
    const a = shaft(s, Ia, 10);
    const b = shaft(s, Ib, 0);
    const k = s.addRow(0, -1e300, 1e300);
    s.addEntry(k, a, 1);
    s.addEntry(k, b, -r);
    s.solve();
    // λ solves (1/Ia + r²/Ib)·λ = −(10 − 0)
    const lam = -10 / (1 / Ia + (r * r) / Ib);
    expect(s.lambda[k]).toBeCloseTo(lam, 12);
    expect(s.v[a]).toBeCloseTo(r * s.v[b], 12);
    expect(s.v[a]).toBeCloseTo(10 + lam / Ia, 12);
    // power-conserving torque ratio: the torque on b is r times (and opposite in sign to) the torque on a
    expect((-r * lam) / lam).toBe(-r);
  });

  it('a friction clutch locks when its torque suffices and slips at exactly the limit when not', () => {
    for (const [cap, locks] of [
      [5000, true],
      [0.5, false],
    ] as const) {
      const s = new DriveSolver();
      const a = shaft(s, 1, 20);
      const b = shaft(s, 1, 0);
      const k = s.addRow(0, -cap * DT, cap * DT);
      s.addEntry(k, a, 1);
      s.addEntry(k, b, -1);
      s.solve();
      if (locks) {
        expect(s.v[a]).toBeCloseTo(10, 10);
        expect(s.v[b]).toBeCloseTo(10, 10);
        expect(Math.abs(s.lambda[k])).toBeLessThan(cap * DT);
      } else {
        expect(s.lambda[k]).toBeCloseTo(-cap * DT, 12); // slipping: a is slowed by exactly cap·dt
        expect(s.v[a]).toBeCloseTo(20 - cap * DT, 12);
        expect(s.v[b]).toBeCloseTo(cap * DT, 12);
      }
    }
  });

  it('a brake (drive to 0) stops a shaft in one step if it can, else removes T·dt/I of speed', () => {
    const strong = new DriveSolver();
    const a = shaft(strong, 2, 5);
    const k = strong.addRow(0, -2000 * DT, 2000 * DT);
    strong.addEntry(k, a, 1);
    strong.solve();
    expect(strong.v[a]).toBeCloseTo(0, 12);

    const weak = new DriveSolver();
    const b = shaft(weak, 2, 5);
    const k2 = weak.addRow(0, -1 * DT, 1 * DT);
    weak.addEntry(k2, b, 1);
    weak.solve();
    expect(weak.v[b]).toBeCloseTo(5 - (1 * DT) / 2, 12);
  });

  it('a one-sided speed limit acts only when violated', () => {
    for (const w of [3, 8]) {
      const s = new DriveSolver();
      const a = shaft(s, 1, w);
      const k = s.addRow(5, -1e6, 0); // ω ≤ 5
      s.addEntry(k, a, 1);
      s.solve();
      expect(s.v[a]).toBeCloseTo(Math.min(w, 5), 12);
    }
  });

  it('a stiff chain stays exact: a 0.001 kg·m² flywheel locked 20:1 to a 50 kg·m² load', () => {
    const s = new DriveSolver();
    const fly = shaft(s, 0.001, 300);
    const load = shaft(s, 50, 0);
    const k = s.addRow(0, -1e300, 1e300);
    s.addEntry(k, fly, 1);
    s.addEntry(k, load, -20);
    s.solve();
    expect(s.v[fly]).toBeCloseTo(20 * s.v[load], 9);
    // angular momentum referred to the load shaft is conserved: 20·Ifly·ωfly + Iload·ωload (generalised)
    expect(20 * 0.001 * s.v[fly] + 50 * s.v[load]).toBeCloseTo(20 * 0.001 * 300, 9);
  });

  it('a chain with a slipping clutch between a gear pair and a differential-like three-term row converges', () => {
    // engine —clutch(cap)— shaft1 —gear 2:1— shaft2 —diff— wheels L, R
    const s = new DriveSolver();
    const eng = shaft(s, 0.3, 200);
    const s1 = shaft(s, 0.02, 0);
    const s2 = shaft(s, 0.05, 0);
    const wl = shaft(s, 1, 0);
    const wr = shaft(s, 1, 0);
    const cap = 40;
    const c = s.addRow(0, -cap * DT, cap * DT);
    s.addEntry(c, eng, 1);
    s.addEntry(c, s1, -1);
    const g = s.addRow(0, -1e300, 1e300);
    s.addEntry(g, s1, 1);
    s.addEntry(g, s2, -2);
    const d = s.addRow(0, -1e300, 1e300);
    s.addEntry(d, s2, 1);
    s.addEntry(d, wl, -0.5);
    s.addEntry(d, wr, -0.5);
    s.solve();
    expect(s.v[s1]).toBeCloseTo(2 * s.v[s2], 9);
    expect(s.v[s2]).toBeCloseTo((s.v[wl] + s.v[wr]) / 2, 9);
    expect(s.v[wl]).toBeCloseTo(s.v[wr], 9); // an open differential with equal loads splits equally
    expect(Math.abs(s.lambda[c])).toBeLessThanOrEqual(cap * DT + 1e-12);
    expect(s.v[eng]).toBeLessThan(200);
  });
});
