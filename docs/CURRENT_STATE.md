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
| Console | `__boston.errors` is `[]` and `__boston.glFaults` is `[]`. The `glDrawArrays: Feedback loop formed between Framebuffer and active Texture` warning is **gone** — it was `LensPass`; see §Resolved. Stubbing every pass but one and reading `gl.getError()` now returns `NONE` for all ten. |
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
- **Props / vegetation**: **151,782 prop + decal instances (95 types), 55,392 plants (19
  types)**, spread evenly over all 76.5 km of street rather than piled up around Boston
  Common (see §Resolved, "every prop that would carry a street"). Includes **9,600 parked
  cars** — a static instanced shell, not a simulated vehicle. Measured within 80 m of a
  Financial District street camera: 28 parked cars, 14/14 decal families live, shop
  signage / fascias / fire escapes / A/C units / standpipes all non-zero, 88 ground
  plants. Every one of those was **0** before.
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
- **Traffic** (`src/ai/Traffic.js`, `Navigation.js`): ~120 kinematic AI cars on the real
  lane graph. IDM car-following, two-phase signals on **108** junctions, priority + a
  single-slot junction reservation everywhere else, don't-block-the-box, discretionary
  lane changes, indicators, brake lights, headlights on the world clock. The player's car
  is injected into the lane lists as an obstacle, so traffic queues behind him.
  `traffic.takeOver(car, ctx)` swaps a kinematic car for a real physics `Vehicle` so the
  player can drive anything on the road.
- **Pedestrians** (`src/ai/Pedestrians.js`): ~100–150 people on `city.sidewalks`. They
  cross only at crossing links and only when the signal governing that junction is red for
  the traffic being crossed — reading the **same** `Navigation` instance the cars obey, so
  a queue of people and a queue of cars never both think they have right of way. Keep
  right, steer around each other and the player, stop and stand about, flee at
  `wanted >= 3`. Density scales with the *pavement in range* and with the district (thick
  at the Common, Faneuil Hall, Newbury St; thin in the Seaport). **Two draw calls** for the
  whole crowd.
- **Characters** (`src/gameplay/Character.js`): one procedural 16-bone humanoid shared by
  the crowd and the player. Idle / walk / jog / run / sit / crouch clips are solved offline
  and baked into a 48×150 half-float **GPU animation texture**; the vertex shader looks up
  its own clip and phase, so a whole crowd animates for no CPU at all. Rigid one-bone
  skinning with overlapping joint spheres (no candy-wrapper pinch, half the texture fetches
  of weighted skinning). Per-instance height, build, gait, palette, sleeve length and
  baked-in AO.
- **Player** (`src/gameplay/Player.js`): Rapier `KinematicCharacterController` capsule —
  walk / jog / sprint / crouch / jump with 45 cm autostep, snap-to-ground and a 52° climb
  limit. `F` enters and exits vehicles and emits `player:enterVehicle` /
  `player:exitVehicle`.
