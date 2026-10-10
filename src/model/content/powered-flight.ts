/**
 * Thrusters and rotors in flight (package CP): a rocket that burns off its own mass, a jet car with an afterburner, a
 * propeller cart whose rpm comes from a real engine through the shaft graph, and a helicopter with collective, cyclic
 * and a tail rotor that has to answer the main rotor's torque. Tests: `tests/powered.content.test.ts`.
 */
import { Builder, rotX } from '../builder';
import { makeComponent } from '../componentRegistry';
import type { BodyEntity, Entity } from '../types';
import type { Vec3 } from '../../core/math';
import { registerPrefab, registerTemplate } from './registry';

// ── rocket ────────────────────────────────────────────────────────────────────────────────────────

export function buildRocket(b: Builder, at: Vec3 = [0, 0, 0]): BodyEntity {
  const y = at[1] + 0.35 + 1.2;
  const body = b.body('Rocket', 'cylinder', [0.5, 2.4, 0.5], [at[0], y, at[2]], {
    massOverride: 12,
    linearDamping: 0, // no air drag: the climb is the rocket equation and gravity, nothing else
    angularDamping: 1.5, // the fins: a small wobble from the pad does not turn into a tumble
    material: { preset: 'aluminum', color: '#e8eef5' },
    components: [
      makeComponent('thruster', {
        thrust: 900,
        fuelMass: 25,
        burnTime: 12,
        mode: 'liquid',
        key: 'KeyF',
        axis: 'throttle',
        ramp: 0.15,
        direction: [0, 1, 0],
        position: [0, -1.2, 0],
        flame: true,
        flameColor: '#ffb347',
        flameLength: 1.6,
      }),
    ],
  });
  const nose = b.body('Rocket nose', 'cone', [0.5, 0.7, 0.5], [at[0], y + 1.55, at[2]], {
    massOverride: 1.5,
    linearDamping: 0,
    angularDamping: 1.5,
    material: { preset: 'plastic', color: '#d94a3b' },
  });
  b.joint('fixed', body, nose, [at[0], y + 1.2, at[2]], [0, 1, 0], { name: 'Nose mount' });
  return body;
}

function rocketEntities(): Entity[] {
  const b = new Builder('Rocket');
  b.body('Launch pad', 'cylinder', [1.6, 0.35, 1.6], [0, 0.175, 0], { bodyType: 'static', material: 'concrete' });
  buildRocket(b);
  return b.doc.entities;
}
registerTemplate({
  id: 'rocket-launch',
  name: 'Rocket launch',
  category: 'Powered parts',
  blurb:
    'A 37 kg rocket whose 25 kg of fuel really is its mass: it lightens as it burns, so the speed follows the rocket equation.',
  hint: 'Press Play, then hold F for full throttle (or drag the “throttle” slider in Controls). Watch the mass and fuel in the inspector fall and the climb rate rise as it lightens.',
  view: { position: [7, 3, 9], target: [0, 4, 0] },
  follow: 'Rocket',
  build() {
    const b = new Builder('Rocket launch');
    b.doc.settings.ground.halfSize = 100;
    b.doc.settings.airDrag = 0; // so the climb is the rocket equation and gravity, nothing else
    b.doc.entities = rocketEntities();
    return b.done();
  },
});
registerPrefab({
  id: 'rocket',
  name: 'Rocket',
  icon: 'rocket',
  category: 'Powered parts',
  blurb: 'A rocket on a launch pad: hold F (or the throttle axis) to fire; the fuel burns off the mass.',
  build: rocketEntities,
});

// ── a free-rolling cart for the jet and the propeller ─────────────────────────────────────────────

