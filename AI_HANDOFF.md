# AI_HANDOFF.md — cold-start orientation

You are taking over **BOSTON**, an open-world Three.js game set in a geographically
accurate Boston. This file assumes you know nothing and have only this repository.
It is written to be useful to any coding AI, not just the one that started it.

## 1. Orient yourself (10 minutes)
Read in this order:
1. `AGENTS.md` — rules, stack, exact validation commands.
2. `ARCHITECTURE.md` — the binding engine contract (coordinate system, system lifecycle,
   performance budget).
3. `docs/CURRENT_STATE.md` — what works, what's broken, what's next. **The single most
   important file. Keep it current.**
4. `CONTRACTS.md` — only the sections for the systems you'll touch.

Then prove the project runs, exactly as in `AGENTS.md`:
`npm install` → `node tools/parsecheck.mjs` → `npm run dev` → open `localhost:5273`
→ check `window.__boston.bootReport.failed` is `[]` and the console is clean.

## 2. How the codebase is shaped
- `src/core/` — engine, event bus, settings, input, geo projection, capture harness,
  profiler. Shared foundation; change carefully.
- `src/gfx/` — render pipeline, materials, sky/clouds/weather/fog, lighting, shadows.
- `src/world/` — city graph, roads, terrain, water, buildings, landmarks, props,
  vegetation, vehicle models.
- `src/physics/` — Rapier world, vehicle dynamics, tire model.
- `src/ui/`, `src/audio/`, `src/ai/`, `src/gameplay/` — as named.
- `src/main.js` discovers systems with `import.meta.glob`. **Drop a new system file in and
  it loads automatically**; a file that doesn't exist yet is simply skipped. This is
  deliberate — it lets many agents build in parallel without breaking each other's boot.

## 3. How this project is built (the loop)
The working method is an autonomous build/critique/repair loop:
1. Fan out parallel agents, each owning a disjoint set of files.
2. Each agent verifies its own work in the browser — screenshot + clean console.
3. A **hostile visual critic** scores frames against `docs/CRITIC_RUBRIC.md`, asking one
   question: *would a stranger instantly pick this as the browser render, not GTA V?*
4. Whatever the critic rejects is routed back to the owning system.
5. Repeat. Log each pass as a row in `docs/PROGRESS.md`.

If you are a single agent without the ability to fan out, work the ranked list in
`docs/CURRENT_STATE.md` §Next priorities from the top. It is kept in
highest-leverage-first order.

## 4. Hard-won lessons — do not relearn these
- **Never trust an fps number without checking `document.hidden`.** Background tabs
  throttle rAF to zero. This produced two separate phantom diagnoses.
- **`engine.perf` and the DevOverlay measure CPU submission only.** They read ~4× high
  when GPU-bound. Use `__boston.measureFps()`.
- **Do not A/B-profile by disabling postprocessing passes.** `postprocessing` rewires its
  ping-pong buffers, so removing a pass can measure *slower*. One run produced
  "MotionBlurPass: −33.95 ms". Use `Profiler.prefixCost()`.
- **Do not GPU-sync inside a pass on a tile GPU.** A mid-chain `finish()`+readback forces a
  tile flush costing tens of ms, which lands on whatever you're bracketing. This alone
  manufactured a "clouds cost 66 ms" figure for something that costs 3.6 ms.
- **Chaining `onBeforeCompile` is dangerous.** Two agents independently intercepting it
  caused mutual infinite recursion whose `RangeError` was swallowed by a bare `catch`,
  surfacing only as a shader with 500 duplicate declarations. Any interceptor must return
  a **stable function identity**, guard re-entry, and be **idempotent per shader object**.
- **Vite statically analyses `import('./literal.js')`** and hard-fails on a missing file.
  That's why system loading uses `import.meta.glob`.
- `postprocessing` merges non-convolution effects into one pass; each convolution effect
  needs its own. `autoRenderToScreen` only recomputes when passes are added or removed —
  **not** when you toggle `enabled`, which yields false blacks while bisecting.

## 5. Your first commit
Make a local commit as soon as you have a verified-bootable state, before changing
anything substantial. Do not push unless asked.
