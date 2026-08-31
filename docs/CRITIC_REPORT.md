# Visual critic report — BOSTON

| | |
|---|---|
| **Commit measured** | `4bad832` — working tree clean at the start **and at the end**, verified by `git status --short` both times. HEAD unchanged throughout. **One build.** The sibling `buildPlots` session did not write while I measured. |
| **Resolution / preset** | 1920×1080 drawing buffer (`drawingBufferWidth/Height` confirmed), preset `high`, `pixelRatio` 1.5 |
| **Captures** | ~30 deterministic `capture()` calls across **10 named shots** plus one authored Back Bay framing, with AO, SSR, crack, detail, albedo and aberration ablations |
| **A/A floor (mine, measured)** | **0.00% of 8×8 blocks / mean 0.155 of 255** on a settled dry carriageway; **3.24% / 0.259** whole-frame at `st_southend`; **7.12% / 0.386** at `st_beaconhill`. In rain it collapses to **23.7% / 3.46** because the streaks are *not* frozen. |
| **Boot** | `bootReport.failed` `[]`, `errors` `0`, `glFaults` `[]`, `validate().ok` true — start and end |
| **Verdict** | **OVERALL: 6/10 — KEEP WORKING** (up from 5, 5, 4, 3) |

Every finding is labelled **measured** (a number I produced this session, method stated)
or **judgement** (my eye on a magnified readback).

**The score moves for the first time in four passes. Five of the six changes verify;
the sixth verifies its plumbing and fails its purpose. More importantly, the defect
three consecutive passes have called "the crack motif" is not the cracks — I ablated
them and it did not move.**

---

## 0. Instruments — one correction, one new trap, one thing I got right by luck

**The A/A floor is now essentially zero on static geometry, and `freeze()` deserves
the credit.** *Measured.* On a settled dry carriageway at `st_southend`, two frames
25 steps apart differ by **0.00% of 8×8 blocks, mean |Δ| 0.155/255, max 0.85**. Toggle
round-trips return the whole frame to within **0.001/255** (102.174 → 102.175). This is
the cleanest instrument this project has ever had, and it is what let me settle the
crack question below in two ablations. Every per-pixel finding in previous reports that
was quoted against a 9–33% floor should be re-read with that in mind.

**Correction to the brief: `freeze()` does not freeze the rain.** *Measured.* At
`st_southend` in rain the same-mode floor on the carriageway is **23.7% of blocks, mean
3.46, max 97**, versus 0.00%/0.155 dry. `Weather.rain` and `Weather.splash` are not
`Object3D`s so I could not hide them. Any wet-road A/B — including the brief's SSR
figure — is being read against that floor, and the SSR effect is smaller than it (§1).

**New trap, and it is the important one: `capture()` is not reproducible frame-to-frame.**
*Measured.* The same shot captured twice, both settled 60 steps, differs by **87.7% of
blocks, mean |Δ| 3.91/255**, whole-frame mean 101.75 vs 105.01 — and 27,781 of 28,413
changed blocks are *brighter*. Across the session `st_southend` settled at means of
100.7, 101.8, 105.0, 105.1, 108.1, 109.1, 110.7 — a **9% spread**. Within a capture the
trace is flat (108.084 → 108.077 over 80 steps), so auto-exposure is pinned during the
freeze but pins a *history-dependent* value. Consequences:

- **Ratios inside one capture are trustworthy.** The albedo fraction came out 0.6213 /
  0.6175 / 0.6219 across three independent captures whose absolute means spanned 100.7
  to 110.7 (§3).
- **Absolute cross-capture levels are not.** My first albedo-fraction reading was 0.464
  — numerically identical to the value the commit claims to have improved *from* — purely
  because that capture followed a custom camera and had not settled. I nearly filed it.
  **Do not compare a mean from one capture against a mean from another.**

*Measured.* The HUD, minimap and DevOverlay are DOM, not canvas, so they are absent from
`gl.readPixels`. Readback statistics are clean. But `readPixels` only returns real data
**in the same evaluation as a render** — a grab in a later tool call returns solid black.