- **Camera** (`src/gameplay/CameraRig.js`): GTA-style chase rig. Instant rotation with a
  spring-damped pivot, a five-ray collision sweep that pulls in instantly and eases back
  out, speed-dependent distance and field of view, distinct on-foot and in-vehicle
  behaviour, auto-recentre behind the car when the mouse is idle, `V` toggles free-fly.
  Honours `enabled` for the capture harness and re-derives its orbit angles from wherever
  the harness left the camera.
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
| Skyline is a wall of same-height slabs | `plot.maxHeight` is **one flat number per district** (every Financial District parcel carries 240 m) and `makeSpec` did `storeys = max(storeys, floor(fit * 0.62))`, giving every tower the same fraction of the same number: 479 buildings inside one 20 m band with a hard gap from 100–140 m. Height now comes from a power law under a per-district ceiling (`Facades.DISTRICT_HEIGHT`), gated on parcel area and distance to Boston's two real tower clusters (`TOWER_CORES`). Caps stay under the landmarks so 200 Clarendon (241 m) and the Prudential (229 m) stay outliers. Result is monotonic: 5900 / 513 / 136 / 125 / 149 / 63 / 34 / 19 / 3 by 20 m bucket. | `Facades.makeSpec`, commit `9ed0f06` (swept in) |
| Every tower ends in the same flat parapet line at distance | The rooftop antenna mast — a **silhouette** element — was emitted at `lod === 0` only, so it was dropped exactly when the top edge became the only readable thing about a tower. Now emits for `lod < 2` and is mirrored into `shellRoofKit` off the same keyed hash. | `Facades.roofClutter` / `shellRoofKit`, commit `35c42fe` |
| **Every hour of the day tone-maps identically — exposure is a fixed 2.424 at noon and at midnight** | `RenderPipeline.options.minEV` was `-0.6`, and `AutoExposurePass` converts EV100 to a log-luminance clamp as `log2(L) = EV100 - 3`. That put the metering **floor at log2 L = -3.6**, which is *brighter than most of the game*: measured metered log-luminance is -1.4 at overcast noon but -4.4 at a 09:30 street and -5.8 at 22:00. Everything from mid-afternoon downwards sat pinned on the floor, so the adaptation had a constant to integrate and the exposure never moved. Boston's scene-referred radiances are simply nowhere near photographic cd/m², so a photographic EV floor clamps real scenes. Floor is now `minEV: -8.5` (log2 L = -11.5), ~3 stops below the darkest shot. Verified: exposure now spans **0.54 (overcast noon) to 3.47 (rain street)** across the eight review shots and nothing sits on the clamp. | `RenderPipeline.options.minEV` |
| Night rendered as bright as noon *after* the clamp was fixed | A meter with unit gain maps every scene onto the same middle grey by construction — that is what a meter is for. Fixing the clamp therefore made 22:00 render at frame p50 100/255, identical to 09:30. It also silently cancelled the lighting stage: any change to `NIGHT_SKY` was undone by the exposure stage within a second, which is why that constant had been pushed to a non-physical 0.9 chasing a visible result. `AutoExposurePass.setResponse(pivot, gainDown)` now compresses the metered value toward a pivot on the **dark side only** (full gain upwards, so a bright sky still stops down and cannot clip). At `meterGainDown: 0.55` night_neon lands 1.9 stops below its fully-adapted exposure while the four daylight shots move under a quarter of a stop. | `AutoExposurePass.setResponse` + `RenderPipeline.options.meterPivot`/`meterGainDown` |
| `LensPass` draw rejected with `GL_INVALID_OPERATION` (framebuffer feedback loop) every frame — the whole progressive-tent bloom halo silently missing | The upsample bound `mips[i-1]` as a `supportBuffer` sampler **while rendering into `mips[i-1]`**. Reading and writing one texture in the same draw is a feedback loop; the driver dropped the draw and reported it as a `console.warn`, so it never reached `__boston.errors`. The frame still looked plausible because `mips[0]` kept its plain downsample. The upsample now emits `vec4(col * scatter, scatter)` and the *blender* combines it with the destination (`src + dst*(1-srcA)` = `mix(dst, col, scatter)`), so the finer level is never sampled. Also energy-preserving, unlike the old unbounded `support + col`. Verified: stubbing every pass but one and reading `gl.getError()` now returns `NONE` for all ten passes, and binding a target as its own sampler still faults on this driver, so the test has not gone blind. | `LensPass.upMat` / `UP_FRAG` |
| Shadow recovery believed unnecessary because "the HDR probe shows no detail below the clip point" | The probe *was* the frozen meter. With metering live, `probeLuminance()` on the dusk downtown framing reports scene p05 at **-7.36** against an adapted key of -3.11 — 4.2 stops of real rendered detail under a curve that clips at ~5.5. Toe re-enabled at `shadowContrast: 0.62`. Dusk pure-black pixels 7.45% → 1.9%, p05 0.4 → 4.9, with p50/p90/p99 moving under 1.5/255. Note `shadowToeStops` is a **width**: widening it to 9 lifts the deepest shadows *less* (night_neon black 5.4% at 7 stops, 8.9% at 9). Tune the contrast, not the width. | `RenderPipeline.options.shadowContrast` |
| The `atmosphere` pass reported **zero** cost in every GPU profile | `_passNames` was captured inside `_rebuild`, which runs at init — before the atmosphere stage inserts its pass. `GpuTimer` round-robins over that list and `_instrument` is what makes a pass timable at all, so a pass added later was not merely mis-timed, it was invisible. `_syncPassList()` now re-reads the composer whenever the pass count changes. | `RenderPipeline._syncPassList` |
| Lateral chromatic aberration much heavier at night than authored | `LensFinalEffect` scales CA by `1 + stopsUnder * 0.22` off the adapted luminance, uncapped. That was harmless only while the meter was frozen at -3.6 (a constant 1.87×); with metering live it reached 2.8× and put ~3 px of fringing in every corner of a night frame. Capped at `apertureMax` 1.9, which leaves the day look unchanged. | `LensFinalEffect` |
| **41–52 pure-white snow banks standing on a clear August street**, one with a handrail through it | Two independent bugs, both in props. (1) The weather gate worked, but `PropBatch.refresh()` ended with `m.visible = cnt > 0`, which overwrote `setVisible(false)` the next time the camera crossed a chunk boundary. `Props.update` only re-applied the gate `if (this._snow)` — i.e. never in the case that needed it. Suppression is now a durable `PropBatch.hidden` flag that `refresh()` honours. (2) They were authored at `halfRoad - 0.2`, i.e. **inside the carriageway**, which is why they sat mid-road and intersected pavement furniture; a plough throws snow onto the kerb, so they now sit at `halfRoad + 0.34`. Also re-coloured — ploughed city snow is grit-grey at the base, not `ffffff`. Same class of bug hid in `Decals.setWeather`, which showed road **salt** under `overcast`. | `PropBatch.hidden`, `Props._applySnow` |
| **Every prop that would carry a street placed zero instances city-wide**: `shopSignA/B`, `storeFasciaA/B`, `fireEscape`, `acUnit`, `flagUS/MA`, `satDish`, `standpipe`, all five `veg_*` and all fourteen decal families | Not missing — *piled up in one place*. Both placers drained a flat global counter (`take(k) => (quota[k] -= n) >= 0`) while walking segments and parcels that `finishLayout` sorts **by distance from Boston Common**, so the entire city-wide budget was spent within a few hundred metres of the origin and every `if (!take(k)) break;` then truncated the rest of the city. Measured from the live instance matrices: all wall props and wall decals inside a **340–413 m radius**; `decal_grimeWall` occupied **10 chunks of 436**; the whole `tarSeam` budget went on 29 of 488 segments. A second, compounding bug: `finishLayout` walked **all four** edges of each parcel polygon, so three quarters of the wall props that did exist were on the sides and back of the parcel, buried inside the block. Now a two-pass placer — pass 1 counts sites with the identical code path, pass 2 places with probability budget/sites — plus street-facing edges only, with the outward normal derived from the parcel's own depth vector rather than from polygon winding. Result: same families now reach a **3,300 m radius over 400–800 chunks**, and a Financial District street camera sees 14/14 decal families and non-zero signage where it previously saw none. | `Props.RATE`/`runPlacement`, `Decals.RATE`/`runDecals`, `finishLayout` |
| Props drew full-detail geometry hundreds of metres past their LOD range | `_registerTypes` used `def.far` as the cull distance for any type with no reduced level, silently ignoring the authored `def.near`. 984-triangle fire escapes drew to 215 m; 440-triangle tree grates, seen almost edge-on, drew to 130 m. Single-LOD types now cull at `min(far, near * 1.3)`, `fireEscape` gained a 78-triangle LOD1, and the two flat-on-the-ground props lost the 4×24 tori that were most of their triangle count. Measured at `night_neon` with instance counts held constant: props 514k → **277k** triangles, all four owned systems 736k → **498k**. | `Props._registerTypes`, `buildFireEscape`/`buildTreeGrate`/`buildManhole` |
| Buildings render as flat, pale, untextured white slabs beside properly-facaded neighbours ("floating with white outline boxes") | The slabs are the LOD 2 shell; the detailed LOD 0/1 chunks had not been built yet. `Buildings._pump` widened its per-frame build budget only while `ctx.time.frame < 200` and used 6 ms after that. A camera teleport invalidates every near chunk at once, a dense chunk is ~160 ms of emit on its own, and `capture()` warms up only ~24 frames — so 6 ms/frame could never converge. Whatever happened to be built already showed a full facade and everything else showed the shell, hence the mixture. `update` now detects a teleport (camera moved more than one CHUNK in a frame) and `_pump` spends 50 ms/frame for 45 frames. Normal driving moves ~0.5 m a frame and never trips it. Measured after a 2 km teleport and a single `capture()`: near chunks built 0/14 → **14/14**; frame changed by hiding the detailed meshes 1.5% → **66.1%** (noise 0.1%). | `Buildings._pump` / `update`, commit `a927ec9` |

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

   ~~Separately, one fullscreen pass forms a framebuffer feedback loop (`LensPass
   INVALID_OPERATION`).~~ **Fixed** — see §Resolved. Re-derived after the critic could not
   reproduce it: the bisect now returns `NONE` for all ten passes, *and* deliberately
   re-creating the old shape at runtime (binding a render target as its own sampler) still
   returns `INVALID_OPERATION` on this driver — so the clean result is a fix, not a blind
   test.
