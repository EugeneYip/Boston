# Visual critic report — BOSTON

| | |
|---|---|
| **Commit measured** | `4704bc3` — working tree clean at the start **and at the end**, verified by `git status --porcelain` both times. **One build throughout.** |
| **Resolution / preset** | 1920×1080 drawing buffer (`drawingBufferWidth/Height` confirmed), preset `high`, `pixelRatio` 1.5 |
| **Captures** | ~25 deterministic `capture()` calls across **11 named shots**, plus a 7-state wetness toggle, a 4-state shadow A/B, a road diffuse ablation and a `uDetail` ablation |
| **Boot** | `bootReport.failed` `[]`, `errors` `0`, `glFaults` `[]`, `validate().ok` true — at the start and at the end |
| **Verdict** | **OVERALL: 5/10 — KEEP WORKING** (held from 5; was 4, before that 3) |

Every finding below is labelled **measured** (a number I produced this session, method
stated) or **judgement** (my eye on a magnified readback).

**Three of the four changes verify, one over-delivers against its own commit message,
and the score does not move — because none of them changes a blind-test outcome on any
shot, and looking closer surfaced two defects nobody has filed yet.**

---

## 0. Instruments — what is trustworthy now, and one new trap

*Measured.* `capture()` returns `timeScale: 0` and the freeze holds. On a parked
`st_southend` camera with the exposure meter pinned, a 600×220 px carriageway patch read
**119.95 / 119.95 / 119.96 / 119.95** across four separate toggle round-trips — a drift
of **0.008%**. Whole-frame mean drifted 105.91 → 106.95 over 24 frames (**0.98%**),
slightly more than the 0.46% claimed but immaterial. Cross-capture comparison is valid.
This is the single biggest instrument improvement this project has had.

**New trap, and it bit me: `freeze(true)` does not freeze traffic.** The clock, the sun
and the exposure are pinned, but `step()` still advances vehicles. Two frames taken 25
steps apart at `st_southend` differed because a moving car had driven out of the middle
of the frame. Anything measured on a screen rect must either be taken within a few steps
of its pair, or restricted to pixels a car cannot enter. Add this to the ablation recipe
next to `freeze(true)`.

*Measured.* Per-pixel A/B is worthless without an A/A control. At `st_beaconhill` the
same-mode noise floor over 8×8 blocks is **9.2%** of blocks; at `night_neon` it is
**33.2%**, because neon, traffic and foliage animate. Every A/B in §4 is quoted against
its own floor.

*Measured.* `bench` discard rule confirmed: first bench after a capture 4.7 ms, settled
4.4 ms — smaller than the ~16 ms the brief warns about, but the ordering holds.

---

## 1. `e09b2e1` — per-class road albedo — **RIGHT ANSWER, WRONG EXPLANATION**

### 1.1 The tile identification is correct. I reproduced it exactly.

*Measured.* I read `road_atlas.alb` (1024², sRGB, `flipY false`) back to the CPU and
computed each memory quadrant's mean **linear** RGB per texel, then did the same on the
four standalone tile textures:

| memory quadrant | mean linear RGB | luma | matches standalone |
|---|---|---:|---|
| x 0–511, y 0–511 | 0.1079 0.1071 0.1181 | **0.1080** | `asphalt.alb` — exact |
| x 512–1023, y 0–511 | 0.2866 0.2675 0.2249 | **0.2685** | `sidewalk.alb` — exact |
| x 0–511, y 512–1023 | 0.3021 0.1114 0.0676 | **0.1488** | `sidewalk_brick.alb` — exact |
| x 512–1023, y 512–1023 | 0.2073 0.1855 0.1703 | **0.1890** | `cobblestone.alb` — exact |

The commit's four means are right, my predecessor's four were wrong, and the giveaway
argument is sound: 0.3021 : 0.1114 : 0.0676 is 4.5 : 1.6 : 1 red. That is brick, not
asphalt. **The commit was right to refuse the uniform 9.0.**

