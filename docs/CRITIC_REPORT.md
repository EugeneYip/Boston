# Visual critic report — BOSTON

| | |
|---|---|
| **Commit measured** | `4311bd1` — working tree clean, local == origin/main, **one build throughout** |
| **Resolution / preset** | 1920×1080 drawing buffer, preset `high`, `pixelRatio` 1.5 on a 1280×720 canvas |
| **Captures** | ~60 deterministic `capture()` calls — 13 named shots, 2 custom aerials, 5 time-of-day variants, 4 weather variants, 3 shader-ablation states |
| **Boot** | `bootReport.failed` `[]`, `errors` `[]`, `glFaults` `[]` at the end of the session |
| **Verdict** | **OVERALL: 4/10 — KEEP WORKING** (was 3/10) |

Everything below is either **measured** (a number I produced this session, with the
method stated) or **judgement** (my eye on a frame). Each finding says which.

---

## 0. Methodology — read this before trusting or repeating any number

Four traps bit me this session. Three of them would have put false findings in this
report if I had not tested them.

1. **A `grab()` that is not immediately preceded by a `step()` reads solid black.**
   The drawing buffer is cleared after compositing. Every readback must be
   `b.step(1); gl.readPixels(...)` in **one synchronous block**. My first grab read
   0% non-zero; the same grab after a `step(1)` read 100%. This is *not* the
   "hidden pane" failure described in `CURRENT_STATE.md` — the GPU is producing
   pixels normally.

2. **Screenshots of the Browser pane are lossy.** At 1:1 zoom the brick facades
   showed dense magenta/cyan speckle and I nearly filed "per-pixel chroma noise /
   broken texture filtering" as an automatic fail. Measured from the readback
   instead: the brick patch's mean absolute difference rises monotonically with
   sample spacing (lag 1 → 4.61, lag 2 → 7.43, lag 4 → 12.2, lag 8 → 21.2). Real
   per-pixel aliasing would be flat across lags. All 28 textured materials use
   `LinearMipmapLinearFilter` at anisotropy 8 or 16. **The speckle was JPEG
   compression in the screenshot channel.** Judge anything at pixel frequency from
   `readPixels`, never from a screenshot.

3. **`capture()` does not settle the scene.** `Buildings._pump` spends **50 ms/frame
   for 45 frames** after a camera teleport (`CATCHUP_FRAMES = 45`, `Buildings.js:24`
   and `:1076`), and `capture()` only runs 24 + 6 = **30** frames. Every benchmark
   taken straight after `capture()` — including the coordinator's spot figures and
   my own first pass — lands *inside* the catch-up window, and the streamed
   building set is still growing. The same camera reported 2.12M → 2.75M → 3.55M
   triangles on three successive captures. **Step at least 60 further frames before
   benchmarking or counting geometry.**

4. **`step(1/60)` is accidentally correct, but not for the reason it looks.**
   `step: (n = 1, dt = 1/60)` takes a frame **count** first. `for (let i = 0; i < n; i++)`
   with `n = 0.0167` runs exactly **once**, because `0 < 0.0167`. I verified the frame
   counter advances by 1, and `bench` via `step(1/60)` and via `step(1)` agree
   (5.8 vs 6.1 ms). The snippet in `AGENTS.md` is safe. It is also one edit away
   from silently measuring nothing, and it reads as if it passes a delta-time.
   **Suggest changing it to `step(1)` in the docs.**

One more caveat I could not eliminate: this machine is under memory pressure, and
repeat measurements of the same settled shot varied by up to 2× (st_beaconhill
median 5.8 ms and 11.8 ms in two runs minutes apart). I report the **worst** settled
median observed and flag the spread.

---

## 1. Performance — the "8 fps" headline does not survive

`docs/CURRENT_STATE.md` and `PROGRESS.md` still say *"8 fps at 1080p high is the
headline problem."* **That is false and should be struck.**

Measured: 1920×1080, preset `high`, camera parked, **90 frames of settling** past the
catch-up window, then the median of 24 synchronous frames each forced to GPU
completion with `gl.finish()`. 24 frames covers four full cycles of the 6-frame
shadow-cascade stagger.

