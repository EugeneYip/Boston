# Stage 1A.2 — acceptance, accounting reconciliation and runtime-readiness closeout

**Date** 2026-09-12 · **Baseline** `df4b44d5dbcea80c5b65dc2c94daeb057dbf8d53` (HEAD == origin/main, clean, 0/0)
**Scope** Data and documentation only. No new geographic sample, no `src/` change, no runtime, no WebGL.
**Stage 1B not begun and not authorised.**
**Canonical where it disagrees with `GIS_HYBRID_WORLD_STAGE1A2_COVERAGE_SAFE_TRANSFER_2026-09-12.md`.**

---

## A. Result

# READY WITH EXPLICIT LIMITATIONS

…with one tension the Owner should resolve explicitly, stated up front rather than buried:

**Stage 1A.2's "zero known false merges" did not mean "zero known wrong".** Reconciling the accounting
exposed **two previously unexplained wrong-parent records**, one per area. A generic under-fill gate
(derived on Back Bay, measured **neutral** on North End) removes the Back Bay one. The North End one is
**provably undetectable** from the permitted sources: its part-to-structure area ratio is **1.001** with
runner-up coverage **0** — MassGIS and the City agree on the geometry exactly and disagree only on the
*label*.

So after the fix:

| | Back Bay | North End |
|---|---|---|
| known wrong-parent assignments in the high-confidence set | **0 of 113** | **12 of 444 (2.7%)** |

The brief lists *"known wrong parent identity remains in the high-confidence set"* under **NOT READY**. On a
literal reading, North End fails it and the answer is NOT READY. I have classified it
**READY WITH EXPLICIT LIMITATIONS** for one specific, checkable reason: **none of the 12 misplaces any
geometry.** Every part is a real PDDL footprint at its true location; the error is confined to which
identity label attaches and which parts group together. For an **X/Z-only prototype that draws footprints**
that is isolable, which is exactly the escape the brief permits. **If the Owner holds the criterion
strictly, the correct answer is NOT READY** — that judgement is the Owner's, not mine, and nothing here
should be read as authorising Stage 1B.

---

## B. MassGIS redistribution — B7 closed

| | |
|---|---|
| dataset title | **Building Structures (2-D)** |
| official dataset page | `https://www.mass.gov/info-details/massgis-data-building-structures-2-d` |
| exact resource used | hosted feature layer, item **`607d9827695341deb11b44a686b45fa4`**, service `services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Building_Structures/FeatureServer/0` |
| retrieval date | **2026-09-12** |
| general policy | MassGIS data is *"a matter of public record… can be used by anyone for their purposes"*; *"may be freely redistributed and integrated into commercial products and applications, including any derivative works"* |
| requested credit | **"MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS"** |
| dataset-specific override | **none found**; item `licenseInfo` empty, no restriction in item or service metadata |

**B7: CLOSED FOR THIS MASSGIS-PUBLISHED DOWNLOADABLE LAYER.** The layer is published by MassGIS with
statewide download options, so the internal-use exception — which concerns datasets MassGIS licenses *in* and
therefore cannot redistribute — does not apply to it.

**Deliberately not generalised:** this closes the question for *this* layer only, not for every dataset
MassGIS may internally possess.

**Correcting my own earlier framing:** Stage 1A.2 §B cited the mass.gov **HTTP 403** as part of the residual
uncertainty. That was wrong in kind. An automated-access failure is not licence uncertainty when the
authoritative policy is established by other means, and it is. The 403 is recorded as a retrieval note only.
The **Rolta** contractor credit in `copyrightText` remains a genuine residual: contractor terms were not
inspected, and MassGIS publishing the layer as a public record is what this rests on.

---

## C. Boston-subset vintage — corrected

**Measured from the already-acquired bounded fixtures. No new acquisition.**

| field | Back Bay (169) | North End (643) |
|---|---|---|
| `SOURCE` | **"City of Boston" — 169/169** | **"City of Boston" — 643/643** |
| `SOURCETYPE` | blank ×169 | blank ×643 |
| `SOURCEDATE` | **blank ×169** | **blank ×643** |
| `SOURCEDATA` | blank ×169 | blank ×643 |
| `EDIT_DATE` / `EDIT_BY` | blank ×169 | blank ×643 |