2. ~~**The exposure chain never adapts — a fixed 2.424 at every hour.**~~ **Fixed.** Three
   separate defects, all in §Resolved: the `minEV` clamp floor sat above most of the game,
   a unit-gain meter then cancelled the day/night cycle once the clamp was lifted, and the
   shadow toe had been switched off on evidence produced by the frozen meter. Measured
   after, `high`, verified camera positions, full-frame readback:

   | shot | exposure | frame p50 | % below lum 2 | % clipped |
   |---|---:|---:|---:|---:|
   | `overcast_wide` 13:00 | **0.54** | 103.8 | 0.0% | 0.0% |
   | `hero_skyline` 17:48 | 0.78 | 111.7 | 0.0% | 0.0% |
   | `bridge` 08:12 | 0.94 | 73.0 | 0.0% | 0.2% |
   | dusk downtown 19:24 | 1.52 | 88.7 | 1.9% | 0.0% |
   | `street_level` 09:30 | 2.11 | 70.0 | 0.1% | 2.5% |
   | `golden_hour` 06:36 | 2.52 | 70.3 | 0.0% | 0.0% |
   | `night_neon` 22:00 | **2.78** | **32.8** | 7.0% | 0.1% |
   | `rain_street` 15:12 | **3.47** | 64.4 | 0.0% | 0.0% |

   Exposure spans **2.7 stops** across the review set and nothing sits on the clamp. Night
   median is now **~30% of overcast noon** (was ~70% end-to-end when the critic measured
   it), and the worst clipping in the set is 2.5% on the one shot with the sun in frame
   (was 15–16%). **For the lighting stage:** `NIGHT_SKY` can and should come back down to a
   physical value now. At `meterGainDown: 0.55` a two-stop cut to the night ambient will
   darken the frame by roughly 0.9 stops instead of being silently cancelled — so make the
   change in small steps and re-read `probeLuminance()` rather than the frame alone.
