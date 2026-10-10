# 03 · Particles, effects, audio and feedback (package FX)

Depends on: foundation (protocol v2 contact/impact events). No audio asset files: all sounds are synthesised with WebAudio. All FX respect quality tiers and have master toggles in Settings.

## Particles and decals
- [x] FX-1 — GPU-instanced particle system (pooled, capped, additive/normal blending, soft sprites, size/colour/alpha over life, gravity & wind aware, deterministic with the scene seed) reusable by every other package via a small API (`fx.emit(type, position, options)`) (tests/fxParticles.test.ts › "particle pool", "emitter: counts, shapes and the seed", "procedural sprite atlas"; tests/fxSystem.test.ts › "Fx emit and update", "quality tiers, intensity and switches"; tests/fxExtending.test.ts + tests/examples/confetti-effect.ts (the API as a package uses it, shown in docs/EXTENDING.md); e2e/tests/fx.mjs › "fx: determinism" (single-stepped runs, same seed ⇒ same particles), screenshots e2e/out/fx-ball-drop.png, fx-blast.png; src/render/fx/)
- [x] FX-2 — Impact sparks (metal/stone), dust puffs (concrete/sand), wood chips, glass shards, rubber scuffs — emitted from real contact impulses with material-dependent look; scale with impulse; rate-limited (tests/fxSurfaces.test.ts: real-engine drops give ½·J·v within 12 % of ½·m·v²·(1+e), every material pair's recipe, counts monotonic in the impulse and capped; tests/fxApp.test.ts › "ContactQueue" and "ContactFeed" (worker events requested only while consumed); e2e/tests/fx.mjs › "fx: ball drop" (sparks, dust, wood chips, glass shards, scuffs, stone chips all emitted; screenshot e2e/out/fx-ball-drop.png read), "fx: ball pit" (300 balls stay within the particle budget); src/render/fx/surfaces.ts, src/app/fx/fxDirector.ts). "Sand" is a registry entry away: no sand material exists yet, concrete and the ground raise the dust
- [x] FX-3 — Smoke / dust trails for fast-moving bodies on ground and tyre smoke when wheels slip (slip estimated from wheel velocity vs ground speed) (tests/fxSlip.test.ts: rolling ⇒ 0, spinning on the spot ⇒ ω·r, locked ⇒ v, wheelspin and braking, tilted shapes, and a real-engine ball that slips at the throw speed then rolls at < 0.15 m/s; "what a contact leaves behind" for the smoke / dust / spark thresholds; e2e/tests/fx.mjs › "fx: car braking skid" (tyre smoke and a dust trail from the real car, screenshot e2e/out/fx-car-skid.png read); src/render/fx/slip.ts, trails.ts)
- [x] FX-4 — Skid marks: persistent decal strips on the ground from slipping wheels / sliding bodies, fading by age, capped, cleared on reset (tests/fxSkid.test.ts: continuous strips, ring buffer never above its capacity, restarts on reversal / jump, clear, upload ranges, mesh draw ranges; e2e/tests/fx.mjs › "fx: car braking skid" (marks laid by the real car, kept while paused, cleared by Reset), "fx: skid marks fade with age" (pixels read back from the renderer: darker than the ground, half faded at 55 s, gone at 95 s); src/render/fx/skidBuffer.ts, skidMesh.ts)
- [x] FX-5 — Explosion effects for the blast tool (fireball, shock ring, debris, smoke, light flash) and projectile impacts (tests/fxSystem.test.ts › "explosion (FX-5)": every part present, ground ring and dust only near the floor, light ∝ radius², decay, Low tier has no flash, reduced motion dims it, projectile version is smaller; e2e/tests/fx.mjs › "fx: blast tool" (the real tool click; screenshot e2e/out/fx-blast.png read) and "fx: a hard projectile hit" (the Fire tool; screenshot e2e/out/fx-projectile-hit.png read); src/render/fx/explosion.ts, src/app/projectiles.ts)
- [x] FX-6 — Debris: chips fly from high-energy impacts on brittle materials as short-lived visual (non-physical) fragments with a toggle for physical debris bodies (capped, auto-cleaned) (tests/fxSurfaces.test.ts › "only very hard hits on brittle materials throw debris chunks"; tests/fxApp.test.ts › "physical debris (FX-6)" against the real engine: capped, removed after their lifetime, land and rest, deterministic for a seed; e2e/tests/fx.mjs › "fx: physical debris" (off by default, switched on through the panel, glass fragments in their own collision group within the cap, all removed again); src/app/fx/physicalDebris.ts)

## Audio
- [ ] FX-10 — Audio engine (WebAudio, lazily started on first user gesture) with master/music-less categories (impacts, rolling/sliding, engines, ambience, UI), per-category volume, mute (M), settings persisted; voice limiting and priority; works with speed scaling (pitch follows time scale when slowed)
- [ ] FX-11 — Procedurally synthesised impact sounds per material class (metal clang with inharmonic partials, wood knock, glass chime/shatter, stone clack, rubber thud, plastic tick, foam), velocity/impulse-scaled and size-aware (big bodies pitch lower)
- [ ] FX-12 — Rolling and sliding noise (filtered noise whose cutoff/gain follow speed and contact load; sliding scrape vs rolling rumble)
- [ ] FX-13 — Engine/motor audio: pitch and timbre from motor speed (RPM) for motorised joints and engine components, with load; wind noise from camera-relative speed; ambient layers
- [ ] FX-14 — 3D spatialisation (panner relative to the camera), distance attenuation, Doppler optional; UI sounds (select, place, delete, error, success) subtle and togglable
- [ ] FX-15 — Spawn/explosion/break/joint-snap/trampoline/launch sounds

## Feedback
- [ ] FX-20 — Camera shake from large impacts/explosions (intensity setting, reduced-motion aware)
- [ ] FX-21 — Gamepad rumble from impacts and engine load (Gamepad `vibrationActuator`, feature-detected), intensity setting
- [ ] FX-22 — Damage/impact indicators: brief flash/outline on heavily hit bodies and screen-edge pulse for hits on the followed body
- [ ] FX-23 — Speed lines / FOV kick when the followed body exceeds a speed threshold (setting, reduced-motion aware)
- [ ] FX-24 — Floating live labels attached to bodies (name, speed, height, mass, kinetic energy, joint angle, custom expression) with unit formatting and declutter (max N, distance fade), toggle per body or global
- [ ] FX-25 — HUD gauges for the followed/selected body: speedometer (analog dial + digital), tachometer from motor/engine RPM, G-meter (acceleration circle), altimeter/vario, mini energy graph; draggable HUD layout with show/hide

## Implementation notes

### Chunk 1 — particles, impact effects, skid marks, explosions (FX-1 … FX-6)

**Where things are.** `src/render/fx/` is the renderer-side system, pure where it can be (no three.js in the pool, the
emitter, the type table, the sprite generator, the recipes, the slip maths or the skid buffer, so all of it is unit-tested
in Node); `src/app/fx/` is the glue (`FxDirector`, the effects clock, per-body facts, the contact queue, physical debris);
`src/app/contactFeed.ts` shares the worker's contact events between consumers (the audio and camera-shake chunks should
`app.contacts.acquire(...)` rather than send `{ op: 'events' }` themselves); `src/ui/fxPanel.ts` + `src/ui/extensions/fx.ts`
are the Effects panel, the commands (`fx.toggle`, `fx.quality.*`, `fx.kind.*`, `fx.skid.clear`, `fx.preview.*`) and the View
menu entries. `docs/ARCHITECTURE.md` §8a describes the design; `docs/EXTENDING.md` has the tested example ("How to add a
particle effect").

**Public API.** `app.fx.emit(type, position, options)`, `explosion`, `impact`, `skid`, `setEnvironment({ gravity, wind,
windAt, floorY })`, `clear`, `stats`, `emittedByType()`; `registerParticleType`, `registerFxSurface`, `surfaceFor`
(`src/render/fx/index.ts`). Settings are `Prefs.fx` (`FxSettings`: master switch, quality `auto | low | medium | high`,
intensity 0.25 … 2, one switch per effect family, physical debris); the chunk-2/3 settings (volumes, shake and rumble
intensity, labels, HUD layout) should be further sections of the Effects panel (`registerFxPanelSection`) and further
fields of their own preference objects, not new top-level tabs.

**Decisions worth knowing.**

* *Energy, not impulse, scales an effect.* `E = ½·J·v` from the contact event is the kinetic energy that went into the
  contact; a 0.3 J … 30 kJ log scale, damped for slow hits of heavy bodies (`impactIntensity`), because bodies here have
  real masses and a plain log of the impulse saturates for everything. Speed below 0.7 m/s or energy below 0.3 J makes no
  effect at all (resting contacts).
* *Slip from the pose.* The engine does not expose contact forces or tyre slip, so `slip.ts` takes the lowest point of the
  shape and the velocity of that point of the rigid body — exact for rolling, spinning, locked and sliding contacts,
  checked against the engine. Wheel-likeness comes from the document: a cylinder on a hinge, or anything tagged `wheel` /
  named like a wheel.
* *Ground only.* Skid marks, dust trails and tyre smoke need the ground plane (y = 0); documented in LIMITATIONS.
* *One random stream per `emit` call* (seed ⊕ call number) so culling and rate limits cannot shift other effects; the
  e2e determinism test single-steps two runs and compares a digest of every live particle.
* *Effects live in simulation time* (`FxClock`): freeze when paused, follow the time scale and the achieved real-time
  factor, advance by the simulated time of a single step.
* *Draw order and cost.* Two instanced draw calls; the alpha-blended pool is sorted back to front each frame with a packed
  float64 key (no allocation). Measured in Node at 10 000 live particles: update ≈ 1.1 ms, sort ≈ 0.7 ms, instance write
  ≈ 2 ms per frame; the High tier's budget is 14 000, Medium 6 000, Low 1 500. The pre-passes of the ambient-occlusion
  pass skip the particle and skid meshes (`onBeforeRender` guard), otherwise they would be drawn with the normal material.
* *Rings are analytic* in the fragment shader (a 64 px cell cannot hold a 13 m thin ring); the atlas cells for `ring` and
  `ringSoft` remain for tools that read the atlas.
* *The tab strip* of the right region now drops the labels of unselected tabs when the tabs do not fit (Inspector, Outliner,
  World, Effects): `panelRegion.ts` + a few lines of CSS, so later panels do not push tabs out of the panel.
* *Legacy shock wave.* `Effects.shockwave` (the wireframe sphere) is still what the Blast tool draws when visual effects or
  explosions are switched off, so a blast never goes unseen.

**Verification evidence.** Screenshots read from `e2e/out/` (E2E_SHOTS=1): `fx-panel.png`, `fx-panel-off.png`,
`fx-ball-drop.png` (36 balls of six materials: orange sparks, wood and stone chips, glass shards with glints, dust),
`fx-car-skid.png` (tyre smoke over black skid marks), `fx-blast.png`, `fx-projectile-hit.png`, `fx-physical-debris.png`,
`fx-skid-top.png`. The blast frame sequence (0.05 … 2.5 s) and the High-quality (ambient occlusion) render were inspected
too.