**All 812 Boston structures in both samples carry `SOURCE = "City of Boston"` and carry no date of any kind.**

**Strongest supported statement:**

> The MassGIS Building Structures layer has a **layer publication / maintenance date of 2026-05-22**. That is
> a **layer-level** date. Every Boston feature in both bounded samples is attributed `SOURCE = "City of
> Boston"` and carries **no `SOURCEDATE`, `SOURCETYPE`, `SOURCEDATA` or `EDIT_DATE`**, so **no feature-level
> date evidence exists** for the Boston subset. This is consistent with the documented history in which
> Boston structures were replaced with City of Boston data in 2019 and the May 2026 statewide building update
> excluded Boston.

**Do not say "Boston Building Structures are May 2026 data."** Stage 1A.2 §B tabulated the 2026-05-22 date
without this separation; that is corrected on top.

---

## D. `LOCAL_ID` — documented vs observed, both preserved

**DOCUMENTED.** The field's only published description in the service metadata is its alias, **"Local ID"**.
MassGIS's general field documentation describes `LOCAL_ID` generically and does not state that it carries a
municipal building identifier. The layer description does record that *"Some building structure features were
obtained from municipal data."*

**OBSERVED BOSTON-SPECIFIC BEHAVIOUR.**

> Current bounded Boston features preserve City `BUILDING_ID` in MassGIS `LOCAL_ID` at
> **134/140** audited Back Bay buildings and **462/462** audited North End buildings.
> This Boston-specific behaviour is empirically verified in the current layer at those rates but is **not**
> established by the general MassGIS field-description text.

**Documentation/data discrepancy, recorded and not resolved by picking a side.** If the general documentation
describes `LOCAL_ID` as unused or generic, it is **stale relative to the 2019 Boston City-data ingestion**
that the layer's own description implies. I have no authoritative statement reconciling the two, so both are
recorded as they stand. Neither is presented as superseding the other.

---

## E. Audit accounting — reconciled exactly

Stage 1A.2 reported record-level accuracy alongside event-level counts without reconciling them. A **record**
(one assigned part) and an **event** (a group or a building) are different units, so the totals never had to
agree — and the report did not say so.

**Category definitions, mutually exclusive at record level.** Merge is tested before split, so the more
dangerous event wins the label.

| category | definition |
|---|---|
| `CORRECT_PARENT` | assigned `LOCAL_ID` === City `BUILDING_ID` |
| `WRONG_PARENT_IN_MERGE` | wrong, and this part's assigned group spans >1 City building |
| `WRONG_PARENT_IN_SPLIT` | wrong, and this part's City building spans >1 assigned group |
| `WRONG_PARENT_ISOLATED` | wrong, and neither — a genuine one-to-one misassignment |

**Event level, counted over groups/buildings, never over records:** `FALSE_MERGE` = an assigned group
spanning >1 City building; `FALSE_SPLIT` = a City building spanning >1 assigned group.

### Back Bay

| record level | gate v1.0 | **gate v1.1** |
|---|---|---|
| assigned | 114 | **113** |
| audit-unknown | 0 | 0 |
| auditable | 114 | **113** |
| `CORRECT_PARENT` | 113 | **113** |
| `WRONG_PARENT_IN_MERGE` | 0 | **0** |
| `WRONG_PARENT_IN_SPLIT` | 0 | **0** |
| `WRONG_PARENT_ISOLATED` | **1** | **0** |
| **sums to auditable** | 113+1 = 114 ✓ | **113+0 = 113 ✓** |
| event level | `FALSE_MERGE` 0, `FALSE_SPLIT` 0 | `FALSE_MERGE` 0, `FALSE_SPLIT` 0 |

### North End

