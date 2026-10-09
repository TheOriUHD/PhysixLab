# 08 · Vehicles, characters, ragdolls (package VH)

Depends on: foundation, joints (JT), components (CP: engine/gearbox/etc.), zones (ZN: water), visuals skins (VZ-42). Every vehicle is a template/prefab that is **driven in a test** (reaches speed, steers, brakes, doesn't flip at normal input) and rendered nicely; all use keyboard + gamepad analog axes (`axes` protocol).

## Vehicle model(s)
- [ ] VH-1 — Raycast vehicle component (engine's raycast vehicle controller): wheel positions/radius, suspension rest length/travel/stiffness/damping, tyre friction & slip, steering with Ackermann, drive layout (FWD/RWD/AWD), brakes, handbrake, anti-roll bars, downforce; robust against flipping; test suite for acceleration, braking distance, cornering, ramp landing
- [ ] VH-2 — Tuning panel for vehicles (live sliders for suspension, gearing, power, grip, mass distribution) + vehicle telemetry (speed, RPM, gear, slip, load per wheel) feeding HUD gauges
- [ ] VH-3 — Car prefab/templates using detailed visual skins: sedan, sports car, pickup, buggy, go-kart, F1-style; both a *raycast* and a *joint-built* (existing) variant stay available

## Other vehicles
- [ ] VH-10 — Tank / tracked vehicle (treads as chained segments or contact-driven belt) with differential steering and a turret that rotates/elevates (servo) and fires
- [ ] VH-11 — Motorbike (two-wheeler with balancing controller / gyro-stabilisation and lean steering), bicycle
- [ ] VH-12 — Boat (hull buoyancy, propeller/outboard, rudder) and jet-ski; sailboat (sail as aerodynamic surface) if aerodynamics (ZN-13) is available
- [ ] VH-13 — Fixed-wing plane (aerodynamic lift/drag/stability, control surfaces: elevator/aileron/rudder, throttle, flaps) that can take off, fly and land
- [ ] VH-14 — Helicopter (main rotor collective/cyclic, tail rotor) and quadcopter drone (4 rotors with stabilising controller)
- [ ] VH-15 — Planetary rover (6-wheel rocker-bogie), hovercraft, lunar lander (thrusters + landing legs)
- [ ] VH-16 — Train (locomotive + coupled cars on a rail track built from path/splines) and tram
- [ ] VH-17 — Truck with trailer (articulated hitch, brakes), tow truck/winch, dump truck (hydraulic bed)
- [ ] VH-18 — Crane (tower/mobile: rotation, boom luffing, trolley, cable winch + hook) and excavator (boom, arm, bucket hydraulics) operated with keys/gamepad sticks
- [ ] VH-19 — Walking robots: biped and quadruped with servos driven by a gait controller (CPG/logic), able to walk forward on flat ground without falling for ≥ 10 s (test)
- [ ] VH-20 — Vehicle garage UI: pick a vehicle, spawn at a point/start line, colour/skin selection, reset vehicle, flip-upright key

## Characters and ragdolls
- [ ] VH-30 — Humanoid ragdoll prefab (capsule limbs, cone-twist/hinge joints with anatomical limits, mass distribution), crash-test dummy variant with force sensors (head/chest G)
- [ ] VH-31 — Ragdoll behaviours: "go limp on impact" (active→ragdoll switch via thresholds), stiffness slider (joint motors holding a pose), pose library (T-pose, sit, stand), throwable
- [ ] VH-32 — Playable character controller (kinematic character controller): walk/run/jump/crouch, slopes & steps, push dynamic bodies with proper masses, ride platforms, WASD + mouse/gamepad, third-person camera; character skin
- [ ] VH-33 — Animals/creatures as simple articulated skins with passive physics (optional, small set) — only if time permits; otherwise marked `[~]`
