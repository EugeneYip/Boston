# PERF_REPORT.md

> ## SUPERSEDED — read this before trusting any number below
>
> This report dates from **2026-08-27** and its absolute figures are **void**. Two
> separate instrument defects invalidated them:
>
> 1. Every frame-time number predating 2026-08-30 was taken while **AO and SSR were
>    silently absent from the compositor** (`BUDGET.high` gated them off while
>    `Pass.enabled` reported `true` — fixed in `06ed84c`), so they do not describe the
>    pipeline that ships.
> 2. `engine.perf` and `measureFps()` read a **throttled rAF cadence** in the embedded
>    preview pane, and reported 71.74 ms for a frame that genuinely cost 6.5 ms.
>
> **Current verified baseline** (short-burst protocol, 1920x1080 preset `high`, AO and
> SSR live): 3.7-5.3 ms across `hero_skyline`, `overcast_wide`, `night_neon`,
> `st_southend`, `st_beaconhill` and `rain_street` — worst case ~31% of the 16.7 ms
> budget, with every triangle, draw and shadow budget met. See `docs/CURRENT_STATE.md`
> §Status and `AI_HANDOFF.md` §6 for the measurement protocol.
>
> **Performance is not currently a priority.** There is roughly 11 ms of headroom to
> spend on image quality. The methodology notes below remain useful; the numbers do not.

# BOSTON — performance diagnosis

