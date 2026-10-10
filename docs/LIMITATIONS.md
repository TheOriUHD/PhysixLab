# Known limitations & roadmap

Honest list of what PhysicsLab does **not** do (yet). Nothing in the UI pretends otherwise.

## Physics

* **Rigid joints are not breakable.** The engine does not expose constraint impulses for rigid joints, so a weld/hinge/slider cannot report how loaded it is. Springs *are* breakable (their force is measured exactly) — stiff springs with a break force make breakable struts for trusses. Estimating rigid-joint loads (e.g. by instrumenting the solver or resolving per-island momentum balances) is the main item on the destruction roadmap.
* **Soft bodies** (jelly, balloon, cloth, cable) are simulated as particle lattices and are **not attachable to rigid bodies or joints** — they can only be pinned in space. Their cost grows with particle count (a 24×24 cloth is ≈ 3 ms/step; self-collisions roughly double it, so keep those for small cloths). The *elastic* energy stored in a deformed soft body is not included in the energy chart (its kinetic and gravitational energy are). Changing a soft body's parameters while simulating rebuilds it at its starting pose. No fluids; rigid-body fracture is not implemented (cloth and cable tearing is).
* **Softness is a frequency, not a modulus.** The stiffness control is the material's natural frequency: ~7 Hz is very squishy, ≈ 40 Hz and above is nearly rigid. Below ~4 Hz a jelly stops conserving volume and collapses.
* **No concave colliders.** Every collider is a primitive or a convex hull. Compound bodies (`parts`: several colliders on one rigid body, each with its own pose and material overrides) approximate concave shapes, but nothing decomposes a concave mesh into parts automatically yet. Resizing a compound body scales its parts proportionally; for a part that is rotated relative to the body a non-uniform scale is approximated (a rotated box cannot be sheared).
* **Large mass ratios across a joint chain** (a 1 kg link carrying a 1000 kg mass) converge slowly with the iterative solver. Raise *Solver iterations* in the World tab, or keep ratios moderate (the car's suspension hubs are deliberately heavy for this reason).
* **Pair material model**: friction is averaged and restitution is the maximum of the two surfaces. There is no per-pair material table or rolling resistance.
* **Determinism** holds for identical inputs on the same browser/engine build, but live edits and the variable number of steps per frame in real-time mode mean two real-time runs of the same scene are not guaranteed bit-identical (single-stepping and zero-input runs are).
* **Per-body sleep threshold is emulated.** Rapier 0.21's JavaScript bindings expose no per-body sleep thresholds, so a body with a `sleepThreshold` has the engine's own sleeping switched off and is put to sleep by the world once its linear speed and the surface speed of its rotation (|ω| × bounding radius) have stayed below the threshold for 0.5 s. A touch from an awake body wakes it as usual. The emulation judges each body on its own (the stock rule works on whole islands of touching / jointed bodies), so it is meant for free bodies and simple stacks. Without a threshold the engine's default applies, unchanged.
* **Collision groups are a 16-group / 16-bit-mask filter** (Rapier interaction groups): a body is in one group and collides with the groups set in its mask, and the other body's mask must accept it too. The ground slab is a member of group 0 and accepts every group, so a body whose mask lacks bit 0 falls through the ground. There is no per-pair material table and no per-group solver or contact-event filtering yet. The model, the sanitiser and the world support groups; there is no editor UI for them yet.
* **Mass overrides keep the shape's inertia tensor.** `massOverride` scales the density so the true mass distribution is kept; `comOverride` moves the centre of mass but keeps the principal inertia about the old centre of mass instead of re-deriving it for the new point (the mass distribution that would put the centre there is not known), the same convention as Unity's `centerOfMass`.
* **Kinematic bodies** move at the constant velocity / spin of their definition unless a mover component drives them: the `sineMover` component follows x(t) = A·sin(2πft + φ) along an axis. Editing a mover's amplitude or phase while it runs jumps the body to the new curve in one step (a moving platform's riders feel it); there are no waypoint / path movers yet.

## Editor

