# Stage 1B.1 workspace — transactional replacement + multi-parcel association

Headless harnesses over the **real** Boston pipeline. `Buildings` and `Facades` import cleanly under Node —
no WebGLRenderer is constructed at module scope and neither `_collectPlots` nor `_buildSpecs` touches the GPU
— so every number here comes from production code rather than from a model of it. The baseline reproduces the
browser exactly: 10,278 specs citywide, 10,944 plots, 361 in the prototype box, clip `{15, 1, 778, 26}`.

| file | what it answers |
|---|---|
| `pipeline.mjs` | runs the real `_collectPlots` + `_buildSpecs` headlessly; exports `makeBuilder` |
| `measure.mjs` → `measure.json` | gate-free overlap distributions: what does the geometry actually look like? |
| `classify.mjs` → `classify.json` | dominant-owner association swept over share × margin |
| `run.mjs` → `run.json` | the transactional replacement through the real pipeline; `--sweep` for alternatives |
| `coverage.mjs` → `coverage.json` | street-facing frontage coverage and longest contiguous factual run |
| `views.mjs` → `views.json` | fixed viewpoints derived **from** the accepted geometry |
| `validate.mjs` → `validate.json` | 23 invariants, flag off and flag on |
| `captures.json` | paired A/B metadata, camera state and SHA-256s (raw PNGs are gitignored) |

Run order: `pipeline` → `measure` → `classify` → `run` → `coverage` → `views` → `validate`.

`cache/`, `captures/` and the `pair-*.png` / `void-*.png` composites are gitignored: the raw image payload is
~21 MB and the brief keeps it out of git. Camera metadata and hashes are committed so any pair can be
reproduced.

**Result: FAIL.** See `../GIS_HYBRID_WORLD_STAGE1B1_MULTI_PARCEL_RUNTIME_2026-09-12.md`. The one number that
carries the verdict: a factual footprint renders **52.6%** of the mass of the procedural building it replaces,
so replacement hollows out the block interior.