Measured with `src/core/Profiler.js` (this report's companion deliverable).
Author: performance agent. All numbers re-measured after the city/buildings content landed.

---

## 0. Read this before quoting any number

**The headline: this is a fill-rate problem in post-processing, not a geometry problem.**
The entire scene render — every building, road, tree and prop — is **4.8 ms of a 48 ms
frame**. Draw calls and triangles are *inside* budget at every shot and every preset.
The 3.8M-triangle figure that started this investigation is not the cause and chasing
it will not buy frames.

### Measurement conditions
- Chrome/Electron on Apple Silicon, tab **fronted and visible** (`document.hidden === false`).
- `high` preset, `street_level`, 1920x1080 drawing buffer unless stated.
- Served from a second Vite server on **:5399** with HMR disabled, rooted at the same live
  source tree, so other agents saving files could not full-reload the page mid-measurement.
  Port 5273 was left untouched. Nothing in the repo was modified to do this.

### Three instruments that produce garbage here — do not use them
1. **`engine.perf.ms` / `perf.fps` / the DevOverlay FPS readout.** These wrap
   `engine.frame()` with `performance.now()`, which measures **CPU submission only**. When
   the frame is GPU-bound the CPU runs ahead and the cost never appears. Observed
   simultaneously: overlay `24.7 fps`, real loop `2.8 fps`. At `night_neon` the overlay read
   **138 fps** on a frame that genuinely takes ~99 ms. Every fps number in this report comes
   from either a GPU-synced measurement or `measureLoopFps()`.
2. **A/B-disabling composer passes** (`pass.enabled = false`). postprocessing rewires its
   ping-pong buffers and `needsSwap` bookkeeping, so removing a pass legitimately makes the
   frame *slower*. This is why `composer = null` measured slower than the full chain. My own
   run produced `MotionBlurPass: -33.95 ms`. It is not a valid instrument.
3. **GPU-sync bracketing inside a pass.** On this tile-based GPU, a mid-chain
   `finish()`+readback forces a tile flush costing tens of ms, which lands on whatever you
   are bracketing. This is the artefact behind **both** the "clouds cost 66 ms" figure and my
   own first-pass "LensPass 54.6 ms". Bracketed, the clouds measured **96.9 ms**; the same
   clouds measured end-to-end measured **3.6 ms**.

### The instrument that does work
`Profiler.measurePrefix()` — render the chain but stub out every pass after index *k*, sync
**once**, and time it. `cost(k) = T(k) - T(k-1)`, so the single sync's overhead cancels in
the subtraction, and stubbing `render` leaves the buffer rotation identical. Empty-chain
floor measured **0.03 ms**, i.e. the instrument's own overhead is negligible.

### Contention caveat (important)
Five other agent tabs share this GPU. **The baseline drifts up to ~30% over ~30 seconds** —
I watched a stable baseline move 28.7 -> 37.2 ms mid-experiment. Consequences:
- Absolute ms below are **min-of-N taken back-to-back**; treat them as +/- 30%.
- Every differential number uses **alternating A/B/A/B with medians** so linear drift cancels.
- **Ratios and rankings are reliable; absolute ms are indicative.** The ranking below was
  stable across four independent runs.

---

## 1. Ground truth

| Measurement | Value |
|---|---|
| Coordinator's honest baseline (natural rAF, visible tab) | **13 fps, 492 draws, 2.73M tris** |
| My GPU-synced full frame, same conditions | **~75 ms = 13.3 fps** |
| Prefix-timed render chain + shadows | **48.5 ms** |
| All CPU systems combined | **~3.0 ms** |
| Budget | 16.7 ms |

The synced measurement and the coordinator's rAF measurement **agree**. Target: remove ~58 ms.

CPU is not the problem. Heaviest system is `buildings` at **1.5 ms/frame**; everything else
is under 0.5 ms. Do not spend effort on `update()` loops.

---

## 2. Where the frame goes — ranked

Prefix timing, min of 5 repeats x 6 frames, `street_level`, `high`, 1920x1080.

| # | Item | ms | % of 48.5 | Owner |
|---|---|---:|---:|---|
| 1 | Final `EffectPass` — `LensFinalEffect` + `FilmGrainEffect`, renders to canvas | **25.5** | 53% | render |
| 2 | Shadow maps, worst case (all 3 cascades in one frame) | **7.7** | 16% | lighting |
| 3 | `BokehDofPass` | **7.7** | 16% | render |
| 4 | `N8AOPostPass` (listed as `Pass#2`) | **3.7 – 8.8** | 8–18% | render |
| 5 | `RenderPass` — **all scene geometry** | **4.8** | 10% | city / buildings |
| 6 | `TAAPass` | **4.2** | 9% | render |
| 7 | `LensPass` (bloom pyramid) | **2.4** | 5% | render |
| 8 | `atmosphere` (clouds + volumetric fog) | **1.2** | 2% | atmosphere |
| 9 | `AutoExposurePass`, `VelocityPass`, `MotionBlurPass`, `EffectPass#10` | **< 1.5 each** | – | render |

Rows sum to more than the chain total because each is a min over independent runs under drift.

**On row 1.** `EffectPass#11` contains only `LensFinalEffect` (4 sharpen taps + 2 chromatic
aberration taps + 1 luminance fetch) and `FilmGrainEffect` (1 fetch) — about 8 texture reads.
That cannot cost 25 ms on its own. It is also the only pass with `renderToScreen === true`,
so prefix timing folds the canvas resolve/present into it. I tried twice to separate the two
and the result was inconclusive under contention. **What is certain and actionable:** the row
scales **2.02x for 2.26x pixels** — it is purely fill-bound, so the lever is resolution and
pass count, not the shader. Flagged to the render agent to confirm with a native GPU capture.

---

## 3. The single biggest lever: `pixelRatioCap`

| `pixelRatioCap` | Drawing buffer | Mpx | Chain | + shadows |
|---|---|---:|---:|---:|
| 1.0 | 1920x1080 | 2.07 | 40.8 ms | **48.5 ms** |
| 1.5 | 2880x1620 | 4.67 | 68.5 ms | **84.1 ms** |

**Dropping `high` from 1.5 to 1.25 saves ~18 ms; to 1.0 saves ~36 ms.** On any DPR-2 display
`high` currently renders 2.26x the pixels the budget is written against — ARCHITECTURE.md
specifies "60 fps at 1920x1080", and `PRESETS.high.pixelRatioCap = 1.5` silently doubles that.

- **File:** `src/core/Settings.js`, `PRESETS.high.pixelRatioCap` (1.5) and
  `PRESETS.ultra.pixelRatioCap` (2.0).
- **Owner:** render.

### Related bug — runtime `pixelRatioCap` changes do nothing
`RenderPipeline`'s resize handler calls `renderer.setPixelRatio(...)` then
`composer.setSize(w, h)`. postprocessing's `EffectComposer.setSize` **skips
`renderer.setSize()` when the CSS size is unchanged**, so the new pixel ratio never reaches
the drawing buffer. Changing quality at runtime leaves the framebuffer at the old resolution.
Fix: call `renderer.setSize(w, h, false)` explicitly after `setPixelRatio` in the `resize`
handler in `src/gfx/RenderPipeline.js` (~line 146). **Owner: render.**

---

## 4. Clouds: settled — **no rewrite justified**

The 66 ms vs 0 ms dispute has a single, verifiable cause. Console, live build:

```
[render] pass "atmosphere" collapsed the frame to black (mean 4.3 -> 0.00).
Disabled to keep the build visible; re-enable with __boston.render.revalidate()
```

The render agent's validator **auto-disabled the atmosphere pass**. So:
- Hiding the clouds changed nothing — correct, the pass was already off.
- The atmosphere agent's 66 ms — measured with the pass forced on, and (given my identical
  96.9 ms bracketed result) almost certainly inflated by the sync-bracket artefact.