I also re-derived every number in the commit's table by hand from `C0 × GAIN ×
tileLinearRGB` under Rec.709 luma, and they reproduce to four figures: asphalt
**0.10788**, gutter **0.09088**, granite kerb face **0.23876** (it samples the *concrete*
tile, not the granite one), brick walk **0.24437**. The counterfactuals reproduce too —
at a uniform 9.0, asphalt **0.0925**, concrete **0.7843**, setts **0.2831**. The
adjudication is correct in every particular.

### 1.2 The *reason* given for the trap is inverted, and the source comment will
re-introduce the bug.

*Measured, from source and from the readback.* `bakeAlbedo` does flip
(`src = (h-1-y)*w`, so painted row 0 lands at v = 1) — but `ATLAS_TILES` **already
compensates for it**: asphalt is blitted at painted `oy = 512` precisely so that it comes
out in memory rows 0–511, i.e. at uv v 0–0.5, which is `T_ASPHALT`. Memory order and tile
order therefore **agree**, and my table above is a straight memory-order read that lands
on the right answer.

What actually misled the previous pass was reading the `ATLAS_TILES` *painted-space*
offsets as if they were memory offsets. Do that and you get asphalt → 0.1488, concrete →
0.1890, brick → 0.1080, cobble → 0.2685 — **exactly** the previous report's permutation.

So `Roads.js:52–57` — *"the quadrant that looks like tile 0 in memory is tile 2… a tile
identified by its memory order alone pairs asphalt with 0.1488"* — states the opposite of
the truth. The next agent who trusts it will apply a flip that is not needed and put the
error back. **The sentence to keep is the one after it: read the RGB column.** Fix the
comment, keep the numbers. *Owner: roads.*

### 1.3 What it bought, measured

*Measured*, `st_southend` 11:12, frozen, meter pinned, 600×220 px carriageway:

| | gain 3.0 (prev pass) | gain 9.0 (prev pass) | **shipped per-class** |
|---|---:|---:|---:|
| carriageway mean | 100.1 | 131.9 | **120.1** |
| carriageway MAD | 10.59 | 16.49 | **18.96** |
| road-to-brick flatness | 5.3× | 3.4× (projected) | **2.0×** (brick facade MAD 37.87) |
| non-albedo fraction | 73% | 55% (projected) | **55.3%** |

*Measured*, `uDetail` ablation in one frame: detail off → mean 137.66 / MAD 10.24;
detail on → 120.09 / 18.96. The procedural pass adds **85% more variance** and darkens
13%. It is doing real work.

### 1.4 Two things the per-class table got wrong, and one it cannot fix

**(a) The brick walk is tuned on luma and is the wrong colour.** *Measured + judgement.*
`brick` lands at luma 0.2443, inside the 0.20–0.30 band — but its linear RGB is
**[0.710, 0.125, 0.058]**. A red channel of 0.71 is roughly 2.4× real red brick and is
close to a saturated paint. At `st_beaconhill` the brick sidewalk reads as **hot orange
terracotta**, like a running track, not Boston pavers. Tune the chroma, not just the luma.

**(b) 55.3% of the carriageway's luminance is still not albedo.** *Measured*, by zeroing
`road.color` in one frozen frame: 120.09 → 66.40. More than half the brightness of a
0.108-albedo surface arrives from somewhere other than its albedo. **This is not fixable
with more gain — the gain is now correct.** The ambient/IBL floor on horizontal surfaces
is too high, and it is why the midday carriageway reads pale and chalky rather than
charcoal. *Owner: lighting + render, not roads.*

**(c) The higher albedo made the crack motif worse, not better.** *Judgement, 2.1× on the
readback at `st_beaconhill` and `st_southend`.* The previous pass predicted "at gain 9 the
same geometry reads considerably better." **It does not.** The cracks are wide, soft-edged,
low-contrast grey-brown curves — long lazy S-bends and loops with rounded ends that wander
across lane lines. Raising the surface around them without changing them made them *more*
prominent. At street magnification they are the single loudest tell in every daylight shot
and they read as **drawn on with a soft marker**. The good news from the same crops: there
is now a genuine fine aggregate speckle between them, which was missing before.

**Verdict: the reasoning holds, the numbers hold, the comment explaining it does not, and
the crack art is now the binding limit on the road.**

---

## 2. The wet response — **BETTER THAN THE COMMIT CLAIMS. It is basically done.**

*Measured*, and this is the most reproducible number in the report. `st_southend` 11:12,
frozen, meter pinned, `Weather.update` stubbed so it cannot re-drive the state, toggling
**only** wetness — both halves of it, `assets.setWetness(v)` *and* the road shader's
`setWet(v)`, which is what the game does in rain — on a car-free 600×220 px neutral
carriageway patch (RGB 121.9 / 118.9 / 124.3):

| state | patch mean |
|---|---:|
| dry | 119.95, 119.95, 119.96, 119.95 |
| wet 0.90 (`rain`) | 83.76, 83.77 |
| wet 1.00 (`storm`) | 79.50 |

**wet/dry = 0.698 at rain, 0.663 at storm.** Reversible four times over with 0.008% drift.
Over the *whole* road-material mask (866k px, built by toggling `material.visible`) it is
0.740; near-road only, 0.713.

The commit's own claim of **0.925 understates what it shipped.** 0.698 is *inside* the
real 0.5–0.7 wet-asphalt band, at its top edge. Whoever measured 0.925 was almost
certainly driving one half of the response and not the other.

**How much further does it need to go? On darkening: essentially none.** Ask for
0.62–0.66 if you want to be strict, and that is a tweak, not a job. **What is still
missing is the other half of "wet", and it is not a darkening problem:**

*Measured.* Wetting the road **reduces** its contrast — MAD 18.96 → 15.30, p05/p90
81.9/148.9 → 55.0/108.3. A real wet street *gains* contrast: near-black asphalt plus
bright specular puddles and a mirrored streetscape. Right now wet = uniformly darker and
flatter. And *measured*: **SSR is not in the composer's pass chain at all** (see §5), so
there is nothing to reflect with.

### `rain_street` — **AUTOMATIC FAIL, restated and worse than described**

*Measured.* 15:12, rain, wetness 0.90, road colour 0.478, roughness 0.326, 722 draws.
Frame mean 58.6, p50 51.1, **1.70% of pixels below luminance 2**.

*Judgement, 2.3× on the readback.* The streaks are long white spindles at **one angle, one
length and one opacity**, drawn at full strength over the sky, the facades and the parked
car's roof alike, with no depth attenuation and no near/far layering. Magnified, several
show **flat ends and straight parallel sides** — they are quads, not drops. Behind them
the tree canopy is a mass of hard-edged dark polygons with pale speckle.

*Judgement.* The shot itself still cannot carry a rain verdict: the camera is on a
pavement, the carriageway is a sliver behind a parked car, and the pavement — in rain,
at wetness 0.9 — shows **no puddles, no standing water and no reflection of the lamp post
two metres in front of it**. I had to re-frame rain onto `st_southend` to measure §2 at
all, for the second pass running.

### `night_neon` — **AUTOMATIC FAIL: 7.83% pure black**

*Measured.* 22:00, mean 41.18, p05 0.9, **7.83% of the frame below luminance 2** (was
7.09%), 0.099% clipped. **Exactly 15 dynamic lights** — 10 point, 5 spot, 3 directional —
for ~2,300 lamp props, unchanged for three passes. The near-road horizontal luminance
profile across the full 1920 px reads 18.8 … 66.6 with a single 101.1 headlight spike and
**no periodic structure whatsoever**.

*Judgement.* The lamps recede down the street as bright points and the asphalt under every
one of them is the same flat blue. A wall-pack luminaire on the right *does* pool
correctly on the brick above it — proving the machinery exists — while the road below has
nothing. The parked cars read as unlit pale-grey polystyrene blocks, brighter than
anything around them; the near car is a black slab with a floating black wheel. And the
crack worms, on an otherwise featureless dark road, are the most legible thing in the
frame.

---

## 3. `3e0ca10` — car clearcoat — **PLUMBING VERIFIED PERFECT, READ STILL NOT PAINT**

### 3.1 The attribute claim is exactly true

*Measured*, walking every geometry in the scene carrying `aSurf`:

| | |
|---|---:|
| meshes with `aSurf` | 195 |
| vertices | 662,501 |
| `aSurf.z == 0` | **615,797** |
| `aSurf.z == 1` | **46,704** (7.05%) |
| distinct `aSurf.z` values | **exactly two: 0.000 and 1.000** |
| distinct tuples among the non-zero | **exactly one: (0.34, 0.05, 1.00, 1.25)** = `SURF.carPaint` |

Binary, single-valued, no leakage. `prop_surf` is a `MeshPhysicalMaterial` with
`clearcoat 1.0 / clearcoatRoughness 0.06` as ceilings and `envMap` present.

### 3.2 Bins, benches and bollards are genuinely unchanged — measured, not assumed

*Measured*, A/B against its own A/A floor at `st_southend`, toggling `prop_surf.clearcoat`
1 → 0:

| region | A/A noise floor | A/B with clearcoat off |
|---|---|---|
| right pavement (bins, benches, bollards, meters, signs) | 20.08% of px, mean \|Δ\| **7.11** | 20.69%, mean \|Δ\| **8.48** |
| parked cars | 0.47% of px, mean \|Δ\| **0.37** | **29.81%**, mean \|Δ\| **10.34**, max 359 |

The pavement sits **at its own noise floor** (that floor is 20% because pedestrians and
foliage animate there). The cars are 63× above theirs. Nothing but car paint moved.

### 3.3 The effect is real and physically shaped

*Measured*, per pixel over a 420×240 car region: clearcoat ON makes **5,470 px brighter**
(peak +145/255) and **14,083 px darker** (peak −146), against a 0.47% noise floor. That is
exactly the right shape — an energy-conserving layer that adds a tight specular lobe and
attenuates the base beneath it. On the flank alone it is a net −5.9%.

### 3.4 Does it read as painted metal? **Halfway. No.**

*Judgement, 3.5–3.8× on the readback, `st_southend` in direct 11:12 sun.* What is new and
genuinely better: the greenhouse now reads as **dark tinted glass with a reflected sky**,
there is a **sheen along the roofline and a shoulder crease highlight**, door handles are
present, and the red car in the foreground carries a clean bright rim along its wheel-arch
crease. That is a real improvement over "unglazed clay."

What still gives it away, in order:

1. **A heavy vertical streak-and-grain overlay sits on top of the paint.** At 3.8× the
   flank is covered in smeared vertical noise that reads as brushed metal or a badly
   mipped dirt map, not as a panel. This is now the loudest thing about the car and it
   defeats the lacquer underneath it.
2. **No legible environment reflection.** A 0.06-roughness clearcoat on a vertical panel
   should carry a compressed image of the buildings opposite and a horizon line. There is
   none — only a broad sheen. The lobe is there; there is nothing sharp in the probe for
   it to reflect.
3. **The silhouette is visibly faceted** — octagonal wheel arches, hard polygon breaks at
   the roof-to-glass transition, a flat chamfered skirt.
4. **The fleet is monochrome.** At `st_backbay` and `street_level` every parked car is
   white, silver or grey. At `street_level` the nearest van is a flat white slab with a
   black rectangle for a windscreen — the single most damaging object in that frame.
5. Chrome hubs clip to 255 with heavy colour fringing (see §5).

**Verdict: the commit did exactly what it said, verified at the attribute, the pixel and
the draw-call level. It is not the thing standing between these cars and GTA V. The
geometry and the paint texture are.**

---

## 4. `d925cc1` — shadow cascade culling — **BUDGETS MET. QUALITY CLAIM HOLDS 3/4,
BADLY UNDERSTATED ON THE 4TH.**

### 4.1 Budgets — verified, independently, with the drain

*Measured.* `shadowMap.autoUpdate = false`, drain 4 frames, record camera-only over 6;
re-enable, drain 6, record over **28 settled frames**. Splits 26.4 / 93.5 / 380 m; texels
**0.029 / 0.103 / 0.559 m**; 2048² maps, 3 cascades.

| shot | camera tris | camera draws | **shadow peak** | **shadow mean** | all-pass draws | budget |
|---|---:|---:|---:|---:|---:|---|
| `night_neon` | 2,500,633 | 358 | **2,305,708** ✅ | 2,124,760 | 642–653 | 2.5 M |
| `st_beaconhill` | 1,805,554 | 318 | **1,761,176** ✅ | 1,597,611 | 586–589 | 2.5 M |
| `st_backbay` | 1,691,297 | 485 | **1,350,079** ✅ | 1,343,234 | 948–**955** | 2.5 M |

**Every budget is met.** Camera tris ≤ 2.50 M against 3.5 M; peak draws 955 against 1200;
settled frame 4.4–5.8 ms against 16.7 ms. The commit's `st_beaconhill` figures (1.75 M /
1.59 M) reproduce almost exactly; its `night_neon` peak (2.22 M) reads **2.31 M** here —
4% higher, still comfortably inside. The distribution is bimodal as warned (~1.94–1.97 M
and ~2.28–2.31 M at `night_neon`), so quote both numbers.

One correction to the commit: **"all-pass draws down to 597–667" is shot-specific.**
`st_backbay` is at 948–955, up from the previous pass's 829. Inside budget, but not down.

### 4.2 Quality — I ran a true A/B inside this one build

I could not check out the old tree (no writing git commands), so I emulated the old
behaviour at runtime: neutralised `onBeforeShadow`/`onAfterShadow` on the 5 LOD-0 chunk
meshes so they cast into every cascade again, left the 54 shell meshes masked, forced
`_dirty` and re-rendered. Composited frames compared as 8×8 block means, each against its
own same-mode A/A floor.

| shot | A/A noise floor | **A/B** | mean \|Δ\| floor → A/B | direction |
|---|---:|---:|---|---|
| `st_beaconhill` | 9.204% | **9.318%** | 0.625 → 0.674 | balanced (1592 darker / 1427 brighter) |
| `hero_skyline` | 14.034% | **14.247%** | 0.580 → 0.586 | balanced (2234 / 2382) |
| `night_neon` | 33.167% | **33.383%** | 0.885 → 0.885 | balanced (5454 / 5362) |
| **`golden_hour`** | 7.710% | **36.833%** | 0.386 → **1.706** | **11,509 darker / 425 brighter** |

Three of four are **at the noise floor** — the claim holds and I could not find a
degradation. `golden_hour` is **4.8× its floor on 36.8% of blocks**, not the "0.9% of
blocks confined to one 24 px column" the commit reports. That is roughly **40× more of the
frame than claimed.**

The *direction* the commit gives is right — 96% of changed blocks are darker with the new
code, consistent with the light-leak-through-window-holes story, and I found no case
anywhere of the new frame losing a shadow. So the conclusion "nothing was lost, a leak was
closed" survives. **The magnitude claim does not.** A change that moves a third of a frame
is a visual change, and it should have been reported as one.

### 4.3 Cascade transitions, contact shadows, bays and areaways — judgement

- **No cascade seam.** *Judgement, `st_beaconhill` 16:00 and `st_backbay` 09:36.* Shadow
  softness and darkness are continuous down the street through both the 26.4 m and the
  93.5 m splits. I looked specifically for a horizontal band and there is none. The
  row-profile of the A/B difference is flat across the split too. **Claim holds.**
- **Dappled tree shadow at `street_level` is the best-looking thing in the build** —
  soft-edged leaf shapes with real variation across the pavement slabs. Whatever else is
  wrong, the near cascades are good.
- **Contact shadows are effectively absent, and the cascades are not why.** *Judgement +
  measured.* Cars, bollards, bins and pedestrians meet the ground with a broad soft
  shadow and **no dark contact line**; the wheel of a parked car at `st_backbay` reads as
  hovering. The cause is §5: **there is no AO pass in the pipeline.** Not a regression
  from this commit — but it is the reason the shadow work does not read as an improvement.
- **Bays and areaways:** I could not find a framing in which either is legible from the
  street, in shadow or in light. 2,529 bays, 1,894 bows and 4,544 areaways exist in the
  data and none of them reads. That is a buildings problem, not a shadow one, and it is
  the same finding as last pass.

---

## 5. New this pass — two defects nobody has filed

### 5.1 AO and SSR report `enabled: true` and are not in the pipeline

*Measured.* At preset `high` the composer's pass list is, in full:

```
FrameStatePass · RenderPass · atmosphere · AutoExposurePass · LensPass
FX[LensComposite+Exposure+ToneMapping+Grade] · FX[SMAA] · FX[LensFinal+FilmGrain]
```

There is **no AO pass and no SSR pass**. Yet `rp.ao.enabled` is `true` and
`rp.ssr.enabled` is `true`. Setting both to `false` and re-rendering changes the frame by
less than its own A/A noise floor. `rp._aoOn` and `rp._ssrOn` are both `false`.

This explains three separate things three separate passes have reported as mysteries:
"AO contributes 0.00", "SSR contributes 0.00", and "there are no contact shadows." Two of
the highest-value effects in the build are **already written and simply not running.**
*Owner: render.* Either wire them in or stop reporting them enabled — right now the
instrument lies.

### 5.2 Chromatic aberration is destroying thin geometry — **AUTOMATIC FAIL**

*Judgement, 2.7× on the readback at `bridge`, and confirmed at `street_level`,
`golden_hour` and on car body creases.* Every thin high-contrast element carries a strong
magenta core with cyan and orange fringes. On the Zakim the vertical light columns render
as **rainbow bars** and the stay cables **break into a dashed line of coloured dots** —
at 1080p the bridge reads as a broken technical drawing. At `street_level` the tree canopy
and building edges on the left are visibly red/cyan split. On the red car's wheel arch the
body crease is fringed magenta.

Two faults compound here: the aberration strength is far too high for a 1080p frame, and
sub-pixel geometry gets no line AA (SMAA alone cannot save a 1 px cable). *Owner: render,
with city/landmarks for the cable geometry.*

---

## 6. Automatic fails

**Standing:**

- **AF-1 `night_neon` — 7.83% of the frame below luminance 2.** *Measured.* Crushed
  blacks with no detail, up from 7.09%.
- **AF-2 Rain streaks are opaque screen-space quads.** *Judgement, magnified.* One angle,
  one length, one opacity, drawn over sky and geometry alike, with visibly flat ends.
- **AF-3 The harbour is an unshaded plane.** *Measured + judgement.* ~55% of `bridge` at
  min 22.2, one flat sheet — no waves, no normal, no reflection, no sun glitter, no
  shoreline. `hero_skyline` and `overcast_wide` the same.
- **AF-4 `overcast_wide` has no black point and no white point.** *Measured.* p05 **73.8**,
  p50 117.3, p90 **163.4**, min 56.0, max 210.8, **0.00% clipped, 0.00% black**. Three
  passes running, unchanged to within a value: 74/117/163 → 73.1/116.4/162.7 → 73.8/117.3/163.4.
  City, river and sky resolve to one blue-grey.
- **AF-5 (new) Chromatic aberration on thin geometry.** §5.2.
- **AF-6 `golden_hour` is still jammed against a brick wall.** *Judgement.* Third pass
  running. The shot cannot be judged, and it is the one shot the shadow commit needed a
  critic to adjudicate.

**Cleared / not found this pass:** no z-fighting, no shadow acne, no visible texture
tiling, no floating or sunk objects, no empty streets, **zero console errors, zero GL
faults**, and — for the first time — **no budget breach anywhere**. `AF-7` (shadow
triangles) from the last report is **closed**.

---

## 7. Shot-by-shot

```
SHOT: st_beaconhill    VERDICT: FAIL   (16:00 clear, 318 cam draws / 589 all-pass, shadow 1.76M)
Scores: silhouette 6, material 5, lighting 5, atmosphere 6, grade 5, density 7,
        geometry 6, boston 7   → 6/10   ** best daylight street **