| shot | median ms | p90 ms | peak draws | peak tris (all passes) |
|---|---:|---:|---:|---:|
| `st_backbay` | **4.7** | 5.6 | 1054 | 3.72M |
| `st_northend` | **6.7** | 7.5 | 730 | 3.42M |
| `st_southend` | **6.9** | 10.4 | 708 | 3.50M |
| `night_neon` | **6.6** | 7.9 | 735 | 5.95M |
| `st_beaconhill` | **11.8** (5.8 in a second run) | 13.4 | 948 | 4.66M |

Every street camera is **inside the 16.7 ms 60 fps budget**, the worst by a factor of
1.4. Draw calls peak at 1054 against the 1200 budget. `hero_skyline`, `downtown_dusk`,
`bridge`, `rain_street` and `overcast_wide` all sit at 2.0–2.8 ms.

**Perf is not this project's problem any more. Stop optimising and spend the budget
on pixels.** The one number still out of contract is the shadow load. Splitting
camera from shadow by freezing `shadowMap.autoUpdate` and re-counting:

| shot | camera tris / draws | shadow tris / draws | ms with shadow update | ms frozen |
|---|---:|---:|---:|---:|
| `night_neon` | 2.53M / 380 ✅ | **3.47M** / 436 ❌ | 6.9 | 4.9 |
| `st_beaconhill` | 1.81M / 327 ✅ | **2.73M** / 419 ❌ | 5.8 | 4.3 |

Camera triangles are comfortably inside the 3.5M budget. **Shadow triangles exceed
the 2.5M budget by 9–39%**, and shadow rendering is ~30% of frame cost (1.5–2.0 ms).
That is the only budget breach, and it is cheap headroom if anyone wants it.

*Caveat (judgement):* these are synchronous `step()` frames with `gl.finish()`, not a
live rAF loop — `measureFps()` still refuses because `document.hidden` is `true` for
this pane. A forced-completion synchronous frame is if anything *pessimistic* about a
real loop, so I am confident the direction is right, but nobody has yet seen this
build run at its natural cadence.

---

## 2. Automatic fails

Called out per the rubric, no matter the scores.

**AF-1 — The road is an untextured plane, and it is the largest surface in the game.**
*Measured.* Horizontal mean-absolute-difference of the near carriageway at
`st_southend`: **1.71 at 1 px spacing, rising only to 3.55 at 89 px**. The brick
facade in the same frame measures 6.29 → **48.25** over the same lags. The road is
~14× flatter than the wall behind it, at every spatial scale. There is no wheel-track
polish, no gutter grime, no camber shading, no oil, no patch joints, no drains. It
occupies roughly 35–45% of every street frame.

**AF-2 — Parked cars clip to pure white and have no detail.**
*Measured.* At `night_neon` 22:00: car body mean **133.2 and 166.5** (max 255) against
near road **19.1** — a ratio of **7.0×**, and brighter than the sky patch (42.5). They
are the brightest objects in a night frame. In daylight (`st_southend`, `st_backbay`)
the pale variants read 250–255 across whole panels with zero shading. *Judgement:* the
body surface is a soft quilted loft that reads as inflatable; there are no plates,
mirrors, handles, wipers or badges.

**AF-3 — Wheels are open tori with a black void where the rim should be.**
*Judgement, at 7× zoom on the readback.* The tyre is a torus; the hub is simply
absent — no rim, no spokes, no brake face, no cap. At street level this is the closest
object to the camera in every framing.

**AF-4 — Facade sill/lintel bands project past the building into open sky.**
*Judgement, confirmed in three independent framings* (`st_southend`, `golden_hour`,
`st_backbay` dusk). Grey horizontal bands extend beyond the facade plane and hang
unattached against the sky, in cascades on curved frontages. This is the single most
obviously *broken* thing in the build — it reads as unfinished geometry, not as a
stylistic choice. Likely the string course / sill run is emitted at parcel width
rather than clipped to the (now corridor-clipped) footprint.

**AF-5 — Rain produces no wet-surface response at all.**
*Judgement + measured.* `st_southend` at `weather: 'rain'` renders the carriageway
visually identical to the same shot at `clear`; the frame gains only overlaid streaks.
No reflections, no puddle specular, no sheen, no spray, no drips, no splash rings. The
rain streaks themselves are uniform white lines of identical length, angle and opacity
drawn over the whole frame including the sky — they read as scratches on the lens.
`CURRENT_STATE.md` already routes "wet asphalt renders white" to roads/materials; the
current state is the opposite failure, and it is worse, because rain is free contrast.