Measured end-to-end with the pass re-enabled: **3.58 ms total** (`renderMs` 36.57 -> 40.15),
and **1.2 ms** by prefix timing. Clouds are ~2% of the frame. **Do not fund a cloud rewrite.**

The real bug is the black frame. Also found while in there:

- **Cloud and volumetric-fog render targets are 326x184**, not the 480x270 the 0.25 scale
  implies at 1920x1080. `Clouds.applyQuality()` (`src/gfx/Clouds.js` ~line 163) sizes from
  `ctx.renderer.domElement.width` at init time, capturing a stale canvas width. Same for
  `AtmosphereFog.setSize`. Fix the black frame first, then re-check the sizing — the pass
  will get more expensive once it is correctly sized. **Owner: atmosphere.**

---

## 5. Night is the worst case: +61 ms over day

Same preset, near-identical draw and triangle counts:

| Shot (high) | Render ms | Cam draws | Cam tris |
|---|---:|---:|---:|
| `street_level` | 37.9 | 162 | 885k |
| `night_neon` | **99.1** | 160 | 1,034k |

Geometry is flat; the cost is shading and overdraw. Alternating A/B, median of 5:

| Toggle at `night_neon` / high | ms |
|---|---:|
| Hide the whole `lights` subtree | **19.1** |
| Hide only `lightPools` (ground pools) | 2.6 |
| => attributable to **`lightGlows`** | **~16.5** |

`lightGlows` is 1500 additive camera-facing quads with `frustumCulled = false`,
`depthWrite: false`, `AdditiveBlending`, and a `uMinPx` uniform that **enforces a minimum
on-screen size** so distant lamps never shrink. That floor is exactly what turns 1500 small
quads into full-screen overdraw.

- **File:** `src/gfx/LightManager.js` — `GLOW_VERT` (`uMinPx`, `vec2 sz = max(iSize, vec2(d * uMinPx))`),
  `_buildProxies()` (`glowMesh.frustumCulled = false`), `MAX_GLOWS = 4600`.
- **Fixes, cheapest first:** (a) let `glowMesh` frustum-cull normally — it is a static
  bounded set; (b) lower `uMinPx` (currently `0.0016`) or clamp the minimum to ~1.5 px;
  (c) tighten `uFade0/uFade1` at night so far glows drop out sooner.
- **Estimated saving:** 10–16 ms at night, near zero visual cost at street level.
- **Owner: lighting.**

The remaining ~40 ms of the day/night delta is the per-fragment emissive-window branch
(`WIN_BODY` in `src/gfx/Lighting.js`) which runs on **every facade fragment** at night —
two `bostonHash21` calls, a `smoothstep` pair and a `sin`-based TV flicker per pixel.
Worth measuring separately with a native capture. **Owner: lighting.**

> Caveat: `night_neon` currently renders almost entirely black (see §7). The glow cost is
> real regardless — additive quads still rasterise — but re-confirm once night is lit.

---

## 6. Budget compliance — draws and triangles are NOT the problem

Camera pass measured by graph walk reproducing `WebGLRenderer.projectObject` culling;
totals from `renderer.info`.

| Preset | Shot | Buffer | Cam draws | Cam tris | Shadow draws | Total draws | Total tris | Render ms |
|---|---|---|---:|---:|---:|---:|---:|---:|
| low | street_level | 1280x720 | 123 | 620k | 68 | 188 | 0.89M | 15.2 |
| low | hero_skyline | 1280x720 | 55 | 500k | 8 | 83 | 0.78M | 11.0 |
| low | night_neon | 1280x720 | 90 | 590k | 30 | 131 | 0.84M | 18.9 |
| low | overcast_wide | 1280x720 | 70 | 527k | 21 | 124 | 1.13M | 12.9 |
| high | street_level | 1920x1080 | 162 | 885k | 97 | 386 | 1.80M | 37.9 |
| high | hero_skyline | 1920x1080 | 124 | 1,114k | 31 | 228 | 1.43M | 35.9 |
| high | night_neon | 1920x1080 | 160 | 1,034k | 91 | 310 | 1.53M | **99.1** |
| high | overcast_wide | 1920x1080 | 136 | 1,269k | 62 | 330 | 2.54M | 39.2 |
| ultra | street_level | 2560x1440 | 174 | 1,388k | 107 | 347 | 2.18M | 113.4 |
| ultra | hero_skyline | 2560x1440 | 161 | 1,889k | 43 | 285 | 2.61M | 85.6 |
| ultra | night_neon | 2560x1440 | 195 | 1,661k | 111 | 435 | **3.88M** | **241.6** |
| ultra | overcast_wide | 2560x1440 | 194 | 2,350k | 76 | 328 | 2.61M | 96.0 |

