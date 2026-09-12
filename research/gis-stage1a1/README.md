# research/gis-stage1a1 — roof-break parts → defensible building units

**Stage 1A.1. Research only. No `src/` change, no runtime consumer, no WebGL, no Stage 1B.**
Additive to `../gis-stage1a/`, which is unchanged except for one documented correction.

Read `../GIS_HYBRID_WORLD_STAGE1A1_BUILDING_RECONSTRUCTION_2026-09-12.md` for findings.
`../GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md` remains canonical on architecture.

## The one-paragraph answer

The PDDL roof-break layer has **no parent-building identifier** — 12 fields on the FeatureServer and
the same 12 in the PDDL CSV. Grouping on shared edges is catastrophic in Back Bay: 218 parts collapse
to 31 components, one swallowing **20 distinct buildings**. And **no PDDL-only signal separates a
party wall from a roof break** — shared-boundary median is 16.13 m within a building against 16.41 m
between buildings. The identity comes instead from **MassGIS Building Structures (2-D)**, whose
`LOCAL_ID` is the City's own building identifier preserved verbatim, on a layer that is a public
record and freely redistributable. 218 parts → **147 units**, 0 false splits, 4 residual false merges
— all attributable to MassGIS lacking a structure for 6 of 140 City buildings, not to the rule.

## Reproduce

```bash
node research/gis-stage1a1/join.mjs              # audit-only ground truth join
node research/gis-stage1a1/group.mjs             # parent assignment
node research/gis-stage1a1/emit.mjs              # fixture + validation + metrics
```
`emit.mjs` is deterministic: three consecutive runs produce a byte-identical `building-fixture.json`.

## Licence boundary — the important part

| use | source | status |
|---|---|---|
| building **geometry** | City of Boston Buildings with Roof Breaks | **ODC-PDDL-1.0** — committed |
| building **identity** (`LOCAL_ID`) | MassGIS Building Structures (2-D) | **MassGIS public record**, redistributable with credit — committed |
| **audit ground truth only** | City `Assessing/DOIT_buildings` (`BUILDING_ID`, `PART_ADDRESS`) | **LEGAL-UNKNOWN** — publishes a warranty disclaimer, no licence; no Analyze Boston record names it. **Never committed**; used only to score the method, exactly as the Northeastern university layer was used |

Attribution required if this ever ships: *MassGIS (Bureau of Geographic Information), Commonwealth of
Massachusetts EOTSS*.

## Files

| file | what it is |
|---|---|
| `join.mjs` | attaches audit-only ground truth to the PDDL parts (geometric join; OBJECTIDs do not correspond) |
| `adjacency.mjs` | shared-boundary adjacency, used to demonstrate why edge union fails |
| `group.mjs` | parent assignment by maximum-overlap containment with an ambiguity margin |
| `building-metrics.mjs` | dissolve + M1/M2/M3 at building level |
| `emit.mjs` | writes the fixture, validation and metrics reports |
| `building-fixture.json` | 7 selected cases; every constituent part preserved verbatim |
| `schema-v0.1-building-candidate.json` | proposed BUILDING level, for review |
| `cache/` | raw downloads — **gitignored** |

## Removal

```bash
rm -rf research/gis-stage1a1
```
Stage 1A is untouched and keeps working on its own.
