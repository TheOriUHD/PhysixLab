# 12 · Editing tools and level-building helpers (package ED)

Depends on: foundation (commands/tools registries, group/path entity kinds), shapes (compound). All are undoable single commands, work in edit mode, and respect locked/hidden. Every tool has a toolbox/command entry, shortcut, hint bar text and an e2e or unit test.

## Selection
- [ ] ED-1 — Lasso select and paint (brush) select; additive/subtractive modifiers; select similar (shape/material/size/tag), invert, select by name/tag/type filter, select group children, select connected (by joints), grow/shrink selection by joint adjacency

## Transform and arrangement
- [ ] ED-10 — Align (min/centre/max per axis, to active object), distribute (even spacing, even gaps), drop to ground / onto surface below, stack (vertical pile with gaps), centre on origin, randomise (position/rotation/scale ranges, seeded)
- [ ] ED-11 — Mirror (copy and flip about X/Y/Z or a custom plane, with joints and soft pins mirrored), symmetry mode (edits mirrored live)
- [ ] ED-12 — Array tools: linear, grid, radial (around axis with count/angle), along a path/spline, with live preview and "apply"; instances either independent bodies or linked parametric array (re-editable)
- [ ] ED-13 — Pivot editing (move pivot / transform around cursor, selection centre, individual origins), custom pivot stored per group; rotate around arbitrary axis; world vs local transform space
- [ ] ED-14 — Snapping: to grid, to surfaces (drag objects flush onto surface aligned to normal), vertices, edge midpoints, face centres, other objects' bounds; indicators and toggle chips; numeric transform entry with relative expressions (`+0.5`, `*2`) and units; rotate-by-angle input
- [ ] ED-15 — Snap-to-surface placement for palette/prefab drops (pointer ray onto surfaces, normal alignment option)

## Hierarchy and organisation
- [ ] ED-20 — Grouping & parenting: group selection (Ctrl+G) into a `group` entity with its own transform; moving/rotating/scaling a group transforms children; nested groups; ungroup; lock/hide at group level; "weld group" (fixed joints) and "merge group into compound" (SH-20) options
- [ ] ED-21 — Copy/paste between scenes (clipboard persisted across scene loads and tabs through localStorage + system clipboard text), paste at cursor/at original, paste with joints/connections preserved
- [ ] ED-22 — User prefabs: save selection as prefab (with thumbnail, tags, parametric variables), insert, update-from-scene, nest prefabs, delete; prefab variants (override material/size); library persistence (IndexedDB when available); import/export prefab packs
- [ ] ED-23 — Paths/splines tool: place and edit `path` entities (add/insert/delete points, handles, closed loops, tension), used by movers (CP-30), arrays (ED-12), camera paths (CM-4), rails/tracks (VH-16)

## History and discoverability
- [x] ED-30 — Undo history panel: list of named commands, click to jump to any state (undo/redo to there), branch indicator, clear, limit setting (tests/historyPanel.test.ts; e2e/tests/edB.mjs › history panel; src/ui/extensions/historyPanel.ts, store.historyEntries/jumpTo/clearHistory/historyLimit)
- [x] ED-31 — Right-click context menu (entity, group, joint, soft body, empty space; multi-selection aware) with the relevant commands, shortcut hints, submenus (tests/edBCommands.test.ts; e2e/tests/edB.mjs › context menu; src/ui/extensions/contextMenus.ts, submenus in src/ui/menu.ts). No soft-body Pin row and no joint enable/disable row: the joint type has no such field
- [x] ED-32 — Command palette integration for every new command (foundation provides the palette) and categorised "Add" menu in the viewport (Shift+A) with search (tests/edBCommands.test.ts palette + keymap checks; e2e/tests/edB.mjs › Shift+A; src/ui/addMenu.ts, src/ui/extensions/addMenu.ts)

## Interaction tools
- [x] ED-40 — Blast variants: radial explosion, directional blast, implosion, shockwave ring, constant-force gust; strength falloff curve; tool options bar (tests/edBTools.test.ts › falloff curves / blast variants (maths + engine); e2e/tests/edBTools.mjs › options bar, blast variants; src/physics/world/blast.ts, src/ui/extensions/edTools.ts). Gust = 20 Hz small impulses while the button is held
- [x] ED-41 — Cut tool: draw a cutting plane through selected solid bodies and split them into two correctly-massed convex-hull bodies (with caps), undoable (tests/convexHull.test.ts, tests/cutTool.test.ts, e2e/tests/cut.mjs; src/app/cutTool.ts, src/model/shapes/chunk.ts). Round shapes are cut from a sampled point cloud — docs/LIMITATIONS.md
- [x] ED-42 — Paint tool: brush recolour/material-paint bodies (click or drag across), eyedropper, preset palettes (e2e/tests/edBTools.mjs › paint tool: one undo step per stroke, eyedropper = Shift+click, material mode, four palettes; src/app/edTools.ts)
- [~] ED-43 — Pin tool: pin a body (or soft particle) to the world at the click point with a joint (hinge/ball/fixed) in running or edit mode; unpin (e2e/tests/edBTools.mjs › pin tool in the running simulation + Shift+click unpin; src/app/edTools.ts). Bodies only — a soft particle cannot be pinned at run time (the engine fixes pinned particles when the body is built); soft bodies keep the inspector's Pin presets — docs/LIMITATIONS.md
- [x] ED-44 — Throw/aim tool: aim arrow with power charging (hold), trajectory preview (ballistic, with drag), projectile types (ball, bowling ball, bomb, bullet, crate, heavy ball, dart), mass/size/speed options (tests/edBTools.test.ts › flight prediction vs analytic parabola and vs the real engine, projectile types in the engine; e2e/tests/edBTools.mjs › throw tool; src/app/trajectory.ts, projectileTypes.ts). The preview ignores obstacles, only the ground
- [x] ED-45 — Grab upgrades: scroll wheel changes grab depth, rotate held object (Q/E, R+drag), freeze/unfreeze held object in place (F), grab strength slider, throw-on-release velocity inheritance option, grab soft particles (exists) with the same controls (tests/edBTools.test.ts › grab upgrades in the engine; e2e/tests/edBTools.mjs › scroll depth + F freeze; src/app/input.ts, physics/world/forces.ts). Soft particles get depth, strength and throw scale; rotate and freeze have no meaning for a single particle

## Implementation notes (package ED-B)
- Done and verified: ED-30, ED-31, ED-32, ED-40, ED-41, ED-42, ED-44, ED-45. `[~]`: ED-43 (soft-particle pin, see LIMITATIONS).
- New infrastructure other packages can use: `registerToolOptions({ mode, options })` (src/app/toolOptions.ts) puts a bar of preference-backed controls over the viewport while a tool is active; `InputController.beginCustom` lets a tool own the pointer after the press; `MenuItem.submenu`; `SceneStore.historyEntries/jumpTo/clearHistory/historyLimit`; `chunk` shape (arbitrary convex hull stored in a hidden `text` shape parameter); sim ops `grabSpin`, `grabFreeze`, `release{throwScale}`, `explode{kind,falloff,dir}`, `grab/grabSoft{strength}`.
- Shortcuts added: P paint, N pin, K cut (cut.byAxis in the palette), Shift+A add menu.
- Keys while holding a body: scroll = depth, Q/E = spin, R+drag = turn, F = freeze/unfreeze.
- Merge note: the cut package's hull maths lives in src/core/convexHull.ts (src/core/hull.ts belongs to the soft-body package).
