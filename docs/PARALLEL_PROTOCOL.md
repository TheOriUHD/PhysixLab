# Parallel build protocol (read after `docs/DEV_RULES.md`)

Many cloud sessions build feature packages at the same time, each in its own container, all publishing to **one integration branch: `claude/focused-bell-993u4q`**. This file is the contract that keeps that sane. **Speed matters: the product owner wants the whole program finished in hours, not days.** Work fast, ship working increments early, polish after.

## 0. Setup (first 5 minutes)
```bash
git fetch origin claude/focused-bell-993u4q && git checkout -B work origin/claude/focused-bell-993u4q   # unless your session branch already tracks it
npm ci
npm run typecheck && npm run lint && npm test        # baseline must be green; if red because of someone else's push, tell nobody - just rebase onto the next green tip
```
Read, in this order: `docs/DEV_RULES.md`, `docs/ARCHITECTURE.md`, `docs/EXTENDING.md`, your checklist file(s) in `docs/features/`, then skim `src/` for the registries you will use. Note: where `docs/DEV_RULES.md` talks about git worktrees, ignore that — you are in your own container.

## 1. Publishing (do this after EVERY completed chunk, and at least every ~60-90 minutes)
```bash
git add -A && git commit -m "<PKG>: <what>"       # small, honest commits; use the attribution footer your harness gives you
git fetch origin claude/focused-bell-993u4q
git rebase origin/claude/focused-bell-993u4q      # or merge if the rebase is too painful; NEVER force-push, never rewrite published history
# resolve conflicts keeping BOTH sides' intent (other sessions are adding to the same registries / types / css / docs)
npm install                                        # if package.json changed (package-lock.json conflict: take origin's lockfile, re-apply your package.json additions, `npm install`)
npm run typecheck && npm run lint && npm test      # must be green after the rebase
git push origin HEAD:claude/focused-bell-993u4q    # rejected (someone pushed first)? fetch + rebase + gate + push again; retry network errors 4x with 2/4/8/16 s backoff
```
Before a *package-complete* push also run `npm run build` and the relevant browser tests (`E2E_FILTER=<name> npm run test:e2e`; the full `npm run test:e2e` takes ~10 min — run it once at the very end of your package, not after every chunk). Never push a tree that fails typecheck/lint/unit tests: other sessions rebase onto it. If you find the tip itself is broken by someone else's push, fix it if the fix is small and obvious, otherwise work around it locally and keep going.

## 2. Avoiding conflicts
* New code goes in **new files**; register through the registries (`docs/EXTENDING.md`). Append your registration lines at the end of lists.
* Styles: create `src/styles/<pkg>.css` and add one `import` line at the end of the style imports in `src/main.ts`; do not grow `app.css` except for tiny fixes.
* Shared files (`types.ts`, `factory.ts`, `sanitize/*`, `protocol.ts`, `prefs.ts`, `shell.ts`, world modules, `package.json`): small localised edits wrapped in `// -- <PKG>: <what> --` comments. Never reformat or reorder code you do not own. Run `npm run format` on files you touched only.
* Other packages are landing concurrently. `git fetch` + look at `git log origin/claude/focused-bell-993u4q --oneline | head -40` every hour or so. If a package you depend on has landed, use it; if not, build against the interface in its checklist and keep your coupling behind a tiny adapter so it is easy to connect later (note this in your Implementation notes).
* Do not edit other packages' checklist files, except to tick an item that you made true.

## 3. Verification (lean but real)
* While developing: narrowest tests only (`npx vitest run tests/<file>`; `E2E_FILTER=...`). Software-GL Chromium is slow: keep browser runs short and targeted.
* Tick a checklist item `[x]` only when it is implemented and verified by a test or an observed screenshot; add the evidence note. Use `[~] ... — reason` only for items that are truly infeasible in a static browser app / the engine, build the closest honest alternative, and list it in `docs/LIMITATIONS.md`.
* **Before declaring your package done**, spawn independent subagents (Agent tool, fresh context, in parallel): (1) *evidence reviewer* — attacks every ticked item, runs the gate; (2) *UX reviewer* — drives the new UI in headless Chromium, takes screenshots at 1600x900 and 1280x720, reads them, lists polish defects; (3) *code reviewer* — reads your diff for bugs, leaks, perf hazards, missing sanitising/migrations, tautological tests. Fix everything blocking/major they find, push again.
* Final message of your session: a precise report — ids done+verified, partial, `[~]` with reasons, new dependencies, anything another package must still do. Also append the same under `## Implementation notes` in your checklist file.

## 4. Quality bar reminders
No fake features, no placeholder UI, no `any` without a comment, no per-frame allocations in hot loops, sanitise and migrate every new document field, dispose every three.js resource, keep keyboard accessibility and tooltips, match existing design tokens. Premium means it works, looks right, and is tested.

## 5. If you get stuck
Do not stop. Pick the closest honest alternative, document it, and keep moving; return to the hard part last. Never leave `main`/integration broken; never delete other people's work.
