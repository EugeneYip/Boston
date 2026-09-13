# Stage 2A.2 workspace — seam closure, degree-2 test, runtime acceptance

| file | what it does |
|---|---|
| `degree2.mjs` → `degree2.json` | Mission A: is the junction floor real? Representable yes; contains the blast radius only on the lot grid |
| `build-candidate.mjs` → `src/data/gis-backbay-roads.js` + `candidate-manifest.json` | cuts on the LOT GRID, not the bbox and not at junctions |
| `containment.mjs` → `containment.json` | containment against the frozen seam, matched by displacement |
| `sink.mjs` → `sink.json` | Mission C: exact one-way sink diagnosis |
| `systems.mjs` → `systems.json` | routing cases, trap census, spawns, tunnel isolation |
| `views.json` / `captures.json` | Stage 2A.1 camera-fair set, recaptured at 1350x840 |

**Headline:** the Stage 2A.1 "junction floor" is **rejected**. `buildPlots` lays lots at `k·acc/round(acc/w)`,
so a cut at `p = k·step` gives `step1 = step2 = step` and **both halves keep the baseline phase**. A junction is
just one lot boundary among many. The seam drops from **216.15 m to 6.96 m**.

**Runtime, all against a control run:** traffic PASS (0 off-road, 0 in-building, stuck counts equal to
baseline), pedestrians PASS (0 in buildings, 44% fewer on the carriageway than baseline), collision PASS
(0 stale road collision), spawns PASS. Registration back to **0.22%** pathology and **5.83 m** median.

**Still open:** 295 parcels beyond the seam on four streets, and one one-way sink — both tracing to the 14
factual ports that still carry no connector.

See `../GIS_HYBRID_WORLD_STAGE2A2_SEAM_RUNTIME_CLOSEOUT_2026-09-13.md`.
