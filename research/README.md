# research/ — the GIS / factual-geography programme

Seventeen reports, 2026-09-11 → 2026-09-13. **Reports are evidence and are not rewritten.**
Where a later stage supersedes an earlier claim it says so in the later report, and the
earlier one carries an errata note.

**If you only read one file, read
`GIS_HYBRID_WORLD_STAGE2A4_CAUSAL_INFLUENCE_CLOSEOUT_2026-09-13.md`.** It is the canonical
closeout of the whole programme.

**Status: the Stage 2A family is CLOSED as PASS WITH KNOWN PROTOTYPE LIMITATIONS. The
project is PAUSED. Stage 2B is not authorized.** See `docs/PAUSE_HANDOFF_2026-09-13.md`.

---

## The question the programme answered

Boston's roads and buildings are hand-authored. Could authoritative GIS data replace them,
and would the engine's procedural systems survive it?

**Answer: for roads, yes, in a bounded and reversible prototype — but the hand-authored
frame cannot be repaired, only replaced.** Everything the programme produced is
**default off**; nothing a player sees has changed.

## Read in this order

| # | report | what it settled |
|---|---|---|
| 1 | `GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md` | Programme framing and acceptance rules |
| 2 | `GIS_HYBRID_WORLD_STAGE1A_BACK_BAY_PROBE_2026-09-12.md` | First real footprints; Back Bay chosen as the probe |
| 3 | `..._STAGE1A1_BUILDING_RECONSTRUCTION_2026-09-12.md` | **Roof breaks are roof planes, not footprints** |
| 4 | `..._STAGE1A2_COVERAGE_SAFE_TRANSFER_2026-09-12.md` | Safe partial transfer; coverage limits |
| 5 | `..._STAGE1A2_ACCEPTANCE_2026-09-12.md` | **CLOSED NEGATIVE:** full footprint replacement |
| 6 | `..._STAGE1B_BACK_BAY_RUNTIME_PROTOTYPE_2026-09-12.md` | First factual buildings in the runtime |
| 7 | `..._STAGE1B1_MULTI_PARCEL_RUNTIME_2026-09-12.md` | Transactional replacement; multi-parcel association |
| 8 | `..._STAGE1C_STREETWALL_HYBRID_2026-09-13.md` | Street-facing hybrid; facade grammar limits |
| 9 | `..._STAGE1D_ROAD_REGISTRATION_DIAGNOSIS_2026-09-13.md` | **The hand-authored road frame is the outlier — per-street error, no global transform** |
| 10 | `..._STAGE1E_FACTUAL_ROAD_SOURCE_FEASIBILITY_2026-09-13.md` | **SAM selected and licence-cleared (ODC-PDDL-1.0)** |
| 11 | `..._STAGE2A_FACTUAL_ROAD_BACKBONE_RUNTIME_2026-09-13.md` | Factual road backbone runs; default-off prototype |
| 12 | `..._STAGE2A1_SEAM_AND_DEPENDENT_SYSTEMS_2026-09-13.md` | Seam containment; dependent-system validation |
| 13 | `..._STAGE2A2_SEAM_RUNTIME_CLOSEOUT_2026-09-13.md` | Lot-phase theorem; runtime acceptance |
| 14 | `..._STAGE2A3_PORT_CLOSURE_2026-09-13.md` | Structural port closure; `noSnap`; **carries an errata** |
| 15 | **`..._STAGE2A4_CAUSAL_INFLUENCE_CLOSEOUT_2026-09-13.md`** | **CANONICAL CLOSEOUT — read this one** |

`OSM_HYBRID_WORLD_FEASIBILITY_2026-09-11.md` and
`OSM_HYBRID_WORLD_PROTOTYPE_HANDOFF_2026-09-11.md` predate the licensed-source decision.
**No OSM geometry is in the runtime** and none may be added.

## Workspaces

Each `gis-stage*/` directory holds the scripts and machine-readable results for its stage.
Most carry their own `README.md` with a run order (`gis-stage1b/` does not). Caches,
captures and PNGs are gitignored; JSON ledgers, manifests and hashes are committed.

The generator of record for the default-off road candidate is
**`research/gis-stage2a3/build-candidate.mjs`**, which writes
`src/data/gis-backbay-roads.js`. It is deterministic — two runs produce the same sha256.

## Standing constraints

- **No OSM geometry in the runtime.**
- The City `Assessing` / `DOIT_buildings` dataset is **LEGAL-UNKNOWN and audit-only**. It
  must not enter the runtime or candidate generation.
- Everything here is **default off**. Enabling any candidate by default needs a separate
  owner decision.
- **Northeastern is frozen.** Do not touch it.
