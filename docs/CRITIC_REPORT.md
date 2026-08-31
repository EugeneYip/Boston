# Visual critic report — BOSTON

| | |
|---|---|
| **Commit measured** | `9bd5e55` — `git status -sb` was `## main...origin/main`, clean, at the start **and at the end**. HEAD unchanged throughout. **One build.** |
| **Resolution / preset** | 1920×1080 drawing buffer (`gl.drawingBufferWidth/Height` confirmed), preset `high` (`engine.settings.preset === 'high'`), `pixelRatio` 1.5, CSS canvas 1280×720 |
| **Captures** | 31 `capture()` calls across 11 named shots plus 11 authored zenith/sunward framings; ablations on 7 road terms, `LightManager.staticFloor`, and weather |
| **A/A floor (mine, measured)** | **1.503/255 per pixel** on a frozen dry carriageway — pure film grain, autocorrelation 0.002 at lag 1, i.e. white noise. **0.812/255** on 8×8 block means between consecutive frames at `night_neon`. **0.083/255** (max 0.30) on 60×60 px cells over 8 frames. **0.026–0.245/255** on `rain_street` band means over 60 frames. Term-ablation round-trip drift on the carriageway rect: **0.30/255**. |
| **Boot** | `bootReport.failed` `[]`, `glFaults` `[]`, `missing` `['Missions.js']` only. Zero console errors. |
| **Verdict** | **OVERALL: 6/10 — KEEP WORKING** (holding at 6; the wins are real but they all landed at night) |

Every finding is labelled **measured** (a number produced this session, method stated) or
**judgement**. This pass produced **no judgement findings**: the Browser pane was hidden
for its entire duration, so I have taken no screenshot and I describe no frame I could not
measure. Everything below is `readPixels` on a real 1920×1080 buffer, block-mean
statistics, ablation deltas and scene-graph reads.

**Headline: four of the five things the brief flagged as changed verify, three of the four
named suspects do not reproduce, and the defect three passes have chased on the carriageway
is `macro` — not the cracks, not `dab`, and not `grit`, which `481c0c1` just cut.**

---

## 0. Instruments — three corrections, all of which nearly cost me a false headline

**`lit.sun.position` normalised is garbage. Use `lit.toSun`.** *Measured.* The directional
light is anchored to the camera/target, so `sun.position.normalize().y` reports a sun that
never leaves 18–32° elevation all day and rises again after 19:30. I had "the sun never
sets, shadows never lengthen" written down as the pass's #1 finding. `lit.toSun` gives
**3.8° at 05:00 → 68.9° at noon → 3.8° at 19:00**, which is a correct late-June Boston day
at 42.4°N (true solar noon max 71.1°). **The sun is right. Classify: instrumentation
artifact.** One residual: `toSun` azimuth jumps −64° → −71° → −169° between 19:00 and
21:00 as the moon takes the vector over. Worth a look, but the intensity there is 0.28–0.52
so it is unlikely to be visible.

**`cascadeCost()` absolute milliseconds are not a per-frame cost.** *Measured.* It reports
`totalMs` **14.4** at `night_neon` and **11.6** at `st_southend` — inside frames that
measure **5.3** and **5.2 ms** end to end. It cannot be both. The *relative* numbers are
still useful: cascade 2 (1536 map, 466 m radius) costs 2.2× cascade 0 (2048, 32 m), and all
three report `everyNFrames: 1`. **Do not rank on its absolute ms.**

**Material parameters do not tell you how a prop shades.** *Measured.* `prop:carSuvB:0`
reads `MeshPhysicalMaterial{ color 1,1,1; metalness 1; roughness 1 }` — which looks exactly
like the "pale polystyrene car" of the old backlog. It is not. `StreetFurniture.js:876`
sets those as **ceilings** that a per-vertex `aSurf` attribute scales, with albedo from
vertex colour. Judging car paint from the material object would have re-filed a closed bug.

**`capture()` declares convergence about 0.8/255 early.** *Measured.* At `rain_street`,
after `capture()` returned `settledFrames: 90`, the top band drifted monotonically
64.50 → 63.65 over 60 further frames, ACF decaying 0.952 / 0.897 / 0.837 / … with **no
periodic peak at any lag out to 30**. Its convergence test is 0.05 per 3 frames; a drift of
0.014/frame slips under it. Harmless for pictures, but it is the whole of the "`rain_street`
20-frame oscillation" (§2).