**AF-6 — `overcast_wide` is a flat milky wash with no black and no white.**
*Measured.* p05 **74**, p50 117, p90 **163**, 0.00% clipped, 0.00% below luminance 2.
The entire 1920×1080 frame lives inside a 90-value band. The city, the river and the
sky resolve to one grey. The rubric's "no flat ambient wash" is failed outright.

**AF-7 — Shadow-cascade triangles are over budget.** 2.73M–3.47M against 2.5M. See §1.

**Explicitly checked and NOT failing** — I want these off the worry list:
- **No z-fighting found** anywhere, in any shot, at any zoom.
- **No visible texture tiling.** *Measured* by autocorrelation: the brick facade shows
  no periodic trough before lag 79; grass plateaus with only shallow minima at lags
  6/21/33. My initial visual impression of "repeating brick" was the regular window
  grid — architecture, not a texture repeat. Do not chase this.
- **Zero console errors and zero GL faults** across the whole session.
- **No pure-black clipped regions** beyond legitimate deep night shadow (worst 6.99%
  at `night_neon`).
- **No objects floating or sunk**, and **no buildings in the carriageway** (see §3.2).
- **Draw calls and camera triangles are inside budget.**

---

## 3. Verification of the five unconfirmed repair waves

None of these had been seen by anyone. All five did what they claimed. Two
over-corrected, and one is masking a different problem.

### 3.1 `ccc2a50` — airlight ramp — **VERIFIED, with a caveat**

*Method:* ablation. `uInscatFloor`/`uInscatTau` in `src/gfx/Fog.js` drive
`open = mix(uInscatFloor, 1.0, 1 - exp(-tau/uInscatTau))` in
`atmospherePass.glsl.js:254`. Three states rendered on one frozen frame at
`st_northend` 12:00 with the exposure meter pinned (`speedUp = speedDown = 0`):
**C** = in-scatter ablated (`floor 0, tau 1e9`), **B** = shipped (`0.05 / 0.30`),
**A** = pre-fix (`floor 1.0`). Distance comes from the road plane analytically,
`d = h / −ray.y`, camera 1.65 m above the carriageway.

| distance | ablated | shipped | pre-fix | **dL shipped** | dL pre-fix |
|---:|---:|---:|---:|---:|---:|
| 10 m | 122.5 | 122.8 | 126.3 | **+0.2** | +3.8 |
| 18 m | 120.9 | 121.3 | 128.1 | **+0.4** | +7.2 |
| 45 m | 125.7 | 128.3 | 145.8 | **+2.6** | +20.1 |
| 103 m | 124.0 | 128.8 | 153.8 | **+4.8** | +29.9 |
| 242 m | 148.6 | 157.5 | 179.6 | **+8.9** | +31.0 |
| 442 m | 170.1 | 179.5 | 197.4 | **+9.3** | +27.3 |

**Is the near field still washed out? No.** In-scatter now contributes +0.2/255 at
10 m against +3.8 before. The near field is clean.

**Is there a real depth cue at 400 m? Yes, but a modest one** — +9.3/255, monotonic
from 45 m. Judgement: that is a *thin* cue. The commit's claim of "1.5 km at 93% of
the un-ramped value" is a **linear-radiance** ratio; in display space after the tone
curve I measure the shipped in-scatter at roughly 30% of the pre-fix value in the far
field. Both can be true — the tone curve compresses the highlight — but anyone reading
that 93% as "the far field is unchanged to the eye" is reading it wrong.

*Caveat on my own numbers:* below screen row ~550 the band is genuine road; above it
the street's vanishing point and distant geometry dominate, so the 442 m row is
indicative rather than a clean road sample.

**Is the horizon step gone? Yes — cleanly.** *Measured* with the project's own
method (median luminance step per row across 480 columns, plus sign coherence),
±14 rows around the analytically-computed horizon:

| shot | horizon row | worst median step | coherence | seam rows |
|---|---:|---:|---:|---:|
| `st_backbay` | 543 | −1.00 | 0.25 | **0** |
| `st_beaconhill` | 546 | +2.72 | 0.30 | **0** |
| `st_northend` | 536 | −1.36 | 0.18 | **0** |
| `st_southend` | 541 | −2.07 | 0.31 | **0** |
| `street_level` | 540 | −1.28 | 0.17 | **0** |