*Measured.* Perf, confirmed in agreeing bursts with idle gaps: `hero_skyline` **3.4 ms**
(281 draws / 1.46 M tris), `st_beaconhill` **5.1 ms** (631 / 3.26 M). Matches the brief.
**Not a concern — but all-pass triangles at `street_level` are 3.33 M against a 3.5 M
budget, 95% of it.** That is tighter than the last pass reported and is the only budget
worth watching.

---

## 1. `06ed84c` — AO and SSR in the compositor — **AO VERIFIES AND IS VISIBLE. SSR IS
WIRED, GATED CORRECTLY, AND DOES NOTHING.**

### 1.1 The pass chain, in full

*Measured.* At preset `high`:

```
FrameStatePass · RenderPass · N8AOPostPass · atmosphere · AutoExposurePass
VelocityPass (OFF) · SSRPass (OFF) · LensPass
FX[LensComposite+Exposure+ToneMapping+Grade] · FX[SMAA] · FX[LensFinal+FilmGrain]
```

AO is in and enabled. **SSR and Velocity are in the chain but `enabled === false` in
clear weather and at night** — `postprocessing` skips a disabled pass entirely. This is
not the old bug: they switch on correctly in rain (`rain_street`, and `st_southend`
forced to rain, both report `ssr.enabled true / velocity.enabled true`). It is a
weather gate and it is the right design. But it means the brief's "AO+SSR+Velocity all
live" describes the *rain* frames only; in the five dry shots SSR costs nothing and does
nothing, correctly.

### 1.2 Contact shadows now exist. Measured, located, and visible.

*Measured*, `st_beaconhill`, AO toggled inside one capture against a 7.12% floor:

| | |
|---|---:|
| whole-frame mean, AO on | 86.321 |
| whole-frame mean, AO off | 88.764 |
| **AO darkening** | **−2.443/255** |
| blocks changed | **44.1%** (floor 7.12%) — 6× |
| direction | 13,826 darker / 473 brighter — AO only darkens ✅ |
| reversibility | 9.6%, balanced 1278/1818 — noise, not drift |

At `st_southend` the same toggle gives **−1.635/255 over 36.4% of blocks against a 3.24%
floor** — 11× its floor. The brief's −2.25 sits between my two shots.

**The band profile confirms the claim.** *Measured.* Averaging the AO delta across
x 1500–1880 at `st_beaconhill` and stepping y in 10 px rows, the darkening runs 5–8/255
over open pavement and **peaks at 10.0–12.7/255 at y 610–640, which is exactly the
pavement/facade contact line**, then falls back to 4–7 below it. That is a contact term
behaving like one, independently reproduced.

*Judgement.* It reads. At `street_level` there is real darkening under the vans, in the
tree pits and along the wall bases; at `rain_street` under the parked car and at the
railing feet. The predecessor's "the wheel reads as hovering" is **fixed**. It is on the
gentle side — a 12/255 peak is a 5% darkening where a real contact shadow is much
darker — but the effect is present, correctly placed and worth keeping.

### 1.3 The wet road does not reflect. **This half fails.**

*Measured*, `st_southend` forced to rain, SSR toggled inside one capture:

| carriageway (600×320 px) | SSR on | SSR off |
|---|---:|---:|
| mean | 58.91 | 57.45 |
| MAD | 12.92 | 11.59 |
| blocks changed by the toggle | **21.4%, mean 2.45** | |
| **same-mode A/A floor** | **23.7%, mean 3.46** | |

**The SSR effect is smaller than the shot's own noise floor.** The direction is right
(+1.47/255 and slightly more contrast — a reflection adds light), but 1.47/255 on a
58-mean road is 2.5% and invisible. The brief's own figure (mean −1.03, **median 0**)
says the same thing: the median road pixel is untouched.

*Judgement, 1.83× on the readback.* There is **no reflection of anything** in the wet
carriageway — no mirrored facade, no lamp streak, no sky. **No puddles anywhere.** One
small specular blob in the whole crop. And wet still *reduces* contrast (MAD 12.9 wet
against 28.1 dry), when a real wet street gains it. **SSR is running, costing frame time,
and buying nothing.** *Owner: render.*

---

## 2. `06ed84c` — chromatic aberration — **FIXED. I am withdrawing the automatic fail.**

*Measured*, sub-pixel R→B shift by SSD minimisation with parabolic refinement, 200 px
patches:

| | `street_level` | `bridge` |
|---|---:|---:|
| corner TL / TR | −0.45 / **+0.56 px** | (degenerate, see below) |
| corner BL / BR | −0.21 / +0.04 px | 0.00 / 0.00 px |
| centre | −0.05 px | −0.03 px |

`street_level` reproduces the brief's 0.50 px at the corners and ~0 at centre.

**A caution on my own instrument:** the `bridge` top corners read ±5.8 px, which looks
alarming and is an artefact. With `lensFinal.aberration` forced to **0** those same
patches read **−5.78 / +5.87** — identical. They are smooth sky, where R and B carry
genuinely different content and an alignment search is ill-posed. Ablating aberration at
`bridge` moves the frame by 14.2% of blocks / mean 0.41, *below* that shot's own
reproducibility. Any future pass measuring CA must use a high-contrast achromatic edge.

*Judgement, 2.25× on the readback of the Zakim.* The predecessor's "rainbow bars",
"dashed line of coloured dots" and "broken technical drawing" are **gone**. The cables
are clean grey-blue. Building edges at `street_level` and the car creases at
`st_southend` carry no visible fringe. **AF-5 is closed.**

---

## 3. `7abe067` — cracks and the specular floor — **THE SPECULAR FIX VERIFIES. THE CRACK
FIX ALSO VERIFIES — AND IT FIXED THE WRONG THING.**

### 3.1 The specular floor: verified, and it is the biggest material win in the build

*Measured*, three independent captures of `st_southend`, zeroing `road.color` inside each:

| capture | carriageway mean | zero-albedo mean | **albedo fraction** |
|---|---:|---:|---:|
| 1 | 109.08 | 41.31 | **0.6213** |
| 2 | 100.66 | 38.50 | **0.6175** |
| 3 (150-step settle) | 110.69 | 41.85 | **0.6219** |

**0.62, stable to ±0.4% across captures whose absolute means differ by 10%.** Against
0.464 before, that is non-albedo luminance falling from 53.6% to 38%. Slightly short of
the claimed 0.666, and comfortably the right answer. Dry MAD on this rect is 28.1–34.0.
The road is no longer a majority-specular surface, and the "chalky pale asphalt" note
from the last three reports is **closed**. The diagnosis in the commit — that the floor
was `MeshStandardMaterial`'s hard-coded F0, not ambient — is borne out.

### 3.2 The cracks are fixed, and they were never the problem

This is the finding of the pass.

*Measured.* `setCrack(1)` → `setCrack(0)` inside one capture, on the near carriageway,
against a **0.00%** A/A floor: **6.33% of blocks, mean 0.41, max 20.1**, 341 blocks
brighter / 1 darker. Perfectly reversible (0.00%). So the crack term is real, small and
correctly signed.

*Judgement, 2× on the readback.* With cracks **on**, the new network is visible and it
is *good*: thin, straight, dark, angular segments that meet at Y-junctions, clustered
near the lane edge and the gutter. That is what the commit promised and it delivered it.

**And with `setCrack(0)` the soft grey marker scribbles are still there, unchanged.**
Every long lazy S-bend, every fat rounded terminus, every stroke that wanders across the
lane line — all still present with the crack term at zero. I then set `setDetail(0)`,
which removes the aggregate speckle, and the strokes became *more* prominent, dark and
unmistakable, with visible stair-stepping on their edges.

**Three consecutive critic passes — including mine's predecessor — have attributed this
to the cracks. It is not the cracks. The crack rework repaired a term that was not
producing the defect.**

*Measured, on scale.* Raycasting the ground plane through the strokes puts the near
carriageway at **4.6 mm/px** (the source says 3.8, close enough to validate the method)
and makes a typical stroke **~1.1 m long and ~6 cm wide**.

*Judgement, from source plus that scale.* The surviving suspect is **`dab`**, the
cold-patch term at `Roads.js:824`:

```glsl
float dab = smoothstep(0.72, 0.93, bNoise(W * 2.6 + 61.4))
          * smoothstep(0.38, 0.70, n2) * bFade(0.40);
```

