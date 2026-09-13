# Stage 2A workspace — factual road backbone (PASS, DEFAULT OFF)

Swaps one thing: the geographic centreline backbone inside a 400 × 400 m Back Bay box. Every width, class,
frontage rule, parcel rule, facade, sidewalk, prop and collider is the code that was already there.

| file | what it does |
|---|---|
| `build-candidate.mjs` | Stage 1E fixture → `src/data/gis-backbay-roads.js` (generated) + `candidate-manifest.json`. Offline, deterministic |
| `headless.mjs` | → `headless.json`. Control vs candidate through the real generation code; registration and blast-radius metrics |
| `validate.mjs` | → `validate.json`. 26 invariants: default-off parity, flag mutual exclusion, topology, dependents |
| `views.mjs` | → `views.json`. Cameras derived from the candidate, held ≥45 m inside the core |
| `captures.json` | paired A/B metadata, camera state, SHA-256s (PNGs gitignored) |

```
node research/gis-stage2a/build-candidate.mjs
node research/gis-stage2a/headless.mjs
node research/gis-stage2a/validate.mjs
```

**Headline:** road line inside a factual building **42.35% → 0.22%**; Boston's own generated streetwall moves
from **16.77 m → 5.84 m** from the real wall, with no factual building data involved. 26/26 invariants,
Northeastern untouched, no new landmark violation. Counterweight: re-subdivision reaches up to 284 m outside
the core on 14 streets, and the district overview reads busier.

See `../GIS_HYBRID_WORLD_STAGE2A_FACTUAL_ROAD_BACKBONE_RUNTIME_2026-09-13.md`.
