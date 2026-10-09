# 03 · Particles, effects, audio and feedback (package FX)

Depends on: foundation (protocol v2 contact/impact events). No audio asset files: all sounds are synthesised with WebAudio. All FX respect quality tiers and have master toggles in Settings.

## Particles and decals
- [ ] FX-1 — GPU-instanced particle system (pooled, capped, additive/normal blending, soft sprites, size/colour/alpha over life, gravity & wind aware, deterministic with the scene seed) reusable by every other package via a small API (`fx.emit(type, position, options)`)
- [ ] FX-2 — Impact sparks (metal/stone), dust puffs (concrete/sand), wood chips, glass shards, rubber scuffs — emitted from real contact impulses with material-dependent look; scale with impulse; rate-limited
- [ ] FX-3 — Smoke / dust trails for fast-moving bodies on ground and tyre smoke when wheels slip (slip estimated from wheel velocity vs ground speed)
- [ ] FX-4 — Skid marks: persistent decal strips on the ground from slipping wheels / sliding bodies, fading by age, capped, cleared on reset
- [ ] FX-5 — Explosion effects for the blast tool (fireball, shock ring, debris, smoke, light flash) and projectile impacts
- [ ] FX-6 — Debris: chips fly from high-energy impacts on brittle materials as short-lived visual (non-physical) fragments with a toggle for physical debris bodies (capped, auto-cleaned)

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