It is an **iso-band of smooth value noise** — precisely the construction the commit's own
`bCell` comment identifies as the cause of the problem: *"a value-noise iso-line is a
smooth meandering curve whose width is set by the local gradient, so it is wide wherever
the noise is flat, it never runs straight, and it never meets another crack at an
angle."* That diagnosis was correct and it was applied to the cracks while the identical
pathology was left in `dab`, which carries a −0.30 coefficient — the heaviest dark term
on the carriageway after `joint` and the cracks themselves. The `cut`/`joint` utility
patches, visible as pale quadrilaterals with thin dark rims in the detail-off frame, are
behaving correctly and are *not* the strokes.

I have not proved it is `dab` rather than another un-ablatable term — there is no
uniform for it — so treat the attribution as judgement and the elimination of cracks and
detail as measured. **Whoever picks this up should add a `setDab`-style ablation before
changing anything.** *Owner: roads.*

This defect is the loudest tell in `st_southend`, `st_beaconhill`, `night_neon` (where
it is the most legible thing in the frame) and the wet `st_southend`.

---

## 4. `7abe067` — brick walk tint — **VERIFIED. It reads as Boston brick.**

*Measured*, `st_beaconhill`, both pavements:

| | sRGB | ratio |
|---|---|---|
| left walk | 115 / 82 / 66 | **1.73 : 1.23 : 1** |
| right walk | 115 / 83 / 71 | **1.60 : 1.17 : 1** |

Against 12:2:1 two passes ago and 4.5:1.6:1 at the albedo. Real Boston brick pavers sit
around 1.75:1.18:1. **This is now correct to within measurement noise, and it is the
cleanest of the six changes.** *Judgement:* at magnification the walk reads as a muted
warm red-brown; the "hot orange terracotta running track" is gone.

---

## 5. `f4ee6d9` — skyline upper register — **VERIFIED EXACTLY. The landmarks read as
peaks. They do not read as *these* landmarks.**

*Measured*, from `buildings.specs` (10,048 buildings), with landmark positions taken
from the project's own `geo()` rather than guessed:

| band (m) | count | | |
|---|---:|---|---|
| 0–20 | 8,139 | max height | **184.9 m** (was 162.5) ✅ |
| 20–40 | 1,282 | 165–225 m band | **8** (was 0) ✅ |
| 40–100 | 524 | p99 | 101.6 m |
| 100–165 | 95 | median | 16.4 m |
| **165–225** | **8** | | |

| landmark | true position (`geo`) | peak within 300 m | over 40 m | real height |
|---|---|---:|---:|---:|
| Prudential | x −1363, z 912 | **176.2 m** | 20 | 228 m |
| Hancock | x −769, z 744 | **150.6 m** | 27 | 240 m |

47 buildings over 40 m across the two clusters against the brief's 46. **The histogram is
unfrozen, the claim reproduces in every particular, and the geography is right** — the
176.2 m tower sits 130 m from the Prudential's true coordinates.

*Judgement*, from an authored framing looking north-west across Back Bay at 17:12. **The
towers now read as peaks.** There is a clear tall slab where the Prudential belongs and a
cluster where the Hancock belongs, rising out of the rowhouse carpet. The "flat carpet
where the two tallest buildings in Boston stand" is fixed and `overcast_wide` shows a
genuine downtown massing for the first time in four passes.

**What still fails:** they are plain grey rectangular boxes. The Prudential's taper and
crown and the Hancock's slender blue-glass parallelogram — the most recognisable
silhouette in the city — are absent, and at 176 m and 151 m they are 23% and 37% short of
the real buildings, so the two tallest things in Boston are shorter than four Financial
District towers. A Bostonian would recognise the *street plan* long before the skyline.
The rowhouse carpet beneath is uniform to the point of reading as a texture.

---

## 6. `1c420c0` — `freeze()` stops the actors — **VERIFIED, AND IT IS THE MOST VALUABLE
OF THE SIX.** See §0. Static-geometry A/A floor 0.00% / 0.155. The one hole is rain (§0).

---

## 7. Automatic fails

**Standing:**

- **AF-1 `night_neon` — 8.66% of the frame below luminance 2.** *Measured.* Worse for a
  third pass: 7.09% → 7.83% → **8.66%**. Whole frame mean 42.06, p05 0.72, RGB
  [40.5, 40.3, 64.6]; the lower half is [28.4, 39.6, 80.8] — a flat blue ambient wash.
  *Judgement:* one wall-pack pools correctly on brick, proving the machinery; the road
  under ~2,300 lamp props has no pool at all. Cars are pale polystyrene; trees are hard
  black polygon masses.