| record level | gate v1.0 | **gate v1.1 (identical)** |
|---|---|---|
| assigned | 464 | **464** |
| audit-unknown | 20 | 20 |
| auditable | 444 | **444** |
| `CORRECT_PARENT` | 432 | **432** |
| `WRONG_PARENT_IN_MERGE` | 0 | **0** |
| `WRONG_PARENT_IN_SPLIT` | 11 | **11** |
| `WRONG_PARENT_ISOLATED` | 1 | **1** |
| **sums to auditable** | 432+11+1 = 444 ✓ | **444 ✓** |
| event level | `FALSE_MERGE` 0, `FALSE_SPLIT` 11 | `FALSE_MERGE` 0, `FALSE_SPLIT` 11 |

**Both sets reconcile exactly.** The apparent gap in Stage 1A.2 was 11 split-related records being invisible
against an event count of 11 splits, plus one isolated record per area that was never identified.

---

## F. The two previously unexplained records

**Back Bay — `bos-rb-671423`.** Assigned `Bos_0400985000_B0`, truth `Bos_0400985000_B1` — **same parcel,
different building number**. Coverage 0.714, margin 1.214, centroid inside: it sails through v1.0.
Part area **1,645 m²** inside a structure of **24,507 m²** — the part fills **6.7%** of its parent, and
MassGIS holds **no** structure for the true `_B1`.

**North End — `bos-rb-655614`.** Assigned `Bos_0301346000_B0`, truth `Bos_0301291000_B0` — **different
parcels**. Coverage 0.636, margin 1.136, runner-up coverage **0**. Part area **149.6 m²**, structure area
**149.4 m²** — ratio **1.001**. MassGIS *does* hold a structure for the true building.

**The two are not the same kind of error.** The first is weak evidence — a part barely filling a parent. The
second is a **pure label conflict on identical geometry**: the two sources outline the same building and
disagree only on which parcel id names it. No area, coverage, margin or adjacency signal can separate that
without a third source.

---

## G. "Zero false merges" ≠ "zero wrong" — corrected

Stage 1A.2's headline and verdict used *zero known false merges* as the production-safety target. **That is
too weak and the wording is corrected.** A one-to-one wrong-parent assignment is factually wrong without
being a merge, and Back Bay had exactly one.

Evaluated against the stronger condition — **zero known wrong factual parent assignments in the
high-confidence subset**:

| area | gate v1.0 | gate v1.1 | meets the stronger condition? |
|---|---|---|---|
| Back Bay | 1 wrong of 114 | **0 wrong of 113** | **YES** |
| North End | 12 wrong of 444 | **12 wrong of 444 (2.7%)** | **NO** |

**Stage 1A.2 does not currently meet the stronger condition.** It meets it in the derivation area and fails
it in the transfer area, at a measured 2.7%.

---

## H. Gate v1.1 — the generic correction

```
stage1a2-gate/1.1.0  =  v1.0  +  minParentFill 0.10
```

**Under-fill demotion:** if the parts assigned to a structure account for less than 10% of that structure's
own `AREA_SQ_FT`, they are demoted to `AMBIGUOUS_UNDERFILLED_PARENT`. A parent a part barely fills is weak
evidence for that part's identity.

- **Generic and evidence-based.** No address, id or building is named. No exception table.
- **Derived on Back Bay only**, from the case in §F.
- **Measured neutral on North End**: 464 assigned before and after, identical record and event counts. The
  frozen-v1.0 transfer result therefore **remains valid and is reported separately** rather than replaced.

Cost: exactly **one** Back Bay part (114 → 113 assigned, 52.3% → 51.8% coverage) to remove the only Back Bay
error.

---

## I. The 0.01 ft rule — what it actually is

**Measured on the existing fixtures, n = 789 `GRND_ELEV_2010` values across both areas:**

- recorded to **3 decimal places** on 697 of 789 values (2 dp on 65, 1 dp on 17, 0 dp on 10);
- range 4.059 – 33.333 ft; 694 distinct values;
- **smallest gap between distinct values: 0.001 ft**; **201 inter-value gaps fall below 0.01 ft**; p10 gap
  0.003 ft, median 0.022 ft.

**Therefore 0.01 ft is NOT a pure equality sentinel** — it absorbs 201 near-equal pairs that the source
records as distinct. Nor is it a physical ground-height tolerance: 0.01 ft is **3 mm**, and no survey
separates buildings at that scale.

