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

## CORRECTED 2026-09-08 (Wave 2A) — the 3D heights are systematically high

**Read this before using any number in `HEIGHT_MEASUREMENTS.json`.**
Wave 2A set out to mass the opening cluster from those heights and found them
biased. They are superseded by `HERO_FOOTPRINTS.json`.

Checked against buildings whose heights are independently known:

| | Boston 3D | Boston Buildings | truth |
|---|---|---|---|
| Prudential Tower | 233.6 m | **228.0 m** | 228 m |
| 200 Clarendon | — | **240.2 m** | 241 m |

Boston Buildings is accurate to under a metre on both. Boston 3D is **+5.6 m** on
the Prudential, and on the Krentzman quadrangle its figures imply **4.9–5.9 m per
storey** against Boston Buildings' **3.69–4.33** — and 3.7 m is what a 1938
institutional building actually measures. Measured excess of Boston 3D over
Boston Buildings across the cluster: **+3.2 m to +8.8 m**.

The likely cause: `Height_Ft` takes the top of the whole modelled mass. That is
defensible on a merged object and wrong for a named building, which also explains
why the `COMPLEX` rows were the worst.

### What the opening cluster actually measures

Krentzman quadrangle, from Boston Buildings (PDDL, roof-break parts, tallest part
within the building's own radius):

Richards **18.65 m**, Hayden **18.54**, Dodge **18.47**, Mugar **18.92**, Dana
**18.74**, Ryder **17.30**, Egan **21.39**, Shillman **19.60**, Ell/Curry
**16.00**, Cabot **11.61**, Hastings **27.83**. Not the 24.4–25.1 m this file
previously certified — the quadrangle is **~18.5 m**, about 25% lower.

### Consequence for Wave 2

**Wave 2A did not mass anything, deliberately.** Building the front door 6 m too
tall would have put a systematic error in the most-looked-at place in the
district, which is the exact failure this gate exists to prevent. Massing is
unblocked again, from `HERO_FOOTPRINTS.json`, which carries footprint polygons
**and** per-tier heights from one public-domain source.

The section below is kept because its method and validation still stand — the I3S
reader works and the storey controls were real. What it got wrong was treating a
merged-mass maximum as a building height, and not testing against a landmark of
known height. That test is now part of the record.

---

## SUPERSEDED — 2026-09-08 — the 3D spike ran, and it works

The lead below was taken. `HEIGHT_SOURCE.md` and `HEIGHT_MEASUREMENTS.json` are
the result; this section supersedes the recommendation that follows it.

**Heights did not require decoding meshes.** Boston's I3S scene layer publishes a
per-feature attribute table carrying `Height_Ft`, and
`Height_Ft === Z_Max_Ft − Gnd_El_Ft` holds with **zero deviation across all 4,616
objects** in the envelope. Height is a difference, so it is datum-independent —
which matters, because absolute Z could *not* be reconciled with USGS 3DEP and is
left unresolved on purpose.

| | Hero-A (31) | Hero-B (9) |
|---|---|---|
| **MEASURED** — unique object | **12** | **5** |
| **COMPLEX** — one object covers several buildings | **15** | 2 |
| CONFLICT — rival object of very different height | 4 | 2 |
| UNRESOLVED | **0** | 0 |

**27 of 31 Hero-A now carry an authoritative measured height**, per building or
per complex. That was 0 before.

### The eleven that blocked the gate

The Krentzman quadrangle — the eleven Hero-A buildings that previously had
gross-area inference and nothing else — now reads:

- **measured outright:** Cabot 17.6 m, Mugar 25.6 m, Ryder 23.7 m, Egan 28.1 m,
  Shillman 22.8 m
- **measured as a pair:** Ell + Curry 24.8 m, Richards + Hayden 24.4 m, Dodge +
  Hastings 25.1 m
- **conflict:** Dana Research Center (26.7 m, with a 10.4 m rival nearby)

Every value in the quadrangle lands between **24.4 and 25.1 m** — which is what a
1930s quadrangle designed as one composition should measure, and is the strongest
internal evidence that the extraction is sound. `COMPLEX` here is a statement
about *resolution*, not reliability: the group height is the architecturally
correct unit for massing that quadrangle anyway.

### Validation

Against evidence that had no part in producing the measurement: EXP reads 56.3 m
against an independently tagged 56.6928 m (0.7%); Lightview 3.94 m per storey
over 21, International Village 3.41 over 22, East Village 4.19 over 17, West
Village H 4.36 over 16. The Prudential, outside the campus, reads 233.6 m against
a real roof near 228 m.

### Wave-2 gate — OPEN for Hero-A massing

The front-door cluster is measured, which was the whole blocker. Conditions:

1. **`COMPLEX` heights mass the group, not the building.** Ell and Curry get one
   height because the model gives one; do not invent a difference between them.
2. **The four conflicts stay out** until resolved — Dana, Hastings, 452
   Huntington, East Village. Three of the four are the matcher being cautious
   beside a tall neighbour rather than the data being wrong, so they are likely
   cheap to settle.
3. **Storeys are still storeys.** No storey-to-metre conversion is authorised or
   needed now — real heights exist.
4. **Absolute elevation is still unresolved.** Use height above ground; do not
   take `Gnd_El_Ft` as an elevation in the game's vertical frame.

---

## Recommendation (superseded — kept for the reasoning)

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
