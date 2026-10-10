/**
 * Connects the signal catalogue to the running application: frame buffers of the physics client, the document for
 * names / gravity, the selection for the `selected` reference and the user's aliases.
 */
import type { App } from '../../app/app';
import { CONTACT_STRIDE } from '../../physics/protocol';
import type { SignalSource, WorldFrame } from './signals';

/** Names that always follow the selection. */
export const SELECTED_REFS = ['selected', 'sel'] as const;

export interface AppSource extends SignalSource {
  /** The user-defined aliases (alias -> entity id); edit through `setAliases`. */
  aliases(): Readonly<Record<string, string>>;
  setAliases(a: Record<string, string>): void;
}

export function createAppSource(app: App, initialAliases: Record<string, string> = {}): AppSource {
  let aliases: Record<string, string> = { ...initialAliases };
  const world: WorldFrame = {
    kinetic: 0,
    rotational: 0,
    potential: 0,
    elastic: 0,
    contacts: 0,
    contactForce: NaN,
    px: 0,
    py: 0,
    pz: 0,
  };
  let worldFrame = -1;
  const client = () => app.sim.client;

  const selectedOf = (kind: 'body' | 'joint'): string | null => {
    for (const id of app.store.selection) {
      if (kind === 'body' ? app.store.body(id) : app.store.joint(id)) return id;
    }
    return null;
  };
  const isKind = (id: string, kind: 'body' | 'joint') => !!(kind === 'body' ? app.store.body(id) : app.store.joint(id));

  return {
    time: () => client().stats?.simTime ?? 0,
    gravity: () => app.store.settings.gravity,
    pose: (id) => client().poseOf(id),
    joint: (id) => client().jointOf(id),
    mass: (id) => client().info.mass[id] ?? 0,
    com: (id) => client().info.com[id] ?? null,
    gravityScale: (id) => app.store.body(id)?.gravityScale ?? 1,
    world() {
      const c = client();
      const st = c.stats;
      if (!st) return null;
      if (worldFrame !== c.frameNo) {
        worldFrame = c.frameNo;
        const e = st.energy;
        world.kinetic = e.kinetic;
        world.rotational = e.rotational;
        world.potential = e.potential;
        world.elastic = e.elastic;
        world.contacts = st.contacts;
        world.px = e.momentum[0];
        world.py = e.momentum[1];
        world.pz = e.momentum[2];
        const buf = c.contacts;
        if (app.sim.wantContacts) {
          let f = 0;
          for (let i = CONTACT_STRIDE - 1; i < buf.length; i += CONTACT_STRIDE) f += buf[i];
          world.contactForce = f;
        } else world.contactForce = NaN;
      }
      return world;
    },
    resolve(ref, kind) {
      const r = ref.trim();
      if ((SELECTED_REFS as readonly string[]).includes(r)) return selectedOf(kind);
      const alias = Object.prototype.hasOwnProperty.call(aliases, r) ? aliases[r] : undefined;
      if (alias && isKind(alias, kind)) return alias;
      if (isKind(r, kind)) return r;
      const list = kind === 'body' ? app.store.bodies() : app.store.joints();
      const exact = list.find((e) => e.name === r);
      if (exact) return exact.id;
      const lower = r.toLowerCase();
      return list.find((e) => e.name.toLowerCase() === lower)?.id ?? null;
    },
    aliases: () => aliases,
    setAliases(a) {
      aliases = { ...a };
    },
  };
}