3. **Night on a street now works; `night_neon` specifically is still dark.** A/B of the
   night ambient fix alone, same build, 1920×1080 `high`, full-frame pixel readback:

   | | mean | p50 | p90 | % below lum 2 | % below lum 8 |
   |---|---:|---:|---:|---:|---:|
   | Marlborough St 22:00, before | 26.2 | 10.0 | 89.1 | 33.1% | 46.1% |
   | Marlborough St 22:00, **after** | **39.4** | **20.9** | 106.2 | **19.4%** | **29.9%** |
   | `night_neon` 22:00, before | 5.8 | 1.7 | 16.4 | 50.9% | 68.0% |
   | `night_neon` 22:00, **after** | 7.3 | 2.1 | 17.4 | 48.9% | 65.3% |

   A night street reads as a night city — brick, stoops, cornices, warm sodium halos, pools
   on the pavement, lane markings. `night_neon` barely moves because that specific camera is
   parked in the middle of Boston Common with **no street lamp within 186 m** (checked
   against every registered source; geographically correct — the Common has no roads through
   it), so the frame is carried entirely by ambient, the night sky and a skyline 400 m away,
   and all three are sitting under the exposure clamp in issue 2. **Judge night from a
   street, or re-frame the shot** — e.g. `pos [-1453.4, 4.85, 401.4] look [-1200, 11, 470]`.
   *Owner: lighting (done what it can without 2) + render (2).*
