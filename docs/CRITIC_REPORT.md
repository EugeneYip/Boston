# Visual critic report — BOSTON

| | |
|---|---|
| **Commit measured** | `e86a6e3` — working tree clean at the start **and at the end** of the session, **one build throughout** |
| **Resolution / preset** | 1920×1080 drawing buffer, preset `high`, `pixelRatio` 1.5 on a 1280×720 canvas |
| **Captures** | ~30 deterministic `capture()` calls — 11 named shots, 2 custom framings (rooftop, rain-on-road), plus 8-point albedo and 5-point wetness ablation sweeps |
| **Boot** | `bootReport.failed` `[]`, `errors` `[]`, `glFaults` `[]` at the end of the session; `validate().ok` true |
| **Verdict** | **OVERALL: 5/10 — KEEP WORKING** (was 4/10, before that 3/10) |

Everything below is either **measured** (a number I produced this session, with the
method stated) or **judgement** (my eye on a frame). Each finding says which.

**The skin is going on. It went on at a third of the thickness it needed, on one
surface, and the wet response is still the wrong sign.**

---

## 0. Methodology — one instrument fix that changes how everything gets measured

The three instruments the brief says were repaired **are** repaired, and I sanity-checked
each. But I found a fourth problem, and fixing it removes the constraint the brief
describes as unavoidable.

**`capture()` leaves `timeScale` at 40.** The brief says "absolute luminance on a fixed
shot drifts 76→99 between captures minutes apart (auto-exposure plus a moving cloud
shadow)", and that any A/B must therefore be toggled in one frame. I reproduced the
drift exactly — camera parked, `timeOfDay` unchanged, exposure meter pinned
(`speedUp = speedDown = 0`), the `st_southend` near carriageway read:

```
100.2  100.2  100.2  97.5  92.4  85.4  82.6  89.8  86.5  84.2      (every 3rd frame)
```

−18% and non-monotonic in 27 frames. `freeze: (on) => { timeScale = on ? 0 : 40 }`,
so 27 synchronous frames are **18 seconds of game time** — the cloud shadow crosses the
street. **Calling `window.__boston.freeze(true)` after `capture()` removes it
completely:**

```
98.67  100.21  100.21  100.21  100.21  100.21  100.21  100.21
```

Every ablation in this report was taken with `freeze(true)` and the meter pinned. That
turns an 18% noise floor into a **0.00** one, and it is why I can report a 0.04 spread
on a control patch across an 8-state sweep. **Add `freeze(true)` to the ablation recipe
in `AGENTS.md`.** Toggling in one frame is still good practice, but it is no longer the
only option.

Sanity checks on the three repaired instruments:

1. **`capture()` settling — works, with one caveat.** `streamed` is reported and
   `settled()` is honoured. `st_southend` came back at 3.58M triangles where the
   previous pass measured a half-built 2.12M. **Caveat:** `settled()` is
   `_catchUp === 0 && _queue.length === 0`, which is also true when Buildings has
   *evicted* chunks. Repeat captures of the same shot returned 3.58M → 2.07M → 2.76M
   triangles with `streamed: 0` each time. I compared the frames directly: the visible
   image is unchanged; the delta is off-screen geometry in the shadow cascades that
   unloads because Buildings streams around the **player** (parked at 166, 3.1, 128)
   rather than the capture camera 560 m away. Harmless for pixels, **not** harmless for
   anyone quoting `capture().tris`.
2. **`Engine.resize()` floor — holding.** `drawingBufferWidth/Height` stayed 1920×1080
   for the whole session with the pane hidden. `readPixels` never came back empty.
   The GPU is alive; report the good news loudly, as asked.
3. **`street_level` / `rain_street` re-authoring — half-successful.** Both are off the
   Common. Neither frames a carriageway. See §2, AF-5.

One trap I set for myself and want on the record: `Assets.setWetness()` **rewrites
`material.color`** from `userData.wetnessColor`. My first wet-vs-dry sweep set
`road.color` after calling it, which silently deleted the albedo-darkening half of the
wet response and produced a wrong answer. The correct handle is
`road.userData.wetnessColor`, applied *before* `setWetness`.

---

## 1. `ALBEDO_GAIN` — the open question the road agent refused to decide

**Verdict: 3.0 is too timid. Ship 9.0. The better answer is to retire the uniform
scalar entirely and normalise per tile — see the table below.**

### 1.1 The commit's own diagnosis is still true at the shipped value

*Measured.* I read the **baked** road atlas (`assets.textures.get('road_atlas.alb')`,
1024², sRGB) back to the CPU and computed each 512² tile's mean **linear** luminance
per pixel:

| atlas tile | mean sRGB | **mean linear** |
|---|---:|---:|
| asphalt | 100.3 | **0.1488** |
| concrete (sidewalk) | 116.0 | **0.1890** |
| brick (sidewalk) | 90.5 | **0.1080** |
| cobble (setts) | 140.0 | **0.2685** |

Effective diffuse albedo is `tint × ALBEDO_GAIN × tileLinear`. At the shipped
`ALBEDO_GAIN = 3.0`:

| surface | **effective linear albedo** | real-world | under by |
|---|---:|---|---:|
| **carriageway asphalt** | **0.0424** | 0.09–0.14 (aged hot-mix) | **2.1–3.3×** |
| gutter | **0.0357** | ~0.07–0.10 | 2.0–2.8× |
| sidewalk **brick** | **0.0442** | 0.20–0.30 | **4.5–6.8×** |
| granite kerb | 0.1260 | 0.20–0.28 | 1.6–2.2× |
| sidewalk concrete | 0.1839 | 0.18–0.30 (dirty urban) | ~1.0–1.6× |
| cobble setts | 0.1339 | 0.15–0.22 | ~1.1–1.6× |
| road paint, white | 0.3342 | 0.55–0.75 fresh / 0.35–0.45 worn | ~1.0–2.2× |

The commit's whole diagnosis was "the carriageway ships below its own dielectric F0 of
0.04, which is physically impossible, so no albedo detail can be visible and
`setWetness` is a no-op." **At 3.0 the carriageway is at 0.0424 — 6% above the F0 it
identified as the impossibility threshold, and the gutter at 0.0357 is still below it.**
The condition the commit named as the root cause has been reduced, not cleared.

(The commit computed the asphalt tile at "89/255 = 0.100 linear". Measured on the baked
atlas it is 100.3/255 = 0.1488. The direction of its argument is right; the arithmetic
that produced "the remaining factor is ~9" was working from a slightly different number.)

### 1.2 The sweep — nothing breaks, all the way up

*Measured.* `road_atlas.color` is white and `vertexColors` is on, so scaling
`material.color` by `k` is an exact `ALBEDO_GAIN = 3k` handle. `st_southend` 11:12,
`freeze(true)`, meter pinned, one frozen frame. Road patch = 560×240 px of paint-free
near carriageway; brick control = 340×300 px of the sunlit right-hand facade.

| ALBEDO_GAIN | eff. albedo | road mean | road MAD@89 | road clip | brick p50 | brick MAD@89 | frame mean | frame clip |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 (no diffuse) | 0 | 72.87 | 10.23 | 0.00% | 104.3 | 56.32 | 93.15 | 0.95% |
| 1 | 0.014 | 83.44 | 8.80 | 0.00% | 104.3 | 56.32 | 96.97 | 0.96% |
| 2 | 0.028 | 92.40 | 9.44 | 0.00% | 104.3 | 56.31 | 100.03 | 0.97% |
| **3 (shipped)** | **0.042** | **100.14** | **10.59** | 0.00% | 104.3 | 56.33 | 102.72 | 0.98% |
| 5 | 0.071 | 112.97 | 12.91 | 0.00% | 104.3 | 56.29 | 107.30 | 0.96% |
| 7 | 0.099 | 123.28 | 14.91 | 0.00% | 104.3 | 56.30 | 111.15 | 0.97% |
| **9** | **0.127** | **131.87** | **16.49** | 0.00% | 104.3 | 56.33 | 114.47 | 0.98% |
| 11 | 0.155 | 139.21 | 17.74 | 0.00% | 104.3 | 56.29 | 117.38 | 0.96% |

The brick control does not move: p50 **104.3 at every state**, MAD spread **0.04 across
the whole sweep**. Frame clipping is flat at 0.95–0.98% — **there is no exposure cost at
all**, contrary to the fear recorded in the source comment that 9 would be "a bigger
exposure change than one agent should make." Road clipping is 0.00% throughout and the
road patch max only reaches 182/255 at gain 9.

Road-vs-brick flatness: **9.7× before this pass → 5.3× at gain 3 → 3.4× at gain 9.**

### 1.3 The argument that actually settles it — the wet response

*Measured, and this is the strongest number in the report.* One frozen `st_southend`
frame under `weather: 'rain'`, identical lighting, identical exposure, toggling **only**
`setWetness` with `wetnessColor` pre-scaled so the albedo-darkening term survives:

| ALBEDO_GAIN | dry mean | wet mean | **wet / dry** |
|---:|---:|---:|---:|
| **3 (shipped)** | 48.30 | 52.79 | **1.093** |
| 5 | 55.46 | 55.47 | 1.000 |
| 7 | 61.87 | 58.08 | 0.939 |
| **9** | 67.65 | 60.53 | **0.895** |
| 11 | 73.34 | 64.13 | 0.874 |

**At the shipped gain, wetting the road still makes it 9.3% BRIGHTER.** The sign of the
wet response is unchanged from the failure the previous report filed as AF-5. Break-even
is at `ALBEDO_GAIN ≈ 5.0`. The commit's claimed "wet ratio 1.01 → 0.795" is a comparison
of **rain weather against clear weather** — a different sky, a different sun and a
different exposure — not a wet-against-dry toggle. It is not measuring what its name says.

Supporting split: ablating the road's diffuse colour entirely moves the carriageway from
100.14 to 72.87. **73% of the road's rendered luminance is still not albedo** at gain 3
(vs the commit's 87% before the pass). It is 59% at gain 7 and 55% at gain 9. Env
specular accounts for only ~3/255 of that, SSR for **0.00** (verified by toggling
`rp.ssr.enabled`), AO for 0.00.

### 1.4 The number, and the better answer

**If the knob stays a uniform scalar: `ALBEDO_GAIN = 9.0.`** Defence: it puts the
carriageway at 0.127 linear — inside the real aged-hot-mix band and clear of its own F0
by 3×; it moves the wet/dry ratio to 0.895 (still short of a real 0.75–0.85, but the
right side of 1.0); it raises carriageway MAD@89 from 10.59 to 16.49, closing the
road-to-brick flatness gap from 5.3× to 3.4×; and it costs **nothing** — 0.00% new road
clipping, 0.98% frame clipping unchanged, brick control unmoved. 7.0 is the minimum I
would accept; below 5.0 the wet response is still inverted, which makes 3.0 indefensible.

**But a uniform gain is the wrong shape of knob, and the report should say so.** The
source comment defends it as "preserving every authored ratio". Those ratios were
authored against the near-white fallback atlas where all four tiles were ~0.8 linear;
the real tiles differ by **2.5× between classes** (0.108 to 0.269). The ratios the
uniform gain preserves are precisely the ones the atlas swap destroyed. At gain 9,
cobble reaches 0.402 and concrete 0.552 — both far too bright — while the road-atlas
brick only reaches 0.133, still half of real brick.

**Is the under-authoring visible on concrete, brick and cobble? Yes, and it is not
uniform.** Per-class correction factors relative to today, to hit physical albedo:

| class | ×today | resulting albedo |
|---|---:|---:|
| asphalt / gutter | **×3.0** | 0.127 / 0.107 |
| sidewalk brick | **×5.0** | 0.221 |
| granite kerb / top | ×1.8 | 0.227 / 0.257 |
| sidewalk concrete | ×1.3 | 0.239 |
| cobble setts | ×1.2 | 0.161 |
| road paint white | ×1.7 | 0.568 |

That is a six-line change in the same file by the same owner, and it is strictly better
than any single number. **Owner: roads / materials.**

---

## 2. Automatic fails

Called out per the rubric, no matter the scores. Four of the seven from the previous
pass are cleared.

**AF-5 — Rain still has the wrong sign, and the streaks are broken geometry. STANDS,
restated.**
*Measured + judgement.* The wet road is **1.093× the dry road** in one frozen frame at
identical lighting (§1.3). Magnified 2.1× on the readback, the wet near carriageway is a
uniform dark field, p05 36 / p90 67 — a 30-value band with **no puddles, no standing
water, no sheen structure and no reflections of anything**. SSR contributes exactly 0.00
to it. Judgement, at 2× on the readback of `rain_street`: the streaks are enormous
opaque white quads with **visible polygon corners and faceted, aliased ends**, up to a
third of the screen height for one drop, at one angle and one opacity over the whole
frame including the sky, plus shard-like clusters that read as broken glass over the
facades. This is worse than the "scratches on the lens" the previous pass described.
Rain also blows the sky: `st_southend` clipping goes 0.98% dry → **4.89%** wet.

**AF-6 — `overcast_wide` is still a flat milky wash. STANDS, unchanged.**
*Measured.* p05 **73.1**, p50 116.4, p90 **162.7**, min 55.8, max 210.6, **0.00%
clipped, 0.00% below luminance 2**. The previous pass measured 74 / 117 / 163. Nothing
moved. The whole 1920×1080 frame lives inside a 155-value band and 90% of it inside a
90-value band; city, river and sky resolve to one blue-grey.

**AF-7 — Shadow-cascade triangles are over budget, and the breach moved the wrong way.**
*Measured.* Peak over 10 synchronous frames, camera-only counted with
`shadowMap.autoUpdate = false`:

| shot | camera tris / draws | **shadow tris** | previous pass | all-pass draws |
|---|---:|---:|---:|---:|
| `night_neon` | 2.50M / 344 ✅ | **3.51M** ❌ | 3.47M | 712 |
| `st_beaconhill` | 1.82M / 335 ✅ | **2.82M** ❌ | 2.73M | 775 |
| `st_southend` | 1.39M / 267 ✅ | 2.27M ✅ | — | 578 |
| `st_backbay` | 1.65M / 376 ✅ | 2.04M ✅ | — | 829 |
| `st_northend` | 1.33M / 312 ✅ | 2.08M ✅ | — | 709 |

Against the 2.5M shadow budget: `night_neon` is **40% over** (was 39%) and
`st_beaconhill` **13% over** (was 9%). **The breach did not move materially, and what
movement there is, is upward.** Camera triangles and draw calls are comfortably inside
budget everywhere; peak draws 829 against 1200.

**AF-8 (new) — the harbour is still an unshaded plane.** *Measured + judgement.*
`bridge` at 08:12: water occupies ~55% of frame at min 22.2 and reads as one flat dark
sheet — no waves, no normal, no reflection, no sun glitter. `hero_skyline` the same. The
previous pass listed this under "could not test"; it is testable and it fails.

### Cleared since the last pass — take these off the list

- **AF-4, floating facade ornament — CLEARED.** *Judgement, four independent framings
  (`st_southend`, `st_backbay`, `st_beaconhill`, a custom rooftop camera at 48 m).* Not
  one band, sill or lintel projects into open sky anywhere. This was the single most
  broken read in the build and it is gone.
- **AF-3, hollow wheels — CLEARED.** *Judgement at 3.0× on the readback.* Bright outer
  flange, recessed dish, spokes and a hub cap, visible on parked cars at 5–15 m.
- **AF-2, cars clipping to pure white — CLEARED as clipping.** *Measured* by toggling
  the `prop_surf` material at `st_southend` 11:12: prop pixels are 23.27% of the frame
  at mean luminance 55.2 and **0.13% clipped**. The bodies are now off-white, not 255.
  (The *material response* is still wrong — see §3.2.)
- **AF-1, the road is an untextured plane — DOWNGRADED, not cleared.** *Measured.*
  Carriageway MAD@89 **10.59** against the brick control's **56.33** — 5.3× flatter,
  from 9.7×. There is real structure now. It is no longer an automatic fail; it is
  ranked fix #1 for a different reason (§3.1).
- **No z-fighting, no shadow acne, no visible tiling, no floating or sunk objects, no
  empty streets, zero console errors, zero GL faults** — all re-checked, all clean.

---

## 3. Verdicts on the three changes under review

### 3.1 `8b6fff6` — road and pavement — **REAL, AND UNDER-DOSED**

Every headline claim reproduces. Carriageway MAD@89 measured **10.59** (claimed 10.27);
road-to-brick flatness **5.3×** (claimed 4.7×, my brick patch differs); road material
covers **41.5%** of the `st_southend` frame, confirming "35–45% of every street frame".
The `uDetail` handle works, kerbs are modelled with a top and a face, and the frame cost
is unchanged.

*Judgement, at 2.4–2.7× on the readback (`st_southend` and `st_beaconhill`):* **the crack
field is the new tell.** The cracks are wide, soft, low-contrast grey-brown curves —
hooks, loops and S-bends several pixels across with blurred edges, scattered like
handwriting. Real asphalt cracks are thin, dark, high-contrast, made of straight
segments meeting at angles, and they cluster at joints, edges and wheel paths. These
branch nowhere and follow no directional logic. At street magnification they are the
dominant feature of the surface and they read as **someone having drawn on the road with
a soft grey marker**. Two supporting observations from the same crops: there is no
visible aggregate or chip texture between them (the surface is smooth), and the lane
line is a soft blurred band with no crisp paint edge and no chipping. The utility-cut
patches are the best part of the pass — right idea, edges too soft.

The gain is the headline problem (§1). **Owner: roads / materials.**

### 3.2 `8eeb1b7` — parked cars — **REAL, AND THE CLEARCOAT IS NOW THE BINDING LIMIT**

Clipping and the wheel both verify (see AF-2 and AF-3 above). The wheel face is the
single most visible per-object improvement in the build.

**Yes, the missing clearcoat is now the binding limit — and it is worse than the commit
states.** *Measured:* `prop_surf` is a `MeshStandardMaterial`; its `roughness: 1.0,
metalness: 1.0` are scale factors and the real values come per-vertex from `aSurf`, so
car paint renders at `SURF.paint = [0.46, 0.18]` (`StreetFurniture.js:172`). *Judgement
at 3.0× on the readback, `st_southend` in direct 11:12 sun:* the body has **no specular
highlight of any kind**. There is no shoulder streak, no horizon line, no sky reflection
— the falloff is purely Lambertian and the surface reads as **unglazed clay or
polystyrene**. Roughness 0.46 is far too rough for automotive paint (real clearcoat is
0.05–0.15) and metalness 0.18 is a fudge that buys nothing. The commit's own ask —
`SURF.paint → ~[0.34, 0.05]` and `prop_surf → MeshPhysicalMaterial` with clearcoat 1.0 /
clearcoatRoughness 0.06 — is correct and should be executed; add the roughness change,
because clearcoat alone on a 0.46-rough base will still read matte underneath.

Two further things visible at 3.0×, not mentioned in the commit: the nearest car carries
a **large hard-edged dark chevron across its flank** that reads as a painted decal rather
than a shadow, and its greenhouse is opaque with the windscreen reading as a black slot.
Door lines, mirrors and plates *are* present on cars 2–5 back — they are simply not
present on the nearest one, which is the one the eye lands on. **Owner: props /
materials, with vehicles.**

### 3.3 `a40f35f` — facades — **THE STRONGEST OF THE THREE**

*Measured*, CPU-side over all **10,191** specs:

| | |
|---|---:|
| bays | **2,529** (claim 2,529 ✅) |
| bows | **1,894** (claim 1,894 ✅) |
| areaways | **4,544** (claim 4,544 ✅) |
| stoops | 5,667 |
| mansards / dormers | 2,750 / 663 |
| fire escapes / shopfronts | 1,247 / 3,368 |
| **setback jitter** | mean **0.695 m**, SD **0.379 m**, range 0.10–2.49 m |

The 0.1 m dead-flush building line the previous pass called out is gone. **Nothing broke
at the roofline** — I flew a custom camera to 48 m over Back Bay and magnified the roofs
to 3.8×: bulkheads, packaged HVAC units, roof fans on stalks, brick chimneys, masts and
antennae all sit **inside their parapets**, on angled parcels as well as grid-aligned
ones, and the parapet coping is consistent. This is a clean fix and the rooftop view is
now one of the better frames in the build.

*Judgement — does the streetwall read as Boston?* **Closer than it has ever been, and
still not yet.** `st_backbay` and `st_beaconhill` read as brick rowhouse streets with
cornices, fire escapes, awnings, stoops and street trees, and `st_backbay` carries a
painted red bike lane, which is a genuinely Bostonian detail. What is missing is that
the 2,529 bays and 1,894 bows are not legible from the street — no framing I took shows
a projecting bay or oriel reading as one. Two things I did find at the roofline that are
*not* regressions but are wrong: **every roof deck is one flat untextured tone** — no
membrane seams, gravel, staining, drains or rust — and, judgement with moderate
confidence, at least one pale windowed wall reads as standing free on a roof deck rather
than as a taller neighbour behind it. **Owner: buildings.**

---

## 4. The two open items from last time

**Back Bay towers — STILL OPEN, and worse than "no buildings over 100 m."**
*Measured*, `city.districtAt` on every spec centroid:

| district | specs | ≥60 m | ≥100 m | **max height** |
|---|---:|---:|---:|---:|
| **backBay** | 2,499 | **0** | **0** | **33.6 m** |
| financial | 448 | 208 | 67 | 162.5 |
| southEnd | 2,712 | 1 | 1 | 150.6 |
| seaport | 245 | 34 | 0 | 90.0 |
| beaconHill / northEnd / charlestown | 1,027 / 857 / 653 | 0 | 0 | 35.0 / 31.8 / 16.0 |

Back Bay tops out at **33.6 m across 2,499 buildings**, where 200 Clarendon (241 m) and
the Prudential (229 m) actually stand. The height bands are **byte-identical to the
previous pass** — 0–20 m: 8,384; 20–40: 1,424; 40–60: **128**; 60–100: 183; 100–150: 66;
150–180: 6; **180 m+: 0**. Nothing procedural exceeds 162 m, so the 165–225 m register
where real Boston has ~8 buildings is empty, and the 40–60 m mid-rise band is a cliff.
One oddity worth a look: a **150.6 m tower in the South End**, which is wrong.
*Judgement from `hero_skyline` and `downtown_dusk`:* the towers now carry varied facade
tone and legible window grids — a real improvement on "featureless white boxes" — but
**every one ends in a flat parapet with a flat dark roof deck**. No crowns, no
mechanical penthouses, no spires. It reads as a mesa, not a skyline.

**Night lamp pools — STILL OPEN, unchanged.** *Measured* at `night_neon` 22:00:
**exactly 15 dynamic lights** (10 point at 42/108, 5 spot at 108) plus 3 directional, for
~2,300 lamp props. The near-road horizontal luminance profile across the full 1920 px
width sits between 9 and 34, with a single 49.7 spike from a vehicle headlight and
otherwise a smooth broad hump — **no periodic structure of any kind**. `st_seaport` is
the same: lamps glow in the air, the road beneath them is unlit. A GTA V night street is
*defined* by the chain of lamp ellipses on the asphalt.

---

## 5. Shot-by-shot

```
SHOT: st_beaconhill     VERDICT: FAIL   (16:00 clear, 4.7 ms med, 335 cam draws, 0.00% clipped)
Scores: silhouette 6, material 4, lighting 5, atmosphere 6, grade 6, density 7,
        geometry 7, boston 7   → 6/10   ** best daylight street **
Brick rows, fire escapes, green awning, street sign, real pedestrians, patch joints and
wheel-track polish now visible on the road. Gives it away: (1) the crack "worms";
(2) a flat black manhole disc mid-carriageway; (3) mannequin pedestrians.

SHOT: st_backbay        VERDICT: FAIL   (09:36 clear, 5.1 ms, 376 cam draws, 2.90% clipped)
Scores: 5 / 4 / 5 / 6 / 5 / 7 / 6 / 6   → 6/10
Painted red bike lane, parked rows both sides, street trees, cornices. No floating bands
anywhere — the biggest single change since the last pass. Cars still putty; vanishing
point blows to white.

SHOT: st_southend       VERDICT: FAIL   (11:12, 5.3 ms, 267 cam draws, 0.98% clipped)
Scores: 5 / 4 / 5 / 5 / 6 / 6 / 6 / 6   → 5/10
The reference shot for the road work. Road material = 41.5% of the frame. Detail is
real; the level is a third of what it should be and the cracks read as drawn on.

SHOT: st_seaport        VERDICT: FAIL   (20:00, 3.06% black)
Scores: 5 / 4 / 4 / 6 / 6 / 7 / 6 / 6   → 5/10   ** best night frame **
Neon, crosswalk, double-yellow, signal glow, overhead wires, sky glow. Road is dark navy
with visible crack structure and no lamp pools at all.

SHOT: hero_skyline      VERDICT: FAIL   (17:48, 6.6 ms, 293 draws, 0.00% clipped)
Scores: 4 / 4 / 6 / 7 / 7 / 5 / 5 / 5   → 5/10
Towers now have window grids and varied tone; haze depth is genuinely good; clouds
remain the best single element. Every tower ends in a flat parapet. Water is a flat sheet.

SHOT: downtown_dusk     VERDICT: FAIL   (19:24, 0.01% clipped)
Scores: 4 / 3 / 6 / 7 / 7 / 5 / 5 / 5   → 5/10
Pink cumulus and a sun-glitter path. Underneath, every roof deck is the same flat dark
grey rectangle and the lit-window grid is perfectly regular.

SHOT: st_northend       VERDICT: FAIL   (18:24, 4.3 ms, 0.00% clipped, p90 240.6)
Scores: 5 / 4 / 5 / 6 / 4 / 6 / 6 / 6   → 5/10
Backlit brick, fire escapes, lit shop signs, headlights on. The sun down the street is
still an undifferentiated blob with no disc and no streak.

SHOT: night_neon        VERDICT: FAIL   (22:00, 4.3 ms, 7.09% black, shadow 3.51M ❌)
Scores: 4 / 4 / 4 / 5 / 5 / 6 / 6 / 5   → 5/10
Wheels read properly now. No lamp pools; one LOD-2 shell mid-frame is a plain white box.

SHOT: street_level      VERDICT: FAIL   (09:30 East Berkeley St, 2.02% clipped)
Scores: 6 / 4 / 6 / 6 / 5 / 7 / 6 / 7   → 6/10
Re-authored well: brownstone stoops, wrought-iron rails, areaways, bins, dappled tree
shadow on the pavement. Not a carriageway framing. Tree trunks are smooth bare cylinders.

SHOT: bridge            VERDICT: FAIL   (08:12, 93 draws, 0.05% clipped)
Scores: 4 / 2 / 5 / 7 / 6 / 3 / 4 / 5   → 4/10
Zakim cables and the Bunker Hill monument in haze are good. 55% of the frame is an
unshaded flat plane of water.

SHOT: overcast_wide     VERDICT: FAIL   (13:00 overcast, 2.9 ms)
Scores: 3 / 2 / 3 / 3 / 2 / 4 / 5 / 4   → 3/10   ** worst shot **
p05 73.1 / p90 162.7, 0.00% clipped, 0.00% black. Unchanged from the last pass.

SHOT: rain_street       VERDICT: FAIL   (15:12 rain, Saint James Ave)
Scores: 3 / 3 / 4 / 4 / 3 / 5 / 3 / 4   → 3/10
Off the Common, but the camera is on a pavement with two untextured mannequins occupying
roughly 15% of the frame and a parked car blocking the only carriageway in view. The
streaks are oversized faceted quads. I re-framed rain onto st_southend's camera myself
to judge it (§1.3, AF-5) — the shipped shot cannot carry the verdict.

SHOT: golden_hour       VERDICT: FAIL   (06:36)
Scores: 3 / 3 / 5 / 4 / 5 / 3 / 4 / 4   → 3/10
Still jammed against a brick wall — `unstick` produces a useless framing, unchanged from
the last pass. Usefully it shows brick at close range: courses read roughly 4x life size
against the window they surround, and the windows are flat decals with no glass, no
depth and no sill shadow.
```

### Rubric scores, whole build

| # | Axis | Prev | **Now** | One-line basis |
|---|---|---:|---:|---|
| 1 | Silhouette & massing | 4 | **5** | Roof clutter fits the real roof; setback SD 0.026 → 0.379 m — but the height histogram is byte-identical, Back Bay maxes at 33.6 m, every tower ends flat |
| 2 | Material truth | 2 | **4** | Road MAD 10.6 vs brick 56.3 (was 9.7× flatter, now 5.3×); cars stop clipping — but asphalt albedo 0.042, road-brick 0.044, no clearcoat, wet sign inverted, roofs and water unshaded |
| 3 | Lighting | 5 | **5** | Unchanged: 15 dynamic lights city-wide, zero lamp pools |
| 4 | Atmosphere & depth | 6 | **6** | Unchanged: clouds strong, haze depth good, overcast still one grey |
| 5 | Composition & grade | 5 | **5** | Several shots now 0.00% clipped with clean rolloff; rain blows the sky to 4.89%, sun has no shape, golden_hour unusable |
| 6 | Density & life | 5 | **6** | Bike lane, granite kerbs, wheel faces, mirrors and plates, roof clutter, 4,544 areaways, 5,667 stoops |
| 7 | Geometric fidelity | 4 | **6** | Floating ornament gone, wheels solid, no z-fighting, no tiling — rain streaks are visibly faceted quads |
| 8 | Boston authenticity | 5 | **6** | Rowhouse roofscape, stoops, areaways, bike lane, real geography — but no legible bays, Back Bay flat, brick 4× oversized |

**Direction of travel: up, and for the first time the movement is in the pixels rather
than the systems.** Three commits, three real fixes, one of them (facades) essentially
complete. What holds the score at 5 is that the road pass shipped at a third of its own
prescribed dose, and that everything the previous pass flagged as *unowned* — night
pools, water, overcast, skyline register — has not moved at all.

---

## 6. Ranked fixes

Ranked by (fraction of pixels affected) × (severity of the tell) ÷ (work).

**1. Raise the road albedo — `ALBEDO_GAIN` 3.0 → 9.0, or better, a per-class table.**
*Owner: roads / materials.* 41.5% of every street frame. Measured cost of the change:
zero — 0.00% new clipping, frame clipping flat at 0.98%, brick control unmoved across an
8-state sweep. Measured benefit: carriageway MAD@89 10.6 → 16.5, road-to-brick flatness
5.3× → 3.4×, and the wet/dry ratio crosses from 1.093 to 0.895. **This is a one-line
change that fixes fix #2 as a side effect.** The per-class table in §1.4 is strictly
better and is six lines in the same file.

**2. Wet-surface response: fix the sign, add puddle reflections, rebuild the streaks.**
*Owner: materials + roads + render.* Three separate defects behind one symptom. (a) The
sign — `tone *= 1 - gWet*(0.14 + gPuddle*0.45)` darkens un-puddled asphalt by only 14%;
real asphalt darkens 40–55% when wet. Raise it and the gain together. (b) SSR contributes
**0.00** to the wet road, so a wet street reflects nothing — a wet carriageway that
mirrors the facades is the single strongest AAA signal available and it reuses lighting
that already exists. (c) The streaks are oversized faceted quads at one angle, one
length and one opacity over the whole frame including the sky; they need depth-varied
size and opacity, and they must not draw over the sky at full strength.

**3. Give parked-car paint a clearcoat and a real roughness.** *Owner: props /
materials, with vehicles.* `prop_surf → MeshPhysicalMaterial`, clearcoat 1.0 /
clearcoatRoughness 0.06, `SURF.paint → [0.34, 0.05]`, `envBase` ~1.25. Drive it per
surface class so bins and benches are not lacquered too. Closest object to camera in
every street framing; currently reads as unglazed clay. Also chase the hard dark chevron
on the near car's flank, and give car #1 the door lines and mirrors that cars 2–5 have.

**4. Real light pools on the night street.** *Owner: lighting + render.* 15 dynamic
lights for ~2,300 lamp props; the measured near-road profile has no periodic structure
at all. A projected pool decal per lamp is the cheap version; a clustered forward path is
the right version. This transforms `night_neon` and `st_seaport` at once, and it is the
only item on this list that needs architectural work.

**5. Skyline upper register, Back Bay towers, and roof-deck material.**
*Owner: buildings / city.* Back Bay is 2,499 buildings with a 33.6 m ceiling under the
city's two tallest landmarks; nothing procedural exceeds 162 m; the 40–60 m band has 128
buildings. Fill 165–225 m sparsely downtown, give Back Bay a real cluster, and — cheapest
of the three — put *any* texture on the roof decks, which are currently one flat tone
each and are 30–40% of every elevated frame.

**6. Rework the crack and joint motif on the road.** *Owner: roads.* Thin, dark,
high-contrast, angular, clustered at joints and wheel paths — not soft wide curves.
Sharpen the lane-paint edge and add visible aggregate between the cracks. Ranked below
the gain because at gain 9 the same geometry reads considerably better.

**7. Overcast grade.** *Owner: atmosphere + render.* p05 73 / p90 163 with 0.00% at
either end, unchanged across two critic passes. It needs a real black point.

**8. Water.** *Owner: city / render.* 55% of `bridge`, a flat unshaded plane.
`CURRENT_STATE.md` issue 5 says the shader fails to compile; no GL fault fires, so
whatever the status, it is not shading.

**9. Re-author `rain_street` and `golden_hour`.** *Owner: whoever owns the harness.*
`golden_hour` is still inside a wall two passes running, and `rain_street` puts two
mannequins and a parked car between the camera and the only road in frame. A critic
cannot judge weather on a shot that does not show the surface weather acts on.

**10. Pedestrian and tree materials.** *Owner: characters / vegetation.* Untextured
mannequins are the largest foreground object in `rain_street`; tree trunks are smooth
bare cylinders.

**Not worth doing:** perf work. Median settled frame time at 1920×1080 `high` is
**2.9–6.6 ms** against a 16.7 ms budget (`overcast_wide` 2.9, `night_neon` 4.3,
`st_northend` 4.3, `st_beaconhill` 4.7, `st_backbay` 5.1, `st_southend` 5.3,
`hero_skyline` 6.6). Peak draws 829 against 1200; camera triangles 1.33–2.50M against
3.5M. The **only** breach is shadow triangles, and freezing the cascade saves 0.9 ms of a
4.3 ms frame — real, but not worth a pass. Also do not chase z-fighting or texture
tiling; both re-measured clean.

---

## 7. For the record — what I could not test

- **No real rAF frame rate.** `document.hidden` is `true` for this pane, so
  `measureFps()` still refuses. Every timing here is a synchronous `step(1)` forced to
  GPU completion with `gl.finish()` — pessimistic if anything, but nobody has yet seen
  this build run at its natural cadence.
- **Motion.** All judgement is on frozen frames. The previous pass measured 6.6% of
  pixels alternating between two states on a static camera, consistent with the 6-frame
  cascade stagger; I did not re-measure it and it would read as facade shimmer in motion.
- **The windowed wall at roof level** in the 48 m rooftop framing — I could not
  distinguish "a bulkhead wearing the facade generator" from "a taller neighbour seen
  over a lower roof" from a single viewpoint. Worth five minutes from the buildings owner.

---

`OVERALL: 5/10 — KEEP WORKING`