---

## 1. The four named suspects

### 1.1 Headlight real-light slot churn — **DOES NOT REPRODUCE. Not a defect.**

*Measured*, `night_neon`, traffic populated (`capture()` without `holdActors`), then frozen
and stepped 40 frames recording `LightManager._assigned`:

| | |
|---|---:|
| pool size / `staticFloor` | 15 / 6 |
| composition | **8 headlights + 7 street**, 0 sign, 0 tail, 0 window |
| slots that never changed in 40 frames | **7 of 15** |
| distinct sources per churning slot, over 40 frames | **2–4** |
| total identity changes | 20 across 39 transitions, on 9 of 39 frames |

Traffic is *moving* through those 40 frames, so headlights entering and leaving range
**should** change slots. Two to four sources per slot over two thirds of a second is
correct behaviour, not churn. The 2.4× promotion is buying 8 of 15 slots and the
`_assignedSet` 1.35× hysteresis is visibly holding.

**And the "sd 0.304 lights-on vs 0.043 lights-off" that motivated the suspicion is a
non-signal.** *Measured.* My own 60×60 px cell standard deviation over 8 frames at
`night_neon` is mean **0.083**, max **0.30** — the same number. **0.3 of 255 is 0.1% and
cannot be seen.** Classify: **instrumentation artifact.**

*What the headlights actually buy, measured.* Setting `staticFloor = 15` evicts every
headlight from the real-light pool (composition goes to `{street: 15}`, restores exactly to
`{headlight: 8, street: 7}`). The bottom-third road band moves **45.81 → 42.86 → 48.56**
across off/on. The ablation delta (−2.95) is the same size as the round-trip drift (+2.75),
so **the magnitude is not trustworthy**; a `holdActors` run gave −5.84 with a −0.12 round
trip. Call it **3–6/255 on the night road, direction confirmed, magnitude not**. `e0d25da`
is doing real work.

### 1.2 `rain_street` periodic A/A oscillation — **DOES NOT REPRODUCE.**

*Measured*, `holdActors: true`, 60 consecutive frames, 6 band means:

| band (0 = bottom of image) | 0 | 1 | 2 | 3 | 4 | 5 (top) |
|---|---:|---:|---:|---:|---:|---:|
| mean | 52.35 | 50.70 | 45.62 | 67.04 | 60.70 | 64.06 |
| **sd** | 0.026 | 0.030 | 0.031 | 0.042 | 0.055 | **0.245** |
| range | 0.13 | 0.12 | 0.11 | 0.17 | 0.20 | 0.85 |

The top band's autocorrelation **decays monotonically** from 0.952 with no peak at lag 20 or
anywhere else — that is a drift, not a cycle. Amplitude 0.85/255 = 0.3%. The brief's "sky
band peaks ~100 luma" also does not reproduce: the top band sits at **64**. Classify:
**instrumentation/capture artifact** (§0, `capture()` converging early). **Close it.**

### 1.3 Pale / polystyrene kerbside parked vehicles — **DOES NOT REPRODUCE.**

*Measured*, `st_southend`, 270 raycasts on an even grid, each classified by its first mesh
hit and scored against the 8×8 block it sits in:

| class | blocks | mean L | mean RGB | **saturation** | range |
|---|---:|---:|---|---:|---|
| **vehicle props** | 31 | **51.5** | 61 / 48 / 61 | **55.1%** | 5–180 |
| road chunk | 204 | 102.8 | 104 / 102 / 109 | **8.5%** | 14–167 |
| other props (decals) | 12 | 73.0 | 74 / 72 / 80 | 32.3% | 14–161 |

Parked cars are **half the brightness of the road and six times its saturation**. That is
the opposite of polystyrene. Top hits: `prop:carSportsA:0`, `prop:carSedanC:0`,
`prop:carSuvB:0`. Classify: **stale finding, closed.** The one 255,255,255 blob I found on
`prop:carSuvB:0` at 18 m is a single blown clearcoat specular (`clearcoat: 1.0`,
`clearcoatRoughness: 0.06`, `envScale 1.25`), not the body colour.

### 1.4 The road strokes — **`grit` was cut, and `grit` was not the problem. `macro` is.**

