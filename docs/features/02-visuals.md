# 02 · Visuals, materials, lighting, post-processing (package VZ)

Depends on: foundation (light entity kind, environment settings, asset store). Graphics options live in `prefs` (per user) except scene environment (per scene). Every effect has a quality tier and can be disabled; the app auto-selects a tier from a GPU/FPS probe and can auto-scale resolution under load. Headless e2e (software GL) must stay usable: provide a `?quality=low` URL param.

## Materials and textures
- [ ] VZ-1 — ≥ 35 material presets (adds e.g. brass, copper, titanium, stainless, cast iron, oak/pine/bamboo, marble, granite, sandstone, brick, asphalt, leather, cloth, cardboard, clay, carbon fibre, neoprene, PTFE, acrylic, silicone, bone, chocolate, bubblewrap…) with realistic density/friction/restitution **and** PBR parameters; grouped in the material picker with search
- [ ] VZ-2 — Procedural textures (checker, stripes, hazard, wood grain, brick, concrete, marble, noise, grid, dots, carbon weave) generated on canvas, cached, with UV scale/rotation/offset per body and triplanar mapping option
- [ ] VZ-3 — User-supplied images as albedo texture (stored in assets), with optional normal map, roughness map and emissive map; procedural normal maps derived from height patterns; emissive colour/intensity per body
- [ ] VZ-4 — Material editor in the inspector: swatches + live preview sphere; clearcoat, transmission/IOR for glass, sheen, anisotropy as appropriate; applies to multi-selection

## Environment and lighting
- [ ] VZ-10 — Time-of-day control (sun azimuth/elevation, turbidity, rayleigh) with physically-based sky; animating day-night cycle option; sun light + shadow follow
- [ ] VZ-11 — Environment presets (studio, sunny field, overcast, sunset, night city, blueprint, space, lab, desert, snow) and **user HDRI** (.hdr/.exr/.jpg) as environment + optional background blur; exposure and tone-mapping choice (ACES, AgX, Neutral, Linear)
- [ ] VZ-12 — Placeable light entities (point, spot, directional, rect area) rendered from the `light` entity kind: gizmo, colour, intensity (lumens/candela display), range, cone angle/penumbra, shadow toggle (with a global cap on shadow-casters), helper icons, outliner entry, inspector, flicker/pulse option
- [ ] VZ-13 — Fog (linear/exponential/height fog) with colour and density, scene-stored; ground types (grid, checker, plain, none/void, water-ready) and horizon blending

## Post-processing and quality
- [ ] VZ-20 — Post stack with per-effect toggles: bloom (threshold/strength/radius), depth of field (focus pick by click, aperture, max blur), motion blur (velocity-based, camera + object), contact shadows / GTAO (existing, tunable), screen-space reflections (on glossy/metal; tier-gated), vignette, chromatic aberration, film grain, colour grading (LUT-less sliders: exposure, contrast, saturation, temperature), FXAA/SMAA/MSAA choices
- [ ] VZ-21 — Volumetric light shafts (god rays) for the sun and spotlights (screen-space), intensity/decay controls
- [ ] VZ-22 — Quality presets Low/Medium/High/Ultra + Auto (GPU probe + rolling FPS governor that scales pixel ratio and disables expensive effects with hysteresis) and a Graphics panel in the World tab
- [ ] VZ-23 — Weather: rain, snow, falling leaves/dust with wind interaction (particles driven by scene wind), puddle-wet look (roughness reduction), lightning flash; intensity slider; all GPU-instanced and capped

