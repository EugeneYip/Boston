# Stage 2A.4 — causal influence reconciliation and final acceptance

Report: `research/GIS_HYBRID_WORLD_STAGE2A4_CAUSAL_INFLUENCE_CLOSEOUT_2026-09-13.md`

Run order:

```
node research/gis-stage2a3/build-candidate.mjs   # regenerate (DEFAULT OFF) — the _along fix lives here
node research/gis-stage2a4/road-audit.mjs        # every changed ROAD edge, attributed; unintended splits
node research/gis-stage2a4/parcel-ledger.mjs     # every changed parcel, ONE primary cause each
node research/gis-stage2a4/envelope.mjs          # the two nested regions; what lies outside them
node research/gis-stage2a4/huntington.mjs        # dense scan: is the phase residual minimal?
node research/gis-stage2a4/port-ledger.mjs       # 23 ports -> final states; dead-end classification
node research/gis-stage2a4/sink.mjs              # local capture sink on :5299, for the browser pass
node research/gis-stage2a4/capture-diff.mjs      # A/B against the A/A floor
```

`captures/` (PNGs and raw RGBA) is gitignored; `captures.json` and `capture-diff.json` carry the camera
metadata, file hashes and measurements.

The `gis-stage2a-*.json`, `gis-stage2a1-*.json`, `gis-stage2a2-*.json` and `gis-stage2a3-*.json` files here
are **this stage's** re-runs of the earlier suites, kept so each earlier stage's own committed outputs stay
as they were.

## What this stage changed

One defect, found by audit and fixed: `lotGridCut` built the segment list for `RoadNetwork._along` with
`s: 0` on every segment instead of the cumulative arc, so every candidate cut position past the first
segment came back up to 454 m from the lot boundary it was meant to be. Fixed in
`research/gis-stage2a3/build-candidate.mjs`; `src/data/gis-backbay-roads.js` regenerated. No production
logic changed.
