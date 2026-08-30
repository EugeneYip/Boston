# CRITIC_REPORT.md — visual review vs GTA V

**Reviewer:** visual critic (hostile art director). **Date:** 2026-08-29.
**Resolution:** every capture 1920×1080 (CSS 1280×720 × pixelRatio 1.5). **Preset:** `high`.
**Captures:** 17 frames — the 8 named shots plus 9 street-level and close-up framings on real
named Boston streets, which is where the game is actually played.
**Calibration:** judged against GTA V street-level, dusk-skyline, night and rain framings.
Nothing copied into the project.

---

## Which build this is — read before acting on anything below

The working tree moved three times while I was measuring. Two builds are reported:

| | commit | used for |
|---|---|---|
| **Build A** | `c031123` (*Settings: declare the shadow config…*) | all 17 captures, all scores, all shot-by-shot findings |
| **Build B** | `f1e290a` (*City: fix the water winding, split Comm Ave…*) | a re-verification pass on the four headline defects |

**Why Build A is a private snapshot, not `:5290`.** When I started, `http://127.0.0.1:5290`
served a tree that **did not boot at all**: `BOOT FAILED — ReferenceError: tile is not defined
at Terrain.build (src/world/Terrain.js:303)`. `tile` was a parameter of `_patch()` being read
from `build()`. `node tools/parsecheck.mjs` passed — it is a scope error, not a syntax error, so
parsecheck cannot see it. I therefore did `git archive HEAD` into a scratch directory and served
that on `:5291`, and every capture below carries `location.port === '5291'` and a verified
`bootReport.failed === []`. That regression is now gone; `:5290` boots cleanly again on Build B.
**Someone should add a boot smoke-test to the validation list in AGENTS.md — parsecheck does
not catch this class of break, and the shared server was dead for a long stretch.**

**Also do not trust `:5290` tab-6.** My first capture there came back with `tod 16.4` and
`fov 52` when I had asked for `street_level` (`tod 9.5`, `fov 55`) — another agent was driving
the same page concurrently. Every number in this report is from a tab nobody else touched.

**Console:** `__boston.errors` = `[]` and `__boston.glFaults` = `[]` after **every one** of the
17 captures, checked individually, on both builds. Not a fail this session.

---

## Previous pass (2026-08-27): **2/10, all 16 frames failed the blind test**

Its headline items were: exposure pinned at 2.424 at every hour; a pure-black horizon seam in
every wide shot; a facade emissive band clipping to white; three of eight named shots parked
inside buildings; a 4,277-parcel building hole around the whole perimeter; 15 street lamps
burning at noon; shadows 0.58 stops deep; 41–52 snow banks in clear August weather; every wall
prop and decal in the game piled inside a 340–413 m radius; 4.14 m-thick street-tree trunks;
1.4–3.5 fps.

### Delta — what I could and could not confirm

| Claim | Verdict | Evidence |
|---|---|---|
| Auto-exposure unpinned | **CONFIRMED** | Hanover St, 9 hours: frame p50 78–89 in daylight, 42–43 at 21:00–23:00. Was a 34-level swing across 24 h; now the day/night ratio is real. |
| Night ~35% of noon | **PARTLY** — I measure **~50%** (p50 43 at 23:00 vs 78–89 at noon/15:00). Better than 70%, still not night. |
| Clipping at 18:36 was 15.0%, now 0 | **CONFIRMED** — 0.00% at Hanover 18:00, worst hour of the day is 09:00 at 3.31%. |
| Street lamps Σ0 from 06:00–18:00 | **CONFIRMED** — Σ intensity 0 at 06/09/12/15/18, 1046–1092 at 19:30/21/23/03. 15 lights live at every hour but gated. |
| Shadow-casting key at every hour | **CONFIRMED** — `castShadow` true at all 9 sampled hours, key intensity 0.14–6.06. |
| Shadows 2.54 stops in the umbra | **UNVERIFIED** — the shadow-map A/B needs a full material recompile and blew the tool timeout twice. Visually, daylight canyon shadows are now if anything *too* deep (Milk St 13:30 reads p50 44/255 — a night histogram at half past one). |
| 8.1 km aerial-perspective seam fixed | **CONFIRMED gone** — but a **different, worse seam is live**; see §1. |
| Props spread city-wide | **CONFIRMED, and it is the biggest single improvement in the project.** Within 80 m of a Financial District camera: 37 parked cars, 27 shop signs/fascias, 24 decal families, 14 vegetation families, 91 prop families total. All of those were 0. |
| Snow banks gone in clear weather | **CONFIRMED** — `prop:snowBank`, `decal_salt`, `decal_puddle` all `visible === false` in `clear`. (Their instance matrices still exist; count from `mesh.visible`, not from matrices.) |
| Street-tree trunks fixed | **CONFIRMED for street trees** — London plane 14.5 m / 0.71 m dia, pin oak 0.62 m, honey locust 0.41 m. **Not for park trees**: `tree_americanElm0` is 25.1 m tall with a **1.54 m** bole (H/16; real elms are H/25–H/40). And `tree_weepingWillow0` measures a **14.1 m** bole diameter at the base — that may be drooping canopy cards reaching the ground rather than trunk, but it is currently placed 0 times and needs a look before it ever is. |
| Perimeter hole filled | **CONFIRMED** — 10,666 specs / 11,219 parcels; **zero** 600 m cells that hold ≥15 parcels and no building; buildings span x −3115…2242, z −2747…2001. At (−2179, 1095), where the previous critic found the nearest building 849 m away, there are now **73 buildings within 300 m**. |
| Buildings render | **CONFIRMED** — and they carry brick, cornices, sills, fire escapes, awnings and window grids at street level. |
| Black horizon seam "does not reproduce" | **IT REPRODUCES.** Two independent causes, both localised below (§1, §2). The earlier all-shot scan missed them because it looked for rows where >50% of columns are *pure black*; these are 1–2 px full-width dark lines and a 60-level tonal step, neither of which reaches 0. |

---

## The two things the parent asked me to check

