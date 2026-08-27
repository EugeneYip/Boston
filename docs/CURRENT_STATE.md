# CURRENT_STATE.md — living project state

**Update this file whenever you fix something or find something.** It is the handover
surface: a new agent should be able to read only this and know where to start.

Last verified: 2026-08-27, commit `06f93d3`.

> **Note on verification while several agents are running.** `capture()` runs the engine's
> `update()` chain, so a throw in *any* system aborts the shot. During this pass `HUD`
> (`this.moneyN` undefined), `Pedestrians` (`_refreshCandidates`) and `Traffic` all threw
> inside `capture()`. If you need a shot and someone else's system is mid-flight, stub its
> `update` at runtime rather than editing their file. Vite's HMR full-reload will also wipe
> the page between `capture()` and a screenshot; `npx vite build` + a static server gives a
> stable target.

---

## Status at a glance
| | |
|---|---|
| Boots | Yes — 22 systems, `bootReport.failed` is `[]` |
| Console | `__boston.errors` is `[]`. One driver **warning** remains: `glDrawArrays: Feedback loop formed between Framebuffer and active Texture` from a fullscreen post pass — see issue 1. |
| Real fps | **13 @ 1920×1080 `high`** (`measureFps(2)`, settled, static build, `hero_skyline`). Unchanged by the buildings fix — the whole city now rasterises for the same cost, which is what `PERF_REPORT.md` §6 predicts. |
| Draws / tris | 217 / 1.37M at `hero_skyline`; 529 / 2.87M at `downtown_dusk` — **inside** the 1200 / 3.5M budget |
| Cold boot | ~8 s (was ~45 s) |
| Visual quality | **~3/10.** Content is real; it does not yet look good. |

## What exists and works
- **Engine**: dependency-sorted system registry, fixed 60 Hz physics, clamped variable
  render step, `import.meta.glob` auto-loading of subsystems.
- **City**: 504 edges / 375 nodes, **96 km of street**, 11,219 parcels, 1,513 spawn points,
  real Boston geography via `geo(lat,lon)`. HUD reads real street names.
- **Buildings**: 6,942, placed on real parcels, **and they now actually rasterise** —
  facade banding, window grids and rooflines read at every LOD (see §Resolved). Roofs get
  a per-building surface, tone and re-covered field from `Facades.pickRoof`.
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
| **Buildings do not rasterise — the whole city renders FLAT** | `BuildingKit.installPatch` defined `onBeforeCompile` as an **own accessor**, shadowing the `Material.prototype` accessor `CascadedShadows.installLightingShaders` installs. That prototype hook is the only thing injecting the shared `boston*` uniforms — one of which is `bostonProbeTex`, a **`sampler3D`** declared unconditionally by the patched `shadowmap_pars_fragment` chunk. Never receiving it, three never assigned it a texture unit, so it kept the default **unit 0** — the same unit the facade's `sampler2DArray` atlas lands on. The driver then rejected every building draw with `GL_INVALID_OPERATION: glDrawElements: Two textures of different types use the same sampler location`. Geometry, transforms, attributes, material flags and the compiled shader were all correct; the draw call simply never executed. Only buildings/landmarks were hit because every other system assigns `onBeforeCompile` normally and so goes through the prototype setter. | `BuildingKit.installPatch`, commit `d3de1e3` |
| Roofs read as bare pale planes from every elevated shot | The always-resident LOD-2 shell lidded its parapet (`cap` at `ty + parapet - 0.46`), putting that surface up to **0.9 m above** the LOD-0 roof deck. The shell is drawn even where a detailed chunk is loaded, so its lid covered every real roof in the city and hid all the roof furniture underneath. | `Facades.buildShell`, deck now caps at the shell drop plane with a proper inner parapet face |