For scale, the defect this replaced measured +12.9 to +40.1 at coherence 0.61–0.91.
Every residual here is incoherent, i.e. content. **Closed.**

### 3.2 `754747a` — buildings face the street — **VERIFIED, and it over-corrected**

*Method:* CPU-side over all **10,191** building specs. Road centrelines sampled from
`edge.pts` (never node-to-node chords) every 4–6 m into a spatial hash — 20,032
samples. For each building I take the outward normal of each edge in `spec.front`
(a `Set` of polygon edge indices) and compare it with the direction to the nearest
centreline. The old "longest edge is the facade" rule is computed alongside as a
control.

| | result |
|---|---|
| Buildings whose front edge faces the street (<45°) | **86.6%** |
| Median angle, front edge → street | **3.3°** |
| Same test on the old longest-edge rule | **7.3%**, median **90.0°** |
| Buildings with no `front` set | **0** |

The control reproduces the commit's headline independently: the longest edge is at a
dead 90° to the street — it is the party wall — so **92.7% would face the wrong way**
under the old rule, against the commit's claimed 96.3%. **Buildings now address the
street.**

*Streetwall*, measured from the front-edge midpoint to the nearest centreline, minus
(`halfRoad` + `walk`), over 10,200 facades:

| | value |
|---|---|
| Facade setback from the back of the pavement — p10 / median / p90 | **0.2 / 0.2 / 0.3 m** |
| Facades intruding into carriageway or footway | **2 of 10,200** |
| Per-street standard deviation of setback (212 streets, ≥12 facades) | median **0.1 m**, p90 0.3 m |
| Streetwall continuity (centreline steps with a facade within 20 m) | **77.5%** of 20,193 |

**Not ragged, and not set back.** The streetwall is continuous and flush.

**But it is now flush to 0.1 m, which is more regular than any real street.** No real
Boston block has a 10 cm building line. Bays project, stoops project, areaways set
back, corner buildings step. *This is a large part of why the streets read as extruded
corridors rather than architecture*, and it is a cheap fix: 0.3–1.5 m of per-building
setback jitter plus projecting bays. **Owner: buildings.** Do not undo the fix —
add variance on top of it.

Related: storey heights are sound — median **3.33 m**, p10 3.08, p90 3.59.

### 3.3 `7d3a7ac` — terrain LOD ring seams — **VERIFIED**

*Method:* independent of the commit's own geometry test. Top-down cameras at 2200 m
and 5200 m so that world radius maps monotonically to screen radius; every pixel's
ground radius computed by intersecting the view ray with the ground plane; luminance
binned per 1 m of radius; then the largest single-bin step within ±3 m of the ring
compared against the typical step 5–12 m away.

| ring | camera | max step at ring | background step | samples/bin |
|---|---|---:|---:|---:|
| r = 1440 | 2200 m | **1.95** | 0.51 | 402 |
| r = 1440 | 5200 m | **2.05** | 1.77 | 108 |
| r = 3240 | 5200 m | **2.06** | 1.14 | 176 |

The radial profile across r = 1440 reads 115.9, 116.1, 115.2, 115.9, 115.9, 115.9 …
— flat within 2/255 over 25 bins. **No visible line, no shading hairline, no
z-fighting at either radius.** Closed.

### 3.4 `55ab64b` — districts — **VERIFIED for the bug; the skyline is still wrong**

*Method:* `city.districtAt` sampled on a 60 m grid over `city.bounds`; height
distribution over all 10,191 specs; tall buildings located against `geo()` of the real
Financial District (42.3560, −71.0550) and Back Bay (42.3480, −71.0810).

**The bug is fixed.** `financial` now covers **3.3%** of the sampled map, not 41%.
(`none` 35.5%, `water` 19.1%, `cambridge` 14.8%, `southEnd` 5.5%, `seaport` 5.3%,
`fenway` 5.0%, `charlestown` 4.4%, `backBay` 3.1%, `park` 1.8%, `northEnd` 1.3%,
`beaconHill` 1.0%.)

**Downtown did not lose its towers.** Of 72 buildings ≥100 m, **67 are in the
financial district**, 44 within 600 m of the real Financial District centre, and only
3 outside both real clusters. The zoning is now correctly concentrated.

**But the skyline is still not Boston's**, and two new problems are now visible:

| height band | count |
|---|---:|
| 0–20 m | **8,384** (82%) |
| 20–40 m | 1,424 |
| 40–60 m | **128** |
| 60–100 m | 183 |
| 100–150 m | 66 |
| 150–180 m | 6 |
| **180 m+** | **0** |

