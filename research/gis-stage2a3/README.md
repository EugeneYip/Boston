# Stage 2A.3 — port closure and seam containment

Report: `research/GIS_HYBRID_WORLD_STAGE2A3_PORT_CLOSURE_2026-09-13.md`

Run order:

```
node research/gis-stage2a3/port-ledger.mjs      # PRE-FIX ledger: the Stage 2A.2 state, 23 ports, 9 connected
node research/gis-stage2a3/build-candidate.mjs  # regenerate src/data/gis-backbay-roads.js  (DEFAULT OFF)
node research/gis-stage2a3/validate.mjs         # 16 invariants
node research/gis-stage2a3/containment.mjs      # changed geometry against the DECLARED seam
node research/gis-stage2a3/seam-residual.mjs    # what is left, by mechanism
node research/gis-stage2a3/newnodes.mjs         # junctions gained/lost beyond the seam (0 and 0)
node research/gis-stage2a3/views.mjs            # re-verify the camera-fair set in both worlds
node research/gis-stage2a3/sink.mjs             # local capture sink on :5299, for the browser pass
node research/gis-stage2a3/capture-diff.mjs     # A/B against the A/A floor
```

`captures/` holds the PNGs and raw RGBA buffers and is gitignored; `captures.json` and `capture-diff.json`
carry the camera metadata, file hashes and measurements.

`gis-stage2a-validate.json`, `gis-stage2a1-validate.json`, `gis-stage2a2-sink.json` and
`gis-stage2a2-systems.json` are **this stage's** re-runs of the earlier suites, kept here so the earlier
stages' own committed outputs stay as they were.

`symmetric-trace.json` and `pairing-raw.json` are the Phase 2 evidence: every clipped stub end replayed
against every predicate of the Stage 2A.2 symmetric pass, and the crossing/port geometry the structural
matcher is built on. They were produced by instrumented copies of the Stage 2A.2 generator, which are not
kept — the finding is a proof (a symmetric predicate cannot admit a pair its first pass refused) and the
JSON is its corroboration.
