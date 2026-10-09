# 01 · Shapes, models, colliders, terrain (package SH)

Depends on: foundation (shape registry, compound bodies, asset store). Every shape: inspector parameter editing, correct Rapier collider (convex/compound/trimesh as appropriate), correct volume → mass, bounding radius, three.js geometry, palette tile with a generated icon/thumbnail, serialisation round-trip, physics test (mass = density × analytic volume within tolerance; rests stably on ground; rolls/tumbles plausibly) and a render check.

## Primitives (each is one `ShapeDef` file)
- [ ] SH-1 — torus (major/minor radius, segments) with a true ring-shaped compound/hull-decomposed collider (objects can pass through the hole)
- [ ] SH-2 — ring / washer (flat annulus) and tube / pipe (hollow cylinder, wall thickness) with hollow colliders
- [ ] SH-3 — arch (span, thickness, depth) with a walkable/stackable collider
- [ ] SH-4 — stairs (steps, rise, run, width) and spiral stairs (turns, radius, rise)
- [ ] SH-5 — dome and hemisphere (solid), truncated cone / frustum
- [ ] SH-6 — I-beam and L-beam (and T-beam) structural sections with real section colliders
- [ ] SH-7 — gear (teeth count, module, thickness, bore) and wheel (tire + rim, spokes) as compound colliders
- [ ] SH-8 — ellipsoid (independent x/y/z radii) with an accurate convex collider
- [ ] SH-9 — pyramid (n-gonal), tetrahedron, octahedron, dodecahedron (regular solids)
- [ ] SH-10 — dice (d6 with pips; also d4/d8/d12/d20 with numbered faces) with correct fair-dice rolling
- [ ] SH-11 — curved ramp / half-pipe / quarter-pipe (static-friendly trimesh or decomposed colliders)
- [ ] SH-12 — rounded / beveled variants: box with corner radius (Rapier round shapes or hull rounding), cylinder with rounded edges, chamfer parameter on boxes
- [ ] SH-13 — palette organised by category (basic, structural, mechanical, organic/regular solids, special) with search, generated thumbnails and keyboard shortcuts; shape parameters all editable in the inspector with sensible live-resizing and the scale gizmo

## Compound colliders
- [ ] SH-20 — "Combine selected into one compound body" and "Split compound" commands (undoable), preserving world pose; mass/COM/inertia correct
- [ ] SH-21 — Inspector shows the part list (add/remove/duplicate part, edit part shape/pose/material/sensor flag), gizmo-edit the selected part in the viewport, parts highlight on hover
- [ ] SH-22 — Compound bodies are first-class in picking, outlines, overlays, energy accounting, joints (anchors in body frame), serialisation and share links

## Imported models
- [ ] SH-30 — Import GLB/GLTF, OBJ (+MTL), STL via the Import menu **and** drag-and-drop onto the viewport; asset stored in `doc.assets`; progress/errors surfaced as friendly toasts; size caps with clear messages
- [ ] SH-31 — Import dialog with preview, scale/unit selector (m/cm/mm/in), up-axis fix (Y/Z), recentre, target size, collider mode: **convex hull**, **convex decomposition** (own implementation of approximate convex decomposition with a "max hulls / accuracy" control and a live hull preview), **bounding primitive** (box/sphere/capsule auto-fit), **static trimesh** (only valid for static bodies; automatically forced static with explanation); computed mass from mesh volume × density
- [ ] SH-32 — Imported model renders with its own materials/textures (and can be overridden by the body's material colour); instances of the same asset share geometry
- [ ] SH-33 — Convex decomposition quality verified by tests: hull coverage of volume ≥ target on L-shape, torus, chair-like meshes; concavity respected (a ball dropped into a bowl stays in it)

## Procedural builders
- [ ] SH-40 — Extrude tool: draw/edit a 2D polygon (with holes) in a small sketch dialog (grid snap, numeric vertices, presets) → extruded solid with depth/bevel; collider by decomposition
- [ ] SH-41 — Revolve (lathe) tool: draw a profile curve → solid of revolution (vase, wheel, bowl, rocket) with segment count; collider by decomposition
- [ ] SH-42 — 3D text: text, font choice (bundled typefaces), size, depth, bevel → body with decomposed collider
- [ ] SH-43 — Boolean operations (union / subtract / intersect) between two selected solid bodies producing a new mesh body with a correct decomposed collider; originals optionally kept; uses a robust CSG implementation (dependency allowed) and works with primitives, compounds and imported meshes
- [ ] SH-44 — Every generated mesh is stored as an asset (deduped), survives save/load/share, and is editable by re-opening its builder dialog (parametric history for extrude/revolve/text)

## Terrain
- [ ] SH-50 — Heightfield terrain body (Rapier heightfield collider), size/resolution/scale parameters, procedural generators (flat, rolling hills, mountains, craters, dunes, canyon, ridged noise, seeded), import from a grayscale heightmap image, export heightmap
- [ ] SH-51 — Terrain sculpt tool: raise / lower / smooth / flatten / noise brush with radius + strength + falloff, undoable strokes, collider rebuilt incrementally (live while simulation is stopped; allowed live while running with a clear cost note)
- [ ] SH-52 — Terrain materials: height/slope-based colour bands + texture splat (grass/rock/sand/snow) with per-layer friction applied by sampling under the contact (or a documented single-friction fallback)