function buildCart(b: Builder, name: string, at: Vec3, mass: number): BodyEntity {
  const r = 0.3;
  const chassis = b.body(`${name} chassis`, 'box', [2.2, 0.25, 1.1], [at[0], at[1] + r + 0.15, at[2]], {
    massOverride: mass,
    comOverride: [0, -0.15, 0],
    material: { preset: 'steel', color: '#c9a227', metalness: 0.6, roughness: 0.4 },
  });
  for (const x of [-0.75, 0.75]) {
    for (const z of [-0.65, 0.65]) {
      const p: Vec3 = [at[0] + x, at[1] + r, at[2] + z];
      const wheel = b.body(`${name} wheel`, 'cylinder', [r * 2, 0.16, r * 2], p, {
        rotation: rotX(90),
        massOverride: 8,
        ccd: true,
        material: { preset: 'rubber', color: '#24262b', friction: 1 },
      });
      b.joint('hinge', chassis, wheel, p, [0, 0, -1], {
        name: `${name} axle`,
        components: [makeComponent('brake', { torque: 500, key: 'KeyS' })],
      });
    }
  }
  return chassis;
}

function jetCarEntities(): Entity[] {
  const b = new Builder('Jet car');
  const car = buildCart(b, 'Jet car', [0, 0, 0], 350);
  car.components.push(
    makeComponent('jet', {
      thrust: 2200,
      afterburner: 1.7,
      key: 'KeyW',
      abKey: 'ShiftLeft',
      spool: 1.2,
      maxSpeed: 90,
      fuelMass: 0,
      direction: [1, 0, 0],
      position: [-1.1, 0.1, 0],
      flameColor: '#8fd3ff',
      flameLength: 1.8,
    }),
  );
  return b.doc.entities;
}
registerTemplate({
  id: 'jet-car',
  name: 'Jet car',
  category: 'Powered parts',
  blurb:
    'A jet engine on a free-rolling cart: spool-up lag, an afterburner, and thrust that fades as the cart picks up speed.',
  hint: 'Press Play. Hold W for the throttle (the engine spools up over a second), add Shift for the afterburner, S to brake. Select the car to watch thrust, engine speed and airspeed.',
  view: { position: [-6, 3, 8], target: [4, 0.5, 0] },
  follow: 'Jet car chassis',
  build() {
    const b = new Builder('Jet car');
    b.doc.settings.ground.halfSize = 200;
    b.doc.entities = jetCarEntities();
    return b.done();
  },
});
registerPrefab({
  id: 'jet-car',
  name: 'Jet car',
  icon: 'jet',
  category: 'Powered parts',
  blurb: 'A cart with a jet engine and an afterburner: W throttle, Shift afterburner, S brake.',
  build: jetCarEntities,
});

function propCartEntities(): Entity[] {
  const b = new Builder('Propeller cart');
  const car = buildCart(b, 'Propeller cart', [0, 0, 0], 250);
  car.components.push(
    makeComponent('engine', {
      out: 'prop',
      key: 'KeyW',
      idle: 1000,
      revLimit: 6000,
      inertia: 0.12,
      response: 0.1,
      throttle: 0,
    }),
    makeComponent('propeller', {
      shaft: 'prop',
      diameter: 1.4,
      thrustCoeff: 0.1,
      torqueCoeff: 0.012,
      direction: [1, 0, 0],
      position: [-1.25, 0.85, 0],
      blur: true,
    }),
  );
  return b.doc.entities;
}
registerTemplate({
  id: 'propeller-cart',
  name: 'Propeller cart',
  category: 'Powered parts',
  blurb:
    'An engine turns a propeller through a shaft: thrust and load torque grow with rpm², so the engine settles where its torque equals the propeller’s.',
  hint: 'Press Play and hold W. Select the cart: the propeller shows its rpm, thrust and load torque, the engine its torque curve. Reshape the curve and the equilibrium rpm moves.',
  view: { position: [-5, 3, 7], target: [2, 0.7, 0] },
  follow: 'Propeller cart chassis',
  build() {
    const b = new Builder('Propeller cart');
    b.doc.settings.ground.halfSize = 200;
    b.doc.entities = propCartEntities();
    return b.done();
  },
});
registerPrefab({
  id: 'propeller-cart',
  name: 'Propeller cart',
  icon: 'propeller',
  category: 'Powered parts',
  blurb: 'A cart pushed by an engine-driven propeller: hold W.',
  build: propCartEntities,
});

