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
| Real fps | **13 @ 1920×1080 `high`** (`measureFps(2)`, settled, static build, `hero_skyline`). Unchanged by the buildings fix — the whole city now rasterises for the same cost, which is what `PERF_REPORT.md` §6 predicts. **Not re-measurable while sibling agent tabs are rendering** — see the note under Next priorities. |
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
  Hemisphere colours are normalised to unit luminance so `skyIntensity` is a real
  irradiance at every hour (see §Resolved). Both additive proxy meshes carry real instance
  bounds and frustum-cull; the halo minimum size is derived from the live viewport, so it
  is a fixed 1.1 px at any resolution or FOV rather than a constant tuned for one canvas.
- **Atmosphere**: the `atmosphere` pass is on and stays on (`render.validate()` → `ok:
  true`). Raymarched volumetric clouds now render at every hour — ~33% sky cover at
  `clear`, radiance 0.12 pre-dawn / 4.5 at noon / 25.6 at golden hour / 0.035 at
  midnight, none of them zero. Aerial perspective mixes ~10% sky into geometry at 300 m
  and ~29% at 1 km. Night carries a city light-pollution glow instead of pure black.
  Six weather states with 20 s transitions, real precipitation instancing, wetness
  published to `ctx.assets.setWetness()`, and lightning driving a real `DirectionalLight`
  plus `bus.emit('thunder', {distance})` at the correct speed-of-sound delay.
- **Physics** (Rapier), **vehicles**, **audio**, **HUD/minimap/menu**, **profiler**.
- **Capture harness** (`window.__boston`): 8 named shots, deterministic stepping,
  `measureFps()` that refuses to lie about a backgrounded tab.