Brick rows, fire escapes, green awnings, wrought-iron rails, crosswalk, real pedestrians,
aggregate speckle in the asphalt. Gives it away: (1) the crack worms, now louder at the
higher albedo; (2) the brick sidewalk is hot orange terracotta at 4x life size; (3) a flat
black manhole disc mid-carriageway and no contact shadow under anything.

SHOT: st_backbay       VERDICT: FAIL   (09:36 clear, 485 cam draws / 955 all-pass, 5.8 ms)
Scores: 5 / 4 / 5 / 6 / 5 / 7 / 5 / 6   → 5/10
Red bike lane, street trees both sides, dappled shadow, brick facades. Every parked car is
a pale faceted lump; a wheel at bottom-right reads as hovering; the vanishing point blows
to white.

SHOT: st_southend      VERDICT: FAIL   (11:12 clear, 41.8% road material, 5.3 ms)
Scores: 5 / 5 / 5 / 5 / 5 / 6 / 6 / 6   → 5/10
The reference shot for the road work, and the road is genuinely better: mean 120.1,
MAD 18.96, flatness 2.0x brick. Undone by the cracks and by 55.3% non-albedo luminance.

SHOT: street_level     VERDICT: FAIL   (09:30, 543 draws, 2.08% clipped, 4.4 ms)
Scores: 6 / 4 / 6 / 6 / 4 / 7 / 5 / 7   → 5/10
Best shadows in the build — real dappled leaf shadow on pavement slabs, stoops, iron rails,
granite kerb. Ruined by a foreground white-slab van with a black rectangle windscreen,
a blown-white sky through the canopy, and heavy CA on the left edge.