- **Back Bay has zero buildings over 100 m** — and Back Bay is where Boston's two
  tallest actually stand. 200 Clarendon (241 m) and the Prudential (229 m) exist as
  landmarks, so they will stand entirely alone on a flat low-rise plain, with none of
  the real 111 Huntington / One Dalton / Westin cluster around them.
- **Nothing procedural exceeds 162 m**, so the 165–225 m register is empty. Real
  Boston has roughly eight buildings in it. The landmarks will read as two spikes
  stuck into a mesa rather than as the peaks of a massing.
- There is a cliff from 1,424 buildings at 20–40 m to **128** at 40–60 m. Downtown
  Boston is full of 40–80 m mid-rise; here that band barely exists.

*Judgement, from `hero_skyline` and `downtown_dusk`:* the skyline reads as a field of
similar boxes with no dominant peak and no crowns — every tower ends in a flat
parapet, and the distant ones dissolve into featureless white slabs (see §4).
**Owner: buildings / city.**

### 3.5 `2cc85c5` — point/spot BRDF guard — **VERIFIED, no regression**

*Method:* ablation at `st_seaport` 20:00 with the exposure meter pinned. Enumerate
every live `PointLight`/`SpotLight`, render, zero all intensities, render, diff.

| | |
|---|---|
| Live pooled lights | **15** (10 point + 5 spot) — the full fixed pool |
| Intensities | 13 × 130, 2 × 42 |
| Frame area lifted by >4/255 when they are on | **28.96%** |
| Max lift | **153/255** |
| Mean lift over the frame | 0.69/255 |

**Nothing is missing.** The lights contribute, the guard has not silently killed
anything, there is no banding, and no light that should be lit is dark. The
day/night gating in `_applyPools` also still holds. **No regression from the guard.**

**However, the ablation exposes a much larger problem the guard did not cause.**
Amplifying the on/off difference 3× and looking at it: the contribution is a handful
of small bright spots and **nothing at all on the near road**. There are 15 real
dynamic lights for the entire city against "~2,300 street lamps" — the rest are
additive glow proxies that light nothing. Measured along the `night_neon` carriageway,
the road luminance profile is a smooth ramp (26.7 at 8 m → 132.2 at 39 m → 106.2 at
220 m) with **no periodic pool structure whatsoever**. A night street in GTA V is
defined by the chain of lamp ellipses on the asphalt. Here the lamps glow in the air
and the road under them is unlit. **Owner: lighting + render.** See fix #6.

---

## 4. Shot-by-shot

Format per the rubric. Scores are out of 10; below 8 is a fail.

