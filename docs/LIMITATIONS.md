# Known limitations & roadmap

Honest list of what PhysicsLab does **not** do (yet). Nothing in the UI pretends otherwise.

## Physics

* **Rigid joints are not breakable.** The engine does not expose constraint impulses for rigid joints, so a weld/hinge/slider cannot report how loaded it is. Springs *are* breakable (their force is measured exactly) — stiff springs with a break force make breakable struts for trusses. Estimating rigid-joint loads (e.g. by instrumenting the solver or resolving per-island momentum balances) is the main item on the destruction roadmap.
* **No deformable bodies, fluids, cloth or fracture.** The engine build includes soft-body support; it is not wired into the editor yet.
* **No compound/concave colliders.** Each body has exactly one convex (or primitive) collider. Concave shapes must be built from several bodies and welded together.
* **Large mass ratios across a joint chain** (a 1 kg link carrying a 1000 kg mass) converge slowly with the iterative solver. Raise *Solver iterations* in the World tab, or keep ratios moderate (the car's suspension hubs are deliberately heavy for this reason).
* **Pair material model**: friction is averaged and restitution is the maximum of the two surfaces. There is no per-pair material table or rolling resistance.
* **Determinism** holds for identical inputs on the same browser/engine build, but live edits and the variable number of steps per frame in real-time mode mean two real-time runs of the same scene are not guaranteed bit-identical (single-stepping and zero-input runs are).
* **Kinematic bodies** move at a constant velocity/spin; there is no keyframe or sinusoidal driver (use a motorised joint instead).

## Editor

* Single-collider bodies only; no mesh import; no terrain/heightfield.
* Scaling is per-shape-parameter (diameter, height, extents); a body cannot be non-uniformly scaled if its shape does not allow it (spheres, cylinders and cones stay round).
* Joint creation derives the second body's anchor from the first; for a hinge/slider the initial relative pose is the zero reference, so set up the layout before connecting.
* Groups/folders in the outliner and per-object collision layers are not implemented.
* The library lives in browser storage (a few MB). Use export/share links for anything important.

## Rendering & platform

* Targets desktop browsers with WebGL 2 and WebAssembly; touch navigation works (orbit/zoom) but editing is mouse- and keyboard-centric.
* Very large scenes (several thousand bodies) are limited by per-body draw calls, not by the physics worker; instanced rendering of identical shapes is a straightforward next step.
* Shadows cover a camera-following frustum, so distant objects are unshadowed.

## Ideas on the roadmap

1. Rigid-joint load estimation + breakable welds/hinges; fracture templates.
2. Soft bodies and tearable cloth using the engine's soft-body solver.
3. Vehicle presets with tunable suspension geometry; tyre friction curves.
4. Timeline: record a run, scrub it, compare two runs side by side.
5. Instanced rendering and GPU-side picking for very large scenes.
6. Community gallery on top of the existing share-link format.
7. Challenges/objectives (reach a target, hold a load) evaluated by the same telemetry.
