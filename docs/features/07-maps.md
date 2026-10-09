# 07 · Maps, obstacle library, gallery (package MP)

Depends on: foundation, shapes (SH), components (CP), zones (ZN), joints (JT). Maps are registered through the `maps` registry (name, description, category, difficulty, tags, thumbnail rendered offscreen, optional objective hints, spawn point, camera). **Every map and every obstacle must be verified by a behavioural test** (the thing it is supposed to do really happens in the engine) and loads/runs error-free in e2e.

## Obstacle objects (prefabs with real behaviour; available in Prefabs tab with category "Obstacles" and thumbnails)
- [ ] MP-1 — Ramps: straight, steep, curved/quarter-pipe, kicker, spiral; loop-the-loop (a ball/vehicle at design speed completes it) and corkscrew; banked turn
- [ ] MP-2 — Bridges: plank bridge, suspension bridge (cables + deck), drawbridge (hinged, winch/key controlled), swinging log bridge
- [ ] MP-3 — Seesaw, swing, rope swing, trapdoor, hinged gate, revolving door, drawbridge
- [ ] MP-4 — Moving platforms (linear, circular, vertical lift), sweepers (rotating arms), spinning cross, pendulum hammers, piston walls, crushers (timed), rolling-boulder trap
- [ ] MP-5 — Conveyors, trampolines, bumpers, boost/launch pads, fans/wind tunnels, cannons, catapult, slingshot
- [ ] MP-6 — Slides, funnels, chutes, half-pipes, pachinko pegs, Plinko pegs/bins, pinball flippers (key-driven) + bumpers + plunger
- [ ] MP-7 — Dominoes (straight, spiral, branching), bowling pins (regulation layout, correct masses), ten-pin lane, stacks (pyramid, wall, tower, card house), breakable walls
- [ ] MP-8 — Spinners, windmill, waterwheel, gears train, Newton's-cradle pieces, Rube-Goldberg parts (levers, buckets, see-saws, marble tracks, ball returns), teleporter pair, checkpoint gates and finish arch
- [ ] MP-9 — Terrain pieces (hill, crater, dune patches), pools/water basins, lava-style kill zones, goal baskets, target discs

## Maps (≥ 18; each has objectives text, a spawn/camera, thumbnails, tests)
- [ ] MP-20 — Race track with lap timing, checkpoints and a drivable car at the start line
- [ ] MP-21 — Stunt park (ramps, loops, gaps, quarter-pipes) with a car/bike
- [ ] MP-22 — Obstacle course (sweepers, hammers, moving platforms, bridges) with a character/ball start and finish
- [ ] MP-23 — Demolition arena (tower blocks + wrecking ball, destructible walls)
- [ ] MP-24 — Bowling alley (lane, pins, gutter; ball with spin control)
- [ ] MP-25 — Mini golf (several holes, hole detection, stroke counter via throw-aim tool)
- [ ] MP-26 — Pinball table (flippers, bumpers, plunger, tilted table, score zones)
- [ ] MP-27 — Plinko board (pegs, bins with scoring zones)
- [ ] MP-28 — Rube Goldberg machine (a long chain reaction that completes by ringing a bell / hitting a goal)
- [ ] MP-29 — Castle siege (walls, towers, catapult/trebuchet, destructible masonry)
- [ ] MP-30 — Skate park (bowls, rails, half-pipes) with a rollable board/ball
- [ ] MP-31 — Ski slope (long inclined terrain with friction bands, gates) with a sled
- [ ] MP-32 — Canyon (heightfield canyon with a bridge and river water)
- [ ] MP-33 — City blocks (buildings, roads, ramps, ragdoll pedestrians)
- [ ] MP-34 — Water park (pools, slides, floating toys, wave pool)
- [ ] MP-35 — Zero-g space station (rotating ring, gravity wells off, thruster pack)
- [ ] MP-36 — Physics playground / empty arena variants (flat arena, sand box, glass box, bouncy room, ice rink)
- [ ] MP-37 — Bridge-building test site (anchors, budget, load test truck)
- [ ] MP-38 — Hill climb / off-road (terrain + rocks + vehicle)
- [ ] MP-39 — Maps tab UI: grid with offscreen-rendered thumbnails, filters (category/difficulty/tags), search, "random map", favourites, last-played, load into current or new scene

## Boundaries and respawn
- [ ] MP-40 — World bounds & respawn integration (uses ZN-34) with per-map defaults and a respawn hotkey/UI; "reset object" for the followed vehicle

## Gallery
- [ ] MP-50 — Local map/scene gallery: save to gallery with thumbnail, title, tags, description; sort/filter; likes (local), remix (fork with lineage), version history (restore previous versions), import/export packs (zip-free JSON bundle), share link per item