- **AF-2 Rain streaks are opaque one-angle quads.** *Judgement, magnified.* Unchanged and
  if anything more prominent: long bright spindles at a single angle, length and opacity,
  drawn at full strength over sky, brick, tree trunk, pavement and car alike, with flat
  ends and no depth attenuation. The worst single element in the build.
- **AF-3 The harbour is an unshaded plane.** *Measured + judgement.* ~60% of `bridge` is
  a flat sheet — no waves, no normal, no glitter, no reflection of the bridge above it,
  and a razor-hard horizon line. Same at `hero_skyline` and `overcast_wide`.
- **AF-4 `overcast_wide` has no black point and no white point.** *Measured.* p05 **72.7**,
  p50 115.9, p95 171.8, min **55.7**, max **210.6**, **0.00% clipped, 0.00% black**.
  Fourth pass, unchanged to within a value (73.8/117.3/163.4 last time). City, river and
  sky resolve to one blue-grey.
- **AF-5 `golden_hour` is parked inside a wall.** *Judgement.* **Fourth pass running.**
  Additionally **5.40% of that frame is clipped** with no rolloff — an automatic fail in
  its own right. Usefully it shows brick at ~3× life size and windows as flat decals with
  no glass, reveal or sill shadow.
- **AF-6 (new) The Zakim carries a pincushion of vertical masts.** *Judgement, 2.25× on
  the readback.* Roughly forty vertical spikes stand off the bridge deck, several as tall
  as the tower itself, in addition to the (correct, if aliased) diagonal stay fan. It
  reads as broken geometry. The tower is an undetailed grey obelisk. I could not locate
  the objects by scene traversal — they are likely instanced under a chunk whose origin
  is elsewhere — so this needs a landmarks owner to confirm. *Owner: landmarks.*

**Cleared this pass:** **AF (chromatic aberration) — closed**, §2. **"No contact
shadows" — closed**, §1.2. No z-fighting, no shadow acne, no visible texture tiling, no
floating or sunk objects, no empty streets, **zero console errors, zero GL faults,
`validate().ok` true**, and every ARCHITECTURE.md budget met.

---

## 8. Shot-by-shot

