# Stage 2A.1 workspace — seam containment, dependent systems, Commonwealth, Huntington

| file | what it does |
|---|---|
| `blast-trace.mjs` → `blast-trace.json` | attributes the Stage 2A 284 m blast radius to a mechanism |
| `seam-design.mjs` → `seam-design.json` | derives the seam from baseline junction topology (17 anchors) |
| `build-candidate.mjs` → `src/data/gis-backbay-roads.js` + `candidate-manifest.json` | contained generator |
| `commonwealth.mjs` → `commonwealth.json` | boulevard diagnosis: pairing, widths, mall intrusion |
| `systems.mjs` → `systems.json` | routing cases, trap census, spawns, tunnel isolation |
| `validate.mjs` → `validate.json` | 13 Stage 2A.1 invariants |
| `views.mjs` → `views.json` | camera-fair viewpoints, verified in open air in BOTH worlds |
| `captures.json` | paired A/B metadata and hashes (PNGs gitignored) |

**Result: PARTIAL.** Three of four Owner objections closed — `nuniv` resolved at root (per-vertex arrays were
not clipped with the path), Commonwealth reservation cleared and mall legibility improved, cameras now
camera-fair. Containment improved (outside-core changes 1,038 → 754, max 284 → 232 m) but the contract is not
met: **16 parcels change beyond the declared 216 m seam**. That seam is a floor set by Boston's junction
spacing, because `buildPlots` subdivides per edge.

Registration held: procedural wall → factual wall median **5.78 m** (Stage 2A 5.84, control 16.77).

See `../GIS_HYBRID_WORLD_STAGE2A1_SEAM_AND_DEPENDENT_SYSTEMS_2026-09-13.md`.