## Resolved root causes — do not re-debug these
| Symptom | Root cause | Fixed in |
|---|---|---|
| Whole frame renders black | `postprocessing`'s `SSAOEffect` reports full occlusion at city scale and `MULTIPLY`-blends the frame to nothing | Replaced with N8AO |
| Whole frame renders black (2nd time) | `CopyPass` ignores its `outputBuffer` argument and writes to its own target | RenderPipeline |
| `street_level` / `rain_street` mostly black -- long misread as a post-processing feedback loop | The shots were parked **underneath the road**. Authored as absolute heights before the city had elevation: `street_level` y=1.7 where ground is **3.10**, `rain_street` y=2.4 where ground is **7.99**. Shot heights are now resolved against `city.groundHeight()` and the aim point shifts with them. | this commit |
| Cloud buffer read `(0,0,0,1)` on all 60k texels, every hour, every weather | The raymarch **livelocked**: empty-space-skip rewound one coarse stride on first density hit without clearing the `miss` counter, so it oscillated between two samples until the step budget ran out. `densityFull()` was never once evaluated. | atmosphere agent |
| Clouds pure black at night | After sunset `sunCol` is 0 and sky ambient is 0, so the cloud deck had **no light source at all**. Added `uCityGlow`. | atmosphere agent |
| Capture harness shot the wrong place (camera not parked) | `setCamera` only stood down `cameraRig`; the newly-landed `player` system also drives the camera. Now hard-locks the transform inside `camera.updateMatrixWorld`, which runs immediately before rasterising, so it holds for **any** camera driver added later. | `6f7d861` |
| GL driver faults invisible to the critic | They arrive on `console.warn`, not `console.error`. The sampler-unit collision that hid the invisible city for a session was a warn. Now captured in `__boston.glFaults`. | `6f7d861` |
| Facade shader: ~500 duplicate `aTex`/`vLayer`/`vEmis`/`vWPosB` declarations | Mutual infinite recursion between two `onBeforeCompile` interceptors; the `RangeError` was swallowed by a bare `catch` | `BuildingKit.installPatch` + `Lighting.applyWindowLights`, commit `bafd01b` |
| Boot fails on a not-yet-written system | Vite statically resolves `import('./literal.js')` | `import.meta.glob` in `main.js` |
| "5 fps" / "83 fps" phantom numbers | Backgrounded-tab rAF throttling | `measureFps()` refuses when `document.hidden` |
| "Clouds cost 66 ms" | GPU-sync bracketing on a tile GPU forces a tile flush | Clouds actually cost ~3.6 ms; see `PERF_REPORT.md` §4 |
| **No clouds in any shot, at any hour or weather** — the cloud buffer read `(0,0,0,1)` on every texel | The empty-space-skipping march **livelocked**. On the first coarse-stride hit it rewound one stride and switched to the fine stride, but did not clear `miss`. The rewound sample is empty by construction, so the stale `miss` immediately tripped the back-to-coarse rule, the next coarse stride landed exactly back on the sample that triggered the rewind, and that rewound again. The march oscillated between two points until it burned all 28 steps. Confirmed by instrumenting the loop: every texel with density reported `iters = 28, hits = 0, maxDensityFull = 0` — `densityFull()` was **never once evaluated**, so `scat` stayed 0 and `T` stayed 1. Density itself was always fine (`maxLow` up to 0.71 over 38% of texels), which is why every check of the noise, the weather map, the shell intersection and the coverage calibration came back healthy. | `clouds.glsl.js`: clear `miss` on rewind, require 6 empty fine steps before reverting to coarse, and don't spend the step budget on a rewind |
| Night sky was a pure-black void with cloud-shaped holes in it | Past sunset `sunCol` is 0, the sky-view LUT ambient is 0 and the moon contributes ~1e-4, so the cloud march had **literally no light source** — measured cloud radiance was exactly `0.0000` at `tod 23`. Nothing was wrong with the march; there was simply no term for the city lighting its own cloud base. | `uCityGlow` in `Sky.js`, horizon-weighted in `skyDome.glsl.js` and base-weighted in `clouds.glsl.js` |
| **Night ambient arrived ~58× weaker than the number that authored it** | A `HemisphereLight`'s irradiance is `colour × intensity`. `SKY_NIGHT` (`#16233f`) has a linear luminance of **0.017**, so the authored night floor of `0.22` reached the shader as **0.0038**. Every night surface that was not directly lit was therefore two orders of magnitude too dark, and no amount of tuning the *intensity* could find it, because the intensity was never the problem. | `Lighting._update` now divides both hemisphere colours by the sky luminance (hue in the colour, level in the intensity) and folds that luminance back into the daylight term, so **daylight is unchanged** and only the night floor changes meaning. Probes get the same normalised colour. |
| Lit windows bloomed into one glowing slab per facade | `uWinBright` 4.2 sat two stops above the tone curve's shoulder at the pipeline's fixed exposure — measured 6.7% of a night street frame pinned at 255, mullions bloomed shut. | `WIN_BRIGHT = 1.5` in `Lighting.js`; clipping 6.7% → 0.1% |
| Cold boot 45 s | Per-pixel JS texture synthesis without `willReadFrequently`, redundant full-size octaves | materials 12,782→653 ms, props 12,672→600 ms |
| **Buildings do not rasterise — the whole city renders FLAT** | `BuildingKit.installPatch` defined `onBeforeCompile` as an **own accessor**, shadowing the `Material.prototype` accessor `CascadedShadows.installLightingShaders` installs. That prototype hook is the only thing injecting the shared `boston*` uniforms — one of which is `bostonProbeTex`, a **`sampler3D`** declared unconditionally by the patched `shadowmap_pars_fragment` chunk. Never receiving it, three never assigned it a texture unit, so it kept the default **unit 0** — the same unit the facade's `sampler2DArray` atlas lands on. The driver then rejected every building draw with `GL_INVALID_OPERATION: glDrawElements: Two textures of different types use the same sampler location`. Geometry, transforms, attributes, material flags and the compiled shader were all correct; the draw call simply never executed. Only buildings/landmarks were hit because every other system assigns `onBeforeCompile` normally and so goes through the prototype setter. | `BuildingKit.installPatch`, commit `d3de1e3` |
| Roofs read as bare pale planes from every elevated shot | The always-resident LOD-2 shell lidded its parapet (`cap` at `ty + parapet - 0.46`), putting that surface up to **0.9 m above** the LOD-0 roof deck. The shell is drawn even where a detailed chunk is loaded, so its lid covered every real roof in the city and hid all the roof furniture underneath. | `Facades.buildShell`, deck now caps at the shell drop plane with a proper inner parapet face |