```
SHOT: st_backbay        VERDICT: FAIL   (09:36 clear, 4.7 ms, 1054 draws, 3.72M tris)
Scores: silhouette 4, material 2, lighting 5, atmosphere 6, grade 5, density 6,
        geometry 4, boston 5   → 4/10
Gives it away: (1) the carriageway is a flat plane, MAD 1.7→3.6; (2) the parked row
is clipped white with black-void wheels; (3) tree canopies show hard card edges.
Blind test: YES, instantly — on the road and the cars.

SHOT: st_beaconhill     VERDICT: FAIL   (16:00 clear, 11.8 ms, 948 draws)
The most nearly-credible daylight street. Brick rows, fire escapes, awnings, real
pedestrians, a street sign. Let down by flat matte facades, a black blob of a manhole
decal mid-carriageway, and mannequin pedestrians. → 5/10

SHOT: st_northend       VERDICT: FAIL   (18:24, 6.7 ms, 9.16% clipped)
The sunset down the street is an undifferentiated white blob with no disc, no streak
and no shape. Double-yellow centreline is a nice touch. → 4/10

SHOT: st_southend       VERDICT: FAIL   (11:12, 6.9 ms)
Where the projecting lintel bands are clearest — grey planks hanging in the sky off
the building edges. Brownstone rows have no bays or oriels. → 3/10

SHOT: st_seaport        VERDICT: FAIL   (20:00 night, 6.6 ms)
Best night frame. Neon, crosswalk, traffic signal glow, lit windows, sky glow. Road
is unlit between lamps and dead flat. → 5/10

SHOT: hero_skyline      VERDICT: FAIL   (17:48, 2.6 ms, 229 draws)
Clouds are genuinely good — the best single element in the build. But the far towers
resolve to plain white featureless boxes, and the harbour is a flat mottled sheet
with no waves and no reflection. → 4/10

SHOT: downtown_dusk     VERDICT: FAIL   (19:24, 2.8 ms)
Handsome pink cumulus and a sun-glitter path. Underneath it, a uniform field of dark
boxes with a perfectly regular checkerboard of identical lit windows. → 4/10

SHOT: night_neon        VERDICT: FAIL   (22:00, 6.6 ms, 5.95M tris)
Parked cars glow at 7× the road. Tree cards show rectangular edges. No lamp pools.
→ 3/10

SHOT: overcast_wide     VERDICT: FAIL   (13:00 overcast, 2.7 ms)
The milky wash. p05 74 / p90 163, nothing clipped, nothing black. → 2/10

SHOT: rain_street       VERDICT: FAIL   (15:12 rain)
Not a street — it is the Common. Rain streaks are identical parallel white lines.
White ripple rings render on grass. Nothing is wet. → 2/10

SHOT: golden_hour       VERDICT: FAIL   (06:36, 10.2% clipped)
The camera is jammed against a brick wall — `unstick` produced a useless framing.
Usefully, it shows the brick at close range: courses read ~4–6× life size. → 3/10

SHOT: bridge            VERDICT: FAIL   (08:12, 2.0 ms, 93 draws)
Water is a flat dark plane over ~55% of frame — no waves, no normal, no reflection,
no sun glitter. Zakim cables alias into rainbow fringing. → 3/10

SHOT: street_level      VERDICT: FAIL   (09:30)
Also the Common. Textbook "broccoli" trees; grass is a uniform noise sheet
(autocorrelation plateaus at 16.5 with no macro variation). → 3/10

SHOT: st_beaconhill @ fog 08:00   VERDICT: FAIL — but closest to passing
Fog reads believably, depth is legible, pedestrians silhouette well. The one framing
where a stranger might hesitate. → 6/10
```

### Rubric scores, whole build

| # | Axis | Score | One-line basis |
|---|---|---:|---|
| 1 | Silhouette & massing | **4** | Storey heights and streetwall correct; 82% under 20 m, nothing over 162 m, flat roofs, 0.1 m setback SD |
| 2 | Material truth | **2** | Road MAD 1.7→3.6 vs brick 48; cars clip; grass uniform; no wet response |
| 3 | Lighting | **5** | Key light at every hour and real cascades, but 15 dynamic lights city-wide and no lamp pools |
| 4 | Atmosphere & depth | **6** | Best axis — clouds strong, horizon step gone, airlight ramp working; far field over-erased |
| 5 | Composition & grade | **5** | Exposure adapts 2.7 stops; 5–10% clipping in sun-facing shots; sun has no shape |
| 6 | Density & life | **5** | Real props, cars, peds, signage everywhere; peds are mannequins, no wires/litter/displays |
| 7 | Geometric fidelity | **4** | No z-fighting, seams welded, nothing in the road — but bands float in the sky and wheels are hollow |
| 8 | Boston authenticity | **5** | Geography, districts and street pattern genuinely real; no bays/oriels, Back Bay flat |

**Direction of travel: up, and the systems work is real.** Every one of the five
commits did what it said. What has not happened is that any of it has turned into
*surface quality*. The build has a correct city and a placeholder skin.

---

## 5. Ranked fixes — highest visual impact per unit of work

Ranked by (fraction of pixels affected) × (severity of the tell) ÷ (work).

**1. Road and pavement surface material.** *Owner: materials + roads.*
The carriageway is 35–45% of every street frame and measures 14× flatter than the wall
behind it (MAD 3.55 vs 48.25 at 89 px). It needs albedo variation, darker polished
wheel tracks, gutter grime, patch joints, cracks, drains and oil staining — plus the
kerb face, which `CURRENT_STATE.md` already records as being textured with `T_ASPHALT`
rather than granite and still is. **Ranked first because it is the largest, flattest,
most-visible surface in the game and nothing about fixing it is architecturally
risky.**

