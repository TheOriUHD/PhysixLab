# 05 · Powered parts, sensors, logic, scripting, movers (package CP)

Depends on: foundation (component registry + runtime, protocol v2 analog inputs/events/componentState). Each component: registry def + inspector schema + runtime + visual indicator (where meaningful) + physics test + a prefab/example demonstrating it + undo/redo + serialisation.

## Powered parts
- [ ] CP-1 — Engine: torque curve (editable), idle/rev limit, throttle by key or analog axis, inertia, outputs RPM; drives a hinge or wheel through the gearbox/clutch chain
- [ ] CP-2 — Electric motor (speed/torque with back-EMF style droop, supply limit) and servo (PID position control with limits and speed cap) and stepper (discrete steps with step key/pulse train)
- [ ] CP-3 — Linear actuator and hydraulic cylinder (pressure → force, speed limit, travel range, key/analog control)
- [ ] CP-4 — Brake (disc brake torque, key/analog, parking brake), clutch (slip torque limit, engagement), gearbox (N ratios, shift up/down keys, neutral/reverse), differential (open / locked / limited-slip) with consistent torque split
- [ ] CP-5 — Thruster / rocket (thrust, burn time, fuel mass that depletes and changes body mass), jet (thrust + afterburner), propeller (thrust and torque ∝ rpm², speed-dependent), rotor / helicopter blade set (collective + cyclic → lift and tilt moments); visible exhaust/flame/blur FX hooks

## Sensors
- [ ] CP-10 — Distance sensor (raycast, range, direction), proximity/touch/contact sensor, speed, angular-speed, accelerometer/G, angle (joint angle/tilt/inclinometer), altimeter, position (GPS), timer/clock; configurable noise (seeded)
- [ ] CP-11 — Sensor readouts available to logic, HUD and telemetry; gizmo showing the ray/field in edit mode and while running

## Logic and scripting
- [ ] CP-20 — Node-graph logic editor (canvas UI: pan/zoom, drag nodes, wire ports, minimap, undo) stored in the document; node library: constants, sliders, keys/axes, time/oscillator/noise, sensors, math (add/sub/mul/div/min/max/abs/clamp/map/smooth), comparators, boolean (and/or/not/xor), latches (SR/toggle), timers/delays/pulse, counters, state machine, PID, curve lookup; outputs: motor target/speed, thrust, brake, joint break, enable component, spawn, teleport, set property, play sound, set text label, win/lose events
- [ ] CP-21 — Logic evaluated deterministically in the physics worker each step (cycle detection with a one-step delay), debug mode: live port values shown on wires/nodes while simulating
- [ ] CP-22 — Prebuilt logic examples (cruise control, auto-door with distance sensor, self-balancing pendulum with PID, line-follower-like steering, traffic light timer) as prefabs/templates and verified by tests
- [ ] CP-23 — Scripting: per-scene JavaScript scripts (editor panel with syntax highlighting, error console, run/reset), executed **sandboxed in the worker** with a documented API (`onStart`, `onStep(dt)`, `onEvent`, `bodies.get(name)`, forces/impulses/velocity/teleport/spawn/remove/raycast/sensors/log/random(seeded)/time/key state), instruction/time budget with watchdog, no DOM/network/globals access; examples gallery; tests (script moves a body, hits budget → graceful termination, cannot reach `self`/`fetch`/`postMessage`)

## Movers, emitters and mechanisms-as-components
- [ ] CP-30 — Mover component (kinematic): sinusoidal, linear ping-pong, waypoint loop / along a `path` entity with easing, rotator, pendulum-swing, with phase offset, speed, pause at ends, trigger/key control, and *proper* carrying of riders (kinematic position-based so friction carries bodies on a moving platform)
- [ ] CP-31 — Conveyor (surface velocity applied through contact; friction-limited), bumper/trampoline (restitution + impulse), launch pad (impulse along axis on contact), fan (cone force field with falloff and visible blades), magnetic pad is handled in package ZN
- [ ] CP-32 — Spawner/emitter: spawn prefabs/shapes at a rate or burst (key, trigger, logic), with velocity/jitter/size ranges (seeded), max count, lifetime, recycling oldest; live in running sim; counts toward performance caps
- [ ] CP-33 — Cannon/launcher (key/trigger/logic fire, power, projectile type, reload), catapult behaviour verified with joint-based arm + release component
- [ ] CP-34 — Component inspector UX: "Add component" menu with search/categories, enable toggle, reorder, copy/paste components between bodies, schema-driven fields with validation and inline help