4. **A hard horizontal seam across the whole frame, introduced by the `atmosphere` pass.**
   Distinct from the pure-black horizon gap the critic found (terrain ring ending before
   the sky dome starts) — this one is a *step in the aerial perspective*, and the two can
   appear in the same frame.

   Bisected by rendering every prefix of the live chain into a full-res RGBA8 target and
   reading it back (`prefixImage(k)`), on `capture({ pos:[1500,380,1900],
   look:[-200,60,-400], tod:18.2, fov:45 })` at 1280×720. Sampling one column straight
   down the frame:

   | frame row | after `RenderPass`/`N8AO` | after `atmosphere` |
   |---|---|---|
   | 295 – 302 | `107, 88, 68` | `117, 96, 74` — essentially unfogged |
   | **303** and below | `107, 88, 68` | **`228, 243, 255`** — full in-scatter |

   The scene buffer is smooth across that boundary; the atmosphere pass creates a ~117/255
   step at a single row, dead straight across all 1280 columns. Also reproduces at
   `street_level` (rows 358–363) and worst at `overcast_wide`, where 14 separate seam rows
   between 225 and 273 are introduced by that one pass.

   **Cause**, in `src/shaders/sky/atmospherePass.glsl.js` (~line 156): `if (d > 0.99999)`
   treats a pixel as sky and skips aerial perspective entirely. With the camera at
   `near 0.25 / far 12000`, `d = 0.99999` is reached at about **8.1 km** — so the outer
   third of the view distance is classified as sky and keeps its raw surface colour, while
   the pixel one row nearer gets the full in-scatter. The band is simply the strip of
   ground beyond 8 km. The sky is drawn with no depth write, so its depth is exactly
   `1.0`; testing `d >= 1.0` (or comparing a reconstructed linear distance against the far
   plane) separates sky from far geometry without an epsilon. Better still, make the two
   branches agree in the limit so any residual mismatch is invisible.
   *Owner: atmosphere. File: `src/shaders/sky/atmospherePass.glsl.js`.*
   *Confirmed not the render chain: identical result with `fog.enabled = false` and with
   `clouds.skip = true`, and absent from every prefix up to and including `N8AO`.*
5. **Water shader fails to compile** — `nonPerturbedNormal` undeclared / `geometryNormal`
   redefined; three r171 renamed this varying. Two programs fail `VALIDATE_STATUS`.
   *Owner: city/materials. File: `src/world/Water.js`.*
6. ~~**Crushed blacks in daylight**~~ — **verified fixed and holding.** The double
   sRGB→linear conversion is gone from `LightProbes` (the albedo colours are constructed
   once and not re-converted). Full-frame readback at `golden_hour`: **0.6%** of pixels
   below luminance 2, 1.6% below 8, nothing clipped at the top; `downtown_dusk` 2.3% below
   2. Shadowed regions carry real gradient. Note `street_level` still reads 27.7% black —
   that is issue 1 (the camera is under the road), not the grade.
7. **Buildings at mid/far LOD** — **done, keep an eye on it.** Verified by parking the
   camera so the chunks in frame report `lod` 1 and 2 explicitly. The LOD-2 shell carries
   baked `fac_*` facade strips (one vertical repeat = one storey), a plinth, a coping
   line, a roof kit and now rooftop masts; roofs vary in surface and tone at every tier.
   Nothing reads as a bare box and nothing pops across a LOD boundary.
   *Owner: buildings.*
8. **Vegetation reads as "broccoli"** — blobby canopies, insufficient silhouette variety.
   *Owner: vegetation.*
9. **Not yet built at all**: `Missions.js`. Traffic, pedestrians, the player character and
   the chase camera all landed — see §What exists and works.
10. **Nothing reacts to being hit.** `player.health` never changes, cars drive through
   pedestrians (peds avoid the *player*, not traffic), and `player:wanted` is only ever
   raised by hand. Peds do flee at wanted ≥ 3 and traffic reads the level, but nothing
   sets it. *Owner: gameplay/missions.*
11. **Ped and car spawning still pops** at the streaming radius when the camera moves
    quickly, because a spawn is placed on the nearest pavement/lane sample rather than
    tested for visibility. Fine at walking pace, visible from a fast car.
    *Owner: AI.*
12. **Pedestrians almost never reach a junction, so crossings are rarely seen.**
    `RoadNetwork.buildSidewalks` emits **one walk edge per road edge per side**, and a
    Boston road edge is a whole street — mean **177 m**, up to **1.2 km**, and 430 m on the
    strands round the Common. A crossing link only exists at a junction, so a pedestrian
    dropped mid-block walks for two to five minutes before he can even decide to cross.
    The crossing machinery itself is correct and verified: `WalkNav.nextEdge` returns a
    crossing on **23.7%** of junction decisions (5,701 of 24,048 sampled), and pedestrians
    forced to an edge end do enter `cross`, walk the crossing and continue. What is missing
    is *opportunity*. `Pedestrians` already mitigates it from its own side — spawns take
    the best of four draws by distance-to-corner and then head for the nearer corner, which
    brought the median distance-to-junction from ~215 m down to **86 m** — but the real fix
    is to subdivide long pavement strands at, say, 60 m so the graph has decision points.
    *Owner: city (`RoadNetwork.buildSidewalks`), with AI to follow.*