```
SHOT: hero_skyline     VERDICT: FAIL   (17:48, 281 draws / 1.46M tris, 3.4 ms, 0.00% clip)
Scores: silhouette 7, material 6, lighting 7, atmosphere 8, grade 7, density 6,
        geometry 6, boston 6   → 7/10   ** best shot in the build, and it is close **
Real aerial perspective, warm consistent grade, varied tower massing, roof clutter
appearing. Gives it away: (1) every tower ends in a flat parapet over a flat untextured
roof deck; (2) window grids are perfectly regular with no variation or lit/unlit mix;
(3) facades are flat — no mullion shadow, no reveal, no depth.

SHOT: st_beaconhill    VERDICT: FAIL   (16:00, 631 draws / 3.26M tris, 5.1 ms, 1.23% black)
Scores: 7 / 6 / 6 / 6 / 6 / 7 / 6 / 7   → 6/10   ** best daylight street **
Brick rows, fire escapes, awnings, iron rails, stoops, real pedestrians, correct brick
walk, visible contact darkening. Gives it away: (1) the marker strokes across the whole
carriageway; (2) a flat black manhole disc mid-road; (3) windows are flat black holes.

SHOT: st_southend      VERDICT: FAIL   (11:12, ~570 draws, 4.7 ms)
Scores: 6 / 6 / 6 / 5 / 6 / 6 / 6 / 6   → 6/10
The road reference. Albedo fraction now 0.62, MAD 28-34, real aggregate speckle, genuine
thin angular cracks. Undone by the marker strokes and a monochrome white/grey car fleet.

SHOT: street_level     VERDICT: FAIL   (09:30, 553 draws / 3.33M tris, 2.23% clip)
Scores: 6 / 4 / 7 / 6 / 5 / 7 / 5 / 7   → 6/10
The dappled leaf shadow on the pavement slabs is still the best-looking thing in the
build, and AO now grounds everything on it. Ruined by two foreground vans that are flat
white untextured slabs with black-rectangle windscreens and octagonal wheel arches.

SHOT: overcast_wide    VERDICT: FAIL   (13:00 overcast, 347 draws)
Scores: 5 / 3 / 4 / 5 / 3 / 4 / 5 / 5   → 4/10   (up from 3: the massing is real now)
First pass in four where downtown has an upper register instead of a mesa. Still no black
point and no white point (p05 72.7 / p95 171.8, 0.00% clipped, 0.00% black), towers are
untextured grey slabs, and the whole frame is one hue.

SHOT: night_neon       VERDICT: FAIL   (22:00, 666 draws, 8.66% black)
Scores: 4 / 4 / 3 / 5 / 4 / 6 / 5 / 5   → 4/10
Black crush worse for a third pass. Flat blue road with zero lamp pools under ~2,300
lamps. The marker strokes are the most legible thing in the frame. Trees are black
polygon masses. Cars are unlit polystyrene with no contact shadow on the near one.

SHOT: rain_street      VERDICT: FAIL   (15:12 rain, 700 draws, 1.09% black)
Scores: 4 / 3 / 4 / 4 / 3 / 5 / 4 / 4   → 4/10
Third pass framed on a pavement rather than a carriageway. One-angle opaque streaks over
everything. A pavement in heavy rain with no puddle, no sheen and no reflection. SSR is
enabled here and contributes less than the frame's own noise.

SHOT: bridge           VERDICT: FAIL   (08:12, 90 draws, 0.85% clip)
Scores: 4 / 2 / 5 / 6 / 5 / 3 / 3 / 5   → 4/10
CA is fixed and the cables are clean — but ~60% of the frame is dead flat water and the
deck carries a pincushion of forty vertical masts (AF-6). Composition is 60% water,
25% sky, bridge jammed against the right edge.

SHOT: golden_hour      VERDICT: FAIL   (06:36, 570 draws, 5.40% clipped)
Scores: 3 / 3 / 5 / 4 / 3 / 3 / 4 / 4   → 3/10   ** worst shot; unjudgeable **
Camera inside a wall, fourth pass running, and now also 5.4% clipped with no rolloff.

SHOT: Back Bay (authored, 17:12, 126 draws)   VERDICT: FAIL — but the news is good
The Prudential and Hancock read as peaks above the rowhouse carpet for the first time.
They are plain grey boxes at 77% and 63% of true height, and the carpet below is uniform.
```

### Rubric scores, whole build

| # | Axis | Prev | **Now** | Basis |
|---|---|---:|---:|---|
| 1 | Silhouette & massing | 5 | **6** | **Up.** Histogram unfrozen: max 184.9 m, 165–225 band 0 → 8, 47 buildings over 40 m at the two landmark sites. Against flat parapets, untextured roof decks, box towers and no landmark silhouettes |
| 2 | Material truth | 5 | **6** | **Up.** Road albedo fraction 0.464 → 0.62, brick walk 1.73:1.23:1, genuine thin angular cracks, AO live. Against the marker strokes, no wet reflection, no puddles, flat water, white-slab cars, glassless windows |
| 3 | Lighting | 5 | **6** | **Up.** Contact darkening exists, is measurable (−2.44/255) and peaks at the contact line. Against 15 dynamic lights, zero lamp pools, and `night_neon` black crush worsening to 8.66% |
| 4 | Atmosphere & depth | 6 | **7** | **Up.** `hero_skyline` and the Back Bay framing have real aerial perspective; clouds are excellent. Against flat water and one hard horizon line |
| 5 | Composition & grade | 4 | **6** | **Up two.** Chromatic aberration fixed and the fail withdrawn. Against 8.66% black at `night_neon`, 5.40% clip at `golden_hour`, and `overcast_wide`'s missing black and white points |
| 6 | Density & life | 6 | **6** | Unchanged and still a strength |
| 7 | Geometric fidelity | 5 | **5** | Unchanged. No z-fighting, no tiling, no floaters — but rain streaks are quads, the Zakim has a mast pincushion, car silhouettes are faceted, tree canopies are hard polygon masses |
| 8 | Boston authenticity | 6 | **6** | Brick walk now correct and the skyline has peaks — against 3× oversized brick, landmark towers as grey boxes 23–37% too short, and a uniform rowhouse carpet |