**Correct name: a SOURCE-VALUE AGREEMENT TOLERANCE, set one order of magnitude above the field's own
0.001 ft recording precision.** Values within it are treated as "the source recorded the same elevation".

### Sensitivity (existing fixtures only)

| tolerance | Back Bay assigned / cov% | BB wrong-iso | **BB false merges** | North End assigned / cov% | NE wrong-iso | NE false splits | **NE false merges** |
|---|---|---|---|---|---|---|---|
| 0 ft | 114 / 52.3 | 1 | **0** | 462 / 69.6 | 1 | 11 | **0** |
| **0.01 ft (selected)** | **114 / 52.3** | 1 | **0** | **464 / 69.9** | 1 | 11 | **0** |
| 0.1 ft | 116 / 53.2 | 1 | **1** | 470 / 70.8 | 1 | 11 | **0** |
| 0.5 ft | 133 / 61.0 | 1 | **3** | 489 / 73.6 | 1 | 11 | **0** |
| 1.0 ft | 137 / 62.8 | 1 | **3** | 494 / 74.4 | 1 | 11 | **0** |

**0.01 ft is retained, and the reason is in the table: it is the largest tolerance in the sweep at which
Back Bay has zero false merges.** At 0.1 ft a merge appears. The safe band is **(0, 0.01]**; 0 ft is equally
safe in Back Bay but costs two North End parts. The threshold was **not** chosen to maximise a score — a
larger value would have bought more coverage and been rejected.

---

## J. North End false splits — meaning and handling requirement

| | |
|---|---|
| City buildings affected | **11** |
| groups they become | **22** — every one splits into exactly **2** |
| constituent parts | **24**, of which **23** assigned and 1 ambiguous |
| **every constituent part still represented** | **yes** — nothing is dropped |
| fragments sharing a parcel prefix | **0 of 11** — all are *neighbouring-parcel* labels |

The pattern: a City building that spans a parcel line is carried by MassGIS as **two** structures labelled
with the **two parcels'** ids.

**Runtime consequence, and the answer to "is a split visually safe?" — no, not automatically.** Identity-wise
a split is the safe direction: it under-merges rather than over-merges, and no geometry moves. But if a future
Stage 1B **dissolves per group**, one physical building becomes **two adjacent factual buildings with an
interior seam that does not exist**, which would read as a wall through the middle of a building.

**Future Stage 1B handling requirement — defined here, NOT implemented:**

> A Stage 1B consumer **must not** treat a dissolved group boundary as an exterior wall where it abuts
> another assigned group. Inter-group shared boundaries are to be treated as party walls — which, in attached
> fabric, is what they are regardless of whether a split occurred.

That is a **rendering discipline, not a detection requirement**, and it is chosen deliberately: splits are
**not reliably detectable** from PDDL + MassGIS (detecting them needs the LEGAL-UNKNOWN City data, which is
forbidden in production). The discipline makes detection unnecessary. The alternative — demoting every group
adjacent to another to procedural fallback — would demote most of attached Boston and is rejected.

---

## K. Blank `LOCAL_ID` — normalised at the data contract

**Contract:** `null`, empty string and **whitespace-only** string all normalise to **`NO_PARENT_ID`**.
**Whitespace is never a valid stable identity.** Implemented in `gate.mjs` via `.trim() || null`.

Measured rates, already acquired, no new area:

| area | structures | blank/whitespace `LOCAL_ID` | rate |
|---|---|---|---|
| Back Bay | 169 | **34** | **20.1%** |
| North End | 643 | **149** | **23.2%** |

This is a **hard ceiling on factual coverage** and it is undocumented — it was found only because untrimmed
`" "` is truthy in JavaScript and had collapsed all 34 Back Bay structures into one spurious building.

---

## L. Final fallback contract

