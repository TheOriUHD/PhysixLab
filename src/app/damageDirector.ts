/**
 * VZ-41: feeds impact events into the damage model and the body views. Listens to the contact feed while damage is
 * enabled; the accumulated values vanish when the simulation returns to edit mode (Reset / Stop).
 */
import { DamageModel, damageKindOf, type DamageSettings } from '../render/damage';
import { GROUND_ID, type ContactEvent } from '../physics/protocol';
import type { App } from './app';

export class DamageDirector {
  readonly model = new DamageModel();
  private release: (() => void) | null = null;

  constructor(private readonly app: App) {
    app.sim.on('mode', (m) => {
      if (m === 'edit') this.reset();
    });
    app.prefs.on('change', (keys) => {
      if (keys.includes('damage')) this.apply();
    });
    this.apply();
  }

  get settings(): DamageSettings {
    return this.app.prefs.value.damage;
  }

  private apply(): void {
    const s = this.settings;
    this.model.settings = s;
    if (s.enabled && !this.release) {
      this.release = this.app.contacts.acquire(
        'damage',
        { minImpulse: 0.5, pairInterval: 0.05, maxPerFrame: 32 },
        (ev) => this.onContact(ev),
      );
    } else if (!s.enabled && this.release) {
      this.release();
      this.release = null;
      this.reset();
    }
  }

  private onContact(ev: ContactEvent): void {
    for (const id of [ev.a, ev.b]) {
      if (id === GROUND_ID) continue;
      const view = this.app.bodies.get(id);
      if (!view || view.def.bodyType === 'static') continue;
      view.setDamage(this.model.hit(id, damageKindOf(view.def.material), ev.speed));
    }
  }

  /** Damage of a body, 0..1. */
  damageOf(id: string): number {
    return this.model.get(id);
  }

  /** Forget one body's damage (or all of it). */
  repair(id?: string): void {
    if (id === undefined) return this.reset();
    this.model.set(id, 0);
    this.app.bodies.get(id)?.setDamage(0);
  }

  private reset(): void {
    this.model.reset();
    for (const v of this.app.bodies.views.values()) v.setDamage(0);
  }
}
