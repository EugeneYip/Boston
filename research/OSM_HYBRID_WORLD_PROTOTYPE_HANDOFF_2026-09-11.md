# Prototype handoff — GIS hybrid world, stage 1

**Companion to** `research/OSM_HYBRID_WORLD_FEASIBILITY_2026-09-11.md` (read §N and §O before starting).
**Status** NOT AUTHORISED. This describes what Stage 1A *would* be, so a successor AI can start in one sitting
without re-deriving the study. **Do not build it without explicit Owner authorisation.**

> ### CORRECTED 2026-09-12 — read `research/GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md` first
>
> That note is **canonical** where it disagrees with this file or with the study. Affecting this page:
> **Stage 1 is now split** into Stage 1A (data only, no `src/`) and Stage 1B (runtime overlay, **not
> authorised**) — only 1A is described below; the **GEO-1 8 m / 20 m gate is withdrawn** and replaced by the
> M1–M4 baseline; the Boston 3D layer **was already mined and superseded**; and the no-ODbL-geometry rule is
> **project policy, not a licence requirement**.

---

## The one-paragraph version

Boston's world is generated from 98,932 bytes of hand-authored geography. Measured against OSM inside the one
district where it has been checked, the streets fed from **authoritative GIS** sit a median **2.4–6.0 m** off,
while the **hand-traced** streets sit a median **37.5–95.3 m** off (`docs/neu/GAPS.json`) — the same system,
6x to 40x more accurate where it is fed from real data. The proposed fix is not a rewrite: it is to feed the
existing procedural systems better factual input, offline, exactly the way `src/data/neu-hero.js` is already
fed from City of Boston PDDL data. **Stage 1A generates nothing and renders nothing** — it imports one block's
footprints, converts them through the game's own `geo()`, and reports how far they sit from the world Boston
already builds there. That distance has never been measured outside Northeastern.

---

## Before you touch anything

```bash
mount | grep /Volumes/Projects     # must be mounted; if not, STOP
git status -sb
```

Frozen, do not reopen: **Northeastern** (second-stage technically CLOSED; Owner visual acceptance separate and
outstanding) · **close-range parked-car P0** (CLOSED) · **NPC hair** (BLOCKED on one raster capture, unrelated).

Locked files: `src/core/*`, `ARCHITECTURE.md`, `index.html`, `package.json`.
**`src/core/Geo.js` must not change** — see study §C.4. Its constants are the world frame; altering them moves
every existing feature by up to 6.5 m, including frozen Northeastern.

---

## What stage 1 builds

```
tools/osm-prototype/          # name per the brief; the SOURCES are City of Boston + MassGIS, not OSM
  README.md  config.mjs  fetch.mjs  manifest.mjs  normalize.mjs  validate.mjs  build.mjs  measure.mjs
  .gitignore                  # .cache/    ← raw extracts NEVER committed
  fixtures/backbay.canonical.json          # the only committed data, ~20 KiB
```

**NO `src/` file. No runtime consumer. No WebGL, browser, Vite or build. No new dependency.** Removal is
`rm -rf tools/osm-prototype` — a pure deletion, nothing to revert.

`src/world/GisProbe.js` — the opt-in, default-off overlay behind `?gisProbe=1` — belongs to **Stage 1B and is
NOT authorised.** Do not create it in this stage even though it is small; it is the first change to `src/` and
needs its own Owner review after Stage 1A reports.

**Area:** Back Bay, 400 m square, bbox `42.347703,-71.082431,42.351297,-71.077569`
(world **x ∈ [−1380.46, −980.50], z ∈ [+454.52, +854.60]**, 399.96 × 400.08 m).
**[CORRECTED 2026-09-12 by Stage 1A]** the earlier annotation `x ∈ [−1450, −1050], z ∈ [−600, −200]` was
wrong in magnitude and in the sign of z; the WGS84 bbox is authoritative and reconstructs from centre ± 200 m
to 4e-7 deg. OSM reports 154 buildings here; the authoritative City layer reports **218 roof-break parts**.
Chosen because Back Bay is generated from an exact surveyed frame (`bb()`, `BB_BEARING` 251.5°), so any
mismatch is attributable to the import rather than to authoring scatter. It is also Boston's *least*
representative neighbourhood — the North End is the real difficulty test, and is stage 2.

---

## Sources to use, and the one not to

| use | source | licence |
|---|---|---|
| footprints + heights | City of Boston **Buildings with Roof Breaks** — `gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer/9` | **PDDL** |
| parks | City of Boston **Open Space** (Analyze Boston) | PDDL |
| road comparison | **MassGIS-MassDOT Roads** (read-only, for measurement) | public record, redistributable |
| height cross-check / post-2011 gap-fill | **Boston 3D Buildings (Existing)** — item `d01bebadca584c249960f1eb6080f88c`. **Already mined** (4,616 buildings) and **superseded** for named-building heights: `Height_Ft` runs high (Prudential 233.6 vs a known 228). Upper bound only. | PDDL, via the `data.boston.gov` record naming that exact service |
| **cross-check only (this stage)** | OpenStreetMap via Overpass | ODbL — geometry not committed. **This is project policy, not a licence prohibition** (acceptance §4). OSM is PRIMARY on merit for footway, crossing, rail, landuse, POI and hero-candidacy signals (acceptance §1) |