- **Draw calls: max 435 against a 1200 budget.** Comfortable everywhere. Instancing is doing
  its job — `props` renders 8,373 instances in ~110 draws.
- **Triangles: max 3.88M against 3.5M**, and only at `ultra`/`night_neon`. `high` peaks at
  2.54M. Within budget.
- Time does **not** track triangles: `hero_skyline` at ultra draws 1.89M tris in 85.6 ms
  while `night_neon` draws 1.66M in 241.6 ms.

**Implication for city / buildings / props / vegetation: no geometry reduction is required.**
`buildings` is the largest subtree (up to 1.76M tris at `overcast_wide`/ultra) but the whole
`RenderPass` is only 4.8 ms. Spend effort elsewhere.

---

## 7. Correctness bugs found while profiling

| Bug | Detail | Owner |
|---|---|---|
| `atmosphere` pass auto-disabled | Collapses frame to black (mean 4.3 -> 0.00). Clouds + volumetric fog are currently **not rendering at all**. | atmosphere |
| `night_neon` renders black | 22:00 shot is near-total black with the overlay reporting 138 fps. | lighting |
| Water shader fails to compile | `ERROR: 0:1689: 'nonPerturbedNormal' : undeclared identifier` and `'geometryNormal' : redefinition` in a `MeshStandardMaterial` `onBeforeCompile`. Two programs fail `VALIDATE_STATUS`. Three r171 renamed this varying. | materials / city (Water.js) |
| Runtime `pixelRatioCap` is a no-op | See §3. | render |
| Cloud/fog RTs sized from a stale canvas width | See §4. | atmosphere |

---

## 8. Cold boot

`props` was the outstanding 12,672 ms. Measured with `Profiler.profileInit()`, which builds a
**second** instance of the system against a throwaway scene (nothing live is touched):

| | ms |
|---|---:|
| Cold boot (reported) | 12,672 |
| Second init, caches + JIT warm | **1,762** |
| — `_buildAll` | 1,425 |
| — `_buildWires` | 111 |
| — `_registerTypes` / `_buildLightPool` | 2 / 5 |

Only ~1.8 s is geometry and instancing. The other ~11 s is one-time procedural texture
synthesis plus JIT warm-up on cold numeric loops — the same shape as the materials win
(12,782 -> 3,688 ms). Hot paths, all in `src/world/StreetFurniture.js`:

- **`noiseField(size, cells, seed)`** (~line 59) — allocates a fresh `Float32Array(size*size)`
  on every call.
- **`fbm(size, seed, octaves = 5, ...)`** (~line 81) — calls `noiseField` **5 times at full
  size**; the first octave only needs `base = 4` cells. Generate each octave at its own
  resolution and upsample, or accumulate in place into one preallocated buffer.
- **`normalFromHeight(height, size, strength)`** (~line 93) — per-pixel closure `at(x, y)`
  called 4x, each doing **two `%` operations**. For 512x512 that is ~2M modulos through a
  megamorphic closure. Hoist to precomputed wrap tables and inline the reads; this alone is
  usually a 5–10x win on this exact pattern.

**Owner: props.** Same fix pattern that already worked for materials.

---

## 9. Recommendations, ranked by ms saved per unit of effort