This is the finding of the pass. *Measured*, `st_southend`, near carriageway
(1152 × 280 px, sampled every 2 px = 576 × 140), each term zeroed and restored inside one
frozen capture. Round-trip drift **0.30/255**; A/A control difference field sd **1.503**
with autocorrelation **0.002 at lag 1** (white noise, i.e. film grain).

| term zeroed | Δ mean | **sd of the difference field** | max \|Δ\| | **correlation length** |
|---|---:|---:|---:|---|
| **`macro`** | **+7.08** | **19.18** | **73.1** | **> 256 px** |
| **`chip`** | +1.67 | **11.08** | 49.2 | **≈ 256 px** |
| `grit` | +0.36 | 7.63 | 46.0 | **2 px** |
| `track` | +4.40 | 6.31 | 36.4 | ≈ 128 px |
| `dab` | +0.69 | 4.63 | 41.4 | ≈ 128 px |
| `oil` | −0.31 | **1.503** | 6.7 | 1 |
| `joint` | −0.32 | **1.503** | 6.7 | 1 |
| *(A/A control)* | — | *1.503* | — | *1* |
| `gut` / `seal` | −0.31 / −0.29 | not profiled | — | — |

Read that table against the rect's own tonal spread, **sd 20.95**:

- **`macro` alone has sd 19.18 — about 84% of the entire carriageway's tonal variance —
  at a feature size larger than 256 screen px.** At the scale the previous pass measured on
  this same near carriageway (4.6 mm/px) that is **> 1.2 metres**: exactly the size of the
  "1.1 m long, 6 cm wide soft grey marker strokes" three consecutive passes have chased.
- **`grit` is the only term in the whole surface with a correct fine-aggregate signature** —
  correlation length 2 px, i.e. it dies within one lag step, like real aggregate.
  `481c0c1` cut its amplitude to a 0.36/255 mean contribution. **The repair reduced the one
  term that was behaving correctly and left the metre-scale one at full weight.**
- **`chip` is a second metre-scale blotch term**, sd 11.08 at ~256 px. A term named for
  chipped aggregate should not have a correlation length 128× that of `grit`.
- **`oil` and `joint` are inert.** Their difference fields are *byte-identical* to the A/A
  control — sd 1.503, ACF `0.002 / 0.005 / 0.002 / 0.002 / 0.006 / 0.001 / 0.005 / 0.008`
  in all three cases. `gut` and `seal` are at −0.29/−0.31 against a 0.30 round-trip floor.
  **Four to five of the nine road terms cost shader ALU on every carriageway pixel and
  contribute nothing measurable.**

I cannot say from pixels alone whether a viewer still *sees* strokes — the pane was hidden.
What is measured is that the surface's variance is dominated, at metre scale, by one term,
and that it is not any of the three terms previously blamed.

---

## 2. New findings this pass

### 2.1 The sky window in daylight street shots clips to paper white

*Measured.* At `st_southend` (11:12 clear) the six brightest 8×8 blocks in the frame
raycast to a `ShaderMaterial` mesh at **8995–8998 m** — the sky dome — every one of them at
exactly **255 / 255 / 255**. Whole-frame clipping (all three channels ≥ 250):

| shot | clip % | p95 | p99 | black % (L<8) |
|---|---:|---:|---:|---:|
| `st_southend` 11:12 | **1.57** | 230.6 | 254.8 | 1.46 |
| `street_level` 09:30 | **2.16** | 208.5 | 255.0 | 1.03 |
| `hero_skyline` 17:48 | 0.00 | 246.5 | 251.0 | 0.07 |
| `golden_hour` 06:36 | 0.00 | 244.2 | 252.3 | 0.10 |

The sky dome itself is not the problem. *Measured*, camera pointed at the zenith so
auto-exposure keys off sky alone: clipping is 0.01% at noon, 0% at 06:36 and 17:48. **It is
the street canyon.** Auto-exposure keys off dark facades — `st_southend`'s left third runs
14–70 luma — opens up, and the gap of sky at the end of the street goes to paper. In the
coarse grid the blown region is a contiguous ~6 × 4 cell block reading 231–252 with no
gradient. Rubric automatic fail: *pure-white clipped regions with no detail*, and *highlight
rolloff, no clipping*. *Owner: render (tone map / auto-exposure).*

