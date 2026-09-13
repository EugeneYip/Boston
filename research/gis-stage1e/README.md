# Stage 1E workspace — factual road source feasibility (PASS)

No `src/` change, no runtime activation, no flag, no WebGL. Architecture is
**fetch/pin → raw (gitignored) → normalize → deterministic offline probe**.

| file | what it does |
|---|---|
| `roads.mjs` | loads the pinned raw extracts from `cache/` and projects them with production `geo()` |
| `normalize.mjs` | → `backbay-roads.json` (committed fixture) + `provenance.json` (catalog URLs, CKAN licence ids, service URLs, bbox query, raw SHA-256s, topology) |
| `probe.mjs` | → `probe.json`. Reads the **fixture**, never the network. Byte-identical on rerun |

```
node research/gis-stage1e/probe.mjs      # offline, deterministic
node research/gis-stage1e/normalize.mjs  # needs cache/, re-acquire per provenance.json
```

**PRIMARY: Boston Street Segments (SAM System)** — Boston Maps, **ODC-PDDL-1.0** (pinned from the CKAN API,
not inferred). The decisive result needs no width assumption: Boston's hand-authored road lines are inside a
factual building in **42.35%** of samples; SAM's surface streets in **0.23%**. SAM's unfiltered 8.84% is the
Mass Pike (`ZLEV −1`, a tunnel), its ramp, and a pedestrian plaza (`CFCC A71`) — the layer identifies its own
exceptions. The two factual sources agree with each other to **p50 1.00 m** and both sit **p50 10.64 m** from
Boston, corroborating Stage 1D's 9.12 m.

See `../GIS_HYBRID_WORLD_STAGE1E_FACTUAL_ROAD_SOURCE_FEASIBILITY_2026-09-13.md`.
