# 16 · Game layer: challenges, achievements, campaign, education (package GM)

Depends on: foundation, zones (ZN triggers/goals), time (TM seed/replay), components (CP logic), UI tour engine (package UI provides spotlights; GM defines content — if UI is not merged yet, GM includes a minimal tour engine that UI later reuses).

Honest scope note: leaderboards/accounts/multiplayer need a server; this is a static, serverless app. Provided instead: local leaderboards, shareable result links, importable/exportable results, and a documented optional "leaderboard endpoint" interface that is **off by default** and tested against a mock.

## Challenge system
- [ ] GM-1 — Challenge model (stored in the scene document): title, description, objectives (any/all), constraints (budget in mass/cost/part count, allowed shapes/joints/materials, build-area volume, max parts), time limit, scoring formula, star thresholds (1–3), start/running/won/failed states
- [ ] GM-2 — Objective types, each evaluated from live telemetry/zone events and unit-tested: reach zone / goal, hold structure stable for N s, keep object above height, move object ≥ D metres, reach speed V, survive impact below G, knock all targets, keep energy/height/cost under limit, place all balls in basket, stay afloat, time trial (lap), do-not-touch (forbidden zone)
- [ ] GM-3 — Budgets & part costs: per-material/part costs with a live budget bar while building; over-budget blocks "Simulate" with an explanation (or warns, per challenge)
- [ ] GM-4 — Challenge HUD & result screen: objectives checklist, timer, score breakdown, stars, best score, "retry", "next challenge", share result link; confetti/FX; sounds
- [ ] GM-5 — Challenge editor: author objectives and constraints from the scene via a dialog (pick zones/bodies by clicking), preview, validate (must be winnable? provide "test run" mode), save into the scene so share links carry the challenge
- [ ] GM-6 — Local leaderboards per challenge (top 10 with initials/name, date, replay link if TM recorded), personal bests and ghost integration (TM-5), importable/exportable
- [ ] GM-7 — Daily challenge: deterministic from the date (seeded generator composing a map + constraint + objective), streak tracking; weekly variations
- [ ] GM-8 — Optional leaderboard endpoint interface (off by default; documented JSON contract; mock-tested) + shareable result links verifying score by replay re-simulation (deterministic check) — local verification

## Achievements and campaign
- [ ] GM-10 — Achievements (≥ 40) with unlock toasts, progress counters, gallery panel, persisted; each trigger implemented and tested (first simulation, first joint, drive 100 m, 1000 bodies, complete tutorial, break a joint, perfect stars, build a bridge that holds a truck, etc.)
- [ ] GM-11 — Campaign: ≥ 24 levels in 4 chapters (Basics, Mechanisms, Vehicles & Soft, Engineering) with unlock progression and stars; every level is solvable (verified by an automated "reference solution" scene loaded and simulated to a win in tests)
- [ ] GM-12 — Interactive tutorial levels (≥ 6): guided steps with spotlight/arrow overlays that advance only when the user performs the action (place a box, move it, simulate, add a hinge, bind a key, drive the car, pin cloth), skippable, re-playable from Help; tutorial progress persisted

## Education mode
- [ ] GM-20 — Education mode toggle: friendlier defaults, units shown everywhere, formulas panel (what the sim is computing), lab-notebook panel
- [ ] GM-21 — Lab worksheets (≥ 12): projectile motion, inclined plane & friction, pendulum period, spring–mass SHM, conservation of momentum (1D/2D collisions), energy conservation, Atwood machine, circular motion/centripetal force, torque/lever equilibrium, buoyancy/Archimedes, terminal velocity, rolling vs sliding, gyroscopic precession (qualitative); each has a pre-built scene, instructions, a data-capture table, and a "prediction vs simulation" check
- [ ] GM-22 — Sim-vs-theory calculator: students enter predicted values (or formula-based calculators with the scene's parameters), sim measures the same quantity, % error and tolerance verdict shown; calculators for kinematics, dynamics, energy, momentum, rotation, SHM, fluids; unit-aware
- [ ] GM-23 — Data tables & analysis: capture measurements at events/times into a table, plot (scatter/line), fit linear/quadratic/power/sinusoidal with R², export CSV; link to telemetry
- [ ] GM-24 — Teacher view: lock settings (hide advanced tools, fix gravity, disable cheats), answer-key mode showing the reference results, assignment links (the share link encodes scene + worksheet + locked options), class results import (CSV) summary — all client-side