### 2.2 The dusk grade is magenta, not amber

*Measured*, whole-frame channel means:

| shot | tod | R | G | B | saturation |
|---|---:|---:|---:|---:|---:|
| `downtown_dusk` | 19:24 | **137.6** | **73.5** | **76.2** | 54.4% |
| `st_seaport` | 20:00 | 73.9 | **58.0** | **90.8** | 46.7% |
| zenith, sunward | 19:24 | 134 | **75** | 100 | 44.1% |

**Green is the lowest channel in all three, and in two of them blue is above it.** A real
sunset is R > G > B — amber. R > B > G is magenta. `downtown_dusk` additionally runs 54.4%
mean saturation across the *whole frame* with its bottom band at 66.7%, which is a heavier
tint than any photograph. `downtown_dusk`'s near ground is also thirteen consecutive coarse
cells inside a 7-luma window (18–25) — a flat, undifferentiated dark foreground.
*Owner: render (grade) with atmosphere.*

### 2.3 `overcast_wide` still has no black point and no white point — **fifth pass**

*Measured*: p01 **66.7**, p05 **72.9**, p50 116.6, p95 **178.2**, p99 201.9, **0.00%
clipped, 0.00% black**, top band saturation **5.5%**. The previous pass measured p05 72.7 /
p95 171.8. **Unchanged to within a value, four passes running.** The entire frame lives in a
135-value window out of 255. *Owner: render.*

### 2.4 Precipitation now reads below the film grain

*Measured*, `rain_street` camera, sky band (top 28% of frame), full-resolution vertical
difference, rain **animating** (`freeze(false)`, `pauseActors(false)` — the correct test for
a motion-based precip system), 12-frame averages:

| state | vertical HF energy | reversible? |
|---|---:|---|
| rain | **8.755** | |
| clear | 7.103 | |
| rain again | 8.676 | yes, 0.9% |

Rain-attributable high-frequency energy is **1.65/255**. The film grain floor is ~2.3
luma/pixel, ≈3.3 on a difference. **The rain carries about half the high-frequency energy
that the grain does.** `2c574d6` closed the old automatic fail (opaque one-angle quads) and
overshot: the weather state is now nearly invisible. The wet-road response is fine —
the road band moves 48.65 → 53.33 (+9.6%) between clear and rain. *Owner: weather.*

### 2.5 Aerial perspective barely desaturates

*Measured*, `hero_skyline`, saturation by band, bottom (near) to top (far):
**33.2 / 34.2 / 27.5 / 26.5 / 28.4 / 29.1 / 27.0 / 26.9**. A 6-point drop across the whole
depth range. Luminance does the right thing (54 → 204), so there *is* aerial perspective —
it is purely a luminance ramp with almost no chroma loss. *Owner: atmosphere / fog.*

---

## 3. Performance — not the constraint. There is 11 ms of headroom.

*Measured*, agreeing bursts with 1.4 s idle gaps, first burst discarded, `step(1/60)` +
`gl.finish()`, 1920×1080 `high`:

| shot | frame ms | bursts | draws | tris (all passes) |
|---|---:|---|---:|---:|
| `night_neon` | **5.3** | 8.2 / 5.3 | 638 | 4.36 M |
| `st_southend` | **5.2** | 7.6 / 5.2 | 518 | 2.61 M |
| `rain_street` | — | | 639 | 4.15 M |
| `hero_skyline` | — | | 261 | 1.35 M |
| `downtown_dusk` | — | | 194 | 1.45 M |
| `bridge` | — | | 100 | 0.43 M |

Against 16.7 ms, <1200 draws and the ARCHITECTURE.md split budget (3.5 M camera + 2.5 M
shadow ≈ 6 M total): **every budget met, comfortably.** No rAF number — the pane was hidden
throughout and `measureFps()` refuses by design.

Two notes rather than defects. All three shadow cascades report `everyNFrames: 1`, so none
is amortised, and cascade 2 is the most expensive of the three despite the smallest map.
And §1.4's four inert road terms are pure waste on the largest surface in every street shot.
**Both are headroom to spend on image quality, not problems to fix for their own sake.**

---

## 4. Old backlog — what no longer reproduces

