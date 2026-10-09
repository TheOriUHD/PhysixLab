# 09 · Destruction and damage (package DS)

Depends on: foundation, joints (breakable rigid joints JT-10..12), shapes (compound/mesh), visuals (damage visuals VZ-41), FX (debris/sparks).

- [ ] DS-1 — Pre-fractured objects: fracture a body into N pieces (Voronoi cells clipped to the convex/mesh volume; seeded) held together by breakable welds sized by area/material strength; pieces keep correct mass (sum = original), colliders convex; tool + command + inspector "Fracture…" dialog (cells, irregularity, interior face colour)
- [ ] DS-2 — Runtime shatter: brittle materials (glass, ceramic, concrete, ice, stone) fracture on impacts above an energy threshold or from blasts, into seeded Voronoi pieces at the impact point (denser near impact), conserving momentum; per-material toughness; debris pooling & cap with auto-sleep/cleanup of tiny pieces
- [ ] DS-3 — Collapsing structures: buildings/walls/towers assembled from blocks (bricks, beams, slabs) connected by breakable joints/glue with material strength; a destruction demo (tower collapse after supports are hit) behaves plausibly and is stable until damaged (tests)
- [ ] DS-4 — Damage model: per-body health from accumulated impact energy and joint load with armour/ductile vs brittle response; thresholds trigger deformation visuals, fracture, joint release or removal; health bars optional; reset restores
- [ ] DS-5 — Demolition tools: wrecking ball, explosive charges (timed, shaped), demolition hammer impulse tool, cutting plane tool (slices bodies into two convex pieces with correct mass/COM)
- [ ] DS-6 — Fracture/destruction scenes: demolition arena support, glass wall, brick house, domino-collapse tower, bridge failure — registered as templates with tests
- [ ] DS-7 — Performance guards: maximum piece counts, merge-to-sleep, distance-based simplification, time-sliced fracture computation so a frame never stalls (>25 ms) in the worker
