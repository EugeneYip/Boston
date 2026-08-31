# AGENTS.md — operating rules for any AI agent working on BOSTON

This file is the entry point for **any** coding AI (Claude, GPT, Gemini, Grok, Cursor,
Aider, …). It is model-independent by design. If you are picking this project up cold,
read `AI_HANDOFF.md` first, then this file.

## Canonical repository — verify before any work
**`/Volumes/Projects/boston`**, on an external SSD.

```bash
mount | grep /Volumes/Projects     # must be mounted
pwd                                # /Volumes/Projects/boston
git rev-parse --show-toplevel      # /Volumes/Projects/boston
git status -sb
```

**If `/Volumes/Projects` is not mounted, STOP.** Never silently fall back to, recreate,
or use another Boston checkout. `~/Desktop/boston` was renamed `boston-OLD-DO-NOT-USE`;
anything pointing there predates the migration of 2026-08-31.

**Pushes are manual, performed by the repository owner.** Commit locally; do not push,
and do not assume `origin/main` holds the newest commit.

**Before deleting or moving any repository, inspect `git worktree list --porcelain`.**
Auxiliary worktrees under `.claude/worktrees` can hold uncommitted work; a clean main
worktree does not mean no auxiliary worktree has valuable state.

## Resource policy — machine safety, not preference
- Maximum **2 agents total**; maximum **1 WebGL/browser-heavy agent at a time**.
- Internal free disk **>= 6 GiB** before heavy visual work; elevated swap is a reason
  not to fan out. Below ~4-5 GiB, stop fan-out, close contexts, converge and commit.
- **Close browser/WebGL contexts promptly** — a hidden context still holds a full city
  scene.

This is an operating-system margin, **not** a repository storage requirement: the repo
lives on the SSD and is small. Internal disk is consumed by macOS swap, AI transcripts
and browser caches. A three-agent wave once created three 1 GiB swapfiles and drove the
machine to the point where a git object was corrupted mid-write.

## What this project is
An open-world game set in a geographically real Boston, built in **Three.js**, targeting
the highest visual quality achievable in a browser. Quality bar: *a hostile art director
comparing a screenshot side-by-side with GTA V should not instantly pick ours as the
browser render.*

## Stack (do not change without saying so explicitly)
`three@0.171.0` · `postprocessing@6.39` · `n8ao@2` · `@dimforge/rapier3d-compat@0.20` ·
Vite. Plain ES modules, no TypeScript, no JSX, no build step beyond Vite.

## The five documents
| File | What it is |
|---|---|
| `AI_HANDOFF.md` | Cold-start orientation. Read first. |
| `AGENTS.md` | This file — rules and commands. |
| `ARCHITECTURE.md` | Engine contract: coordinate system, system lifecycle, perf budget. **Binding.** |
| `CONTRACTS.md` | Cross-system interfaces. Implement/consume exactly. |
| `docs/CURRENT_STATE.md` | Living state: what's fixed, what's broken, what's next. **Update it.** |

Supporting: `docs/PERF_REPORT.md` (measured perf diagnosis), `docs/CRITIC_RUBRIC.md`
(how visual work is judged), `docs/AGENT_BRIEF.md` (per-agent working brief),
`docs/PROGRESS.md` (build log, one row per iteration).

## Exact validation commands
Run all of these before claiming anything works.

```bash
# 1. Install (once)
npm install

# 2. Parse-check every source file (fast, catches truncated/half-written files)
node tools/parsecheck.mjs

# 2b. Scope-check every source file. parsecheck runs esbuild's PARSER, which only
#     proves a file is syntactically well-formed -- a bare identifier is legal
#     syntax, so esbuild assumes it is a global and says nothing. parsecheck
#     therefore reported "OK -- all 80 files parse cleanly" on a tree whose boot
#     died instantly with `ReferenceError: tile is not defined at Terrain.build`,
#     and the shared dev server was dead for a long stretch. This catches that
#     class. It is static, so booting the app is still the authoritative gate.
node tools/scopecheck.mjs

# 3. Run the dev server (port 5273, strict)
npm run dev

# 3b. HMR-FREE verification server (port 5290) -- use this for screenshots and
#     any frame timing when other agents may be saving files. The shared dev
#     server full-reloads every tab on every save, which makes measurements
#     fiction (observed: 19.9 / 9.8 / 10.3 / 8.3 / 5.4 fps on an UNCHANGED scene).
npm run verify
```