| old finding | status |
|---|---|
| **AF-1 `night_neon` black crush**, 7.09 → 7.83 → 8.66% below L=2 | **HALVED — 3.45%.** Measured at the same threshold. `98cad4c` verifies. (At L<8 it is 9.94%, which is a night street.) Whole-frame RGB 46.1/45.1/69.9 |
| **AF-2 rain streaks are opaque one-angle quads** | **CLOSED** by `2c574d6`, and overshot — see §2.4 |
| **AF-5 `golden_hour` is parked inside a wall** (four passes) | **CLOSED.** Camera at [−300, 30, 700]; six rays out to 60 m all clear. Clipping 5.40% → **0.00%** |
| "the strokes are `dab`" (previous pass's judgement) | **WRONG.** `dab` sd 4.63. It is `macro`, sd 19.18 (§1.4) |
| "`grit` is the stroke term" (`e578f37`/`481c0c1`) | **WRONG.** `grit` has a 2-px correlation length — the only correct fine term in the surface |
| headlight slot churn (brief candidate) | **does not reproduce** (§1.1) |
| `rain_street` ~20-frame oscillation (brief candidate) | **does not reproduce** (§1.2) |
| pale polystyrene parked cars (brief candidate) | **does not reproduce** (§1.3) |
| "the sun never sets / shadows never lengthen" | **never existed** — my own artifact, caught before filing (§0) |
| **AF-4 `overcast_wide` has no black or white point** | **REPRODUCES, fifth pass** (§2.3) |
| AF-3 harbour is an unshaded plane | **consistent with measurement, not confirmed.** `bridge` is 100 draws / 0.43 M tris; its bottom four bands span 41.2 → 72.3 and its top four are flat at 210–214 |
| AF-6 Zakim mast pincushion | **not re-tested** |
| SSR does nothing in the wet | **not re-tested** |
| Landmark silhouettes / heights, roof decks, window glass, brick scale | **not re-tested** |

---

## 5. Rubric scores

| # | Axis | Prev | **Now** | Basis (all measured this pass) |
|---|---|---:|---:|---|
| 1 | Silhouette & massing | 6 | **6** | Not re-tested. Held. |
| 2 | Material truth | 6 | **6** | Held, and it is a close thing. Parked cars are properly coloured (51.5 L / 55.1% sat). Against `macro` owning 84% of carriageway variance at >1.2 m, `chip` a second metre-scale blotch, and 4–5 of 9 road terms inert |
| 3 | Lighting | 6 | **7** | **Up.** Night black below L=2 halved, 8.66 → 3.45%. Headlights verified in 8 of 15 real slots, stable, reversible, worth 3–6/255 on the night road. 3,084 pool decals / 2,235 lamps |
| 4 | Atmosphere & depth | 7 | **6** | **Down.** Aerial perspective is luminance-only, 33.2 → 26.9% saturation across the full depth. The sky clips to 255 in street canyons. `overcast_wide` unchanged for a fifth pass |
| 5 | Composition & grade | 6 | **5** | **Down.** 1.57% / 2.16% pure-white clip with no rolloff at the two daylight street shots; magenta dusk (G lowest channel at 19:24 and 20:00); `overcast_wide` compressed into 67–202 |
| 6 | Density & life | 6 | **6** | Not re-tested. 518–689 draws at street level; `bridge` 100 and `downtown_dusk` 194 |
| 7 | Geometric fidelity | 5 | **6** | **Up.** Rain is no longer quads. No z-fighting or tiling signature found: horizontal autocorrelation on the mid-frame strip decays monotonically at every shot, with no peak at any lag |
| 8 | Boston authenticity | 6 | **6** | Not re-tested. Sun elevation curve verified correct for 42.4°N (3.8° → 68.9° → 3.8°) |

**Direction of travel: up, but the score holds at 6.** Every commit in the window did what
it said, and two long-standing automatic fails closed. The score does not move because the
work all landed at night, the daylight grade got no attention and is now the weakest axis,
and the loudest daylight material defect was chased for a fourth pass into the wrong term.

---

## 6. Recommended next wave — two items, nothing else

### Wave A — "the carriageway's term budget"
*Owner: a **roads / materials specialist**.* Files: `src/world/Roads.js` only.

Re-balance the surface so the metre-scale term stops owning the frame, and delete the dead
weight. Specifically: cut `macro`'s amplitude, cut or re-scale `chip` to a real chip size,
restore fine-scale energy (`grit` is the only correctly-scaled term in the surface and it
was just cut to 0.36), and remove or repair `oil`, `joint`, `gut` and `seal`.

**Held to, on the `st_southend` near-carriageway rect, inside one frozen capture:**
- `setTerm('macro', 0)` difference field **sd ≤ 8/255** (from 19.18).
- `setTerm('chip', 0)` **correlation length ≤ 16 px** (from ~256).
- `setTerm('grit', 0)` **sd ≥ 8/255 and correlation length ≤ 4 px** — it must come back, and
  it must stay fine.
- The rect's own **sd stays in 19–22** (currently 20.95): redistribute the variance, do not
  delete it. Mean stays in 84–88 (currently 85.7).
- **Every surviving term's ablation Δ ≥ 1.0/255**, three times the 0.30 round-trip floor.
  Anything that cannot clear that is dead and should be gone.
- Report the A/A control alongside every number, as in §1.4.

### Wave B — "the sky window"
*Owner: a **render / post specialist**.* Files: `src/gfx/effects/AutoExposurePass.js`,
`src/gfx/effects/ExposureEffect.js`, `src/gfx/effects/GradeEffect.js`,
`src/gfx/ColorGrade.js`, `src/gfx/RenderPipeline.js`.

Give the highlights a rolloff, and take the magenta out of dusk.

**Held to:**
- `st_southend` and `street_level` **clip % (all channels ≥ 250) ≤ 0.2** (from 1.57 and
  2.16), with **p99 ≥ 240** — roll the shoulder off, do not just darken the frame.
- The sky region of `st_southend` must have **standard deviation > 4/255** — it must contain
  a gradient rather than a flat sheet of 255.
- `downtown_dusk` and `st_seaport`: **G ≥ B** in the whole-frame channel means. Amber, not
  magenta. `downtown_dusk` whole-frame saturation **≤ 45%** (from 54.4).
- `overcast_wide`: **p01 ≤ 40** and **p99 ≥ 225** (from 66.7 and 201.9).
- No regression: `hero_skyline` clip stays 0.00%, `night_neon` below-L=2 stays ≤ 4%,
  frame time stays under 8 ms in agreeing bursts at 1920×1080 `high`.

**Explicitly not this wave:** perf (5.2–5.3 ms against 16.7), headlights, the real-light
pool, precipitation timing, and anything on the four suspects in §1 that do not reproduce.
If a third slot exists, spend it on `overcast_wide`, which is now the only automatic fail
standing that has survived five consecutive passes.

---

## 7. Shot-by-shot

```
SHOT: hero_skyline     VERDICT: FAIL   (17:48, 261 draws / 1.35M tris, 0.00% clip, 0.07% black)
Scores: 7 / 6 / 7 / 6 / 6 / 6 / 6 / 6   → 6/10   ** best shot in the build **
mean 132.4, p05 41.6, p95 246.5, sat 29.4. Real luminance ramp with depth (54 -> 204).
Gives it away: (1) saturation is flat with depth, 33.2 -> 26.9; (2) the band just above
the skyline is nine consecutive cells inside 7 luma - a featureless sheet; (3) not re-tested
for facade/roof detail, which the previous pass failed it on.

SHOT: st_southend      VERDICT: FAIL   (11:12, 518-584 draws / 2.61M tris, 5.2 ms, 1.57% clip)
Scores: 6 / 5 / 7 / 6 / 5 / 6 / 6 / 6   → 6/10
The road reference. Cars now read (51.5 L, 55.1% sat) against a road at 102.8 / 8.5%.
Gives it away: (1) the sky window clips to 255,255,255 with no gradient; (2) `macro`
owns 84% of the carriageway's variance at >1.2 m; (3) the road is 8.5% saturated - flat grey.

SHOT: street_level     VERDICT: FAIL   (09:30, 557 draws / 3.35M tris, 2.16% clip)
Scores: 6 / 5 / 7 / 6 / 5 / 7 / 6 / 6   → 6/10
mean 81.7, sat 42.7%, RGB 73/82/103. Highest clip fraction in the build.
Gives it away: (1) 2.16% pure white, p99 = 255.0; (2) 42.7% whole-frame saturation;
(3) the same carriageway term imbalance.

SHOT: night_neon       VERDICT: FAIL   (22:00, 638 draws / 4.36M tris, 5.3 ms, 3.45% below L=2)
Scores: 5 / 5 / 7 / 6 / 6 / 6 / 6 / 6   → 6/10   ** most improved **
Black crush halved from 8.66%. mean 48.7, RGB 46/45/70. 8 headlights + 7 street lamps
in the real-light pool, stable across 40 frames. Sky reads 10-20 luma - correct.
Gives it away: (1) still a blue wash, B is 52% above R in the whole-frame mean;
(2) no sign, tail or window source ever wins a real light in a shot named for neon.

SHOT: rain_street      VERDICT: FAIL   (15:12 rain, 639 draws / 4.15M tris, 1.30% black)
Scores: 5 / 5 / 6 / 5 / 5 / 6 / 6 / 5   → 5/10
Wet road responds correctly (+9.6% on the road band). Band means are stable to 0.03-0.25
over 60 frames - the old oscillation is gone.
Gives it away: (1) the rain carries half the high-frequency energy of the film grain.

SHOT: downtown_dusk    VERDICT: FAIL   (19:24, 194 draws / 1.45M tris, 0.007% clip)
Scores: 5 / 5 / 5 / 5 / 3 / 4 / 6 / 5   → 5/10   ** worst grade in the build **
RGB 137.6 / 73.5 / 76.2 - magenta, not amber. 54.4% whole-frame saturation, 66.7% in the
near band. Near ground is 13 consecutive cells inside a 7-luma window. 194 draws.

SHOT: st_seaport       VERDICT: FAIL   (20:00, 689 draws / 1.99M tris, 3.59% black)
Scores: 5 / 5 / 6 / 5 / 4 / 6 / 6 / 5   → 5/10
mean 63.8, RGB 73.9 / 58.0 / 90.8 - green is the lowest channel again, p01 = 0.5.

SHOT: golden_hour      VERDICT: FAIL   (06:36, 516 draws / 3.00M tris, 0.00% clip)
Scores: 6 / 5 / 6 / 5 / 5 / 6 / 6 / 5   → 5/10   ** no longer unjudgeable **
Out of the wall at last, and the 5.40% clip is gone. Sun is at ~20 deg, which is not
golden hour; sky saturation at the zenith is 10.6% and sunward 5.8%. mean 132.4.

SHOT: overcast_wide    VERDICT: FAIL   (13:00 overcast, 343 draws / 1.75M tris)
Scores: 5 / 4 / 4 / 5 / 3 / 5 / 5 / 5   → 4/10   ** worst shot; unchanged for four passes **
p01 66.7 / p05 72.9 / p95 178.2 / p99 201.9, 0.00% clipped, 0.00% black. Top band 5.5% sat.

SHOT: bridge           VERDICT: FAIL   (08:12, 100 draws / 0.43M tris, 0.108% clip)
Scores: 4 / 4 / 5 / 5 / 5 / 3 / 5 / 5   → 4/10
100 draws and 0.43M triangles - the emptiest frame in the build by a factor of two.
Bottom four bands 41-72, top four flat at 210-214. Consistent with AF-3 standing.
```

---

## 8. For the record — what I could not test

- **Nothing was seen.** The Browser pane was hidden for the whole session
  (`document.hidden === true`, `tabs_select` did not front it), so there is no screenshot
  and no magnified readback in this report. Every claim is a number. Where a defect needs an
  eye — the road strokes' *appearance*, roof decks, window glass, landmark silhouettes, the
  Zakim masts, brick scale, tree canopies — I have said "not re-tested" rather than guess.
- **No real frame rate.** `measureFps()` refuses when the pane is hidden. All timings are
  synchronous `step(1/60)` forced to GPU completion, two agreeing bursts, minimum taken.
- **`night_neon` sd 0.304 / `rain_street` oscillation / headlight churn / pale cars** — all
  four brief candidates measured and none reproduces. That is the most useful thing in this
  report and the reason the next wave is only two items.
- **AF-3 (water), AF-6 (Zakim masts), SSR, landmark silhouettes, roof decks, window glass
  and brick scale** were not re-measured; the budget went to the four candidates and the
  road term bisection.
- **Motion.** Still nobody has watched this build move.

---

`OVERALL: 6/10 — KEEP WORKING`