### A. Boston Common's "broad dark wavy banding" — **it is the terrain NORMAL MAP.** Fixed in Build B.

Confirmed by direct A/B on Build A, at `street_level` (Boston Common, 09:30):

- `material.map = null` → pattern **gone** (but so is everything).
- `material.vertexColors = false` → pattern **still there**.
- **`material.normalMap = null` → the ground becomes a flat, plausible mown lawn. The banding is
  entirely gone.** Saved side-by-side; the difference is not subtle.
- `normalScale = (1,−1)` → the pattern inverts but persists, so it is **not** a green-channel /
  handedness bug. It is amplitude × content.

Root cause: the terrain used `uv = (x/24, z/24)` — a 512² albedo/normal/roughness set stretched
over **24 m**, i.e. 4.7 cm per texel — with `normalScale = (1,1)`. The map's own crack/vein
content then perturbs the normal so hard that a dead-flat lawn shades as a dried lakebed. The
same stretch is why the diffuse read as sand-and-mud rather than turf.

**Build B fixes this** (`Terrain.build` now takes `tile` from `material.userData.tileMeters`,
default 4 m, with the comment "stretched grass over 24 m and turned turf into a large blotchy
crackle"). I re-captured the Common on Build B and the crackle is gone; the lawn now reads as
turf. What remains on the lawn: it is one flat uniform green with no wear paths, no clover, no
tonal variety, the fine 4 m tile is now visible as a regular mesh at 2 m, the grass tufts read
as clumps of black spikes, and `veg_shrub` is literally three squashed green ellipsoids sitting
on a white concrete drum.

### B. "5.82 M triangles against a 3.5 M budget on a Beacon Hill street" — **CONFIRMED, and it is worse than reported. It is the shadow cascades.**

`renderer.info.render.triangles`, Build A, 1920×1080 `high`:

| framing | draws | tris |
|---|---:|---:|
| `night_neon` (Marlborough St, 22:00) | 908 | **7.01 M** |
| Newbury St, 12:00 | 851 | **6.31 M** |
| Beacon St, 11:00 | **1238** | **5.56 M** |
| Boylston St, 15:30 rain | 818 | **4.95 M** |
| Mount Vernon St (Beacon Hill), 12:00 | 830 | **4.90 M** |
| `golden_hour` | 901 | **4.27 M** |
| Acorn St, 10:00 | 850 | **4.22 M** |
| Milk St road close-up, 12:00 | 915 | **3.74 M** |
| Milk St, 13:30 | 761 | 2.91 M |
| Hanover St, 18:36 | 782 | 2.65 M |
| `rain_street` / `street_level` / `overcast_wide` / `hero_skyline` / `downtown_dusk` / `bridge` | 115–503 | 0.54–2.10 M |

**Eight of seventeen frames exceed the 3.5 M budget; the worst is 100% over. Beacon Street also
breaks the 1200 draw-call budget at 1238.** Every one of the offenders is a street-level frame,
i.e. the framing the player spends the entire game in. The named-shot set is not over budget,
which is exactly why this was not caught.

**Localisation.** I re-implemented three's own bounding-sphere frustum test in page script and
summed triangles over every visible mesh that passes it, at `night_neon`:

- geometry actually inside the camera frustum: **2.97 M**
- `renderer.info.render.triangles`: **6.26 M**

So **~3.3 M triangles per frame — 53% of the total, and the entire budget overrun — is shadow
cascade re-submission**, not the camera pass. It is not props (`prop:*` families sum to ~0.2 M).
The camera-pass breakdown at `night_neon` is `buildings/Mesh` 1.25 M, `buildings/shell` 0.69 M,
`pedestrians/peds_far` 0.15 M (×529 instances), `terrain` 0.13 M.

`CURRENT_STATE.md` already contains the analysis that explains this — a 600 m shell sector's
bounding sphere is ~430 m against a 64 m cascade-0 ortho box, so five sectors pass a test their
geometry would fail almost everywhere — but it concludes "do not expect fps from turning the
shell's castShadow off". That conclusion is about *fps*. This is about the **budget the rubric
enforces**, and on that measure the shadow pass is 100% of the problem. Either tighten cascade
submission granularity, or amend ARCHITECTURE.md to state whether the 3.5 M budget is a camera
figure or a whole-frame figure. Today it says "triangles **rendered** per frame", which
`renderer.info` answers as 7.01 M.

---

## 1. The atmosphere pass draws a hard horizontal step across every level-camera frame

**This is the single most damaging defect in the game and it is in almost every screenshot in
this report.** It is not the fixed 8.1 km epsilon and it is not a post-processing scanline.

At `street_level`, `rain_street`, Mount Vernon St, Newbury St, Hanover St, Milk St, Boylston St
rain, Acorn St and the Charles — a dead-straight, full-width tonal step at the horizon row
(row 541 of 1080 for a level camera). It cuts through pedestrians, brick facades 14 m away, and
the road.

**Measured.** Mount Vernon St, 12:00, three widely separated columns, all hitting *the same
building shell at 13.8–14.5 m*:

| column | row 540 | row 542 |
|---|---|---|
| x = 120 | (73, 53, 62) | (59, **18**, **27**) |
| x = 300 | (49, 68, 87) | (**14**, 45, 71) |
| x = 1750 | (84, 60, 64) | (71, **28**, **36**) |

**Owner and mechanism, pinned by uniform ablation** (composite `ShaderMaterial` in the
`atmosphere` pass):

| change | seam |
|---|---|
| `pass.enabled = false` | **gone** (rows 536–546 uniform) |
| `uSkyIntensity = 0` | **gone** |
| `uHazeSigma = 0` | present |
| `uRayleighScale = 0` | present |
| `uUseVolume = 0` | present |

So the whole thing lives in the **in-scatter term** of `COMPOSITE_FRAG` in
`src/shaders/sky/atmospherePass.glsl.js`:

```glsl
vec3 inscat = skyLut(normalize(vec3(rd.x, max(rd.y, -0.02), rd.z)));
col = col * T + inscat * (vec3(1.0) - T);
```

Two coupled bugs:

1. **The in-scatter is a step function of `rd.y`, not a function of distance.** Removing it
   changes **99.1% of the frame** by a mean of 12/255. Sampled at known depths on Mount Vernon
   St: a wall at **13.1 m above the horizon** loses (+3, +24, +38); a wall at **13.8 m below the
   horizon** loses (−1, 0, +1); a tree at 38 m above the horizon loses (+41, +47, +60). Distance
   is not what governs it — the sign of `rd.y` is. `heightPath()` itself is continuous and
   correct; the discontinuity is in the sky-view LUT lookup, whose horizon parameterisation has
   an infinite derivative at `rd.y = 0`, made worse by the `max(rd.y, -0.02)` clamp pinning every
   downward ray to a single dark LUT row.
2. **It is far too strong in the near field.** `uSkyIntensity = 24` against
   `uHazeSigma = 3.4e-4` and `uHazeH = 1300` means `(1 − T)` at 14 m is ~0.5%, yet that 0.5%
   moves a wall pixel from (11, 39, 63) to (43, 66, 86) — the in-scatter radiance is roughly two
   orders of magnitude above nearby surface radiance. This is the "milky wash at 10 m, no depth
   cue at 400 m" the previous critic described, now with a number on it.

`atmospherePass.glsl.js` is untouched since `d290e5e`, and I re-measured on Build B: at
Hanover St the step is still 60 levels in one row (row 540 → 542, (131,149,163) → (65,89,113)).
**Live on HEAD.** *Owner: atmosphere.*

## 2. The terrain has two full-perimeter holes you can see through

The "long thin dark hairlines crossing the entire city" are open ground. Raycast through them at
`overcast_wide` and the ray misses the terrain entirely and hits the **sky dome's back face at
9 km, at y = −391 m**. Measured Chebyshev extents of the three nested `_patch()` rings:

| | Build A | Build B |
|---|---|---|
| core patch outer edge | 1500 | 1506 |
| mid patch **inner** edge | **1508** | **1508** |
| mid patch outer edge | 3200 | 3200 |
| far patch **inner** edge | **3300** | **3300** |

`_patch(half, step, hole)` drops a vertex when `|x| < hole` **and** `|z| < hole`, but the grid
step never lands on `hole`, so the outer ring's first surviving vertex sits one step out. The
result is an **8 m open ring at r ≈ 1500 and a 100 m open ring at r ≈ 3200**, right around the
whole world. From any elevated camera they are full-width dark lines; on `overcast_wide` I count
four of them, and they are also visible in the `hero_skyline` telephoto and in `bridge`.
Unchanged on Build B. *Owner: city / terrain (`src/world/Terrain.js` `_patch`/`build`).*

## 3. 12% of the road network has a building standing on it

Point-in-polygon of every road-centreline vertex against every building footprint
(self-test: 100% of 500 building centroids test inside their own polygon):

| | Build A | Build B |
|---|---|---|
| centreline samples | 5,922 | 6,038 |
| **inside a building** | **725 (12.24%)** | **720 (11.92%)** |

Worst: Atlantic Avenue 36, Beacon Street 32, Boylston Street 32, Commercial Street 25, Newbury
Street 24, Summer Street 24, and every Public Alley. Independently confirmed by raycasting
straight up from the Beacon Street centreline at (−544.9, −24): two building hits at y 3.34 and
3.52 over ground 2.69. This is what the Acorn Street capture below is a picture of — a forest of
brick piers and white string-courses standing in the carriageway. It is also a gameplay
blocker, not just a visual one. *Owner: city / buildings (parcel-vs-road-corridor clipping).*

## 4. Nothing in the world reflects anything

`scene.environment` is a **336×256** PMREM at `environmentIntensity = 0.419`, containing sky
only — no buildings, no ground, no local content. No material in the scene carries its own
`envMap`, and there is no SSR pass. Meanwhile:

| material | roughness | metalness |
|---|---:|---:|
| `building_glass` | **0.06** | 0.02 |
| `glass_car` | 0.25 | 0 |
| `car_paint_*` | 0.26 | 0.78 (clearcoat 1) |
| water bodies | 0.075 | 0 |

A near-mirror (roughness 0.06) with a 336×256 sky-only probe renders as a flat dark quad. This
is exactly why the dusk skyline has no glazing, the Charles is a matte sheet, and a wet road in
rain reflects nothing. It is one of the largest single gaps between this and GTA V and it is
currently *unaddressed*, not merely tuned wrong. *Owner: materials / render.*

---

## 5. Shot by shot

### SHOT: `street_level` — Boston Common, 09:30 clear   VERDICT: **FAIL**
Scores: silhouette 3, material 3, lighting 4, atmosphere 2, grade 3, density 2, geometry 4,
boston 4 → **overall 3.1/10**
Perf: 517 draws / 1.77 M tris. mean 76.5, p50 72, 2.08% clipped, 0.16% black, sat 0.49.

1. The lawn is a **dried-lakebed crackle** (§A) — pale sand ridges and dark channels in long
   meanders, at metre scale, on flat mown grass. *Fixed in Build B; re-shot and confirmed.*
2. **The whole frame is one cyan cast and the far half is a milky wash.** Trees 100 m away are
   already ~60% fogged; the tone at 10 m and at 400 m barely differ, so there is no depth cue.
   Boston Common at 09:30 in August is warm and green.
3. **Trees are dark card-clusters with hard aliased leaf rims and smooth pale-grey trunks** with
   no bark relief and no root flare; the far tier degrades to pale grey sticks — a visible LOD
   colour shift within one frame. Grass tufts read as clumps of black spikes, shrubs as squashed
   spheres.

Also: the horizon step (§1) cuts the frame in half at row 541; the park is empty apart from a
bin, a bench and a planter.
Blind test: **YES** — instantly.

### SHOT: `downtown_dusk` — 19:24 clear   VERDICT: **FAIL**
Scores: silhouette 3, material 2, lighting 4, atmosphere 4, grade 5, density 2, geometry 3,
boston 2 → **overall 3.1/10**
Perf: 250 draws / 1.54 M tris. mean 88.9, p50 81, 0.01% clipped, 1.06% black.

The dusk sky is genuinely good — pink-lilac cumulus with real structure. Everything under it is
not.

1. **Every lit window in the city is the same brightness, the same colour and on.** A perfectly
   regular grid of identical bright dots on every storey of every building. It reads as an LED
   matrix. Real dusk offices are maybe 30–60% lit, in different colour temperatures, with
   blinds, ceiling-bounce and desk lamps.
2. **The city is a plateau.** Every building tops out in the same 30 m band; there is no tower,
   no spire, no setback, no massing hierarchy. The height data supports better — p50 16.1 m,
   p90 25.4 m, max 163.5 m — but from this angle you cannot tell.
3. **The streets below are pure black.** No lamp pools, no headlights, no shopfronts. The ground
   plane between buildings is 1.06% clipped-black with nothing in it.

Also: several pale roof slabs float clear of their masses; no aerial perspective separating
2 km from 200 m.
Blind test: **YES**.

### SHOT: `night_neon` — Marlborough St, 22:00 clear   VERDICT: **FAIL**
Scores: silhouette 5, material 3, lighting 4, atmosphere 4, grade 4, density 5, geometry 3,
boston 5 → **overall 4.1/10**
Perf: 908 draws / **7.01 M tris — 100% over budget**. mean 45.9, p50 35, 0.31% clipped,
**6.38% black**.

The best frame in the set. It is recognisably a Back Bay street at night: brownstones, stoops,
brick pavement, fire escapes, parked cars, a lit lamp. And it still fails on sight.

1. **A 424-triangle untextured grey box fills the right foreground.** It is `prop:carVanW`,
   correctly sized at 2.29 × 2.07 × 5.34 m, standing **3.7 m from the eye** — with no wheels, no
   glass, no lights, no door lines, no mirrors, no material. It reads as a concrete sarcophagus.
   In GTA V a parked car at 3.7 m is the most detailed object in frame.
2. **The lamps make almost no pool.** The lamp head at top right is a flat white quad clipping
   to 255 with no fixture, no shaped glare, and no ellipse of light on the pavement under it.
3. **Windows are flat quads with a painted fill and no interior.** Every dark window is the same
   navy; every light one has the same blotch pattern. Nothing behind the glass.

Also: 6.4% of the frame below luminance 2.
Blind test: **YES**.

### SHOT: `hero_skyline` — 17:48 clear   VERDICT: **FAIL**
Scores: silhouette 3, material 2, lighting 4, atmosphere 4, grade 5, density 2, geometry 2,
boston 2 → **overall 3.0/10**
Perf: 378 draws / 1.81 M tris. mean 135.2, p50 116, **0% clipped, 0% black** — the grade itself
is clean now.

1. **Roof decks are bigger than the buildings they cap and hang free in space.** A 14° telephoto
   at the same camera makes it unambiguous: a tan roof plane overhangs its facade by metres on
   two sides with sky visible under the edge, and a second roof-mounted box overhangs into space.
   I count ten or more in the wide frame. *Automatic fail.*
2. **One facade material for the entire skyline.** The same fine horizontal pinstripe at the same
   pitch on every building regardless of height, age or type — and it moirés, so it will crawl in
   motion. Boston's skyline is dark glass and red brick. Roofs are bare planes: no HVAC, no
   cooling towers, no penthouses, no tanks, no railings.
3. **No cast shadow from any tower onto any other at 17:48**, with a low sun. Faces are shaded,
   nothing is shadowed.

Also: two terrain-gap hairlines cross the harbour; the harbour is a flat cream band with no
specular at the one hour of the day it should be a sheet of glare.
Blind test: **YES**.

### SHOT: `golden_hour` — 06:36   VERDICT: **FAIL — the shot is still pressed against a wall**
Scores: n/a as a composition. As the accidental facade close-up it is: material 3, geometry 3
→ **overall 2.5/10**
Perf: 901 draws / **4.27 M tris — over budget**.

The camera at (−300, 18, 420) is **10.3 m from the centre of an 18 m-tall building with a 20 m
radius** — i.e. at its roof line, inside its footprint. `unstick()` returns `moved: 0`: the shot
is not "enclosed" (only one ray hits) and `viewClear`'s `NEAR_WALL = 4` threshold passes. **One
of the eight named review shots is still wallpaper, and the harness's own guard cannot see it.**
Add a "is the camera inside a building footprint" test using `specs[].poly`, the same test §3
uses.

As a free material close-up it is useful:
1. **The brick is a flat red-brown with a low-frequency mottle — no bond, no mortar joints, no
   individual bricks** at a range where the windows are 400 px tall.
2. **Zero contact darkening anywhere.** White sills and lintels meet the wall with no shadow
   line at all. N8AO is running at `halfRes: true`, so at 1920×1080 the AO buffer is 960×540 and
   nothing at facade-detail scale survives it.
3. **The glass is a painted texture, not a reflection** — the same blotchy grey-white pattern
   with a mullion cross drawn on it, repeated identically across several windows. One vertical
   dark seam runs the full height of the facade.

Blind test: **YES**.

### SHOT: `overcast_wide` — 13:00 overcast   VERDICT: **FAIL**
Scores: silhouette 3, material 2, lighting 3, atmosphere 2, grade 4, density 2, geometry 1,
boston 2 → **overall 2.4/10**
Perf: 414 draws / 1.90 M tris. mean 123.2, p50 115, 0% clipped, 0% black. Weather now correctly
resolves to `overcast` — the missing `weather` key is fixed.

1. **Four dead-straight dark hairlines cross the whole frame** in front of and above the city —
   the terrain LOD gap rings of §2, showing the sky dome's underside through holes in the world.
   *Automatic fail: gaps at seams.*
2. **The fog is soup.** Buildings at ~1 km are 90% washed out; the whole city is one uniform
   blue-grey. This is not overcast, it is a fogbank, and it destroys the sense of scale the shot
   exists to convey.
3. **The city reads as a tabletop model**: flat roofs, one value, one hue, no street grid legible
   from above — and Boston's street pattern *is* its identity from the air.

Blind test: **YES**.

### SHOT: `rain_street` — 15:12 rain   VERDICT: **FAIL — and it is not a street**
Scores: silhouette 2, material 2, lighting 3, atmosphere 3, grade 3, density 2, geometry 2,
boston 2 → **overall 2.4/10**
Perf: 503 draws / 2.10 M tris. mean 75.6, p50 53.

The camera is now above ground (y 10.4 on ground 8.0) — the under-the-road bug is fixed — but it
is standing on **Boston Common**, looking at grass, trees and a litter bin. Two of the eight
named shots (`street_level` and `rain_street`) are now the same park, and the only rain-on-
tarmac framing in the review set does not exist. Re-author it onto a real street.

1. **The rain is a screen of white scratches** — 3–5 px wide, 400+ px long, uniform density from
   the near field to the horizon, clipping to white, with visible chromatic-aberration rainbow
   fringes, drawn over geometry 3 m away. No splash, no spray, no density falloff, no scale with
   distance.
2. **Bright hollow rings sit on the grass** — perfectly circular glowing donuts with colour
   fringing, five of them in the lower left. Rain ripple decals landing on a lawn and rendering
   as lens ghosts.
3. **The tree canopies are inverted umbrellas.** The canopy is a wide disc that curves *up* at
   the rim; from below you see a solid dark shell with jagged white-edged tears. It reads as torn
   tarpaulin.

Also: the ground shows no wetness response at all; a razor-sharp full-width tonal step at the
horizon (§1).
Blind test: **YES**.

### SHOT: `bridge` — 08:12 clear   VERDICT: **FAIL**
Scores: silhouette 2, material 1, lighting 3, atmosphere 3, grade 4, density 1, geometry 1,
boston 2 → **overall 2.1/10**
Perf: 115 draws / 0.54 M tris — the frame is nearly empty.

1. **A dead-straight full-width black line at the horizon** (§2) plus a hard-edged black
   parallelogram lying on the ground at mid-right with no object above it.
2. **There is no water in a shot named `bridge`.** The camera at (−40, 26, −980) points across
   bare terrain — `waterAt()` is false everywhere in front of it, and the nearest building spec
   is more than 400 m away. Two thirds of the frame is an empty green field where North
   Station should be. Re-author against `city.waterPolys`.
3. **The Zakim's cable stays are 1 px hairlines with heavy chromatic aberration** — red/green/
   blue barber poles that will crawl violently in motion. The pylon is a white obelisk, the deck
   a white slab with no road surface, markings, barriers or traffic. Zero boats, buoys, gulls or
   navigation lights.

Blind test: **YES**.

---

### Street level — where the game is played, and where nobody has looked

### SHOT: Mount Vernon Street, Beacon Hill, eye 1.65 m, 12:00 clear   VERDICT: **FAIL**
`pos [-372.7, 4.4, -274.7] look along [18.7, 0, -2.9] fov 55`
Scores: silhouette 5, material 3, lighting 4, atmosphere 2, grade 3, density 5, geometry 3,
boston 5 → **overall 3.8/10**
Perf: 830 draws / **4.90 M tris**. mean 64, p50 47, 0.99% clipped.

Density is real here — brick, cornices, fire escapes, awnings, a parking meter, traffic signals,
overhead wires, pedestrians, dappled tree shadow on the road. And:

1. **The horizon step (§1) cuts the frame in half** and bisects a pedestrian.
2. **Every sign in the frame is a blank white board.** Three large signboards and a fascia, all
   completely blank — no lettering, no logo, no colour. Blank signage is worse than no signage.
3. **The road at noon is flat navy-black with no aggregate and no wear** at 2 m from the eye, and
   the pedestrian is a faceless mannequin with a smooth wooden head, ~2.2 m tall.

Also: awnings are unframed floating quads, one of them ~8 m wide; fire escapes read as flat red
zips on the wall; **no parked cars on a Beacon Hill street**, which is parked solid in reality.
Blind test: **YES**.

### SHOT: Newbury Street, eye 1.65 m, 12:00 clear   VERDICT: **FAIL**
Scores: silhouette 4, material 3, lighting 4, atmosphere 2, grade 3, density 5, geometry 3,
boston 3 → **overall 3.4/10**
Perf: 851 draws / **6.31 M tris**. mean 81.2, p50 80.

1. **A parked van fills the right third of the frame as a smooth grey block** (§`night_neon` 1) —
   3.7 m from the eye, 424 triangles, no wheels, no glass.
2. **The road decals are chalk scribbles.** Soft light-grey closed loops and hooks scattered on
   the asphalt, *lighter* than the surface they patch (real patches are darker), and the same
   motif appears at four or five different rotations in one frame. **Visible tiling repetition —
   automatic fail.**
3. **Newbury Street is not recognisable.** No ground-floor retail, no shop windows, no A-boards,
   no café tables, no readable signage; the awnings are floating banners up to 10 m wide.

Blind test: **YES**.

### SHOT: Milk Street, Financial District, eye 1.65 m, 13:30 clear   VERDICT: **FAIL**
Scores: silhouette 4, material 3, lighting 2, atmosphere 2, grade 2, density 4, geometry 3,
boston 3 → **overall 2.9/10**
Perf: 761 draws / 2.91 M tris. mean 63.3, **p50 44**, 0.51% black.

1. **It is half past one in the afternoon and the frame is a night-blue canyon.** p50 44/255.
   Anything not in direct sun is crushed to near-black blue. A GTA V downtown street at 13:30 is
   bright, with open shadows carrying bounce off the facades opposite.
2. **The horizon step is at its most blatant here**, stepping a facade 15 m away from milky grey
   above the line to dark navy below it, straight through three pedestrians.
3. **Zero moving vehicles on a Financial District street at 13:30** — four traffic shells within
   80 m, *none of them ahead of the camera*, and none on the visible carriageway for 200 m. 37
   parked cars are within 80 m but none are on this block.

Also: **green lawn strips still run down both Financial District pavements** and along the
gutter line (a `verge` band in `Roads.js` `_section`); bright orange autumn-leaf decals glow in
the August gutter; pedestrians are faceless mannequins with no contact shadow.
Blind test: **YES**.

### SHOT: Milk Street road surface, 2.2 m, pitched down, 12:00   VERDICT: **FAIL**
Scores: material 2, geometry 3, density 4 → **overall 2.5/10**
Perf: 915 draws / **3.74 M tris**.

This is the surface the player stares at for the whole game.
1. **No asphalt.** At 3 m the road is smooth pale grey with a faint mottle: no aggregate, no tar
   seams, no wheel-polished lane tracks, no oil stripe, no gutter grime.
2. **The same grey worm-and-loop decal motif repeats five or more times in one frame** at
   different rotations, and it is lighter than the surface. **Automatic fail.**
3. **A yellow-green grass stripe runs the length of the gutter on both sides** in the middle of
   the Financial District.

Good news, credited: the kerb is now real geometry with a granite top band and a vertical face,
not a painted stripe. It needs chips, staining and a gutter channel, but the shape is right.
Blind test: **YES**.

### SHOT: Boylston Street, eye 1.65 m, 15:30 RAIN   VERDICT: **FAIL**
Scores: silhouette 3, material 1, lighting 3, atmosphere 3, grade 3, density 3, geometry 2,
boston 2 → **overall 2.5/10**
Perf: 818 draws / **4.95 M tris**. mean 90.1, p50 81.

1. **Wet asphalt renders WHITE.** The whole carriageway is a pale blue-white sheet that reads as
   ice or fresh snow. Water darkens asphalt and makes it mirror-like; this does the exact
   opposite, and it is the most wrong single thing in the frame.
2. **The wet road reflects nothing** — no buildings, no sky structure, no vertical smear of light
   sources, no puddles (see §4: there is no environment to reflect).
3. **Three dark building slabs float free in the sky** at mid-frame, detached from any mass, plus
   two canopy lobes hanging in space beside a tree. *Automatic fail: objects floating.*

Also: the rain scratches again; parked cars read as a line of boulders along both kerbs; every
building is the same pale grey-white with the same window grid.
Blind test: **YES**.

### SHOT: Acorn Street, Beacon Hill, eye 1.65 m, 10:00 clear   VERDICT: **FAIL — broken geometry**
Scores: silhouette 1, material 4, lighting 4, atmosphere 2, grade 3, density 3, geometry **1**,
boston 3 → **overall 2.6/10**
Perf: 850 draws / **4.22 M tris**.

The most-photographed street in Boston, and the frame is a construction accident. Every object
named below raycasts to `buildings/Mesh` at 2.2–6.4 m:

1. **A forest of free-standing brick piers marches down the middle of the alley**, with nothing
   above them, and one of them is 2.2 m in front of the camera.
2. **Long white concrete string-courses lie diagonally across the carriageway and pass straight
   through the facades**, several of them floating.
3. **A traffic barrel floats at waist height**, a pedestrian is embedded in a wall, and thin
   bright window strips hang free of the right-hand facade.

This is §3 seen from the ground: on a 4.2 m alley, buildings on both sides are built across the
road. Credited: the granite setts and the brick pavement are there and are the right materials.
Blind test: **YES**.

### SHOT: The Charles River, 08:30 clear (Build B, after the water-winding fix)   VERDICT: **FAIL**
Scores: material 1, atmosphere 4, grade 4, density 1, geometry 1, boston 2 → **overall 2.2/10**
Perf: 151 draws / 0.41 M tris.

1. **The river is a matte pale-blue plane.** No waves, no ripples, no normal detail, no specular
   glitter with a low morning sun, no reflection of the far bank, no shoreline transition, no
   foam. Roughness is authored at 0.075 — near-mirror — with nothing to mirror (§4).
2. **A hard black band runs the full frame width where the water meets the far bank**, plus the
   aliased diagonal water edge on the right with no bank, wall or beach.
3. **Zero life on a river that is famous for boats.** No sculls, no sailboats, no docks, no
   bridges in view, no gulls.
4. The far bank is a strip of flat saturated red/blue/tan boxes at one height — a shipping yard,
   not Cambridge.

Blind test: **YES**.

---

## 6. Cross-cutting numbers

### 6.1 The day, at one fixed street camera (Hanover St, 1920×1080, `high`)

| tod | mean | p50 | p05 | clip % | black % | lamp Σ | key I | casts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 03:00 | 60.8 | 56 | 3 | 0.24 | 3.16 | 1092 | 0.14 | yes |
| 06:00 | 105.0 | 88 | 19 | 0.00 | 0.08 | **0** | 4.37 | yes |
| 09:00 | 98.3 | 84 | 14 | 3.31 | 0.02 | **0** | 5.87 | yes |
| 12:00 | 99.4 | 78 | 23 | 0.00 | 0.05 | **0** | 6.06 | yes |
| 15:00 | 100.0 | 89 | 17 | 0.00 | 0.01 | **0** | 5.87 | yes |
| 18:00 | 99.3 | 80 | 18 | 0.00 | 0.42 | **0** | 4.37 | yes |
| 19:30 | 60.0 | 51 | 3 | 0.07 | 3.05 | 1046 | 0.45 | yes |
| 21:00 | 50.7 | 42 | 1 | 0.17 | **6.00** | 1092 | 0.28 | yes |
| 23:00 | 50.1 | 43 | 2 | 0.07 | 4.87 | 1092 | 0.24 | yes |

The exposure fix, the lamp clock-gate and the dusk key-light gap are all genuinely fixed, and
the worst clipping in a whole day is 3.3%. Two things remain wrong: night is **~50%** of noon's
median, which is a dusk histogram not a night one; and **6% of the 21:00 frame is below
luminance 2** — the rubric's "pure black with no detail" threshold. You have traded the top of
the histogram for the bottom. The knob to move is not `NIGHT_SKY` on its own; it is the
combination of the toe and the near-field in-scatter of §1, which is currently adding a floor of
haze to everything above the horizon and nothing below it.

### 6.2 Density, within 80 m of a Financial District street camera

| | now | previous pass |
|---|---:|---:|
| prop families present | **91** | — |
| parked cars | **37** (17 ahead) | 0 |
| decal families | **24** | 0 |
| vegetation families | **14** | 0 |
| store fascias + shop signs | **39** | 0 |
| pedestrians | **80** | 28 |
| **moving traffic shells** | **4, none ahead of the camera** | ~1 per 800 m |

The prop placer fix is real and it is the single biggest improvement in the project. **Traffic is
now the density problem.** A downtown street at 13:30 with no moving vehicle in 200 m is the
number-one tech-demo tell in the rubric, and the parked cars — which are there in numbers — are
424-triangle featureless boxes that actively hurt at close range.

### 6.3 Things that float

Instance Y minus `city.groundHeight()` (wall-mounted props excluded — their height above ground
is meaningless):

| instanced mesh | p50 | max |
|---|---:|---:|
| `traffic_shell_suv_far` | +0.41 | **+7.99** |
| `traffic_shell_police_far` | +0.41 | **+8.14** |

The p50s are axle height and correct. The 8 m outliers are probably cars on bridge decks (where
`groundHeight` returns terrain, not the deck) — I could not separate the two cases and am not
calling it a bug. The floats I *did* see are geometric and unambiguous: detached roof planes
(`hero_skyline` telephoto), floating building slabs and canopy lobes in the Boylston rain shot,
and the free-standing piers, beams and barrel on Acorn Street.

Two `traffic_shell_police_near`/`_far` mesh pairs exist rather than one — a duplicated pair,
worth a glance.

---

## 7. Performance

**I could not obtain a trustworthy `measureFps()` in this session, and I will not quote one.**
Every attempt returned `notCompositing: true` — the shared Browser pane was claimed by other
agents within seconds of each `preview_start`, so rAF delivered 0 frames while `document.hidden`
stayed false. Credit where due: **the new `notCompositing` guard did its job** and refused to
hand me a garbage number, four separate times.

What I can state:

- `gl.finish()`-bracketed synchronous frames on a locked street camera (662 draws, 4.59 M tris):
  **489 / 542 / 521 ms per frame → ~1.9 fps.**
- The engine's own CPU-submission counter on the same frame: 5.3 fps. That instrument
  **over**-reports when GPU-bound, so it is an upper bound.
- Across the session the same locked `street_level` frame returned anywhere from 30 ms to
  3011 ms depending on what sibling agent tabs were doing. The spread is contention, not signal.

Under every instrument available the frame is between **10× and 30× off the 60 fps budget**.
`CURRENT_STATE.md`'s own settled figure is 13 fps. The rubric's automatic fail stands. Re-measure
on a quiet machine before acting on any specific number.

**Budget, which I *can* measure reliably:** 8 of 17 frames over 3.5 M triangles (worst 7.01 M),
1 of 17 over 1200 draws (1238). See §B for where the triangles are.

---

## 8. Automatic fails

1. **Gaps at seams** — two full-perimeter terrain holes at r ≈ 1500 m (8 m wide) and r ≈ 3200 m
   (100 m wide); you see the sky dome's back face through them. Present in every elevated shot.
2. **Objects floating** — roof decks detached from and larger than their buildings
   (`hero_skyline`); building slabs and canopy lobes hanging in the sky (Boylston rain); brick
   piers, concrete beams and a traffic barrel free-standing in the Acorn Street carriageway.
3. **Objects intersecting** — buildings standing on 11.9% of the road centreline; a pedestrian
   embedded in a wall on Acorn Street.
4. **Visible tiling repetition** — the road crack/patch decal motifs repeat 4–5× at different
   rotations inside a single frame, on Newbury Street and in the road close-up; the facade
   pinstripe repeats at one scale across the entire skyline and moirés.
5. **Pure-black regions with no detail** — 6.00% of the 21:00 frame and 6.38% of `night_neon`
   below luminance 2; `downtown_dusk`'s streets are 1.06% clipped black.
6. **Over the triangle budget** — 8 of 17 frames, worst 7.01 M against 3.5 M.
7. **Over the draw-call budget** — Beacon Street at 1238 against 1200.
8. **Under 60 fps at 1080p on `high`** — ~2 fps by `gl.finish()`, 13 fps by the project's own
   settled figure. Not directly re-measurable this session (§7).
9. **Empty streets** — zero moving vehicles ahead of the camera on Milk Street at 13:30 and on
   Mount Vernon Street at noon.

**Not a fail this session:** console errors (`errors` and `glFaults` empty after all 17
captures), z-fighting, shadow acne, snow banks in clear weather, the perimeter building hole,
the pinned exposure, lamps at noon, the dusk key-light gap, oversized street-tree trunks.

---

## 9. What we have been missing

The named shot set has been hiding the game from itself. Every one of the eight named shots is
either aerial, distant, or in a park; **not one of them is a level camera at eye height on a
built street**, which is the only framing the player will ever see. Consequences:

- The **horizon step (§1)** does not appear in an aerial or pitched shot. It is in *every*
  street frame, and it is the most visible defect in the game.
- The **triangle overrun (§B)** does not appear in the named set. Every street frame blows it.
- The **parked-car shell** is invisible from 150 m and unmissable at 3.7 m. It is now the
  dominant foreground object on half the streets in the city because 9,600 of them were placed.
- **Buildings in the road (§3)** are invisible from above and catastrophic at 1.65 m.
- **Signage is blank.** `shopSignA/B` and `storeFasciaA/B` are now placed in good numbers — and
  they are white boards with nothing written on them. Placing them without artwork made the
  problem *more* visible, not less.
- **The green verge band runs down downtown gutters** on every Financial District street.
- **Pedestrians have no faces, no hands and no contact shadows**, and at eye height they are the
  closest thing to the camera after the road.

Two process fixes, more valuable than any single art fix:
1. **Put four eye-height street shots into `CaptureHarness.shots`** — one Beacon Hill, one
   Financial District canyon, one North End at dusk, one rain-on-tarmac — and make them the
   default review set. Also give `unstick` an inside-a-footprint test against `specs[].poly`
   (`golden_hour` still fails, §5).
2. **Add a boot smoke-test to AGENTS.md's validation list.** `parsecheck` passed on a tree that
   did not boot; the shared verify server was serving a dead build to every agent.

---

## OVERALL: 3/10 — KEEP WORKING

Real, measurable progress since 2/10: the city is populated, the exposure moves with the clock,
the lamps obey it, there is a shadow-casting key at every hour, the perimeter is built, the props
are city-wide, the kerbs are geometry, and the sky is the best thing in the project. Every one of
the seventeen frames still fails the blind test on sight, and three new automatic fails
(terrain holes, buildings in the road, the horizon step) are as bad as anything the previous pass
found.

### Ranked highest-leverage fixes

| # | Fix | Owner | Why it ranks here |
|---|---|---|---|
| 1 | **Make aerial perspective a function of distance, not of `rd.y`.** In `atmospherePass.glsl.js` `COMPOSITE_FRAG`, the `inscat` term steps ~60/255 across the horizon row on geometry 14 m away, and it changes 99.1% of every frame. Fix the sky-view LUT lookup across the horizon (and drop the `max(rd.y,-0.02)` clamp), then re-tune `uSkyIntensity` (24) so near-field in-scatter is not two orders of magnitude above surface radiance. | **atmosphere** | A hard line across the middle of every street frame in the game. Nothing else can look right until it goes. |
| 2 | **Close the two terrain LOD ring holes** at r ≈ 1500 and r ≈ 3200 — make each outer patch's inner boundary land exactly on the inner patch's outer edge, or overlap and depth-bias. | **city / terrain** | Full-width see-through slots around the whole world; visible in every elevated shot. `Terrain._patch`/`build`. |
| 3 | **Stop building on the roads.** 720 of 6,038 road-centreline samples are inside a building footprint. Clip parcel polygons against the road corridor (`halfRoad` + pavement) before `makeSpec`. | **city / buildings** | Automatic fail, gameplay blocker, and it is what makes Beacon Hill look like a demolition site. |
| 4 | **Give parked cars a real LOD0.** `prop:parkedCar` is 424 triangles with no wheels, glass, lights or door lines, and 9,600 of them are placed at the kerb where the player walks. At 3.7 m it is the dominant object in frame. | **props / vehicles** | Turns the best density work in the project from an asset into a liability. |
| 5 | **Give the world something to reflect.** `scene.environment` is a 336×256 sky-only PMREM and no material has an `envMap`; glass is authored at roughness 0.06 and water at 0.075. Either raise the probe resolution and bake local content, or add SSR. | **materials / render** | Dead glass, a matte river and a wet road that reflects nothing are three separate rubric failures with one cause. |
| 6 | **Author the road surface.** Real asphalt aggregate at 2 m, tar seams, wheel-polished tracks, an oil stripe, gutter grime — and replace the decal set: darker-than-asphalt patches, jagged branching cracks, and no motif repeating inside one frame. | **materials** | The player looks at this more than anything else, and its repetition is an automatic fail today. |
| 7 | **Get street frames under the triangle budget.** 8 of 17 over, worst 7.01 M; ~3.3 M of that is shadow-cascade re-submission, not the camera pass. Distance/size-gate the LOD-2 shell sectors per cascade. | **render / lighting** | The only budget breach I can measure cleanly, and it is entirely one subsystem. |
| 8 | **Put text on the signage and shopfronts on the ground floor.** `shopSignA/B` and `storeFasciaA/B` place fine now and render as blank white boards. | **props / materials** | Cheapest remaining jump in "density & life"; the placement work is already done. |
| 9 | **Raise traffic density near the camera by an order of magnitude.** 4 shells within 80 m and none ahead of the camera on a downtown street at 13:30. | **traffic** | Empty streets are the rubric's #1 tech-demo tell. |
| 10 | **Make wet asphalt dark.** Rain currently lightens the road to near-white; it should go black and specular. | **materials / atmosphere** | One constant, one of the most wrong things in the game. |
| 11 | **Re-author the rain particles** — thin, short, near-field-only streaks with density falloff, splashes and spray, and stop them clipping to white with CA fringes. And keep the ripple decals off grass. | **atmosphere** | The rain state currently looks like film-scratch damage. |
| 12 | **Cap the roof decks to their own footprints and put clutter on them** — HVAC, tanks, penthouses, vents, railings. | **buildings** | Floating roof slabs are an automatic fail; bare roofs are why the skyline reads as a massing model. |
| 13 | **Break up the facade library**: one pinstripe at one scale across the whole skyline, and one lit-window brightness for every window in the city at dusk. Vary lit fraction, colour temperature and blind state per unit. | **buildings / lighting** | `downtown_dusk`'s LED-matrix look is the single thing that most gives that frame away. |
| 14 | **Turn N8AO off half-res, or add a second contact-scale AO term.** There is no contact darkening at all where a white sill meets brick, where a prop meets the pavement, or in a facade reveal. | **render** | Everything reads as decals on flat planes without it. |
| 15 | **Fix the named shot set**: `golden_hour` is still inside a building (`unstick` returns `moved: 0` — add a footprint test), `rain_street` and `street_level` are the same park, `bridge` points away from the water. Add four eye-height street shots. | **capture harness** | Until this is done the review set does not look at the game. |
| 16 | **Kill the green verge band on downtown streets**, and gate `decal_leaves` on season. | **city / roads** | Lawn strips down the Financial District gutter, autumn leaves in August. |
| 17 | **Give pedestrians faces, hands and contact shadows**, and stop the LOD colour shift on trees (near dark green, far pale grey in the same frame). | **AI / vegetation** | Both are unmissable at eye height, which is where the game is played. |