## Unresolved issues (ranked)
1. **The two street-level shots are parked *underneath the road*. This is not a render
   bug.** `street_level` sits at `y = 1.7` where `city.groundHeight(40, 120)` is **3.10**,
   and `rain_street` sits at `y = 2.4` where the ground is **7.99** — so both review shots
   render the underside of the terrain over a black lower half, which is what the earlier
   "low cameras collapse to black" table was measuring. Swept at the same x/z and the same
   look direction, the transition lands exactly on the ground plane, not on any camera
   height a post-processing bug could care about:

   | cam Y | 1.7 | 2.6 | 3.4 | 4.8 |
   |---|---|---|---|---|
   | above ground by | −1.40 | −0.50 | **+0.30** | +1.70 |
   | black frac | 0.283 | 0.285 | **0.006** | 0.012 |
   | mean lum | 47.6 | 49.7 | 81.4 | 73.3 |

   Raising `street_level` to `y ≈ 4.8` renders the Common correctly, rain and all. **Fix
   the shot definitions against `city.groundHeight()` rather than hunting the frame.**
   *Owner: capture harness / city. File: `src/core/CaptureHarness.js` `this.shots`.*

   Separately and still real, but **not** the cause of the black street shots: one
   fullscreen pass does form a framebuffer feedback loop. Bisected by stubbing every
   pass's `render` except one and reading `gl.getError()` after `composer.render()` —
   exactly one throws:
   `FrameStatePass NONE · RenderPass NONE · N8AO NONE · atmosphere NONE · AutoExposure
   NONE · Velocity NONE · TAA NONE · `**`LensPass INVALID_OPERATION`**` · EffectPass NONE ·
   EffectPass NONE`. All four atmosphere draws (cloud march, volumetrics, composite, sky
   LUT) are GL-clean in the same test. LensPass's draw is being dropped every frame, so
   whatever it contributes is silently absent.
   *Owner: render pipeline. File: `src/gfx/RenderPipeline.js`, `src/gfx/effects/`.*
2. **The exposure chain never adapts — it is a fixed 2.424 at every hour.** This is now the
   single biggest thing holding night back, and it is *not* a lighting bug.
   `AutoExposurePass`'s metering clamp pins the adapted log-luminance at the bottom of its
   range at **both** noon and 22:00, measured with `probeLuminance()`:

   | shot | adapted log2 L | resulting exposure | true scene log2 L (p50) |
   |---|---:|---:|---:|
   | `street_level` 09:30 | −3.60 (clamped) | 2.424 | −6.54 |
   | `night_neon` 22:00 | −3.60 (clamped) | 2.424 | **−10.49** |

   Night is genuinely four stops darker and the meter is not allowed to see any of it.
   `minEV: -0.6` in `RenderPipeline`'s exposure options maps to a floor of
   `log2(0.125·2^−0.6) = −3.6`; something around **−6 to −8** would give night its stops
   back. Two consequences worth knowing before touching anything else: (a) raising scene
   light is currently the *only* way to make night brighter, which is why `NIGHT_SKY` in
   `Lighting.js` is authored far above a physical skyglow and is commented to come back
   down once this is fixed; (b) `toeParams` shadow recovery is switched off on the grounds
   that the HDR probe shows no detail below the clip point — it does, four stops of it.
   Verified from lighting's side by rendering an identical emissive quad at both hours:
   the same emitted radiance lands at the same output value, so nothing downstream of the
   scene is compensating. *Owner: render. File: `src/gfx/RenderPipeline.js` ~line 177,
   `src/gfx/effects/AutoExposurePass.js`.*
3. **`night_neon` is still dark, but no longer black** — and what is left is mostly issues
   1 and 2 plus the shot's own framing. Measured at 1920×1080 `high`, full-frame pixel
   readback: mean luminance **5.3 → 12.3**, p50 **1.6 → 7.7**, p99 **19.6 → 108**,
   fraction below luminance 2 **51.3% → 34.4%**. A representative *street* night shot
   (Marlborough St, Back Bay) now reads mean **46**, 14.4% below 2, 0.1% clipped, and
   looks like a night city. `night_neon`'s camera is parked in the middle of Boston Common
   with **no street lamp within 186 m** — geographically correct, but it means the shot is
   carried entirely by ambient, the night sky and the distant skyline. Worth re-framing the
   shot, or judging night from a street. *Owner: lighting (done what it can) + render (2).*
4. **Water shader fails to compile** — `nonPerturbedNormal` undeclared / `geometryNormal`
   redefined; three r171 renamed this varying. Two programs fail `VALIDATE_STATUS`.
   *Owner: city/materials. File: `src/world/Water.js`.*
5. ~~**Crushed blacks in daylight**~~ — **verified fixed and holding.** The double
   sRGB→linear conversion is gone from `LightProbes` (the albedo colours are constructed
   once and not re-converted). Full-frame readback at `golden_hour`: **0.6%** of pixels
   below luminance 2, 1.6% below 8, nothing clipped at the top; `downtown_dusk` 2.3% below
   2. Shadowed regions carry real gradient. Note `street_level` still reads 27.7% black —
   that is issue 1 (the camera is under the road), not the grade.
