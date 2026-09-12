# Stage 1A.2 — coverage-safe building identity, and one bounded transfer test

**Date** 2026-09-12 · **Baseline** `0cc2258edfc66c5609341bed8b6a061313b55ff5` (HEAD == origin/main, clean, 0/0)
**Scope** Data only. No `src/` change, no runtime consumer, no WebGL, no dependency. **Stage 1B not begun.**
**Canonical on architecture** `research/GIS_HYBRID_WORLD_RESEARCH_ACCEPTANCE_2026-09-11.md`.

---

## A. Result

# PASS

A gate that **refuses to assert identity it cannot support** reaches **zero known false merges in both
areas**, and it was frozen before the second area was queried.

| | Back Bay | North End |
|---|---|---|
| roof parts | 218 | **664** |
| **coverage (parts with a factual parent)** | **52.3%** | **69.9%** |
| building groups | 112 | 415 |
| **precision** (confirmed-correct / auditable) | **99.1%** (113/114) | **97.3%** (432/444) |
| **known false merges** | **0** | **0** |
| known false splits | **0** | **11** |
| MassGIS missing-parent rate | 4.3% (6/140) | **0.0%** (0/462) |

The gate transferred to a harder morphology **without retuning and with higher coverage**, and the Back Bay
source gap **did not recur**. The residual defect in each area is the *same* underlying phenomenon pointing
in opposite directions, and both are now understood rather than merely counted.

---

## B. MassGIS redistribution — B7 closed, narrowly