## Geometry really is free here — one more datum
Hiding the **entire** `buildings` root at `hero_skyline` (1920×1080 `high`) removed 1.55 M
triangles and made the frame **slower**, not faster: 7–8 fps with buildings, **3.5–5 fps
without**. Less occlusion means more sky and ground reaching the post chain, and the post
chain is the cost. This is `PERF_REPORT.md` §6 reproduced from the other direction — do not
attribute an fps change to building geometry without an A/B like this one.

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

## Corrections to docs/PERF_REPORT.md — believe these over the report
The report is broadly excellent but three of its specifics were later disproved by
direct measurement. Do not act on the originals.

| Report claim | Correction |
|---|---|
| §5: "~16.5 ms is `lightGlows`" at night | **Does not exist.** Derived by hiding the whole `lights` subtree, which also hides 15 pooled Point/SpotLights — `projectObject` returns early on `visible === false` *before* pushing a light, so the toggle silently changes the light count and recompiles every lit material (`renderer.info.programs` 61 → 81). Measured per-mesh instead: `lightGlows` **3.63 ms**, `lightPools` **2.75 ms**. |
| §4: cloud RT is 326x184 due to a stale canvas width | **Not a bug.** 326x184 is exactly `round(1920 x 0.17)`; `QUALITY.high.scale` is **0.17** (0.24 is `ultra`). The report assumed 0.25 from a class docstring. |
| §7 / issue #1: low cameras collapse to black = post-processing feedback loop | **Mostly the camera being underground.** `street_level` was parked 1.4 m below the road surface. Fixed in `9ed0f06`. A genuine `LensPass` GL fault does also exist, but it is a separate and smaller effect. |

**General lesson, now twice-proven:** never A/B a subsystem by toggling `visible` on a
group that also contains lights. It changes shader permutations, not just what is drawn.

## Performance methodology (read `PERF_REPORT.md` §0 in full before profiling)
**The headline: this is a fill-rate problem in post-processing, not a geometry problem.**
The entire scene render — every building, road, tree and prop — is ~4.8 ms of a ~48 ms
frame. Draws and triangles are inside budget at every shot and preset.
**Do not reduce building/road/prop/vegetation triangle counts. Do not rewrite the clouds.**

Trustworthy instruments: `__boston.measureFps()`, `Profiler.prefixCost()`.
Garbage instruments here: `engine.perf`/DevOverlay fps (CPU-only), disabling composer
passes (rewires ping-pong buffers), GPU-sync bracketing inside a pass (tile flush).

**The one geometry exception: `VehicleVisual` does not obey the "geometry is free" rule.**
An articulated car is ~19 separate meshes at LOD0, each with `frustumCulled = false`
(`VehicleModels` culls the parent `Group`, and **three does not frustum-cull Groups**), and
most of them cast into three shadow cascades. Sixteen of them measured **+600 draw calls
and +1.27M triangles** — more than the entire rest of the city, which was 335 draws and
2.2M triangles at the same moment. Anything that hands out `VehicleVisual`s in bulk must
cap them hard, deny them to cars behind the camera, and put everything else in an instanced
shell. `Traffic.js` now allows 3 at LOD0 / 10 total and cost drops to ~160 draws.

**Verifying anything while other agents are editing.** Vite full-reloads the page on every
save, which wipes `window.engine` mid-measurement and makes an `async` test script vanish.
`npx vite build && npx vite preview --port 5299 --outDir dist` gives a target that does not
move. Also: `measureFps()` correctly refuses when the tab is backgrounded, and a browser
tool call that is not a screenshot will not front it — re-front before every measurement or
you will collect a page of `hidden: true`.