SHOT: downtown_dusk    VERDICT: FAIL   (19:24, 179 draws, 0.005% clipped)
Scores: 4 / 4 / 6 / 7 / 6 / 5 / 5 / 5   → 5/10
The sky is the best thing in the project — pink cumulus with structure, a real sun disc, a
glitter path. Underneath, every tower ends in a flat parapet over a flat untextured roof
deck, the lit-window grid is perfectly regular, and the facade tone barely varies.

SHOT: night_neon       VERDICT: FAIL   (22:00, 668 draws, 7.83% black, shadow 2.31M ✅)
Scores: 4 / 4 / 4 / 5 / 4 / 6 / 5 / 5   → 4/10
Budget finally met. One wall-pack pools correctly on brick, proving the machinery works;
the road under 2,300 lamps has zero periodic structure. Cars are unlit polystyrene.

SHOT: hero_skyline     VERDICT: FAIL   (17:48, 256 draws, 0.00% clipped)
Scores: 4 / 4 / 6 / 7 / 6 / 5 / 5 / 5   → 5/10
Haze depth good, clouds good. Flat parapets, flat water.

SHOT: bridge           VERDICT: FAIL   (08:12, 90 draws, 0.053% clipped)
Scores: 4 / 2 / 5 / 6 / 4 / 3 / 3 / 5   → 4/10
55% flat unshaded water. The Zakim's cables alias into a dashed rainbow line and its light
columns render as magenta/cyan bars — the frame reads as a broken drawing.

