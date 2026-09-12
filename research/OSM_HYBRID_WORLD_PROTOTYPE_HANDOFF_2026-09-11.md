# Prototype handoff — GIS hybrid world, stage 1

**Companion to** `research/OSM_HYBRID_WORLD_FEASIBILITY_2026-09-11.md` (read §N and §O before starting).
**Status** NOT AUTHORISED. This describes what stage 1 *would* be, so a successor AI can start in one sitting
without re-deriving the study. **Do not build it without explicit Owner authorisation.**

---

## The one-paragraph version

Boston's world is generated from 98,932 bytes of hand-authored geography that sits a **median 24.7 m** from
reality. The proposed fix is not a rewrite: it is to feed the existing procedural systems better factual input,
offline, exactly the way `src/data/neu-hero.js` is already fed from City of Boston PDDL data. Stage 1 does not
generate anything — it draws imported footprint outlines beside the existing city and measures how far apart
they are. **If that distance is > 20 m, the whole programme stops.**

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
  README.md  config.mjs  fetch.mjs  manifest.mjs  normalize.mjs  validate.mjs  build.mjs
  .gitignore                  # .cache/    ← raw extracts NEVER committed
  fixtures/backbay.canonical.json          # the only committed data, ~20 KiB
src/world/GisProbe.js         # opt-in, default OFF, behind ?gisProbe=1
```

`GisProbe` draws the imported outlines as flat ribbons at `groundHeight() + 0.05`. **It generates no buildings,
no parcels, no colliders, and modifies no existing file.** Removal is `rm -rf tools/osm-prototype
src/world/GisProbe.js` — a pure deletion; `src/main.js` auto-loads systems via `import.meta.glob` and a missing
file degrades gracefully (`AGENTS.md` rule 3).

**Area:** Back Bay, 400 m square, bbox `42.347703,-71.082431,42.351297,-71.077569`
(world ≈ x ∈ [−1450, −1050], z ∈ [−600, −200]). 154 buildings, median 5 corners.
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
| citywide massing, later | **Boston 3D Buildings (Existing)** — authoritative, updated June 2026, **not yet mined** | PDDL |
| **cross-check only** | OpenStreetMap via Overpass | **ODbL — geometry must never be committed** |

`Districts.isReserved` → `inHeroFootprint` is the existing keep-out hand-off. Reuse it. Do not invent a second.

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

## Gates — the one that decides everything

Full table in study §O. The decision gate:

> **GEO-1 — median offset between imported footprints and the existing streetwall over the block.**
> **PASS ≤ 8 m · PARTIAL 8–20 m · FAIL > 20 m.**

Context: the existing world is median 24.7 m from reality, so the two frames landing within 8 m of each other
means they are compatible and everything downstream is tractable. A FAIL means factual footprints and the
hand-authored street grid cannot coexist without moving the roads — which means moving everything — and the
honest response is to stop.

Hard stops, no retry: any `GAME-*` change · `PERF-4` (a second WebGL context) · any `LEG-*` failure.

Determinism (`STR-1`) is byte-identical output across two runs from the same cache. Ship it as a fixture test —
the Northeastern pipeline has none, and a successor currently cannot verify a regeneration is correct.

---

## What comes after, and in what order

`0 freeze → 1 Back Bay probe → 2 North End probe → 3 coordinate contract (no numeric change) →
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
