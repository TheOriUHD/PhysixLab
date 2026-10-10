/**
 * A fuel tank that really is part of the body: the fuel's mass is added to the body when the component starts, taken
 * off as it burns, and given back when the component goes away. Burning is done in two halves around the force of the
 * step (`burnHalf` before applying it, again after), so the impulse of a step is applied at the body's *mean* mass of
 * that step — which makes the discrete sum equal to the rocket equation  Δv = v_e·ln(m₀ / m₁)  to second order.
 *
 * The engine keeps the changed mass properties in its snapshots, so a restored world has the right mass already; the
 * tank only has to remember how much it contributed (`added`) so it can give it back correctly.
 */
import type { BodyHandle } from '../context';

export class Fuel {
  /** Fuel left, kg. */
  left = 0;
  /** Mass this tank is currently contributing to the body, kg (equal to `left` between steps). */
  added = 0;
  /** Burned in the first half of the current step, so the second half takes the rest. */
  private pending = 0;

  attach(body: BodyHandle | null, kg: number): void {
    this.left = Math.max(0, kg);
    this.added = 0;
    this.pending = 0;
    if (body && body.type === 'dynamic' && this.left > 0) {
      body.setMass(body.mass + this.left);
      this.added = this.left;
    }
  }

  /** Remove whatever the tank still contributes. */
  detach(body: BodyHandle | null): void {
    if (body && this.added > 0 && body.alive) body.setMass(Math.max(1e-6, body.mass - this.added));
    this.added = 0;
  }

  /** Burn `kg` over a step: half now (before the force is applied), the other half in `finish`. */
  begin(body: BodyHandle | null, kg: number): number {
    const burn = Math.min(Math.max(0, kg), this.left);
    this.pending = burn;
    if (burn > 0 && body && this.added > 0) body.setMass(Math.max(1e-6, body.mass - burn / 2));
    return burn;
  }

  /** Complete the step's burn. */
  finish(body: BodyHandle | null): void {
    const burn = this.pending;
    this.pending = 0;
    if (burn <= 0) return;
    this.left = Math.max(0, this.left - burn);
    if (body && this.added > 0) {
      body.setMass(Math.max(1e-6, body.mass - burn / 2));
      this.added = Math.max(0, this.added - burn);
    }
  }

  save(): { left: number; added: number } {
    return { left: this.left, added: this.added };
  }

  /** After a snapshot restore: the body already has the mass it had when the snapshot was taken. */
  restore(body: BodyHandle | null, saved: { left?: number; added?: number } | null): void {
    if (!saved) return;
    // `attach` ran on the freshly created component and added a full tank; take that back, then adopt the saved state
    if (body && body.alive && this.added > 0) body.setMass(Math.max(1e-6, body.mass - this.added));
    this.left = saved.left ?? this.left;
    this.added = saved.added ?? this.added;
    this.pending = 0;
  }
}