Then in the browser at `http://localhost:5273`:
```js
// Wait for boot, then:
window.__boston.bootReport            // { loaded, missing, failed } — `failed` must be []
await window.__boston.measureFps(2)   // real fps; refuses if the tab is backgrounded
window.__boston.stats()               // draws / tris / geometries / textures / programs
await window.__boston.capture({ shot: 'street_level' })   // park camera + render deterministically
window.__boston.shotNames()           // the 8 named review viewpoints
```
The browser console must be **clean** — zero errors.

**Booting is not optional before you claim something works.** Neither parsecheck nor
scopecheck can see a conditional or cross-module runtime failure. `bootReport.failed`
must be `[]` and `window.__boston.glFaults` must be `[]`.

If the Browser pane is hidden, `document.hidden` is true, `requestAnimationFrame` is
throttled to zero and `measureFps()` **refuses by design**. Do not report an rAF-based
number in that state; drive frames synchronously instead and force GPU completion:
```js
const b = window.__boston, r = b.engine.renderer, gl = r.getContext();
function bench(n){const s=[];for(let i=0;i<n;i++){const t=performance.now();b.step(1/60);gl.finish();s.push(performance.now()-t);}s.sort((a,c)=>a-c);return s[Math.floor(s.length/2)];}
```
Keep any single evaluation under ~40 `step()` calls; ~190 exceeds the tool timeout.

**Bench in SHORT BURSTS WITH IDLE GAPS, or you will measure your own throttling.**
A tight `step()` + `gl.finish()` loop saturates the GPU, and after roughly 50–60
consecutive stepped frames the machine throttles hard. Measured on an unchanging
frozen frame, with geometries, textures, programs, draws and triangles *identical*
throughout: 6.1 → 5.8 → 4.4 → 4.7 → **32.3 → 42.9 ms**, then back to **4.3 ms after
a 4-second idle**. It is not a leak and not scene state — it recovers completely.
This is why several agents reported frame cost as "unmeasurable", quoting ranges
like 2.3–95.8 ms or 114–217 ms and blaming sibling tabs: the long run was doing it
to itself. Protocol that works:

```js
const idle = (ms) => new Promise(r => setTimeout(r, ms));
await b.capture({ shot });
await idle(1200); burst(10);              // discard: shader compilation
await idle(1200); const a = burst(10);
await idle(1200); const c = burst(10);
const ms = Math.min(a, c);                // agreeing bursts, not a long median
```
Two bursts that agree are trustworthy; a long median is not.

## Non-negotiable rules
1. **Y up. 1 unit = 1 metre. +X east, −Z north. Origin = Boston Common.** Place every
   real-world thing via `geo(lat, lon)` from `src/core/Geo.js`. Never hand-guess coords.
2. **Only `src/gfx/RenderPipeline.js` may call `renderer.render()`.**
3. Systems are classes with `static id`, optional `static deps`, and
   `init/update/fixedUpdate/lateUpdate/dispose`. `src/main.js` auto-loads them via
   `import.meta.glob`; a missing file degrades gracefully instead of failing boot.
4. **No per-frame allocation in `update()`.** Reuse module-scope scratch vectors.
5. Everything must `dispose()` cleanly.
6. If several agents work in parallel, **each edits only files it owns**. To change
   someone else's file, report it instead. Chaining another system's
   `onBeforeCompile` has already caused one infinite-recursion outage — see
   `docs/CURRENT_STATE.md` §Resolved.

## Measuring performance — read before quoting any number
A backgrounded tab throttles `requestAnimationFrame` to **zero**, and `capture()`/`step()`
drive frames synchronously. Neither reflects real performance.
`engine.perf` / the DevOverlay FPS readout measure **CPU submission only** and over-report
badly when GPU-bound (observed: overlay 129 fps on a 32.5 fps frame).

**Only these are trustworthy:**
- `await window.__boston.measureFps(2)` — real rAF loop; refuses when `document.hidden`.
- `Profiler.prefixCost()` — per-pass GPU cost. See `docs/PERF_REPORT.md` §0 for the three
  instruments that produce garbage here and why.

Always state **resolution and quality preset** alongside any fps figure.
Budget: **60 fps at 1920×1080 on `high`**, <1200 draws, <3.5M tris.

## Git
Commit locally at verified-bootable points. Do not push unless asked.