## Unresolved issues (ranked)
1. **`street_level` is unusable: a fullscreen post pass forms a framebuffer feedback loop.**
   The `atmosphere` pass is enabled again and `hero_skyline` / `downtown_dusk` / the
   downtown aerial all render correctly, but any **low camera** collapses the frame into a
   stretched noise buffer over pure black. Measured (`meanLum` / `blackFrac` of the frame,
   `tod 9.5 clear`, same look direction):

   | cam Y | 2 | 6 | 14 | 30 | 70 | 150 |
   |---|---|---|---|---|---|---|
   | mean lum | 50.5 | 52.1 | 45.2 | 105.7 | 128.6 | 129.6 |
   | black frac | **0.49** | 0.01 | 0.14 | 0.08 | 0.01 | 0.00 |

   **This is not buildings — proven twice.** Swapping all facade materials for a plain
   `MeshStandardMaterial` reproduces it identically, and hiding the entire `buildings` root
   changes the frame by less than 1% (`blackFrac` 0.48 → 0.47, `meanLum` 50.5 → 51.0).
   The console shows only `glDrawArrays: Feedback loop formed between Framebuffer and
   active Texture` — a fullscreen pass sampling the target it is writing. Worth re-checking
   the note that the atmosphere RT is sized from a stale canvas width (326×184).
   *Owner: atmosphere / render pipeline. Files: `src/gfx/Clouds.js`, `src/gfx/Fog.js`,
   `src/gfx/RenderPipeline.js`.*
2. **`night_neon` renders near-black.** Night is a signature GTA-style view and currently
   unusable. *Owner: lighting.*
3. **Water shader fails to compile** — `nonPerturbedNormal` undeclared / `geometryNormal`
   redefined; three r171 renamed this varying. Two programs fail `VALIDATE_STATUS`.
   *Owner: city/materials. File: `src/world/Water.js`.*
4. **Crushed blacks in daylight** — a double sRGB→linear conversion was found making
   bounce light 7.8× too dark. Verify the fix actually landed and holds.
   *Owner: lighting.*
5. **Buildings at mid/far LOD** — partly done. The LOD-2 shell already carries baked
   `fac_*` facade strips (one vertical repeat = one storey), a plinth, a coping line and a
   roof kit, so it no longer reads as a bare box; roofs now vary in surface and tone.
   Still open: the height distribution is bimodal and wrong for Boston (5,900 buildings
   under 20 m, then **479 between 140–160 m** — real Boston has ~40 buildings over 100 m),
   so the skyline is a wall of same-height towers. *Owner: buildings.*
6. **Vegetation reads as "broccoli"** — blobby canopies, insufficient silhouette variety.
   *Owner: vegetation.*
7. **Not yet built at all**: `Traffic.js`, `Pedestrians.js`, `Player.js`, `Missions.js`.
   The city has no traffic, no pedestrians and no player character. Empty streets are the
   #1 tell of a tech demo on the critic rubric.

## Debugging methodology — learned the hard way on issue #0
- **"The console is clean" is not the same as "the GL context is happy."** Driver-level
  `GL_INVALID_OPERATION` from `glDrawElements` arrives as a **`warn`**, not an `error`, so
  it never reaches `__boston.errors` and is easy to scroll past. Chrome then prints
  *"WebGL: too many errors, no more errors will be reported to the context"* and goes
  silent for the rest of the session. Always read console **warnings** when geometry that
  should be there isn't.
- A draw call that the driver rejects renders **nothing at all** — not black, not
  untextured. If geometry, transforms, bounds, attributes and material flags all check out
  and a plain material works, suspect the *program's* texture-unit state, not the mesh.
- **A `sampler` that three never uploads defaults to texture unit 0.** If any other sampler
  in the same program is a different type (`sampler2D` vs `sampler2DArray` vs `sampler3D`),
  WebGL kills the draw. Uniforms only reach a material through `onBeforeCompile`; if you
  shadow that property, you silently opt out of every prototype-level injector.
- **`material.needsUpdate = true` does NOT re-run `onBeforeCompile`.** Three caches the
  program per `(material, programCacheKey)`, so an unchanged key returns the old program
  without recompiling. Any bisect that swaps `onBeforeCompile` and sets `needsUpdate` is a
  **no-op** and proves nothing — this invalidated a whole earlier round of diagnosis. Vary
  `customProgramCacheKey` to force a real recompile.
- A `customProgramCacheKey` that returns a **constant** is not itself dangerous for program
  sharing (three appends it to a full parameter key), but it *does* freeze recompilation,
  and it makes two materials that differ only in chained-in GLSL share one program.

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
