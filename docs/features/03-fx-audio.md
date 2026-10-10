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
- [x] FX-10 — Audio engine (WebAudio, lazily started on first user gesture) with master/music-less categories (impacts, rolling/sliding, engines, ambience, UI), per-category volume, mute, settings persisted; voice limiting and priority; works with speed scaling (pitch follows time scale when slowed). **Mute is `Shift+M`, not `M`:** `M` is the Measure tool's long-standing key (README, tests, shortcut help), so mute is `Shift+M` plus the speaker button of the top bar and the palette command; plain `M` still measures. (tests/audioCore.test.ts › "audio settings" (five categories, defaults, sanitiser, round trip); tests/audioApp.test.ts › "stored sound preferences" (damaged localStorage loads as valid settings, changes persist); tests/audioEngine.test.ts (the engine against a fake WebAudio context in Node: no context before a gesture and only one after, a disabled engine creates nothing until it is enabled by a click, mute stops every voice and suspends the idle context 250 ms later and unmute resumes the same one, category volumes move the buses, ≤ 24 impact voices with quieter newcomers rejected and louder ones stealing, a stolen voice is faded, loops share the pool, each distinct sound is rendered once, a request whose buffer does not fit the frame's render budget plays next frame, the cache is bounded at 280 buffers, the common sounds are prepared in idle frames, the time-scale pitch and the 3D state reach the playback rate / pan / cutoff, no-WebAudio browsers are survived); tests/audioCore.test.ts › "volume and time-scale laws" (slider → gain, `pitchForTimeScale` 1× → 1, 0.5× → 0.73, 0.25× → 0.54, floor 0.35), "voice pool (FX-10: limiting and priority)" (category and total budgets, steal the quietest for a louder newcomer, turn a quieter one away, the 15 % steal margin, old voices easier to steal), "TopN"; e2e/tests/audio.mjs › "no AudioContext until a user gesture … strict autoplay policy logs nothing" (a second browser with `--autoplay-policy=document-user-activation-required`: no context before a gesture, none for moves and scrolls, exactly one created inside the pointer event, mute / unmute reuse it, zero warnings), "keys that are not user activations (Escape) do not start the context", "with sound switched off no context is ever created; the panel switch turns it on", "Sound panel — volumes, switches, mute (Shift+M leaves Measure on M), top-bar speaker; settings persist" (sliders reach the bus gains: master 50 % × rolling 25 % = 0.0156, reload keeps the settings; screenshots e2e/out/audio-panel.png, audio-muted.png read), "collisions play material sounds … mute silences them" (the analyser on the master output measures the level, muted output is exactly 0, the context suspends and no contact events are requested while muted), "voice limiting — 300 balls landing keep within the voice budget" (≤ 36 voices, ≤ 24 impact voices, rejected + stolen > 0), "a motorised joint and a rolling ball … pitch follows the time scale" (a running motor voice drops ×0.73 at 0.5×, a one-shot plays at rate 0.73); src/audio/engine.ts, voicePool.ts, settings.ts, src/ui/audioPanel.ts, src/ui/extensions/audio.ts)
- [x] FX-11 — Procedurally synthesised impact sounds per material class (metal clang with inharmonic partials, wood knock, glass chime/shatter, stone clack, rubber thud, plastic tick, foam), velocity/impulse-scaled and size-aware (big bodies pitch lower) (tests/audioImpact.test.ts: loudness monotonic in impulse and in speed, a slow heavy touch quieter than a fast light hit of equal energy, every preset renders, the metal clang's partials sit at 2.756 / 5.404 × the fundamental and not at the integer multiples, steel and glass ring for hundreds of milliseconds while wood, stone, lead, rubber and foam are short (steel rings > 4× longer than wood), brightness glass > steel > wood > rubber, rubber's falling pitch, a soft partner damps the ring, brittle materials break (voice cut short + the `break` event's fragments), fundamental falls monotonically with size for every material; tests/audioApp.test.ts › "contacts from the real engine become impact voices" (balls dropped in the real engine from 0.15 … 9.6 m: gains and timbre rise monotonically, 0.1 m vs 0.8 m steel ball: lower pitch, louder); e2e/tests/audio.mjs › "material impact sounds rendered offline" (the same WebAudio graph rendered in Chromium with `OfflineAudioContext` and measured: steel rings > 0.4 s with its fundamental at 500–1300 Hz, glass > 0.3 s above 1.8 kHz, wood and stone and rubber short, a 4 m beam > 2.5× lower than a 0.4 m ball, peak level rises with the impulse 5 → 5000 N·s, steel on foam rings < 0.7× of steel on steel), "collisions play material sounds … " (real drops of five materials render `i|steel|`, `i|wood|`, `i|glass|`, `i|rubber|`, `i|concrete|` and `i|ground|` buffers; a 30 m glass drop is flagged `|x` and plays `e|b|glass`; no audio file is ever requested); src/audio/materials.ts, impact.ts, dsp.ts)
- [x] FX-12 — Rolling and sliding noise (filtered noise whose cutoff/gain follow speed and contact load; sliding scrape vs rolling rumble) (tests/audioCore.test.ts › "rolling and sliding mapping (FX-12)" (a free-rolling ball is all rumble, a dragged box all scrape, a skidding wheel trades one for the other; level and cutoff monotonic in the rolling speed, level and pitch monotonic in the slip speed; 10 N → 0.35 … 20 kN → 1 load law; rubber squeals, stone rasps, foam is nearly silent, bigger is lower); e2e/tests/audio.mjs › "rolling rumble and sliding scrape rendered offline follow speed and load" (browser-rendered: 8 m/s rolls louder and brighter than 1 m/s, the scrape is a higher noise than the rumble, 20 kN is louder than 20 N), "a motorised joint and a rolling ball get voices …" (a steel ball rolling at 6 m/s gets a rumble voice from the real ground contact), "a sliding box scrapes" (concrete crate: scrape gain > 0.01, rumble ≈ 0, band-pass 300–3000 Hz); src/audio/rolling.ts, loops.ts (`RollingVoice`), src/app/audio/audioDirector.ts (`scanRolling`: the loudest 6 bodies get voices, from `render/fx/slip.ts`). The contact load is the body's weight (LIMITATIONS)
- [x] FX-13 — Engine/motor audio: pitch and timbre from motor speed (RPM) for motorised joints and engine components, with load; wind noise from camera-relative speed; ambient layers (tests/audioCore.test.ts › "engine and motor mapping (FX-13)" (fundamental monotonic in rpm for combustion / electric / rotor, the combustion fires at rpm/60 × 3, filter opens and level rises with load, silent when stopped, blade-pass chop rate = rpm/60 × 2 and its depth, jet roars with thrust), "ambience mapping" (wind monotonic in speed, gust rate and depth, no air in zero gravity); tests/audioApp.test.ts › "where engine sounds come from" (a hinge driven by the real engine at 8 rad/s reads 76 rpm, a stalled one a load above 0.9, 24 rad/s a whine ≥ 1.5× higher; source discovery from `ComponentDef.state` units: rpm, °/s, rad/s, or a throttle % for jets); e2e/tests/audio.mjs › "engine and motor voices rendered offline" (Chromium-rendered: combustion fundamental 50 Hz at 1 000 rpm and 250 Hz at 5 000 rpm, brighter and louder with load, the electric whine climbs with rpm, a 300 rpm rotor is chopped at 10 Hz and a 3 000 rpm one is a steady buzz, a jet louder with thrust, wind louder and brighter with speed, a stopped engine silent), "a motorised joint and a rolling ball get voices …" (a velocity-motor hinge gets an electric voice; asking for 14 rad/s instead of 4 raises its pitch by > 1.4×), "wind rushes past a camera following a fast body, and the air goes away in zero gravity" (screenshot e2e/out/audio-wind.png); src/audio/motor.ts, ambience.ts, loops.ts, src/app/audio/motorSources.ts). Components are found through their published state, so the engine / motor / propeller / rotor / servo / jet / thruster of package CP sound as soon as it merges; here that is verified against the state layouts, not against those components
- [x] FX-14 — 3D spatialisation (panner relative to the camera), distance attenuation, Doppler optional; UI sounds (select, place, delete, error, success) subtle and togglable (tests/audioCore.test.ts › "spatialisation (FX-14)" (pan follows the side, grows monotonically from ahead to the right, centres for ahead / behind / above; inverse-distance law, silent past 320 m; air and head shading dull far and rear sounds; Doppler (c + v_l)/(c + v_s) exactly, softened by the amount, clamped); tests/audioApp.test.ts › "UiSoundGate"; e2e/tests/audio.mjs › "sounds are positioned relative to the camera" (the live engine with the real camera: a sound on the right pans > 0.5, on the left < −0.5, 70 m away is < 0.2 × the level of one at 6 m and duller, Doppler on raises the pitch of an approaching source (> 1.05) and lowers a leaving one (< 0.95), off by default, 3D positioning off centres everything at full level; the same state rendered offline in stereo puts > 3× more energy in the right channel), "interface sounds — select, place, delete, error, success are subtle, rate-limited and switchable" (all five play at gain < 0.12 and centred; thirty selection changes in one frame make ≤ 2 ticks; switching them off in the panel silences them); src/audio/spatial.ts, graph.ts (`SpatialChain`), src/app/audio/uiGate.ts, audioDirector.ts). The spatialiser is a StereoPanner + gain + low-pass per voice rather than the browser's HRTF `PannerNode` (cheaper, testable; LIMITATIONS)
- [x] FX-15 — Spawn/explosion/break/joint-snap/trampoline/launch sounds (tests/audioImpact.test.ts › "event sounds (FX-15)" (all twelve events render to finite, audible buffers; a bigger blast is lower with more of its energy under 120 Hz and a tail over 1 s, the loudest of the set; a harder launch is brighter, the spawn pop higher for small bodies; breaking differs by material: glass > wood > stone in brightness; the snap's pitch drops, a stronger trampoline boing is higher; error is lower than success, place rises, delete falls; parameters are quantised to a few buffers; `registerSoundEvent` validates); tests/audioExtending.test.ts (the guide's example); e2e/tests/audio.mjs › "the blast tool, a shot, a spawn, a breaking spring and a trampoline each play their sound" (all through the real UI and physics: a spring with a 200 N break force snaps → `e|sn|`, a ball dropped on a body tagged `trampoline` → `e|tr|`, the Blast tool click → `e|x|` (loud: gain > 0.05), the Fire tool → `e|la|`, a body added to the running world → `e|sp|`), "collisions play material sounds …" (a glass ball dropped from 30 m → the break event `e|b|glass|`), "components can ask for a sound" (the `ignite`, `bounce` and `sound` component events reach the engine; an unknown id is ignored); src/audio/events.ts, src/app/audio/audioDirector.ts, src/app/projectiles.ts). The `break` sound is triggered by physics only through brittle impacts (the destruction package will call `app.audio.playEvent('break', …)` for fractures); `ignite` / `bounce` / `sound` events are verified by emitting them into the client, not from CP / ZN components


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

### Chunk 2 — sound (FX-10 … FX-15)

**Where things are.** `src/audio/` is the sound system, pure where it can be: `dsp.ts` (recipes → samples, noise, biquads,
the measurements the tests use), `materials.ts` + `impact.ts` (what a struck material sounds like; the plan from a contact
to voices), `events.ts` (event sounds and the interface sounds, a `Registry`), `spatial.ts`, `voicePool.ts`, `rolling.ts`,
`motor.ts`, `ambience.ts`, `settings.ts`, `mapping.ts` — none of them touches WebAudio or the DOM, so `tests/audioCore.test.ts`
and `tests/audioImpact.test.ts` run in Node and **measure the rendered waveforms** (dominant frequency, ring time, spectral
centroid, band shares), not only the parameters. `graph.ts` / `loops.ts` / `engine.ts` / `offline.ts` are the WebAudio side:
they take a `BaseAudioContext`, so the same graphs run live and in an `OfflineAudioContext` (the e2e renders and measures
them in Chromium). `src/app/audio/` is the glue (`AudioDirector`, `bodyAudio`, `motorSources`, `loopSet`, `uiGate`);
`src/ui/audioPanel.ts` + `src/ui/extensions/audio.ts` + `src/ui/soundButton.ts` are the UI. `docs/EXTENDING.md` has the
tested example ("How to add a sound"), `docs/ARCHITECTURE.md` §8b the design.

**Public API.** `app.audio` is the `AudioEngine`: `playEvent(id, position | null, params, velocity?)`, `playImpact(voices,
point)`, `openLoop(category, priority, make)`, `spatialOf`, `stats`, `recent` (the last 64 sounds that started: key, gain,
rate, pan), `cachedKeys()`, `level()` (RMS measured at the master output). `registerSoundEvent`, `registerSoundMaterial`
(`src/audio/index.ts`). Settings are `Prefs.audio` (`AudioSettings`: master switch, mute, master volume, one volume per
category, spatial, Doppler, pitch with time scale, interface sounds); components can ask for a sound with
`ctx.emit('sound', { id, params })` (and `ignite` / `bounce` events play the launch and the trampoline sound);
`app.audioDirector.explosion(at, radius, strength)` and `.launch(at, speed, size)` are for tools.

**Decisions worth knowing.**

* *Mute is Shift+M.* `M` is the Measure tool's key since the first release; the checklist's "mute (M)" would have been a
  shortcut clash (an error at registration), so mute is `Shift+M` (exact Shift match beats the loose `M`), the speaker in
  the top bar and the palette; plain `M` measures as before (checked by the e2e). After a mouse drag the volume sliders
  give their focus back so `Shift+M` works immediately.
* *Nothing exists before a gesture.* The engine creates no `AudioContext` until a pointer, key (other than Escape) or touch
  event, and creates it *inside* that event (the e2e records `window.event` at construction, in a browser started with the
  strict autoplay policy, and fails on any console message about audio). With sound switched off no context is ever
  created and the physics is asked for no contact events; muted, disabled or in a hidden tab the context is suspended
  (250 ms after the fade) and resumed on the next gesture / unmute. Sounds requested before the context runs are dropped,
  not queued.
* *Everything is synthesised, once per distinct sound.* Impacts are modal synthesis (decaying sinusoids at a material's
  mode ratios + a contact click + a body thump) rendered by `renderRecipe` into an `AudioBuffer` and cached under a
  quantised key (material, pitch in sixths of an octave, timbre level 0 … 3, damping, shatter); the fine pitch is the
  playback rate. The cache is an LRU bounded by 280 buffers / 40 MB; at most ~5 ms of rendering a frame (a request whose
  buffer is not ready waits a frame or two, up to a second); the common sounds are rendered in idle frames after the
  context starts (`stats.warming`). Sustained sounds (rolling, engines, wind, the air bed) are live node graphs — noise
  loops through filters, a pulse-train oscillator — whose parameters follow the pure mappings 30 times a second.
* *Loudness is energy, not impulse.* `E = ½·J·v` on a log scale (0.02 J → 0 … 20 kJ → 1), damped for slow hits of heavy
  bodies; timbre follows the speed (a heavy ball touching down is a thump, not a clang). The level → gain curve is
  −50 dB … 0 dB on `L^0.6`, so an everyday hit (a 10 kg ball from a metre) is around −12 dB. Levels were balanced against
  each other by measuring offline renders (impacts peak −20 … −6 dBFS, engine RMS ≈ −24, rolling −28, wind −30, bed −48).
* *Who rings.* Each body rings with its own material (a light body hitting a heavy one rings loudly, the heavy one barely),
  a soft partner damps the ring (steel on foam is a short dull clink), the ground adds a deep thump. A brittle material hit
  hard breaks: the ring is cut short and the director adds the `break` event (the material's own spray of fragments).
* *Rolling vs sliding.* From the lowest point of each body and its velocity (`render/fx/slip.ts`): rolling without slip
  is a low-passed rumble that opens with speed, slip is a band-passed scrape (rubber squeals, metal screeches, stone
  rasps). Load is the body's weight (the engine gives no contact forces). The loudest 6 bodies get voices (kept by body id
  in a `LoopSet`, so a voice follows its body); the scan runs in the 30 Hz loop update, allocation-free.
* *Engines are found, not registered.* A source is a motorised hinge / slider (rpm from the measured joint speed; load from
  the gap between the demanded and the reached speed), or any component whose `ComponentDef.state` has a speed (rpm,
  °/s, rad/s) — load from its throttle / drive / collective % — or, for jets and thrusters, a throttle %. The kind of
  voice (combustion, electric, rotor, jet) comes from the type name (`defaultMotorKind`). The loudest 4 sources sound.
* *Wind is the followed body's air speed*, not the camera's orbit speed (orbiting and panning are not flight), smoothed
  over 0.35 s; the air bed and the wind fade out in zero gravity (read as space). Both only while the simulation runs.
* *Spatialisation.* A stereo panner, a distance gain (inverse law beyond 4 m, silent at 320 m), a low-pass for air and for
  "behind the camera", optional Doppler from the camera's smoothed velocity and the source's velocity.
* *Time scale.* `pitchForTimeScale`: 0.5× → 0.73, 0.25× → 0.54, floor 0.35, 4× → 1.22 — applied to one-shots' playback
  rate and to every loop's frequencies; switchable.
* *Contact events* come from the shared `app.contacts` feed (`minImpulse 0.02`, `pairInterval 0.05`); the strongest 8 per
  frame are handled (`ContactQueue`), and the voice pool (24 impact voices, 36 in all) rejects what nobody would hear.

**Verification evidence.** `tests/audioCore.test.ts` (45), `audioImpact.test.ts` (30), `audioApp.test.ts` (17, against the
real Rapier engine), `audioExtending.test.ts` (3); `e2e/tests/audio.mjs` (16 tests, ~5 minutes under software GL).
Screenshots read: `e2e/out/audio-panel.png`, `audio-muted.png`, `audio-wind.png`. Measured in the browser (software GL, a
slow shared CPU): the director's frame cost is 0.4 ms (mean) in the 300-ball pit once the balls have settled and 6.6 ms
(mean, 17 ms 95th percentile, mostly buffer renders on a cold JIT) during the 3 s avalanche of 300 balls landing at once,
starting ≈ 16 voices a frame; 53 buffers (2.2 MB) cover a whole pit run.
