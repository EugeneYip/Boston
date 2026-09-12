# research/gis-stage1a2 — coverage-safe building identity + transfer test

**Stage 1A.2. Research only. No `src/` change, no runtime consumer, no WebGL, no Stage 1B.**
Additive to `../gis-stage1a/` and `../gis-stage1a1/`, both unchanged except for documented corrections.

Findings: `../GIS_HYBRID_WORLD_STAGE1A2_COVERAGE_SAFE_TRANSFER_2026-09-12.md`.

## The one-paragraph answer

Stage 1A.1's four Back Bay false merges were not a missing parent and not a bad rule: MassGIS draws **one**
roofprint over **two** City buildings, with the areas balancing to a ratio of exactly **1.00**. Neither PDDL
nor MassGIS holds the subdivision, so no gate over those sources can recover it — but a gate can refuse to
assert identity over mixed evidence. Demoting any structure whose parts disagree on `GRND_ELEV_2010` gives
**0 known false merges** in both areas, at **52.3%** coverage in Back Bay and **69.9%** in North End, with
the rest falling back to procedural. The rule was frozen and checksummed before North End was queried.

## Reproduce

```bash
node research/gis-stage1a2/northend.mjs   # transfer test
node research/gis-stage1a2/emit.mjs       # results.json (deterministic)
```
Three consecutive runs produce a byte-identical `results.json`.

## The frozen gate

`stage1a2-gate/1.0.0` — `minMargin 0.35`, `groundToleranceFt 0.01`, **no coverage floor** (coverage is
confounded by the two layers' geometry lineages and is not the discriminator). Whole structures are demoted,
never individual parts: which member is the intruder is exactly what the parent layer cannot say.

## Licence boundary

| use | source | status |
|---|---|---|
| part geometry | City of Boston Buildings with Roof Breaks | **ODC-PDDL-1.0** |
| parent identity (`LOCAL_ID`) | MassGIS Building Structures (2-D) | **MassGIS public record**, redistributable with credit |
| **audit ground truth only** | City `Assessing/DOIT_buildings` | **LEGAL-UNKNOWN — never committed** |

Attribution if this ships: *MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS*.

## Removal

```bash
rm -rf research/gis-stage1a2
```
