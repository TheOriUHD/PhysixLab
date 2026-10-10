/**
 * Where engine and motor sounds come from (FX-13). A **source** is anything in the scene that turns: a motorised hinge
 * or slider (the joint's own motor), or a component that publishes its speed in its state (`ComponentDef.state`
 * with an entry in rpm, °/s or rad/s — the engine, the electric motor, propellers and rotors, servos — or, for jets
 * and thrusters, a throttle / thrust percentage). Sources are found from the document and the component registry, so a
 * component added by another package sounds like an engine as soon as it publishes its speed; nothing here names a
 * particular component except the table that picks the *kind* of sound (`defaultMotorKind`).
 *
 * `scanSources` is run when the document or the simulation layout changes; `readSource` is cheap and runs every
 * frame to turn the live joint state / component state into an rpm and a load.
 */
import { componentDef } from '../../model/componentRegistry';
import type { BodyEntity, Entity, JointEntity, MotorSpec } from '../../model/types';
import { isBody, isJoint } from '../../model/types';
import { defaultMotorKind, RATED_RPM, type MotorKind } from '../../audio/motor';
import { clamp01 } from '../../audio/mapping';

export interface MotorSource {
  /** Unique key (the voice is kept by it). */
  key: string;
  kind: MotorKind;
  /** The body whose pose positions the sound. */
  bodyId: string | null;
  /** A joint motor: the joint's id and the motor spec. */
  joint?: { id: string; type: 'hinge' | 'slider'; motor: MotorSpec };
  /** A component: its id and which numbers of its state mean what. */
  component?: {
    id: string;
    /** Index of the speed in the state, or −1 (jets); `rpmScale` converts it to rpm. */
    speed: number;
    rpmScale: number;
    /** Index of a percentage that says how hard it works (throttle, drive, collective), or −1; /100 for a fraction. */
    load: number;
  };
}

const LOAD_LABEL = /throttle|drive|collective|engine speed|power/i;
/** State units that mean "how fast it turns", and the factor to rpm. */
const SPEED_UNITS: Record<string, number> = { rpm: 1, '°/s': 1 / 6, 'rad/s': 60 / (2 * Math.PI) };

/** Which numbers of a component's published state are its speed and its load (null: it makes no engine sound). */
export function stateRoles(
  type: string,
  state: readonly { label: string; unit?: string }[] | undefined,
): { speed: number; rpmScale: number; load: number; kind: MotorKind } | null {
  if (!state) return null;
  const kind = defaultMotorKind(type);
  const speed = state.findIndex((s) => s.unit !== undefined && s.unit in SPEED_UNITS);
  const load = state.findIndex((s) => s.unit === '%' && LOAD_LABEL.test(s.label));
  if (speed >= 0) return { speed, rpmScale: SPEED_UNITS[state[speed].unit as string], load, kind };
  // Jets and thrusters publish a thrust and a percentage, no speed.
  if (kind === 'jet' && load >= 0) return { speed: -1, rpmScale: 1, load, kind };
  return null;
}

function componentSources(owner: BodyEntity | JointEntity, bodyId: string | null, out: MotorSource[]): void {
  for (const c of owner.components) {
    if (!c.enabled) continue;
    const roles = stateRoles(c.type, componentDef(c.type)?.state);
    if (!roles) continue;
    out.push({
      key: `c:${c.id}`,
      kind: roles.kind,
      bodyId,
      component: { id: c.id, speed: roles.speed, rpmScale: roles.rpmScale, load: roles.load },
    });
  }
}

/** Every motor-like thing in the document, in a stable order. */
export function scanSources(entities: Iterable<Entity>): MotorSource[] {
  const out: MotorSource[] = [];
  for (const e of entities) {
    if (isBody(e)) {
      if (!e.hidden) componentSources(e, e.id, out);
    } else if (isJoint(e)) {
      const bodyId = e.bodyA ?? e.bodyB;
      if ((e.type === 'hinge' || e.type === 'slider') && e.motor.mode !== 'off' && e.motor.maxForce > 0)
        out.push({ key: `j:${e.id}`, kind: 'electric', bodyId, joint: { id: e.id, type: e.type, motor: e.motor } });
      componentSources(e, bodyId, out);
    }
  }
  return out;
}

/** The motor's input (−1 … 1) the way the world computes it: held keys, or 1 when no key is bound. */
export function motorInput(m: MotorSpec, keys: ReadonlySet<string>): number {
  const hasKeys = !!(m.keyPos || m.keyNeg);
  return hasKeys ? (m.keyPos && keys.has(m.keyPos) ? 1 : 0) - (m.keyNeg && keys.has(m.keyNeg) ? 1 : 0) : 1;
}

/** Linear speed (m/s) of a slider is turned into a motor speed at 300 rpm per m/s; a hinge's rad/s become rpm. */
export const SLIDER_RPM_PER_MS = 300;

/**
 * How hard a joint motor works, 0 … 1. A velocity motor is loaded by the gap between the speed it is asked for and the
 * speed it reaches (free-running = light, straining or stalled = heavy), with a floor while it is driven; a position
 * motor works while it moves. An undriven motor (no key held) is silent.
 */
export function jointMotorLoad(m: MotorSpec, speed: number, input: number): number {
  if (m.mode === 'off') return 0;
  if (m.mode === 'velocity') {
    const demand = Math.abs(m.targetVelocity * input);
    if (demand < 1e-6) return 0;
    return Math.max(0.2, clamp01(1 - Math.abs(speed) / demand));
  }
  return clamp01(Math.abs(speed) / 1.5) * 0.6;
}

export interface MotorReading {
  rpm: number;
  load: number;
}

/**
 * Read a source's current speed and load.
 *  - `jointSpeed`: the joint's measured rate (rad/s for a hinge, m/s for a slider) or NaN if it is not simulated;
 *  - `state`: the numbers its component published, or null.
 */
export function readSource(
  s: MotorSource,
  jointSpeed: number,
  state: ArrayLike<number> | null,
  keys: ReadonlySet<string>,
  out: MotorReading,
): MotorReading | null {
  if (s.joint) {
    if (!Number.isFinite(jointSpeed)) return null;
    const input = motorInput(s.joint.motor, keys);
    const speed = Math.abs(jointSpeed);
    out.rpm = s.joint.type === 'hinge' ? (speed * 60) / (2 * Math.PI) : speed * SLIDER_RPM_PER_MS;
    out.load = jointMotorLoad(s.joint.motor, jointSpeed, input);
    return out;
  }
  const c = s.component;
  if (!c || !state) return null;
  const rated = RATED_RPM[s.kind];
  out.load = c.load >= 0 && c.load < state.length ? clamp01(state[c.load] / 100) : -1;
  if (c.speed >= 0) {
    if (c.speed >= state.length) return null;
    out.rpm = Math.abs(state[c.speed]) * c.rpmScale;
    // No load published: lean on the speed (a motor near its rated speed is working).
    if (out.load < 0) out.load = clamp01((out.rpm / rated) * 0.8);
  } else {
    out.rpm = 0; // a jet: the load is the thrust fraction
    if (out.load < 0) return null;
  }
  return out;
}