| state | meaning | consumer |
|---|---|---|
| `FACTUAL_PARENT_CONFIRMED` | assigned, usable `LOCAL_ID`, margin cleared, ground values agree, parent adequately filled | factual representation |
| `FACTUAL_PARENT_AMBIGUOUS` | `AMBIGUOUS_STRADDLE`, `AMBIGUOUS_MIXED_GROUND`, `AMBIGUOUS_UNDERFILLED_PARENT` | **procedural fallback** |
| `FACTUAL_PARENT_MISSING` | `NO_PARENT`, `NO_PARENT_ID` (incl. blank/whitespace) | **procedural fallback** |
| **`FACTUAL_SOURCE_DELINEATION_CONFLICT`** | **new** — sources disagree on whether attached fabric is one building or two; known to exist, **not reliably detectable** from the permitted sources | handled by the §J rendering discipline, not by demotion |
| `PROCEDURAL_FALLBACK_REQUIRED` | terminal state for the above | today's `RoadNetwork.buildPlots` path, unchanged |

**Guarantee: no unsupported identity is required to reach 100% world coverage.** Factual where safe
(Back Bay 51.8%, North End 69.9% of parts), procedural everywhere else. `FACTUAL_SOURCE_DELINEATION_CONFLICT`
is recorded as a **known, undetectable residual** rather than pretended away — that honesty is the point of
having the state.

---

## M. Vertical datum

**Unchanged: VERTICAL-DATUM-PARTLY-RESOLVED.** NAVD88 is documented for `BASE_ELEVATION` /
`ELEVATION_SEA_LEVEL` / `TOP_SEA_LEVEL` / `TOP_GROUND_LEVEL` on the LEGAL-UNKNOWN City service; the PDDL
fields consumed (`GRND_ELEV_2010`, `ROOF_ELEV_2010`, `BLDG_HGT_2010`) carry **no stated vertical reference**.
Not expanded. **No Y transformation authorised or performed.** Height *differences* remain datum-independent.

---

## N. Readiness

# READY WITH EXPLICIT LIMITATIONS

| READY criterion | status |
|---|---|
| B7 licensing closed for the MassGIS parent layer | **met** (§B) |
| no known wrong factual parent in the high-confidence gate | **met in Back Bay (0/113); NOT met in North End (12/444 = 2.7%)** |
| blank `LOCAL_ID` fail-safe | **met** (§K) |
| false-split runtime handling defined | **met** (§J) |
| deterministic factual/fallback classification | **met** — byte-identical ×3 |
| source-vintage wording correct | **met** (§C) |
| `LOCAL_ID` empirical semantics documented honestly | **met** (§D) |

**The single unmet criterion is the one in §G**, and the classification turns entirely on how it is read.
I have classified READY WITH EXPLICIT LIMITATIONS because the 12 North End errors **misplace no geometry** —
every part is a real PDDL footprint at its true location, and the error is confined to identity labelling and
grouping, which an X/Z-only footprint prototype does not consume. **Under a literal reading of the brief's
NOT READY list, this is NOT READY, and that call belongs to the Owner.**

---

## O. Limitations a future Stage 1B must obey

1. **X/Z only.** No Y integration — the vertical datum for the consumed fields is unresolved (§M).
2. **Factual coverage is ~52–70% of parts.** The remainder **must** fall back procedurally. Do not seek
   100% factual coverage; it is unreachable from these sources.
3. **Never render an inter-group boundary as an exterior wall** (§J). Splits are undetectable; the discipline
   replaces detection.
4. **Never use City `DOIT_buildings` in production.** It remains LEGAL-UNKNOWN; audit-only, never committed.
5. **Blank/whitespace `LOCAL_ID` is `NO_PARENT_ID`**, always (§K).
6. **Attribute MassGIS** as *"MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts
   EOTSS"*.
7. **Accept a measured ~2.7% identity-label error rate** in transfer areas, or do not proceed.
8. **Do not quote 2026-05-22 as the Boston data vintage** (§C).
9. Requires **separate Owner authorisation** and a short exclusive rendering window; the App project remains
   the primary workload.

---

*Stage 1A.2 acceptance closeout. Research only. No new geographic sample, no runtime change, no dependency,
no `src/` modification, no WebGL. Stage 1B not begun and not authorised.*