SHOT: overcast_wide    VERDICT: FAIL   (13:00 overcast, 352 draws, 2.9 ms)
Scores: 3 / 2 / 3 / 4 / 2 / 4 / 5 / 4   → 3/10   ** worst usable shot **
p05 73.8 / p90 163.4, 0.00% clipped, 0.00% black, unchanged over three passes. Also the
clearest view of the massing failure: downtown is a mesa of identical flat-topped boxes and
Back Bay is a flat carpet where the two tallest buildings in Boston stand.

SHOT: rain_street      VERDICT: FAIL   (15:12 rain, 722 draws, 1.70% black)
Scores: 3 / 3 / 4 / 4 / 3 / 5 / 3 / 4   → 3/10
Opaque quad streaks over everything; a pavement in heavy rain with no puddle and no
reflection; still not framed on a carriageway.

SHOT: golden_hour      VERDICT: FAIL   (06:36)
Scores: 3 / 3 / 4 / 4 / 4 / 3 / 4 / 4   → 3/10
Camera inside a wall, third pass running. Usefully it shows brick at 4-8x life size and
windows as flat decals with no glass, no reveal and no sill shadow.
```

### Rubric scores, whole build

| # | Axis | Prev | **Now** | Basis |
|---|---|---:|---:|---|
| 1 | Silhouette & massing | 5 | **5** | Height histogram **byte-identical for a third pass** (8384 / 1424 / 128 / 183 / 66 / 6 / 0), max 162.5 m, Back Bay ceiling 33.6 m, every tower a flat parapet |
| 2 | Material truth | 4 | **5** | Road albedo now physically correct per class, wet/dry 0.698 in band, clearcoat live and binary — against 55.3% non-albedo road, terracotta brick walk, matte faceted cars, no AO, no SSR, flat water, flat roof decks |
| 3 | Lighting | 5 | **5** | 15 dynamic lights unchanged, zero lamp pools, no AO pass so no contact darkening — but the near-cascade dappled shadow is genuinely good |
| 4 | Atmosphere & depth | 6 | **6** | `downtown_dusk` sky is the build's best asset; haze depth good; overcast still one grey; water flat |
| 5 | Composition & grade | 5 | **4** | **Down.** Chromatic aberration fringes every thin edge in the build; `night_neon` 7.83% black; `street_level` 2.08% clipped; `golden_hour` unusable |
| 6 | Density & life | 6 | **6** | Unchanged and still a strength: props, kerbs, stoops, awnings, fire escapes, bike lane, signals, trees |
| 7 | Geometric fidelity | 6 | **5** | **Down.** No z-fighting, no tiling, no floaters — but rain streaks are quads, cables alias to dots, car silhouettes are visibly faceted, tree canopies are hard polygon masses |
| 8 | Boston authenticity | 6 | **6** | Rowhouse streets, stoops, bike lane, Zakim, Bunker Hill, real grid — Back Bay flat, brick 4× oversized and the wrong red |

**Direction of travel: the instruments are finally trustworthy and the physics is finally
right, and the frame did not move.** All four changes under review are real; three verify
completely and one over-delivers. But the previous pass's four highest-ranked items closed
without a single blind test flipping, because what actually gives these frames away is
one layer up from the physics: the crack art, the car geometry, the missing AO and SSR
passes, and an aberration pass that is eating the thin geometry. **5/10, held.**

---

## 8. Ranked fixes

Ranked by (fraction of pixels affected) × (severity of the tell) ÷ (work).

**1. Rework the crack motif, and cut the road's ambient floor.** *Owner: roads, with
lighting + render.* 42% of every street frame. Two things, one surface. (a) The cracks
must be **thin, near-black, high-contrast, made of straight segments meeting at angles,
clustered at joints, edges and wheel paths** — not soft wide wandering curves. They are
now the loudest tell in every daylight and night street shot, and the albedo fix made them
worse. (b) **55.3% of the carriageway's rendered luminance is not albedo** (measured, by
zeroing the diffuse colour in one frozen frame). The gain is correct now; the ambient/IBL
floor on horizontal surfaces is what makes a 0.108-albedo road read chalky. Also fix the
brick walk's chroma — luma 0.244 is right, linear red 0.710 is not.

**2. Put AO and SSR back in the pass chain.** *Owner: render.* Both objects report
`enabled: true`; neither appears in the composer's pass list; toggling them changes nothing
beyond the noise floor. This is the cheapest big win on the board — the code exists.
AO buys the contact darkening whose absence I filed under three separate headings this
pass; SSR buys the wet-road reflection that is the only thing still missing from an
otherwise-finished wet response.

**3. Real light pools on the night street.** *Owner: lighting + render.* 15 dynamic lights
for ~2,300 lamp props; the measured near-road profile has no periodic structure at all;
unchanged for three passes. One wall-pack in `night_neon` already pools correctly on brick,
so this is a coverage problem, not a capability problem. A projected pool decal per lamp is
the cheap version. Transforms `night_neon` and `st_seaport` together.

**4. Car geometry and paint texture — not more clearcoat.** *Owner: props / vehicles, with
materials.* The clearcoat commit is done and verified; do not spend more there. What is
left: kill or greatly soften the vertical streak/grain overlay on the paint, smooth the
faceted wheel arches and roof breaks, and give the parked fleet colour — every car in
`st_backbay` and `street_level` is white, silver or grey, and the nearest one in
`street_level` is a flat white slab with a black rectangle for a windscreen.

**5. Skyline upper register, Back Bay towers, roof-deck material.** *Owner: buildings /
city.* The height histogram is byte-identical for a third consecutive pass. Nothing
procedural exceeds 162.5 m, the 165–225 m register is empty, the 40–60 m band has 128
buildings, and Back Bay tops out at 33.6 m across 2,499 buildings under the site of the
city's two tallest. Cheapest third of this: put **any** texture on the roof decks, which
are 30–40% of every elevated frame and are currently one flat tone each.

**Then, in order:** 6. Rebuild the rain streaks with depth-varied size and opacity, and
stop them drawing over the sky at full strength. 7. Halve the chromatic aberration and give
thin geometry line AA. 8. Give `overcast_wide` a real black point. 9. Shade the water.
10. Re-author `golden_hour` (three passes inside a wall) and `rain_street` (two passes off
the carriageway). 11. Make one bay and one areaway legible from a street camera, out of the
2,529 and 4,544 that exist. 12. Pedestrian and tree-trunk materials.

**Not worth doing: perf.** *Measured.* Settled median frame at 1920×1080 `high` is
**4.4–5.8 ms** against 16.7 ms. Shadow triangles peak 2.31 M / 1.76 M / 1.35 M against
2.5 M. Camera triangles ≤ 2.50 M against 3.5 M. Peak all-pass draws 955 against 1200.
**Every budget in ARCHITECTURE.md is met.** Do not spend another pass here.

---

## 9. For the record — what I could not test

- **No real rAF frame rate.** `document.hidden` is `true` for this pane and
  `measureFps()` refuses. Every timing is a synchronous `step(1/60)` forced to GPU
  completion with `gl.finish()`.
- **No cross-build A/B for the shadow change.** I could not check out the parent commit
  (no writing git commands), so §4.2 emulates the old behaviour at runtime by neutralising
  the `onBeforeShadow`/`onAfterShadow` hooks on the 5 chunk meshes and leaving the 54
  shells masked. I believe that is faithful — it is the exact pair the commit added — but
  it is an emulation, not the old binary.
- **Motion.** All judgement is on frozen frames. Nobody has yet seen this build move.
- **`st_seaport` and `st_northend`** were measured in the previous pass but not re-shot
  here; I spent the budget on the four changes under review.

---

`OVERALL: 5/10 — KEEP WORKING`