## Next priorities (highest leverage first)
| # | Action | Est. gain | File |
|---|---|---|---|
| 1 | `PRESETS.high.pixelRatioCap` 1.5 → 1.25 or 1.0 — on a DPR-2 display `high` renders 2.26× the pixels the budget is written against | **18–36 ms** | `src/core/Settings.js` |
| 2 | Fix resize so `pixelRatioCap` actually applies: call `renderer.setSize(w,h,false)` after `setPixelRatio` (`EffectComposer.setSize` skips it when CSS size is unchanged) | unblocks #1 | `src/gfx/RenderPipeline.js` ~146 |
| 3 | ~~Let `glowMesh` frustum-cull; lower/clamp `uMinPx`~~ **Done, but the 10–16 ms was never there** — see the correction below the table. Measured cost of the additive proxies at `night_neon`/`high`/1080p: `lightGlows` **3.6 ms**, `lightPools` **2.7 ms** | ~1–2 ms | `src/gfx/LightManager.js` |
| 4 | ~~Fix the black atmosphere pass, then re-check its render-target sizing~~ **Done.** Clouds, aerial perspective and the night sky all render; the pass survives `render.validate()` (`ok: true`, frame mean 17.58 → 19.39 across it). **The 326×184 sizing was never a bug** — see the note below the table | — | `src/gfx/Clouds.js`, `Fog.js` |
| 5 | Merge the final two `EffectPass`es / drop sharpen taps when TAA is off | up to 25 ms, unproven | `RenderPipeline._rebuild` |
| 6 | ~~Build Traffic, Pedestrians, Player~~ **Done.** All four systems (`traffic`, `peds`, `player`, `cameraRig`) are live. A/B at 1080p/`high` on the verify server: **7.3 → 6.9 fps**, +281 draws, +1.03M tris for the whole AI layer. **Pedestrians are effectively free** (2 draws, 76k tris, ~0.6 ms CPU); ~95% of the cost is traffic. Traffic is the first thing to trim if the triangle budget gets tight — lower `MAX_DETAIL`/`SHELL_SHADOW_CAP` in `Traffic.js` | the "density & life" rubric axis | `src/ai/`, `src/gameplay/` |
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

**Resolution ladder — verified working, and the earlier "`getPixelRatio()` reads 1 at every
preset" was the preset table, not the pipeline.** `_applyResolution` derives the ratio from
`min(devicePixelRatio, settings.pixelRatioCap, sqrt(budgetPixels / cssPixels))` and then
calls `renderer.setSize(w, h, true)` explicitly, because `EffectComposer.setSize` skips
`renderer.setSize` when the CSS size is unchanged. Measured in a 1280×720 CSS window after
the preset ladder was corrected to 1.0 / 1.25 / 1.5 / 2.0:

| preset | cap | `getPixelRatio()` | drawing buffer | `composer.inputBuffer` | passes |
|---|---:|---:|---|---|---:|
| low | 1.0 | 1.00 | 1280×720 | 1280×720 | 8 |
| medium | 1.25 | 1.25 | 1600×900 | 1600×900 | 9 |
| high | 1.5 | 1.50 | **1920×1080** | 1920×1080 | 10 |
| ultra | 2.0 | 2.00 | 2560×1440 | 2560×1440 | 13 |

The ratio, the canvas and every composer buffer all track the cap. While `high` was
capped at 1.0 every preset produced ratio 1.0 by construction, which is what made it look
like the cap never reached the buffer.

**Per-pass timing is currently unobtainable, not merely noisy.** Three back-to-back
`prefixCost({frames:6, repeats:4})` runs on one frozen frame returned `fullChainMs`
34.5 / 43.8 / 52.2 and three *mutually contradictory* rankings — run 1 said `TAAPass`
40.6 ms and `N8AO` 1.7; run 3 said `N8AO` 21.1 and `TAAPass` 21.0 with `AutoExposurePass`
at 10.8 ms, which is impossible (it renders a 128² and a 1×1). `measureFps(2)` on the same
locked scene returned 15.8 / 5.4 / 3.5 fps. Real GPU timer queries *are* available here
(`EXT_disjoint_timer_query_webgl2`, `gpuTimer.available === true`) but every pass reported
a ~9 ms floor, i.e. the begin/end pair was catching queued work from other tabs. **Do not
publish a per-stage millisecond table taken while sibling agent tabs are rendering** —
wait for a quiet machine, and prefer `gpuProfile(true)` + `gpuTimings()` over `prefixCost`
now that the timer extension is present.

**Another instrument that lies here: fps measured while other agents are rendering.**
Several agents run their own full-resolution instances in sibling browser tabs. Five
back-to-back `measureFps(2)` calls on an unchanged scene returned 19.9 / 9.8 / 10.3 / 8.3 /
5.4, and prefix timing returned *negative* per-pass costs. Skipping the cloud march
entirely (`clouds.skip = true`) measured **slower** than running it. Do not quote an fps
number without first confirming no other Boston tab is live.
