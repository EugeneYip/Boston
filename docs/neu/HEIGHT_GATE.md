# Building-height gate — Northeastern hero district

**Wave 2 (Hero-A massing) is gated on this.** The question is not "can we find a
number for each building" — it is "which numbers can we defend, and which would
we be inventing".

Measured 2026-09-07 at Wave 1A. Regenerate the underlying join with
`tools/neu-audit/`; the per-building rows are in `BUILDING_INVENTORY.json`.

## What each source actually provides

| source | licence | heights? |
|---|---|---|
| **Northeastern ArcGIS** `Buildings_ALL` | **none published** — see SOURCES.md | `Height_Relative` and `Levels_Above_Ground` are **`0` for all 104 Boston rows** |
| **MassGIS property tax parcels** | public domain | **`STORIES` on 41 of 70** NEU-owned parcels in the envelope; values run 1–22, so tall buildings are recorded rather than capped |
| **Boston Approved Building Permits** | PDDL | `sq_feet`, `occupancytype`, free-text description — **no storey or height field**. Not a height source. |
| **Boston 3D Buildings (Existing)** | PDDL | an I3S **SceneServer** — authoritative 3D massing, but delivered as binary mesh node pages, not attributes. Usable, at the cost of an I3S reader. **The strongest unexploited lead.** |
| OpenStreetMap | ODbL | `building:levels` on 36, `height` on 6. Evidence only — see the licence note below. |
| gross area ÷ footprint | derived | every building with `GrossArea`, as an **upper bound** (gross area includes below-grade space) |

## Confidence grading

Storeys are recorded **as storeys**. No conversion to metres is applied anywhere
in this package; a typology conversion needs explicit authorisation.

- **B** — assessor `STORIES` corroborated within ±1 by an independent estimate
- **C** — assessor value alone, nothing to check it against
- **D** — no assessor value; gross-area inference only
- **CONFLICT** — assessor value contradicted by more than one storey
- **UNKNOWN** — nothing

## Coverage

**Hero-A, n = 31**

| grade | count |
|---|---|
| **B — corroborated** | **14** |
| D — inferred only | 11 |
| **CONFLICT — needs survey** | **6** |
| C / UNKNOWN | 0 |

**Hero-B, n = 9**

| grade | count |
|---|---|
| **B — corroborated** | **6** |
| D — inferred only | 1 |
| CONFLICT | 2 |

The conflicts, with the disagreement: West Village H (assessor 8 vs 16/9.3),
Stearns Center (1 vs 6), Knowles Centre (1 vs 4.5), 335A Huntington (5 vs 0.9),
452 Huntington (4 vs 1), Speare Hall (3 vs 4.3); Hero-B: EXP (6 vs 9), West
Village F (8 vs 10.5). Several are the assessor recording a nominal **1** for an
institutional parcel, and several are a tower whose parcel describes its podium.

## The finding that decides the recommendation

**The evidence is inversely distributed against need.**

The tall residences are the *best* evidenced — International Village 22,
Lightview 21, East Village 17, Behrakis 8, Willis 8, West Village E 8 — all
corroborated exactly, and all Hero-B. Those are skyline objects, seen from far
away, and their heights are known.

The **11 Hero-A buildings graded D — inference only — are the Krentzman
quadrangle**: Ell, Richards, Hayden, Dodge, Mugar, Curry, Cabot, Ryder, Egan,
Shillman, Dana. That is the arrival sequence. The buildings the player would
stand in front of are precisely the ones whose heights are least supported, and
gross-area inference is an upper bound, not a measurement.

## Recommendation

**Wave 2 may open for Hero-B, not for Hero-A.**

- **Proceed** with the six corroborated Hero-B towers plus Renaissance Park
  Garage. Their storey counts are B-grade, they read at distance where storey
  count matters more than facade, and getting the skyline right is independently
  valuable.
- **Hold** the Hero-A Krentzman quadrangle. Eleven of the thirty-one rest on
  inference and six are contradicted. Massing the front door from an upper bound
  would put a guess in the most-looked-at place in the district.
- **Do not** convert storeys to metres without authorisation.

**The unblock for Hero-A is Boston 3D Buildings (Existing)** — PDDL, authoritative,
updated June 2026, and it covers the whole city. It needs an I3S SceneServer
reader to extract per-building roof elevations. That is a bounded piece of work
and it would move the whole Hero-A set from D to A/B in one step. It is the
single highest-value next investigation for this programme.

## Licence note

Runtime heights must come from the public-domain sources (MassGIS assessor, or
Boston 3D). OpenStreetMap levels are used **only as a disagreement detector** —
to decide whether a public-domain value is trustworthy — and no OSM number is
carried into runtime. If a future wave wants to *use* an OSM level as the value,
that is an ODbL decision for the owner, not an engineering one.