6. **Buildings at mid/far LOD** — partly done. The LOD-2 shell already carries baked
   `fac_*` facade strips (one vertical repeat = one storey), a plinth, a coping line and a
   roof kit, so it no longer reads as a bare box; roofs now vary in surface and tone.
   Still open: the height distribution is bimodal and wrong for Boston (5,900 buildings
   under 20 m, then **479 between 140–160 m** — real Boston has ~40 buildings over 100 m),
   so the skyline is a wall of same-height towers. *Owner: buildings.*
7. **Vegetation reads as "broccoli"** — blobby canopies, insufficient silhouette variety.
   *Owner: vegetation.*
8. **Not yet built at all**: `Player.js`, `Missions.js`.
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
| 3 | ~~Let `glowMesh` frustum-cull; lower/clamp `uMinPx`~~ **Done, but the 10–16 ms was never there** — see the correction below the table. Measured cost of the additive proxies at `night_neon`/`high`/1080p: `lightGlows` **3.6 ms**, `lightPools` **2.7 ms** | ~1–2 ms | `src/gfx/LightManager.js` |
| 4 | ~~Fix the black atmosphere pass, then re-check its render-target sizing~~ **Done.** Clouds, aerial perspective and the night sky all render; the pass survives `render.validate()` (`ok: true`, frame mean 17.58 → 19.39 across it). **The 326×184 sizing was never a bug** — see the note below the table | — | `src/gfx/Clouds.js`, `Fog.js` |
| 5 | Merge the final two `EffectPass`es / drop sharpen taps when TAA is off | up to 25 ms, unproven | `RenderPipeline._rebuild` |
| 6 | Build Traffic, Pedestrians, Player | the "density & life" rubric axis | `src/ai/`, `src/gameplay/` |
| 7 | Surface `measureFps` in the DevOverlay instead of `engine.perf` | stops future misdiagnosis | `src/ui/DevOverlay.js` |

**Correction to `PERF_REPORT.md` §5 — "~16.5 ms is `lightGlows`" is an artefact of the
toggle, not a measurement of overdraw.** §5 derives the figure by subtracting `lightPools`
(2.6 ms) from "hide the whole `lights` subtree" (19.1 ms). But `LightManager`'s `lights`
group also holds the **fixed pool of 10 `PointLight`s and 5 `SpotLight`s**, and
`WebGLRenderer.projectObject` returns early on `visible === false` *before* it pushes a
light — so hiding the group silently changes `NUM_POINT_LIGHTS`/`NUM_SPOT_LIGHTS` and
recompiles every lit material in the scene. Verified: `renderer.info.programs.length` goes
**61 → 81** on that single toggle. The subtraction is therefore comparing two different
shader worlds.

Toggling each proxy mesh on its own — which changes no light count and recompiles nothing —
against a 97.1 ms `night_neon` frame (alternating A/B, median of 6 × 3 s `measureFps`,
1920×1080 `high`): `lightGlows` **3.63 ms**, `lightPools` **2.75 ms**. Real, worth having,
but an order of magnitude short of the estimate. The per-fragment cost of the 15 pooled
lights is the more interesting number and is still unmeasured — every attempt landed in a
window where sibling agent tabs had the GPU at 2–4 fps.

**Correction to `PERF_REPORT.md` §4 — the atmosphere render targets are the right size.**
326×184 is exactly `round(1920 × 0.17)` × `round(1080 × 0.17)`. The report expected 480×270
because it assumed a 0.25 scale from the class docstring, but `QUALITY.high.scale` in
`Clouds.js` is **0.17**; `ultra` is the 0.24 tier. Verified live: drawing buffer 1920×1080
→ 326×184, and at a 1282×800 buffer the same targets come out 218×136, so `setSize` does
track the buffer. `applyQuality` now reads `renderer.getDrawingBufferSize()` instead of
`domElement.width` anyway, so it can no longer capture a stale canvas size at init.

**Another instrument that lies here: fps measured while other agents are rendering.**
Several agents run their own full-resolution instances in sibling browser tabs. Five
back-to-back `measureFps(2)` calls on an unchanged scene returned 19.9 / 9.8 / 10.3 / 8.3 /
5.4, and prefix timing returned *negative* per-pass costs. Skipping the cloud march
entirely (`clouds.skip = true`) measured **slower** than running it. Do not quote an fps
number without first confirming no other Boston tab is live.