* Compound bodies exist in the document, the world and the renderer, but there is no editor UI to author their parts yet (use scene files / prefabs); no terrain/heightfield.
* **The asset store holds data, nothing draws it yet.** Meshes, textures, heightmaps, audio and blobs can be stored in a scene, referenced (`BodyEntity.meshId`), de-duplicated, saved, shared and undone, but no importer, renderer or collider consumes them yet — a body with a `meshId` is still drawn and simulated from its shape or parts. Share links carry assets too and are refused above 150 kB (the scene can still be exported as a file); assets are capped at 16 MB each, 64 MB and 256 per scene.
* Scaling is per-shape-parameter (diameter, height, extents); a body cannot be non-uniformly scaled if its shape does not allow it (spheres, cylinders and cones stay round).
* Joint creation derives the second body's anchor from the first; for a hinge/slider the initial relative pose is the zero reference, so set up the layout before connecting.
* **Groups** carry a pivot transform and move their members; they have no scale (resizing a group is not offered) and joints between a member and an outsider stretch when the group moves. Members keep world poses, so a group's pivot does not follow its members around when they are moved individually. Rotating a group turns the world-space vectors the document stores on its members (initial and kinematic velocities, world-anchored joint ends and their axes) but not the world-space *parameters of components* (a Sine mover's axis, a Constant force in World axes): re-aim them by hand after rotating a group (a Constant force in Body axes turns with its body by itself). Group helpers are hidden while simulating. Per-object collision layers have no editor UI.
* **Lights** are editor objects with a real three.js light each; only the first 8 enabled lights light the scene and 3 cast shadows (more are drawn as helpers only). Rect-area lights cast no shadows (a three.js limitation) and light surfaces without any image-based "bounce". Lights do not take part in the simulation (no light-triggered logic yet).
* **Paths** are edited point by point (gizmo on a selected handle, or numerically in the inspector); there is no freehand drawing tool, and nothing follows a path yet — the spline, its arc-length evaluation and `ctx.path` are in place for the mover components.
* The library lives in browser storage (a few MB). Use export/share links for anything important.

## Components and protocol v2

* **Components of an unknown type are dropped on load** (with a warning), like unknown shapes: a scene saved by a build with more components than this one loses those components rather than carrying data nobody can edit or run. Two registries must agree: a type needs both its `ComponentDef` (model) and its `ComponentRuntime` (worker); a def without a runtime is kept but inert.
* **Contact events report the *start* of contacts only** (a ball hitting the floor, a crate landing), not sliding or resting contact; use `ctx.contacts()` for what a body touches right now. The approach `speed` of a contact event is estimated from the impulse and the pair's effective mass and restitution (`J / (m_eff·(1 + e))`): exact for a central impact, approximate for off-centre or fast-spinning contacts. Events are rate-limited per pair, so a bouncing ball reports its first impact within each `pairInterval`, not every micro-bounce.
* **Sensors need a moving body on one side**: the engine reports sensor overlaps for dynamic-vs-fixed and dynamic-vs-kinematic pairs, not for a kinematic body inside a static sensor.
* **Ray casts see the world as of the last step**: a ray after bodies were added, removed or teleported first runs a zero-length update step (time does not advance and a resting scene is untouched); kinematic bodies moved during the current step are seen at their previous position until the next step. The update step re-solves the contacts once, so in a scene with moving contacts a run that casts rays right after edits is deterministic but not bit-identical to a run that does not.
* **Snapshots are exact for what the engine and the world record** (rigid bodies, joints, soft bodies, RNG, clock, components with `saveState`). Components without `saveState` start over from their parameters on restore; the mouse grab is released; pending events and the per-pair rate-limit memory of contact events are not saved (so the first impact of a pair after a restore is reported even if it had reported within `pairInterval` before the snapshot); key and axis input are supplied by the next tick. A snapshot is for this build's engine: its bytes are not a file format.
* **Component state is published only on change** and read by component id; there is no history (the telemetry package keeps series).

## Rendering & platform

* Targets desktop browsers with WebGL 2 and WebAssembly; touch navigation works (orbit/zoom) but editing is mouse- and keyboard-centric.
* Very large scenes (several thousand bodies) are limited by per-body draw calls, not by the physics worker; instanced rendering of identical shapes is a straightforward next step.
* Shadows cover a camera-following frustum, so distant objects are unshadowed.

## Ideas on the roadmap

1. Rigid-joint load estimation + breakable welds/hinges; fracture templates.
2. Attach soft bodies to rigid bodies and joints (sails, nets, hanging cloth), cutting tools for cloth, volumetric soft meshes from imported shapes.
3. Vehicle presets with tunable suspension geometry; tyre friction curves.
4. Timeline: record a run, scrub it, compare two runs side by side.
5. Instanced rendering and GPU-side picking for very large scenes.
6. Community gallery on top of the existing share-link format.
7. Challenges/objectives (reach a target, hold a load) evaluated by the same telemetry.
