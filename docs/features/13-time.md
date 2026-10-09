# 13 · Time travel, replay, ghosts, determinism (package TM)

Depends on: foundation (snapshot/restore hooks, seeded RNG, protocol v2), soft bodies, components (state serialisation).

- [ ] TM-1 — Simulation recorder in the worker: periodic **full-state snapshots** (rigid bodies via the engine snapshot, soft bodies via particle positions/velocities, component states, RNG state, joint break state, input log) in a bounded ring buffer (memory-capped, adaptive interval); restore to any snapshot reproduces the exact future (deterministic test: run N steps, snapshot, run M steps, restore, rerun M steps → identical poses)
- [ ] TM-2 — Rewind: hold a key (default Backspace/`R` during run) or button to rewind in real time (with reverse playback speed control); resume from the past point (branching timeline); works with soft bodies and components
- [ ] TM-3 — Scrub timeline UI at the bottom: scrubber with run length, snapshot ticks, events markers (impacts, breaks, goals), bookmarks (add/jump/rename), play/pause/step both directions, speed, loop region
- [ ] TM-4 — Deterministic input recording & replay: record keys/axes/ops (grabs, tools, edits) with step stamps and the scene seed; replay reproduces the run exactly; export/import replay files (JSON, deflated) and share links; replay viewer mode
- [ ] TM-5 — Ghost of the previous run: translucent ghost bodies from a stored trajectory track overlaid on the live run (choose which run), "personal best" ghost for challenges; compare two runs (A/B overlay, distance between trajectories chart)
- [ ] TM-6 — Seeded randomness everywhere: scene seed setting + "reseed" button; spawners, noise, particles-with-physical-effect, fracture, gusts, sensor noise all use the world RNG; unit tests prove same seed → same result and different seed → different result
- [ ] TM-7 — Determinism validation mode: run the scene twice headlessly in a test and compare state hashes per N steps; displayed in the diagnostics panel as "deterministic ✓/✗" with a first-divergence report
- [ ] TM-8 — Slow motion & time controls polish: time-scale presets, auto slow-mo on impact option, step back/forward by one frame (from snapshots), frame-accurate step counter display
