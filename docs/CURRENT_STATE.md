# CURRENT_STATE.md — living project state

**Update this file whenever you fix something or find something.** It is the handover
surface: a new agent should be able to read only this and know where to start.

Last verified: 2026-08-27, commit `bafd01b`.

---

## Status at a glance
| | |
|---|---|
| Boots | Yes — 22 systems, `bootReport.failed` is `[]` |
| Console | 1 known error (atmosphere pass auto-disabled, below) |
| Real fps | 32.5 @ 981×568 `high`. **Not yet measured at the 1920×1080 budget resolution.** |
| Draws / tris | 394 / 2.67M — **inside** the 1200 / 3.5M budget |
| Cold boot | ~8 s (was ~45 s) |
| Visual quality | **~3/10.** Content is real; it does not yet look good. |

## What exists and works
- **Engine**: dependency-sorted system registry, fixed 60 Hz physics, clamped variable
  render step, `import.meta.glob` auto-loading of subsystems.
- **City**: 504 edges / 375 nodes, **96 km of street**, 11,219 parcels, 1,513 spawn points,
  real Boston geography via `geo(lat,lon)`. HUD reads real street names.
- **Buildings**: 6,942, placed on real parcels, with compiling facade shaders.
- **Landmarks**: 20, at true coordinates — 200 Clarendon, Prudential, State House dome,
  Custom House, Fenway/Green Monster, Citgo sign, Zakim Bridge, Old State House.
  23,882 tris in **4 draws** — the batching standard to aim for elsewhere.
- **Props / vegetation**: 33,770 prop instances (86 types), 19,405 plants (19 types).
- **Lighting**: 3 cascades @ 2048/2048/1536, 1,500 street lamps, 2,226 emissive sources.
- **Physics** (Rapier), **vehicles**, **audio**, **HUD/minimap/menu**, **profiler**.
- **Capture harness** (`window.__boston`): 8 named shots, deterministic stepping,
  `measureFps()` that refuses to lie about a backgrounded tab.

## Resolved root causes — do not re-debug these
| Symptom | Root cause | Fixed in |
|---|---|---|
| Whole frame renders black | `postprocessing`'s `SSAOEffect` reports full occlusion at city scale and `MULTIPLY`-blends the frame to nothing | Replaced with N8AO |
| Whole frame renders black (2nd time) | `CopyPass` ignores its `outputBuffer` argument and writes to its own target | RenderPipeline |
| Facade shader: ~500 duplicate `aTex`/`vLayer`/`vEmis`/`vWPosB` declarations | Mutual infinite recursion between two `onBeforeCompile` interceptors; the `RangeError` was swallowed by a bare `catch` | `BuildingKit.installPatch` + `Lighting.applyWindowLights`, commit `bafd01b` |
| Boot fails on a not-yet-written system | Vite statically resolves `import('./literal.js')` | `import.meta.glob` in `main.js` |
| "5 fps" / "83 fps" phantom numbers | Backgrounded-tab rAF throttling | `measureFps()` refuses when `document.hidden` |
| "Clouds cost 66 ms" | GPU-sync bracketing on a tile GPU forces a tile flush | Clouds actually cost ~3.6 ms; see `PERF_REPORT.md` §4 |
| Cold boot 45 s | Per-pixel JS texture synthesis without `willReadFrequently`, redundant full-size octaves | materials 12,782→653 ms, props 12,672→600 ms |

## Unresolved issues (ranked)
1. **`atmosphere` pass collapses the frame to black** and is auto-disabled by the render
   pipeline's validator, so **clouds and volumetric fog do not render at all**. The sky is
   a flat gradient and there is no aerial perspective. This is the biggest single visual
   deficit. Re-enable with `__boston.render.revalidate()` after fixing.
   *Owner: atmosphere. Files: `src/gfx/Clouds.js`, `src/gfx/Fog.js`, `src/shaders/sky/`.*
2. **`night_neon` renders near-black.** Night is a signature GTA-style view and currently
   unusable. *Owner: lighting.*
3. **Water shader fails to compile** — `nonPerturbedNormal` undeclared / `geometryNormal`
   redefined; three r171 renamed this varying. Two programs fail `VALIDATE_STATUS`.
   *Owner: city/materials. File: `src/world/Water.js`.*
4. **Crushed blacks in daylight** — a double sRGB→linear conversion was found making
   bounce light 7.8× too dark. Verify the fix actually landed and holds.
   *Owner: lighting.*
5. **Buildings read as flat boxes at mid/far LOD.** Even the cheapest tier needs facade
   banding, window-grid variation and a roofline. *Owner: buildings.*
6. **Vegetation reads as "broccoli"** — blobby canopies, insufficient silhouette variety.
   *Owner: vegetation.*
7. **Not yet built at all**: `Traffic.js`, `Pedestrians.js`, `Player.js`, `Missions.js`.
   The city has no traffic, no pedestrians and no player character. Empty streets are the
   #1 tell of a tech demo on the critic rubric.

## Performance methodology (read `PERF_REPORT.md` §0 in full before profiling)
**The headline: this is a fill-rate problem in post-processing, not a geometry problem.**
The entire scene render — every building, road, tree and prop — is ~4.8 ms of a ~48 ms
frame. Draws and triangles are inside budget at every shot and preset.
**Do not reduce building/road/prop/vegetation triangle counts. Do not rewrite the clouds.**

Trustworthy instruments: `__boston.measureFps()`, `Profiler.prefixCost()`.
Garbage instruments here: `engine.perf`/DevOverlay fps (CPU-only), disabling composer
passes (rewires ping-pong buffers), GPU-sync bracketing inside a pass (tile flush).

## Next priorities (highest leverage first)
| # | Action | Est. gain | File |
|---|---|---|---|
| 1 | `PRESETS.high.pixelRatioCap` 1.5 → 1.25 or 1.0 — on a DPR-2 display `high` renders 2.26× the pixels the budget is written against | **18–36 ms** | `src/core/Settings.js` |
| 2 | Fix resize so `pixelRatioCap` actually applies: call `renderer.setSize(w,h,false)` after `setPixelRatio` (`EffectComposer.setSize` skips it when CSS size is unchanged) | unblocks #1 | `src/gfx/RenderPipeline.js` ~146 |
| 3 | Let `glowMesh` frustum-cull; lower/clamp `uMinPx` — 1,500 additive quads with an enforced minimum on-screen size become full-screen overdraw | **10–16 ms at night** | `src/gfx/LightManager.js` |
| 4 | Fix the black atmosphere pass, then re-check its render-target sizing (currently sized from a stale canvas width: 326×184, not 480×270) | correctness | `src/gfx/Clouds.js`, `Fog.js` |
| 5 | Merge the final two `EffectPass`es / drop sharpen taps when TAA is off | up to 25 ms, unproven | `RenderPipeline._rebuild` |
| 6 | Build Traffic, Pedestrians, Player | the "density & life" rubric axis | `src/ai/`, `src/gameplay/` |
| 7 | Surface `measureFps` in the DevOverlay instead of `engine.perf` | stops future misdiagnosis | `src/ui/DevOverlay.js` |