`Districts.isReserved` → `inHeroFootprint` is the existing keep-out hand-off. Reuse the **pattern**; do not
invent a second. But see acceptance §10: the NEU implementation is campus-specific — the *part-not-building*
unit, `MICRO_M2 = 100`, the campus-polygon envelope and `crossesPath` against the Huntington arterial do
**not** generalise. `src/world/NeuHero.js` and `src/data/neu-hero.js` are read-only reference, never a
template to edit. Northeastern stays frozen.

---

## Traps already paid for — do not rediscover these

1. **Project through the game's own `geo()`.** A private projection would disagree with the engine and the
   disagreement would look like a geography defect (`tools/neu-audit/README.md`).
2. **Overpass answers 406 without a `User-Agent`**, and 429 on rate limit. Have a mirror.
3. **Sample well inside the extract.** Measuring to the bbox edge measures the boundary, not the road —
   Tremont Street once scored a 2,268 m "error" that way.
4. **Centroids must be area-weighted**, not vertex means; detailed frontages drag a vertex mean streetward.
5. **MassGIS divided roads are two carriageways.** Averaging them leaves a ~6–8 m half-median residual that is
   *geometry, not error*.
6. **Vintage ≠ extract date.** The footprint layer is a 2010 snapshot; the sidewalk layer is 2011 and predates
   ISEC (2017) and EXP (2024). A "missing" building may simply postdate the source.
7. **`THREE.ShapeUtils.triangulateShape` flips handedness 2D→XZ.** Reverse the winding (`Districts._mesh`).
8. **Parcels are not footprints.** `plot.polygon` is exactly 4 vertices and carries `frontage`/`edgeId`/`side`;
   `Buildings.js:1051` enforces it. A footprint tier is a *parallel* path, not a substitution.
9. **Missing material-bucket NAME ≠ missing geometry.** This project has made that error four times. Inspect
   generated geometry, never comments.
10. **A hidden Browser pane part-composites screenshots and carries a stale HUD.** If visual checks are needed,
    the pane must be visible.

---

## Metrics — what Stage 1A actually produces

**The old GEO-1 gate (≤ 8 m PASS / > 20 m FAIL) is WITHDRAWN as arbitrary.** It was one number doing three
jobs, calibrated against a landmark statistic that measures something else. Four separated metrics replace it
(acceptance §7):

| id | measures | definition |
|---|---|---|
| **M1** | source consistency | Roof Breaks footprint centroid vs the independently produced OSM centroid for the same building. **Not accuracy** — no survey reference exists |
| **M2** | current-world displacement | perpendicular distance from each imported footprint's street-facing edge to the `frontage` polyline of the generated parcels on the owning road edge. Exclude parcels whose building has `frontDirs.length > 1` (corner/setback) and report them separately |
| **M3** | translation-removed residual | fit the best rigid **translation** over the block, report it, re-report M2 on the residual. Report fitted rotation and scale separately and **do not** remove them |
| **M4** | prototype improvement | **Stage 1B only** — not measurable here |

Report full distributions (min / median / p90 / max, n, histogram), not a verdict. Decision bands, anchored to
in-project precedent rather than invented:

- **≤ 6 m** — as good as the MassGIS-sourced streets already achieve (Huntington 6.0, Columbus 2.4).
- **6–37 m** — informative; needs judgement.
- **≥ 37 m** — no better than Tremont Street, the worst hand-traced street already shipped. **STOP signal.**

Hard stops, no retry: any `GAME-*` change · `PERF-4` (a second WebGL context) · any `LEG-*` failure.
Note `LEG-2` is **project policy, not a licence requirement** (acceptance §4).

Determinism (`STR-1`) is byte-identical output across two runs from the same cache. Ship it as a fixture test —
the Northeastern pipeline has none, and a successor currently cannot verify a regeneration is correct.

---

## What comes after, and in what order

`0 freeze → 1A Back Bay data probe → 1B default-off overlay (separate authorisation) → 2 North End probe →
3 coordinate contract (no numeric change) →
4 footprints, shell tier only → 5 footprints gain facades + collision → 6 parks/water/rail →
7 hero registry → 8 terrain DEM → 9 roads → 10 district-by-district`

**Roads and terrain are last on purpose.** They are the roots every other contract hangs off, and stages 4–7
capture most of the benefit at a fraction of the risk. Never reaching 8–9 is an acceptable outcome.

Stage 8 is **blocked** until the vertical datum is reconciled: the game is sea-level-zero, MassGIS lidar is
NAVD88, `docs/neu/SOURCES.md` records them as unreconciled with a ~+1.5 m observed offset, and `WATER[].level`
holds the Charles ~2 m above sea level.

---

## Two documentation corrections this study found, not applied

Both are in locked or generated files, so they were left alone. They need an Owner decision:

1. **`src/core/Geo.js:2`** — *"Accurate to <1m over the 6km play area."* Measured max error vs the WGS84
   geodesic is **6.47 m**, with 3680 ppm of anisotropy. The claim is an over-claim by ~6.5×. `src/core/*` is
   locked by `ARCHITECTURE.md`.
2. **`docs/neu/ANCHORS.json`** — *"NOT the projection, which is exact by construction."* True of the world
   frame's internal self-consistency; not true of its agreement with WGS84. The file is generated by
   `tools/neu-audit/build.mjs`, so the fix belongs in the generator.

Neither affects runtime behaviour. Neither is urgent. Both would mislead a successor who trusted them.

---

*Research only. Nothing here is authorised. The Owner must approve architecture, licence implications,
prototype scope and migration risk before any of it is built.*
