# AGENTS.md — operating rules for any AI agent working on BOSTON

This file is the entry point for **any** coding AI (Claude, GPT, Gemini, Grok, Cursor,
Aider, …). It is model-independent by design. If you are picking this project up cold,
read `AI_HANDOFF.md` first, then this file.

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