## Scene performance
- [x] VZ-30 — Instanced rendering: identical shape+material bodies (≥ 8) share an `InstancedMesh` with per-instance colour; selection/hover/outline/picking still work per instance; benchmark shows ≥ 3× fewer draw calls on the 300-ball pit (e2e/tests/vz-instancing.mjs: 668 → 32 draw calls over two frames; picking/hover/selection per instance; src/render/instancing.ts, bodyViews.ts. Selected/hovered bodies are promoted to their own mesh so the outline pass and emissive highlight work; `?instancing=0` is the baseline switch)
- [ ] VZ-31 — Level of detail for complex geometry (imported meshes, spheres/cylinders segment counts by screen size), frustum culling verified, hidden-entity skipping
- [ ] VZ-32 — Shadow system upgrades: cascaded/camera-following with stable texel snapping, configurable resolution, contact-hardening look at tier High+

## Feedback visuals
- [ ] VZ-40 — Hover/selection highlight upgrades: distinct hover vs selection vs multi-selection outline colours, animated pulse option, optional bounding box and axis triad on selection, joint & soft-body highlight, linked-entity highlight (select a joint → its bodies glow), colour-blind-safe palette
- [ ] VZ-41 — Damage visuals: accumulated impact damage per body (from protocol impact events) darkens/scratches/cracks the surface (shader-based crack/scorch overlay, per-material behaviour: metals dent-tint, glass cracks, wood splinter tint), configurable, resets on sim reset; damage value in inspector/overlay
- [x] VZ-42 — Visual skins: a body may carry a `skin` (render-only model composed of several meshes) so a physics box can *look* like a detailed object; skin registry with a **detailed car** (chassis shell, glass, headlights/tail-lights that react to brake, interior, wheels with tires/rims/brake discs, wheel rotation + suspension compression from the physics), applied to the drivable car template (evidence: framework in src/render/skins; `car.body` + `car.wheel` in car.ts / carWheel.ts applied by `buildCar`; tests/carSkin.test.ts (struts lengthen/shorten with wheel travel, tail-light intensity on KeyS, tri budget 42k, dispose, live paint colour); e2e/tests/vz-skins.mjs (skins present, W drives +X with spinning wheels, brake light + struts live, inspector Skin select + undo); screenshots read at 1600x900)

## Themes
- [ ] VZ-50 — UI themes: dark (current), light, high-contrast, midnight blue, solarized, "blueprint"; accent colour picker; theme persisted; all panels, charts, overlays and canvases respect tokens (no hard-coded colours left in TS/CSS outside the token layer)

## Implementation notes

### VZ-42 car skin
- `src/render/skins/car.ts` registers `car.body` (box) and `car.wheel` (cylinder, `carWheel.ts`); `carKit.ts` holds the ref-counted shared geometry/material lease and merge batch. The shell is a lofted-by-extrusion body (centre tub + two wheel-arched side pieces, tumblehome/taper baked in, vertex-colour underbody darkening), tinted glass, roof/pillars, mirrors, grille, bumpers, interior (seats, dash, steering wheel, emissive cluster), headlights (emissive, always on) and tail-lights (dim glow; bright while `KeyS` is held, smoothed). About 42k triangles for the whole car.
- Suspension: for every body tagged `car-wheel` within 2.5 m, the chassis skin expresses the wheel's world pose in the chassis frame and stretches damper rod/tube, coil spring and two lower arms from the fixed mount to the hub (real slider travel); brake calipers follow hub position and steering yaw but not the spin; brake discs spin with the wheel skin.
- `buildCar`: chassis `skin: car.body` + tag `car-body`; wheels `skin: car.wheel` + tag `car-wheel`; the glass Cabin is `hidden` (still simulated). Paint follows the chassis' live `material.color` because the skin reads it each frame through `bodiesWithTag('car-body')`, so **colour edits need no hook change**. `skin.params.color` pins a colour instead.
- Inspector: `src/ui/extensions/skin.ts` ("Skin" section, order 160) lists registered skins that fit the shape, plus None; undoable through `ctx.edit`.
- Known limits: skin geometry is fixed-size (resizing the chassis box does not scale the shell); the car is left-hand drive (driver at -Z); the wheel's outer face is chosen from the authored z sign of the wheel body.
