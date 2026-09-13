# Stage 1D workspace — road / street-frame registration diagnosis (READ-ONLY)

No `src/` change, no runtime transform, no WebGL, no network, no new data source, no DOIT.

| file | what it answers |
|---|---|
| `samples.mjs` | the diagnostic sample set and the semantics behind it — 2,165 points where both allowed sources see a wall and agree within 0.5 m |
| `fit.mjs` | the model family. Every model displaces the procedural front line, so each is linear in its parameters; trimmed least squares |
| `run.mjs` | **deterministic entry point** → `summary.json`: global/per-street fits, intersection test, cross-validation |
| `tail.mjs` | → `tail.json`: bounded classification of Stage 1C's ~20% source-disagreement tail |

```
node research/gis-stage1d/run.mjs
node research/gis-stage1d/tail.mjs
```

Both artifacts are byte-identical on rerun.

**Result: DIAGNOSIS STRONG, dominant cause `MIXED_LOCAL_GEOMETRY`.** A global rigid fit buys (−0.15, −2.41) m
and −1.15°, removing 9% of the residual and 0% of the admissibility gap. Per-street corrections are
idiosyncratic (lateral sd 4.29 m, width sd 8.36 m) and **do not transfer between the two sides of the same
street** — per-street width trains at 8.16 m and scores 16.40 m held-out, worse than no correction at all.
The root cause is in the repo: `src/data/boston-geo.js` is hand-authored, "a median ~25 m from reality", and
Back Bay is an idealised rotated grid fitted to landmark anchors.

See `../GIS_HYBRID_WORLD_STAGE1D_ROAD_REGISTRATION_DIAGNOSIS_2026-09-13.md`.