| Rank | Change | Est. saving | Effort | File / symbol | Owner |
|---|---|---:|---|---|---|
| 1 | `PRESETS.high.pixelRatioCap` 1.5 -> 1.25 (or 1.0) | **18–36 ms** | one constant | `src/core/Settings.js` | render |
| 2 | Fix `resize` so `pixelRatioCap` actually applies (`renderer.setSize` after `setPixelRatio`) | unblocks #1 at runtime | 1 line | `src/gfx/RenderPipeline.js` ~146 | render |
| 3 | Let `glowMesh` frustum-cull; lower/clamp `uMinPx` | **10–16 ms at night** | small | `src/gfx/LightManager.js` `_buildProxies`, `GLOW_VERT` | lighting |
| 4 | Merge the final two `EffectPass`es / drop `LensFinalEffect` sharpen taps when TAA is off; confirm present-vs-shader split with a native capture | up to 25 ms, unproven split | medium | `RenderPipeline._rebuild`, `LensFinalEffect` | render |
| 5 | Halve `BokehDofPass` gather (`MAX_RINGS 4`, 24 samples/ring) or gate DOF off `high` | **~4–7 ms** | small | `src/gfx/effects/BokehDofPass.js` | render |
| 6 | Gate `TAAPass` + `VelocityPass` off `high`, keep for `ultra` | **~5 ms** | small | `RenderPipeline._rebuild`, `options.taa` | render |
| 7 | Reduce N8AO `aoSamples` (12) / `denoiseSamples` (6) further on `high` | **~2–4 ms** | one constant | `RenderPipeline.init` ao config | render |
| 8 | Fix the black `atmosphere` pass, then re-check RT sizing | correctness; +1–4 ms when re-enabled | medium | `src/gfx/Clouds.js`, `src/gfx/Fog.js` | atmosphere |
| 9 | Optimise `fbm` / `normalFromHeight` / `noiseField` | **~5–9 s cold boot** | medium | `src/world/StreetFurniture.js` | props |
| 10 | Fix the `nonPerturbedNormal` water shader error | correctness (2 dead programs) | small | `src/world/Water.js` | materials / city |
| 11 | Stop trusting `engine.perf` for fps; surface `measureLoopFps` in the DevOverlay | avoids future misdiagnosis | small | `src/ui/DevOverlay.js` | render |

**Explicitly do NOT do:** reduce building/road/prop/vegetation triangle counts, or rewrite the
clouds. Neither is on the critical path, and both are inside budget.

---

## 10. The profiler

`src/core/Profiler.js`, `static id = 'profiler'`. Wraps `engine.frame`, every system's
`update`/`fixedUpdate`/`lateUpdate`, and `renderer.shadowMap.render` **at runtime** — no other
agent's file is touched. Per-frame path allocates nothing; the expensive parts are on demand.

### Loading it
`main.js` builds its system list from `import.meta.glob` over `gfx/world/ai/gameplay/ui/audio`
only, so **nothing in `src/core/` is auto-registered**. Until the core owner adds
`'./core/*.js'` to that glob and `'./core/Profiler.js'` to `OPTIONAL`, attach after boot:

```js
const { default: Profiler } = await import('/src/core/Profiler.js');
await Profiler.attach(window.engine);      // idempotent
```

**Request to the core owner:** two lines in `src/main.js` to make it permanent.

### API (all on `window.__boston`)
| Call | What it does |
|---|---|
| `profile({deep})` | Full structured JSON report. Stamps `hidden`/`warning` if the tab is backgrounded. |
| `profileFast()` | Cheap smoothed snapshot; safe every frame. |
| `prefixCost({frames, repeats, shadows})` | **The trustworthy per-pass instrument.** |
| `loopFps(seconds)` | Real rAF frame rate; refuses when `document.hidden`. |
| `sceneCost({heavy})` | Draws/tris per top-level subtree + heaviest meshes. |
| `systemCost()` | CPU ms per system, per phase. |
| `cascadeCost(n)` / `passCost(n)` | Sync-bracketed. **Known to over-report on tile GPUs — see §0.3.** |
| `initCost(id, methods)` | Cold-boot breakdown via a throwaway second instance. |
| `bisect({...})` | A/B helper. Shadow toggles use uniforms only, never `castShadow` or `shadowMap.enabled` (both force a full shader recompile). |

`RenderPipeline`'s original pass profiler is preserved as `__boston.profilePasses`.

### Things the instrument deliberately refuses to do
- Never toggles `renderer.shadowMap.enabled` or `light.castShadow` — both change shader
  defines and recompile every material in the scene (this wedged the page for minutes on the
  first attempt).
- `measureRender()` excludes shadow maps by design: `composer.render()` never runs
  `lateUpdate`, so nothing re-marks `shadow.needsUpdate` and three skips them. Shadow cost is
  measured separately by forcing every cascade dirty.

---

## 11. Open questions I could not settle

1. **Present vs shader inside the final `EffectPass`.** Two attempts were inconclusive under
   GPU contention. Needs a native capture (Xcode Metal / Chrome GPU trace). 25 ms is the
   single biggest row, so this is worth someone's time.
2. **Per-cascade shadow cost.** `measureCascades()` returned obvious nonsense (1008 ms for
   cascade 0) — the sync-bracket artefact again. The aggregate worst-case 7.7 ms is sound;
   the per-cascade split is not. Shadows are ~16% of the frame, so this is not urgent.
3. **The emissive-window fragment branch** (§5) — likely tens of ms at night but not isolated.