**Direction of travel: for the first time the frame moved.** Five of six changes verify,
the score goes to 6, and two long-standing automatic fails close. The pass also found
that the single loudest defect in every street shot has been misattributed for three
passes and survived the commit that was meant to fix it.

---

## 9. Ranked fixes

**1. Find and re-author the marker strokes on the carriageway — they are not the cracks.**
*Owner: roads.* 40%+ of every street frame and the loudest tell in four shots. Measured:
they survive `setCrack(0)` **and** `setDetail(0)` intact against a 0.00% noise floor.
Judgement: the surviving suspect is `dab` at `Roads.js:824`, an iso-band of smooth value
noise — the exact construction this commit's own `bCell` comment blames for "soft grey
marker scribbles", left in place while the cracks were fixed. **Add a `setDab` ablation
first and confirm before changing anything.** The new crack network is good; leave it.

**2. Real light pools on the night street, and lift the black point.**
*Owner: lighting + render.* `night_neon` is 8.66% pure black and getting worse each pass;
15 dynamic lights for ~2,300 lamp props; one wall-pack already pools correctly on brick,
so this is coverage, not capability. A projected pool decal per lamp is the cheap
version. Transforms `night_neon` and `st_seaport` together.

**3. Make the wet road actually reflect, or turn SSR off and save the frame time.**
*Owner: render.* Measured: SSR moves the carriageway by +1.47/255 against a 3.46/255
noise floor, with the brief's own median of 0. Judgement: no reflection of anything, no
puddles, and wet currently *reduces* contrast (MAD 12.9 vs 28.1 dry) when it should raise
it. Puddle geometry with a flat normal would buy more than the SSR pass currently does.
**Also fix the instrument: `freeze()` does not stop the rain**, which is why this is hard
to measure at all.

**4. Rebuild the rain streaks.** *Owner: atmosphere / weather.* Depth-varied length,
size and opacity; stop them drawing over the sky and distant geometry at full strength;
more than one angle. Currently the worst single element in the build and an automatic
fail for three passes.

**5. Car paint texture and silhouette, and give the fleet colour.** *Owner: vehicles,
with materials.* The clearcoat work is done and verified — do not spend there. What is
left: every parked car at `street_level`, `st_southend` and `st_backbay` is white, silver
or grey; the two foreground vans at `street_level` are flat white slabs with black
rectangle windscreens; wheel arches are visibly octagonal.

**Then, in order:** 6. Landmark silhouettes — the Prudential's crown and the Hancock's
parallelogram, and heights nearer 228 m and 240 m rather than 176 and 151. 7. The Zakim
mast pincushion (AF-6). 8. Give `overcast_wide` a real black point. 9. Any texture at all
on roof decks — 30–40% of every elevated frame. 10. Shade the water. 11. Re-author
`golden_hour` (four passes inside a wall) and `rain_street` (three passes off the
carriageway). 12. Glass in windows — reveal depth and a sill shadow. 13. Brick at real
scale; it is ~3× oversized. 14. Tree canopy and trunk materials.

**Not worth doing: perf.** *Measured, agreeing bursts.* `hero_skyline` 3.4 ms,
`st_beaconhill` 5.1 ms at 1920×1080 `high`. Every budget met. **One thing to watch:
all-pass triangles at `street_level` are 3.33 M against 3.5 M — 95% of budget.**

---

## 10. For the record — what I could not test

- **No real rAF frame rate.** `document.hidden` was true for this pane throughout and
  `measureFps()` refuses by design. All timings are synchronous `step(1/60)` forced to
  GPU completion. The drawing buffer was a genuine 1920×1080 and `readPixels` returned
  real data, so the pixel work is sound.
- **The `dab` attribution is judgement, not measurement.** There is no uniform for it.
  What is measured is that the defect is neither the cracks nor the detail pass.
- **The Zakim masts could not be located in the scene graph** — they are likely instanced
  under a chunk whose origin lies outside my search box.
- **Rain could not be frozen**, so every wet-road number sits on a 23.7% floor.
- **Motion.** All judgement is on frozen frames. Nobody has yet seen this build move.
- **`st_northend`, `st_seaport`, `st_backbay` and `downtown_dusk`** were not re-shot; the
  budget went to the six changes and the crack investigation.

---

`OVERALL: 6/10 — KEEP WORKING`