// ── helicopter ────────────────────────────────────────────────────────────────────────────────────

function helicopterEntities(): Entity[] {
  const b = new Builder('Helicopter');
  const body = b.body('Helicopter', 'box', [2, 0.9, 1], [0, 0.55, 0], {
    massOverride: 150,
    linearDamping: 0.2,
    angularDamping: 3, // the rotor discs and the fuselage damp rotation in the air
    material: { preset: 'aluminum', color: '#3b82d9' },
    components: [
      // main rotor: collective on R / F, cyclic on the arrow keys, drag torque turns the fuselage the other way
      makeComponent('rotor', {
        radius: 2.5,
        thrustCoeff: 0.012,
        torqueCoeff: 0.001,
        maxRpm: 380,
        spool: 2,
        collective: 0,
        collectiveUp: 'KeyR',
        collectiveDown: 'KeyF',
        collectiveRate: 0.3,
        pitchForward: 'ArrowUp',
        pitchBack: 'ArrowDown',
        rollRight: 'ArrowRight',
        rollLeft: 'ArrowLeft',
        pitchAxis: 'pitch', // the Controls panel's sliders tilt the disc too, smoothly
        rollAxis: 'roll',
        maxTilt: 6,
        trimRoll: -5, // leans the main rotor a little to the left, against the tail rotor's sideways push
        direction: [0, 1, 0],
        forward: [1, 0, 0],
        position: [-0.08, 0.9, 0], // over the centre of mass (the tail boom moves it a little aft)
        reaction: true,
      }),
      // tail rotor: sideways thrust at the end of the boom answers the main rotor's torque; Q / E trim it
      makeComponent('rotor', {
        radius: 0.6,
        thrustCoeff: 0.012,
        torqueCoeff: 0.001,
        maxRpm: 2500,
        spool: 2,
        collective: 0.4,
        collectiveUp: 'KeyQ',
        collectiveDown: 'KeyE',
        collectiveRate: 0.4,
        maxTilt: 0,
        direction: [0, 0, 1],
        forward: [1, 0, 0],
        position: [-2.4, 0, 0], // at the height of the centre of mass: the sideways thrust does not roll the fuselage
        reaction: false,
        blur: true,
      }),
    ],
  });
  const boom = b.body('Tail boom', 'box', [2.4, 0.16, 0.16], [-2.1, 0.7, 0], { massOverride: 6, material: 'aluminum' });
  b.joint('fixed', body, boom, [-1, 0.7, 0], [0, 1, 0], { name: 'Tail boom mount' });
  for (const z of [-0.5, 0.5]) {
    const skid = b.body('Skid', 'box', [1.9, 0.07, 0.1], [0, 0.035, z], { massOverride: 3, material: 'steel' });
    b.joint('fixed', body, skid, [0, 0.1, z], [0, 1, 0], { name: 'Skid mount' });
  }
  return b.doc.entities;
}
registerTemplate({
  id: 'helicopter',
  name: 'Helicopter',
  category: 'Powered parts',
  blurb: 'A main rotor with collective and cyclic, and a tail rotor that has to cancel its torque.',
  hint: 'Press Play. Wait for the rotor to spool up, then hold R to raise the collective until it lifts off (F lowers it). Arrow keys (or the pitch / roll sliders in Controls) tilt the disc to fly; Q / E trim the tail rotor against yaw.',
  view: { position: [-8, 4, 9], target: [0, 1.5, 0] },
  follow: 'Helicopter',
  build() {
    const b = new Builder('Helicopter');
    b.doc.settings.ground.halfSize = 120;
    b.doc.entities = helicopterEntities();
    return b.done();
  },
});
registerPrefab({
  id: 'helicopter',
  name: 'Helicopter',
  icon: 'rotor',
  category: 'Powered parts',
  blurb: 'Main and tail rotor: R / F collective, arrows cyclic, Q / E tail trim.',
  build: helicopterEntities,
});