| | |
|---|---|
| exact resource | **Building Structures (2-D)**, hosted feature layer, item **`607d9827695341deb11b44a686b45fa4`** |
| service | `services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Building_Structures/FeatureServer/0` |
| retrieved | **2026-09-12** |
| layer last updated | **2026-05-22** (publisher's own description: *"This layer was last updated on May 22, 2026"*) |
| item `licenseInfo` | **empty** |
| item `accessInformation` | **"MassGIS, City of Boston"** |
| layer `copyrightText` | **"Rolta, MassGIS, City of Boston"** |
| general policy | MassGIS data *"is a matter of public record… can be used by anyone for their purposes"*; *"may be freely redistributed and integrated into commercial products and applications, including any derivative works"*; credit requested as **"MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS"** |
| layer-specific override | **none found** |

**Conclusion: B7 closed, with one residual noted.** The internal-use exception concerns datasets MassGIS
licenses *in* and therefore cannot redistribute; this layer is published by MassGIS with statewide download
links, so the exception does not appear to apply. **Residual, and deliberately not waved away:** the layer
credits **Rolta**, the contractor who produced the original interpretation. Contractor terms were not
inspected, and the mass.gov layer page blocks automated retrieval (HTTP 403), so the layer-specific page was
not read directly — the general policy and the item/service metadata are what this rests on. That is enough
to proceed with research and to commit derived identity; it is **not** a legal opinion.

---

## C. `LOCAL_ID` — documented vs observed

**DOCUMENTED SEMANTICS.** The field's only published description is its alias, **"Local ID"**. MassGIS
publishes no field-level definition of what it contains or when it is populated. The layer description does
record that *"Some building structure features were obtained from municipal data."*

**OBSERVED CURRENT BOSTON SEMANTICS.**

> Current Boston features were observed to preserve City `BUILDING_ID` in MassGIS `LOCAL_ID` for **134 of 140**
> audited Back Bay buildings and **462 of 462** audited North End buildings. This Boston-specific behaviour is
> empirically verified in the current layer but is **not** established by the general MassGIS field-description
> text.

Supporting, but still not a field definition: every structure in both boxes carries `SOURCE = "City of
Boston"` (169/169 and 643/643).

**A data-quality fact that is not documented anywhere and cost a real defect:** `LOCAL_ID` is
**whitespace-only** on a material fraction of features — **34 of 169** in Back Bay, **149 of 643** in North
End. Untrimmed, `" "` is truthy in JavaScript and collapses every such structure into one bogus building; in
Back Bay that produced a single spurious "building" spanning 34 structures. Blank is now treated as absent.

---

## D. Corrected false-merge attribution

Stage 1A.1 said the residual merges were *"a source coverage gap, not a rule defect."* **Narrowed, and the
measurement says something more specific than either the old wording or the brief's suggested wording.**

For all three auditable Back Bay merge cases, the MassGIS structure area equals the **sum** of the two City
buildings' part areas, to a ratio of **exactly 1.00**:

| MassGIS structure | struct area | City building A | City building B | combined | ratio |
|---|---|---|---|---|---|
| `Bos_0503218000_B0` | 237 m² | 232 Newbury, 111 m² | 230 Newbury, 126 m² | **237 m²** | **1.00** |
| `Bos_0503226000_B0` | 934 m² | 214 Newbury, 225 m² | 208 Newbury, 709 m² | **934 m²** | **1.00** |
| `Bos_0503220000_B0` | 231 m² | 228 Newbury, 112 m² | 226 Newbury, 119 m² | **231 m²** | **1.00** |

**MassGIS draws one roofprint over exactly two City buildings.** This is not a missing parent, and the
surviving structure is not over-subscribed — an over-subscription gate was built and swept and **failed at
every ratio**, because the accounting balances perfectly.

**Correct classification: SOURCE-LEVEL BUILDING-DELINEATION DISAGREEMENT** — two authoritative sources
disagree about whether an attached pair is one building or two. It is *triggered* in the pipeline exactly as
the brief describes (the true parent is absent by `LOCAL_ID`, so a neighbour wins), so
**SOURCE-COVERAGE-TRIGGERED GROUPING FAILURE MODE** is accurate as a description of the pipeline behaviour —
but the root cause is delineation, not coverage. Neither PDDL nor MassGIS contains the subdivision, so **no
gate over those two sources can recover it.** The only safe response is to detect and demote.

North End proves the same phenomenon runs the other way: 11 false splits where one City building's parts land
in **two adjacent MassGIS structures with neighbouring parcel ids** (e.g. City `Bos_0302360000_B0` →
`Bos_0302360000_B0` + `Bos_0302361000_B0`). **0 of 11** are same-parcel `_Bn` variants. MassGIS subdivides
what the City unifies, and unifies what the City subdivides, in attached fabric.

---

## E. Audit denominator (Phase 3)

Stage 1A.1's "94.4%" mixed populations. Restated with exact numerator and denominator, and **audit-unknown
counted as neither correct nor wrong**:

| population | Back Bay | North End |
|---|---|---|
| roof parts | 218 | 664 |
| assigned by the frozen gate | 114 | 464 |
| — **auditable** (assigned *and* City ground truth exists) | **114** | **444** |
| — **audit-unknown** (assigned, no ground truth) | **0** | **20** |
| — **confirmed-correct** | **113** | **432** |
| — **confirmed-wrong** | **1** | **12** |
| **precision = correct / auditable** | **113/114 = 99.1%** | **432/444 = 97.3%** |

Back Bay audit-source quality, unchanged from Stage 1A.1 and not hidden: 9 duplicate `PART_ID`s, 29 parts
with no `BUILDING_ID`. Under the frozen gate none of those 29 reach the ASSIGNED state, which is why Back Bay
audit-unknown is 0.

---

## F. Back Bay: original result and the precision/coverage curve

**Original Stage 1A.1 grouping:** 202 assigned (92.7%), 131 groups, 4 known false merges, 0 false splits.

**Phase 2 curve** (Back Bay, auditable denominator; `minMargin` 0.35 unless stated). Full sweep in
`research/gis-stage1a2/results.json`.

| gate | assigned | cov % | groups | correct/auditable | prec % | **FM** | FS |
|---|---|---|---|---|---|---|---|
| minCov 0.00, minMar 0.00 | 218 | 100 | 134 | 173/189 | 91.5 | **4** | 1 |
| minCov 0.00, minMar 0.35 *(Stage 1A.1)* | 202 | 92.7 | 131 | 169/179 | 94.4 | **4** | 0 |
| minCov 0.30, minMar 0.35 | 168 | 77.1 | 108 | 143/152 | 94.1 | **4** | 0 |
| minCov 0.40, minMar 0.35 | 137 | 62.8 | 84 | 115/124 | 92.7 | **3** | 0 |
| minCov 0.50, minMar 0.35 | 99 | 45.4 | 56 | 82/90 | 91.1 | **2** | 0 |
| minCov 0.60, minMar 0.35 | 41 | 18.8 | 23 | 35/38 | 92.1 | **0** | 0 |
| minCov 0.80, minMar 0.35 | 13 | 6.0 | 6 | 13/13 | 100 | **0** | 0 |
| **SELECTED: minMar 0.35 + mixed-ground demotion** | **114** | **52.3** | **112** | **113/114** | **99.1** | **0** | **0** |

**A pure coverage floor reaches zero false merges only at 18.8% coverage**, because coverage is confounded
by geometry lineage — MassGIS roofprints were interpreted from 2011–12 imagery and NDSM-shifted, the City
parts are roof-break polygons, so overlap is genuinely partial (median 0.47) for correct and incorrect
assignments alike. **An over-subscription gate was also built and swept, and failed at every ratio** (§D).

---

## G. The frozen rule

```
stage1a2-gate/1.0.0
  minCoverage            0.00      (coverage is confounded; it is not the discriminator)
  minMargin              0.35      (reject straddles — carried over from Stage 1A.1)
  requireCentroidInside  false
  groundToleranceFt      0.01      (mixed-ground demotion)
```

**Mixed-ground demotion:** if a MassGIS structure's assigned parts disagree on `GRND_ELEV_2010` beyond
0.01 ft, **the whole structure is demoted to `AMBIGUOUS_MIXED_GROUND`**. Singletons are untouched — with one
part there is nothing to mix.

`GRND_ELEV_2010` is surveyed per part, so parts of one structure that disagree on it may be separately
founded buildings. **As a classifier this is poor: measured 100% recall at 15% precision on Back Bay.** As a
*demotion* it is exactly the right shape — it catches every detectable merge, and its entire cost is
demoting correct groups to ambiguous. That is the brief's principle applied literally: **a false negative is
preferable to a false merge.**

Whole groups are demoted, never individual parts: which member is the intruder is precisely what cannot be
determined from the parent layer.

**Frozen and recorded before the North End bbox was queried** (`gate.mjs` sha256 `b5d35506d17d9d0f…`). Not
retuned afterwards.

---

## H. Back Bay under the frozen gate

| state | parts |
|---|---|
| **ASSIGNED** | **114 (52.3%)** → 112 building groups |
| `AMBIGUOUS_MIXED_GROUND` | 60 |
| `AMBIGUOUS_STRADDLE` | 16 |
| `NO_PARENT_ID` (blank MassGIS `LOCAL_ID`) | 28 |
| `NO_PARENT` | 0 |

**Known false merges 0. Known false splits 0.** Precision 113/114 = **99.1%**. The single wrong assignment is
`Bos_0400985000_B0` against a truth of `Bos_0400985000_B1` — the same parcel, a different building number. It
is a singleton group, so it does not produce a merge.

---

## I. North End transfer test

**bbox recorded before querying.** WGS84 `42.362703, −71.056931, 42.366297, −71.052069`; Boston local
**x [717.25, 1117.22], z [−1215.28, −815.20]**; **399.97 × 400.08 m**.

| source | count |
|---|---|
| PDDL roof-break parts | **664** normalized, **0 rejected** |
| MassGIS structures | **643** — 494 with a usable `LOCAL_ID`, **149 blank/whitespace** |
| City audit features | 663; **462 distinct audited buildings** reaching the parts |
| **`LOCAL_ID` audit match** | **462 / 462 = 100.0%** |
| **MassGIS missing-parent rate** | **0 / 462 = 0.0%** |

| state | parts |
|---|---|
| **ASSIGNED** | **464 (69.9%)** → 415 building groups |
| `AMBIGUOUS_STRADDLE` | 84 |
| `NO_PARENT_ID` | 57 |
| `AMBIGUOUS_MIXED_GROUND` | 54 |
| `NO_PARENT` | 5 |

**Known false merges 0.** **Known false splits 11** (2.4% of 462 audited buildings). Precision 432/444 =
**97.3%**; audit-unknown 20, counted as neither correct nor wrong.

Before the mixed-ground demotion the same area gives 518 assigned (78.0%), **1 false merge**, 11 false
splits — so the demotion earns its place in North End too, at a cost of 8.1 points of coverage.

**Transfer verdict: the rule transfers.** Zero false merges in a denser, irregular, non-grid morphology, at
**higher** coverage than the area it was derived on. The new failure mode is false splits — the **safe**
direction under the design principle, and the mirror of the Back Bay merges (§D).

---

## J. Source-gap recurrence (Phase 8)

Back Bay: **6 of 140** City buildings had no MassGIS structure (**4.3%**).
North End: **0 of 462** (**0.0%**).

**Classification: NOT OBSERVED ELSEWHERE.** No citywide rate is inferred from two 400 m boxes. What the
second area does establish is that the Back Bay gap is **not a general property of the parent layer**, which
materially improves the outlook for the approach — and that the *delineation* disagreement persists in both
areas, in opposite directions.

---

## K. Corrected M3 stability wording

Stage 1A measured a best-fit translation of **(+6.65, −11.30) m, magnitude 13.115 m**; Stage 1A.1, on
building units, measured **(−6.232, −7.188) m, magnitude 9.514 m**. The vector reverses sign in x.

**The best-fit translation vector is therefore SENSITIVE TO MATCH POPULATION AND UNIT DEFINITION and must not
be presented as a stable physical offset.** The durable conclusion is narrower and does survive:

> Removing one rigid translation leaves a residual median of about **8.4–8.6 m** in the measured Back Bay
> samples, so the discrepancy is **not explained solely by one block-wide translation**.

No new M2/M3 programme was run: the Stage 1A/1A.1 displacement conclusion stands and the frozen gate does not
bear on it.

---

## L. Vertical datum

**Unchanged: VERTICAL-DATUM-PARTLY-RESOLVED.** NAVD88 is documented for `BASE_ELEVATION` /
`ELEVATION_SEA_LEVEL` / `TOP_SEA_LEVEL` / `TOP_GROUND_LEVEL` on the LEGAL-UNKNOWN City service; the PDDL
fields actually consumed (`GRND_ELEV_2010`, `ROOF_ELEV_2010`, `BLDG_HGT_2010`) still carry **no stated
vertical reference**. Not expanded — it is not the Stage 1A.2 blocker. **No Y transformation authorized or
performed.** Height *differences* remain datum-independent and usable; absolute elevations do not.

---

## M. Hybrid fallback contract (Phase 11, data-schema only)

Four states, sufficient to let a future Stage 1B migrate **part of** a district rather than all of it:

| state | meaning | future consumer |
|---|---|---|
| `FACTUAL_PARENT_CONFIRMED` | assigned with a usable `LOCAL_ID`, margin cleared, ground elevations consistent | factual building representation |
| `FACTUAL_PARENT_AMBIGUOUS` | `AMBIGUOUS_STRADDLE` or `AMBIGUOUS_MIXED_GROUND` — evidence exists but does not support one identity | **procedural fallback**; may be revisited if a better parent source appears |
| `FACTUAL_PARENT_MISSING` | `NO_PARENT` / `NO_PARENT_ID` — no parent structure, or a blank `LOCAL_ID` | **procedural fallback** |
| `PROCEDURAL_FALLBACK_REQUIRED` | terminal state for the two above | today's `RoadNetwork.buildPlots` path, unchanged |

**No inferred identity is required to reach coverage.** Back Bay 52.3% / North End 69.9% of parts get a
factual parent; the remainder falls back cleanly. No runtime code was modified, and none is implied — the
point is only to show that partial migration is representable.

---

## N. Determinism and artifacts

`research/gis-stage1a2/` — `gate.mjs`, `bbox-northend.mjs`, `northend.mjs`, `emit.mjs`, `results.json`,
`README.md`. `cache/` gitignored; **no City DOIT geometry is committed**.

**Byte-identical across three consecutive runs**, `results.json` sha256 `f5b25570adc91572…`.
Stage 1A and Stage 1A.1 fixtures are **unchanged**.

---

## O. Verdict

# PASS

- MassGIS redistribution **pinned** to the exact resource, with the Rolta residual stated (§B).
- `LOCAL_ID` semantics recorded **as observed, explicitly not as documented** (§C).
- Back Bay false merges **eliminated**, 4 → **0**, by demotion rather than by forcing (§G, §H).
- **No false splits introduced in Back Bay**; 11 in North End at 2.4%, the safe direction (§I).
- High-confidence coverage remains useful: **52.3% / 69.9%** of parts, at 99.1% / 97.3% precision.
- Rule **frozen and checksummed before** the second-area test.
- Transfer exposes **no fundamental identity failure**.
- Output **deterministic**, byte-identical ×3.
- Procedural fallback state defined and sufficient (§M).

**Stage 1B is NOT authorized by this PASS.** It should be **CONSIDERED**, and the remaining blockers below
are the Owner's to weigh.

---

## P. Remaining blockers

| # | blocker | severity | note |
|---|---|---|---|
| B1′ | **Source-level delineation disagreement** between MassGIS and City in attached fabric — unrecoverable from either source | **High** | bounded and now *detected*: merges demoted, splits visible. Not fixable, only handled |
| B2 | **City `DOIT_buildings` remains LEGAL-UNKNOWN**, so the richest identity (addresses, floors, NAVD88) cannot be canonical input | **High** | needs an Owner licensing decision, not more research |
| B3 | **Vertical datum unresolved** for the consumed PDDL elevation fields | **High for any future Y work** | unchanged |
| B8 | **Blank `LOCAL_ID` on 20–23% of MassGIS structures** (34/169, 149/643) — a hard ceiling on coverage | **Medium** | undocumented; found only by defect |
| B9 | **11 North End false splits (2.4%)** | Medium | safe direction; would under-merge a building into two |
| B10 | Audit ground truth itself has defects: 9 duplicate `PART_ID`s, 29 parts with no `BUILDING_ID` (Back Bay) | Low | audit-unknown now counted separately |
| B7 | MassGIS layer page unreadable by automation (403); Rolta contractor terms not inspected | Low | general policy is affirmative and sufficient for research |

**What would justify Stage 1B:** an Owner decision on B2, plus acceptance that a first prototype covers
roughly half to two-thirds of parts factually and lets the rest fall back procedurally.
**What would stop it:** a requirement that all buildings migrate at once — the delineation disagreement (B1′)
makes that unreachable from these two sources.

---

*Stage 1A.2. Research only. No runtime change, no dependency, no `src/` modification, no WebGL.
Stage 1B not begun.*
