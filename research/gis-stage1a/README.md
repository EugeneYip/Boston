# research/gis-stage1a — Back Bay data-only factual geography probe

**Stage 1A. Research only. No runtime integration, no `src/` change, no WebGL.**
Authorised scope is data acquisition, normalization and measurement. Stage 1B (any runtime
consumer) is **NOT authorised**.

Read `../GIS_HYBRID_WORLD_STAGE1A_BACK_BAY_PROBE_2026-09-12.md` for the findings.
Where documents disagree, `../GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md` is canonical.

## Reproduce

```bash
# 1. raw extract -> cache/ (gitignored, never committed)
#    see manifest.json "selectionQuery" for the exact query string
# 2. normalize (no network; reads cache/, writes fixture.json)
node research/gis-stage1a/normalize.mjs
# 3. structural validation (exits non-zero on failure)
node research/gis-stage1a/validate.mjs
# 4. metrics M1 / M2 / M3
node research/gis-stage1a/run-metrics.mjs
```

`normalize.mjs` is deterministic: three consecutive runs produced a byte-identical
`fixture.json` (sha256 in `manifest.json`).

## Files

| file | what it is |
|---|---|
| `bbox.mjs` | the area, resolved once, in WGS84 and Boston local X/Z |
| `transform.mjs` | independent inverse LCC used to **verify** the server's reprojection |
| `current-world.mjs` | builds the CURRENT world's parcels headlessly — no renderer |
| `normalize.mjs` | raw ArcGIS JSON -> `fixture.json` |
| `validate.mjs` | structural validation -> `validation-report.json` |
| `metrics.mjs` / `run-metrics.mjs` | M1/M2/M3 -> `metrics-report.json` |
| `manifest.json` | provenance, one record per source |
| `schema-v0-candidate.json` | the proposed normalized schema, for review |
| `fixture.json` | 218 normalized building parts |
| `cache/` | raw downloads — **gitignored** |

## Why `current-world.mjs` needs no browser

`RoadNetwork.js` imports zero THREE. `Terrain.bake()`, `stampRoads()`, `groundHeight()` and
`Districts.bake()` touch THREE only for module-scope scratch objects. So the real production
path up to `RoadNetwork.buildPlots()` — the same call `City.init()` makes — runs in Node in
~420 ms with no renderer and no canvas. Nothing here constructs a `WebGLRenderer`.

## Removal

```bash
rm -rf research/gis-stage1a
```
Nothing outside this directory was created or modified.
