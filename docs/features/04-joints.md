# 04 · Joints, breakage, per-object physics (package JT)

Depends on: foundation (component system, per-body physics fields, protocol v2). Each joint type: model + sanitise + factory defaults, world build, inspector UI with type-specific fields, viewport visual (gizmo showing axes/limits), outliner icon, serialisation, a physics test against an analytic expectation, and at least one example in a template or prefab.

## New joint types
- [ ] JT-1 — cone-twist (ball joint with swing-cone + twist limits; ragdoll-grade)
- [ ] JT-2 — 6-DOF generic joint: per-axis (3 linear + 3 angular) free/limited/locked, limits, optional per-axis spring/damper + motor
- [ ] JT-3 — pulley (rope over two fixed points, ratio; Atwood machine reproduces a = (m2−m1)g/(m1+m2) within tolerance)
- [ ] JT-4 — rack-and-pinion (linear ↔ angular coupling by pitch radius) and gear pair (angular ratio, including reversing) with correct torque/speed trade-off
- [ ] JT-5 — belt / chain drive between two hinge bodies (ratio from pulley radii, slip limit)
- [ ] JT-6 — universal (cardan) joint (two orthogonal hinge axes)
- [ ] JT-7 — screw joint (rotation coupled to translation by pitch) and winch (motorised rope length with spool, load rating)
- [ ] JT-8 — soft weld (compliant fixed joint with linear + angular stiffness and damping; allows flex)
- [ ] JT-9 — Joint type picker UI (grouped, with diagrams) and quick conversion between compatible types keeping anchors

## Breakable rigid joints
- [x] JT-10 — Rigid-joint load estimation (engine exposes no constraint impulse): estimate force and torque transmitted by a joint from Newton–Euler momentum balance on the sub-assembly on one side of the joint (exact for joints that are bridges in the joint graph, least-squares/shared-load heuristic documented for loops), including contact and applied forces; validated by tests (a hanging mass of m kg loads its weld with ≈ m·g; a lever's hinge reaction matches statics; loads respond to acceleration) (tests/jointLoad.test.ts › "joint load estimation (JT-10)": hanging mass = m·g within 3 % for 2 kg and 50 kg, elevator thrust m(g−a), swinging pendulum peak ≈ 3mg, balanced lever pivot = total weight with per-weld loads; "breakable joints": cantilever weld torque = m·g·L/2 within 5 %; src/physics/world/jointLoad.ts, method documented in its header)
- [x] JT-11 — Break force/torque thresholds for all joint types (inspector fields, "tough/ fragile" presets), break events (sound/visual hook), load-ratio colouring on the joint gizmo and optional stress overlay (green→red), fatigue option (cumulative overload) (src/model/breakage.ts, src/ui/inspector/jointBreakage.ts, src/render/jointViews.ts `stressColor`, View ▸ Joint stress overlay; tests/jointLoad.test.ts › fatigue + document round-trip; e2e/tests/jointsB.mjs: presets, live readout, gizmo load colour; break event `jointBroken` → toast, gizmo removed. Springs keep `spring.breakForce`)
- [x] JT-12 — Break behaviour is correct: a weld holding a heavy block fails when the block is dropped on it above threshold and holds below it; broken joint removed from the live world; reset restores; tests (tests/jointLoad.test.ts › "a weld breaks above its force threshold…" and "a heavy block dropped on a welded plank breaks it above the threshold and not below" (threshold = 0.8× / 1.25× the measured impact peak); reset rebuilds the world so the joint is restored (e2e/tests/jointsB.mjs))

## Authoring
- [ ] JT-20 — Joint gizmo previews: hinge/slider axis arrows, limit arcs/ranges drawn in the viewport, cone for cone-twist, live angle readout; draggable anchor and axis handles in edit mode
- [ ] JT-21 — Joint tool upgrades: click on surface points (not only centres) to place anchors, snap to centre/face/edge midpoints, axis picked from face normal, options bar (type, axis, limits quick-set), chain mode (connect a sequence), multi-select "connect all"
- [ ] JT-22 — Mirror joints with mirrored bodies; copy joint settings to other joints; lock a joint's reference pose; "re-zero" the reference pose

## Per-object physics and collision control
- [ ] JT-30 — Collision groups & masks UI (16 named layers editable in World tab, matrix checkbox editor, per-body dropdown); world filter applied via Rapier interaction groups; tests (bodies on non-colliding layers pass through each other, trigger-only layers)
- [ ] JT-31 — One-way platforms (body flag: collides only from above/below given direction) implemented with physics hooks (`filterContactPair`) and tested
- [ ] JT-32 — Per-body gravity scale (exists), quadratic + linear drag including wind-relative drag, angular drag; inspector fields; tests (terminal velocity matches √(2mg/(ρCdA)))
- [ ] JT-33 — Mass override, centre-of-mass override (drag handle shown in viewport), inertia scale, with COM marker overlay; tests (override changes pendulum period/tipping)
- [ ] JT-34 — Sleep controls per body (threshold, never sleep) and a global "wake all" command