**2. Parked-car material response.** *Owner: props / materials, with vehicles.*
They are the closest object to camera in every street framing, they clip to 255 in
daylight and sit at 7.0× the road at night. Needs: correct albedo/energy so pale
paints stop blowing out, a clearcoat + environment specular so the body reads as
painted metal, a **wheel face** (currently a black void inside a torus), and plates /
mirrors / handles. The palette is already varied in `buildParkedCars` — the problem is
response, not colour choice. **Ranked second: small, bounded, self-contained work on
the most conspicuous foreground object.**

**3. Wet-weather surface response.** *Owner: materials + roads + render.*
Rain currently adds streaks and changes nothing else. A reflective wet road is the
single strongest "AAA" signal available, it reuses lighting that already exists, and
it turns the two weakest shots (`rain_street`, `night_neon`) into the two strongest.
Note the trap already documented: `wetnessRough = 0.92` driving roughness to 0.06
makes the road a near-mirror that blows out under a bright sky — target ~0.25–0.35 with
puddle masks rather than a global roughness collapse. **Ranked third: highest
look-per-hour, but it needs care to avoid the known white-road failure.**

**4. Clip facade ornament to the building footprint.** *Owner: buildings.*
Sill and lintel bands project past the facade and hang unattached in the sky, worst on
curved frontages. It is a bug, not a quality gap, so it is bounded work — and it is the
detail that most says "unfinished" to a stranger. **Ranked fourth because it is cheap
and it removes an outright broken read.**

**5. Far-field aerial perspective and distant building detail.**
*Owner: atmosphere + buildings, together.*
`overcast_wide` compresses the whole city into a 90-value band; `hero_skyline` resolves
distant towers to plain white boxes. Two causes: extinction is too aggressive at
kilometre scale, and the LOD-2 shell loses its facade signal once it desaturates.
Reduce far-field extinction under `overcast`, and keep a low-frequency window/tone
pattern alive on the shell. **Ranked fifth: it fixes both wide shots at once, but it
needs the two owners to agree a target rather than each tuning their own end.**

**6. Real light pools on the night street.** *Owner: lighting + render.*
15 dynamic lights for ~2,300 lamps; the road under a lamp is unlit and the profile
shows no periodic structure. A baked/projected pool decal per lamp, or a clustered
forward path, would transform every night frame. **Sixth: high impact, but the most
architectural work on this list.**

**7. Setback jitter and projecting bays.** *Owner: buildings.*
The streetwall is flush to a 0.1 m standard deviation. Add 0.3–1.5 m of per-building
jitter plus bays, oriels and areaways — which also fixes the single biggest Boston
authenticity miss (South End and Back Bay rows have no bay windows at all).

**8. Skyline upper register and Back Bay towers.** *Owner: buildings / city.*
Nothing procedural above 162 m; Back Bay has zero buildings over 100 m; the 40–60 m
band is nearly empty. Fill 165–225 m sparsely downtown and give Back Bay a real
cluster so the two landmarks read as peaks rather than spikes.

**9. Pedestrian materials.** *Owner: characters / peds.*
The crowd animates well and costs two draw calls, but every figure is an untextured
mannequin. Clothing albedo variation and a face/hair tone would carry a long way.

**10. Tree canopy card silhouettes.** *Owner: vegetation.*
Hard rectangular card edges are visible against the sky at dusk and at night. Alpha
cutout shape on the canopy cards, not more cards.

**Not worth doing:** further perf work; hunting z-fighting; hunting texture tiling.
All three are measured clean.

---

## 6. For the record — what I could not test

- **No real rAF frame rate.** `document.hidden` is `true` for this pane, so
  `measureFps()` refuses and nobody has yet seen this build run at its natural
  cadence. All timings here are synchronous frames forced to GPU completion.
- **Temporal stability under motion.** With the camera frozen and traffic and
  pedestrians stubbed, **6.6% of pixels still alternate between two states**
  frame-to-frame (whole-frame mean delta 5.0/255, max 211; facades 7.2%). The delta
  does not grow with frame separation, so it is a two-state alternation — consistent
  with the 6-frame staggered cascade refresh (draw counts cycle 795, 803, 795, 608,
  990, 608). On a moving camera this would read as facade shimmer. I could not judge
  how bad it looks in motion. *Owner: lighting / render.*
- **Water.** `CURRENT_STATE.md` issue 5 says the water shader fails to compile. I saw
  no GL fault this session, but the harbour renders as a flat untextured plane in both
  `bridge` and `hero_skyline`, so whatever the status, it is not shading.

---

`OVERALL: 4/10 — KEEP WORKING`
