# PhysicsLab — engineering rules for every contributor (human or agent)

Read this before touching code. The product bar is **premium**: every feature must be real, working, tested and polished. A feature is either genuinely implemented or it is not in the UI.

## The ten commandments

1. **No fake features.** No dead buttons, no placeholder panels, no "coming soon", no stubs that pretend. If the engine cannot do something exactly, implement the closest *honest* behaviour, label it accurately in the UI/tooltip, and document the approximation in `docs/LIMITATIONS.md`.
2. **Feature checklists are contracts.** Every work package has `docs/features/NN-name.md` with items `- [ ] ID — description`. You only change `[ ]` to `[x]` after the item is implemented **and** verified by a test (unit/physics/e2e) or an observed screenshot. Next to each ticked item add a short evidence note: `(tests/foo.test.ts › "name"; src/x/y.ts)`. Never tick an item you did not verify. If an item is infeasible, change it to `- [~] ID — … — REASON + what was built instead` (and put it in `docs/LIMITATIONS.md`).
3. **Document is the source of truth.** Scene data lives in the immutable `SceneStore`; physics runs in the worker from the document; the renderer mirrors it. New persistent state goes in the document (with sanitising in `serialize.ts` and a migration if the schema changes), never in ad-hoc globals.
4. **Extend through registries, not switch statements** (shapes, components, tools, commands, panels, templates, prefabs, maps, joint types). Prefer adding new files and one registration line over editing shared files.
5. **Pure TypeScript physics.** Everything in `src/physics` must run identically in the worker and in Node (Vitest), so physics features get real engine tests with analytic expectations (not "it didn't throw").
6. **Typed and strict.** `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` must be green before you finish. No `any` unless commented why. No `@ts-ignore`.
7. **Performance is a feature.** No per-frame allocations in hot loops, no layout thrash, no O(n²) per frame on large scenes. Measure when in doubt.
8. **Polish.** Consistent design tokens (`src/styles/app.css`), icons from `src/ui/icons.ts`, tooltips, keyboard accessibility, empty states, error messages that tell the user what to do. Match the surrounding code's naming and comment density.
9. **Merge hygiene (parallel work).** Many packages are built concurrently in separate git worktrees. Put new code in new files. When you must edit a shared file (`types.ts`, `factory.ts`, `serialize.ts`, `app.ts`, `world.ts`, `protocol.ts`, `app.css`, `package.json`), keep your edit small and localised, append rather than reorder, and wrap larger insertions in a `// ── <package-id>: <what> ──` comment so a merge resolver can see ownership. Never reformat code you did not change. Do not commit `package-lock.json` churn from unrelated installs; add dependencies with `npm install --save <pkg>` only when truly needed (prefer zero-dependency solutions for small things) and mention them in your report.
10. **Report faithfully.** Your final report lists exactly which checklist items are done+verified, which are partial/infeasible and why, files added/changed, new dependencies, commands you ran and their results. If tests fail, say so.

## How to verify

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint (flat config, type-aware typescript-eslint)
npm run format:check     # prettier; `npm run format` rewrites (new code only: see rule 9 on not reformatting)
npm test                 # vitest: real Rapier engine in Node
npm run build            # tsc + vite build
E2E_PORT=5201 npm run test:e2e              # headless Chromium drives the real UI (own vite server, default port 5199)
E2E_PORT=5201 E2E_SHOTS=1 npm run test:e2e  # + screenshots into e2e/out/
E2E_PORT=5201 E2E_FILTER=joint npm run test:e2e   # only tests whose name contains "joint"
E2E_URL=http://127.0.0.1:5173 npm run test:e2e    # use an already running dev server instead of starting one
```

* UI features must be exercised in the browser: add an e2e test (a new file `e2e/tests/<package>.mjs` exporting `tests = [{ name, fn }]`, picked up automatically by `e2e/run.mjs`; helpers such as `newPage`, `simTime`, `screenOf`, `assert` live in `e2e/helpers.mjs`) or at least take and **look at** a screenshot (Read the PNG) to confirm it renders sensibly. Headless Chromium uses software WebGL (swiftshader); heavy post-processing will be slow there — keep tests short.
* Use your own `E2E_PORT` (and Vite dev port) when working in a worktree so parallel packages do not collide. Never edit `src/` while an e2e run against the same dev server is in progress (HMR reloads break the run).
* Vitest swallows `console.log`; use `process.stderr.write` for debugging. Do not `pkill -f` with a pattern that matches your own shell.
* If you work in a git worktree: run `ln -s <main-checkout>/node_modules node_modules` (it is git-ignored), create a branch named after your package (`git checkout -b wp/<id>`), commit there with clear messages, and report the branch name and head SHA. Do not push; the integrator merges.
* Commit message footer (when you commit):
  ```
  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01M6Xgo9GJDjvdHSYzAdoWkp
  ```
  Never put model identifiers anywhere else in the repository (code comments, docs, PRs).

## Map of the code

See `docs/ARCHITECTURE.md`. In short: `src/model` (document + registries), `src/physics` (Rapier world, worker, protocol), `src/render` (three.js), `src/app` (wiring, input, editor commands, persistence), `src/ui` (vanilla TS panels), `tests/` (Vitest), `e2e/` (Playwright-core driver).
