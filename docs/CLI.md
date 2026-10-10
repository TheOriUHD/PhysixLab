# Headless batch mode (DT-33)

`npm run cli` runs a scene to completion in Node on the same `PhysicsWorld` the browser worker uses — no browser, no
rendering, fixed time step, seeded RNG — so results are reproducible. Use it for parameter sweeps, regression checks and
data collection for reports.

```bash
npm run cli -- run scene.physicslab.json --steps 600 --every 10 --out result.csv
npm run cli -- run template:car --steps 300 --sweep gravity=-1.6,-9.81,-24.8 --track Chassis --final
npm run cli -- run scene.json --steps 1200 --sweep Ball.material.restitution=0:1:5 --sweep seed=1,2,3 --out sweep.json
```

| Option | Meaning |
|---|---|
| `run <scene.json \| template:<id>>` | a saved scene (validated and migrated like in the app) or a built-in template id |
| `--steps N` | fixed steps to simulate (default 600; one step = `1 / settings.physicsHz` seconds) |
| `--every N` | record a sample every N steps (default 10; the last step is always recorded) |
| `--seed N` | override `settings.seed` |
| `--sweep p=v1,v2,…` / `p=from:to:count` | repeatable; the runs are the cartesian product (≤ 10 000 points) |
| `--track a,b` | entity names or ids to record (default: every body) |
| `--out FILE` | `.json` → structured result, anything else → CSV; without it CSV goes to stdout |
| `--final` | CSV only: keep each run's last sample |
| `--quiet` | no summary line on stderr |

**Sweep paths.** `gravity` (y component; `gravity.x` / `.y` / `.z`), `seed`, `settings.<field>` (e.g.
`settings.airDrag`), or `<entity name or id>.<field path>` (e.g. `Ball.material.friction`, `Ball.position.1`). The field
must already exist and keep its type; unknown names fail with exit code 2 and a message.

**CSV columns:** `run, <one column per swept parameter>, seed, step, time, body, x, y, z, vx, vy, vz, kinetic, potential`
(one row per run × sample × body; kinetic / potential are whole-scene energies in joules). **JSON:** `{ scene, steps,
runs: [{ index, params, seed, samples: [{ step, time, bodies: { id: [x y z vx vy vz] }, energy }], final }] }`.

**Exit codes:** `0` ok · `1` the simulation failed (e.g. diverged to non-finite values) · `2` usage error / bad sweep ·
`3` the scene could not be read or is invalid.

**Determinism.** Same scene + same seed + same options ⇒ byte-identical output (tested). The CLI is bundled on first use
with Vite's SSR build into `node_modules/.cache/physicslab-cli`, which takes about a second.

Programmatic use: `import { runBatch, parseSweep, toCsv } from './src/cli/batch'` (pure TypeScript, no DOM).
