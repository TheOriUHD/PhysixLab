# 06 · Zones, triggers, fields, fluids, surfaces, contact physics (package ZN)

Depends on: foundation (components, sensor events, collision groups), ideally CP (actions). Zones are bodies (static/kinematic, sensor colliders) carrying a `zone` component; they render as translucent volumes in edit mode (and optionally while running).

## Trigger / sensor zones
- [ ] ZN-1 — Zone component: box/sphere/cylinder/mesh-hull volume, filter (tags, layers, body types), enter/exit/stay events, events delivered to logic/scripts/game layer
- [ ] ZN-2 — Zone actions: checkpoint (ordered), goal/finish (with timing), kill (remove or respawn), respawn-at, teleport-to (target body/point with velocity kept/rotated), launch (impulse), set gravity override, apply force field, spawn, play sound, set label/score, enable/disable component, custom event
- [ ] ZN-3 — Race/timing support: lap counter, split times, best lap, per-body checkpoint progress (works with any vehicle)

## Fields
- [ ] ZN-10 — Gravity fields: directional override region, radial/point gravity wells (planets, inverse-square or constant), tests (orbit period matches Kepler within tolerance), space mode (zero-g + wells) preset
- [ ] ZN-11 — Wind zones: uniform + gusts + turbulence (seeded), force from drag area × relative air velocity (not just a push), visual streamlines/particles
- [ ] ZN-12 — Magnets / magnetic fields: attractors/repulsors with 1/r² (or dipole) force on bodies flagged ferromagnetic or magnetised; magnetic material flag in the material editor; tests
- [ ] ZN-13 — Aerodynamics: lift & drag on wings/foils (per body AoA-based coefficients, stall), body-level drag area/coefficients; tests (lift ∝ v², stall)

## Fluids
- [ ] ZN-20 — Water volumes: buoyancy from submerged volume of every collider (accurate for primitives, sample-based for hulls/compounds), linear + quadratic drag, angular damping, surface waves (Gerstner) affecting buoyancy and rendering, currents; tests (float/sink by density ratio, equilibrium draught ≈ ρ_body/ρ_water, heavy metals sink, ship righting moment)
- [ ] ZN-21 — Water rendering: transparent animated surface, depth tint, foam at intersections, splash particles on entry/exit (hook FX), underwater camera tint
- [ ] ZN-22 — Particle liquid (position-based fluid / SPH, few thousand particles in the worker) interacting with rigid bodies (collision + buoyancy/drag coupling) and containers; emitter source & sink; rendering as screen-space smooth blob or instanced spheres; quality caps
- [ ] ZN-23 — Granular material (sand/grain emitter with proper friction & piling using small rigid spheres/capsules at scale or a particle granular model) with perf caps and a hopper/hourglass example

## Surfaces and contact physics
- [ ] ZN-30 — Surface component presets: ice (μ≈0.03), mud/sand (drag + sinking + rolling resistance), rubber (high μ), sticky (adhesion force while in contact), bouncy (restitution > 1 with energy cap), boost pad (speed-up along direction), gravity-flip pad, slow zone, conveyor (see CP), teleporter pads (paired); inspector + visual textures
- [ ] ZN-31 — Rolling resistance (per material) and torsional/spin friction so balls stop rolling realistically; test (ball rolling on a surface decelerates at μ_r·g)
- [ ] ZN-32 — Static vs kinetic friction (separate coefficients with stick-slip hysteresis) implemented honestly on top of the engine's single-coefficient model; test (block on slope holds at μ_s, slides with μ_k acceleration)
- [ ] ZN-33 — Anisotropic friction (direction-dependent, e.g. skates, tyres, ratchets) and a pair-material friction/restitution table (`World › Materials` matrix editor) with the closest exact-or-approximate mechanism the engine allows; the UI states precisely which pairs are exact and which are approximated and by how much (documented in LIMITATIONS)
- [ ] ZN-34 — World bounds & boundaries: kill-box/kill-plane, soft walls, open/void/water edges, auto-respawn policy (to initial pose, with penalty) with settings UI
