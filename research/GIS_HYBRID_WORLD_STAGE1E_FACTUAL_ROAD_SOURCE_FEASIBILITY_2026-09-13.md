# Stage 1E — factual road source feasibility, licensing, and Back Bay probe

**Date** 2026-09-13 · **Baseline** `919a6c809d082f870d64e78c217d985ed28a5aba` (HEAD == origin/main, clean, 0/0)
**Research + bounded headless probe.** No `src/` change, no runtime activation, no query flag, no WebGL,
no deployment.

---

## A. Executive verdict

# PASS

**A legally clean, semantically appropriate, demonstrably better-registered factual road source exists, and it
is published by the City of Boston under the same licence this project already accepts for building geometry.**

`STAGE_1E_PRIMARY_READY`: **Boston Street Segments (SAM System)** — Boston Maps, **ODC-PDDL-1.0**.

The decisive measurement needs no width assumption at all. Walk along each road reference line and ask
whether the line itself is **inside a factual building**:

| road network | samples | road line inside a factual building |
|---|---|---|
| **Boston hand-authored `STREETS`** | 1,575 | **42.35%** |
| SAM, all features | 2,138 | 8.84% |
| **SAM, surface streets only** | 1,758 | **0.23%** |
| City of Boston Managed Streets | 1,660 | **0.00%** |

Boston's hand-authored streets run through real buildings in **42% of samples**. `Commonwealth Avenue Inbound`
is inside a real building in **100%** of its samples; `Public Alley 435` 93.5%; `Blagden Street` 90%;
`Huntington Avenue` 66.7%; `Newbury Street` 43.1%.

**SAM's 8.84% is not error, and the layer says so itself.** All of it is `Massachusetts TPKE W`
(`F_ZLEV = T_ZLEV = −1` — the Turnpike runs in a **tunnel under Back Bay**), its unnamed descending ramp
(`[0, −1]`), and `Exeter PLZ` (`CFCC A71`, a pedestrian plaza, not a road). Filtering on two published
attributes — `ZLEV ≥ 0` and `CFCC ≠ A71` — leaves **0.23%**. Every named surface street measures exactly
**0.0%**: Commonwealth, Newbury, Boylston, Exeter, Fairfield, Dartmouth, Huntington, Blagden, Stuart,
Clarendon and all seven Public Alleys.

And the two independent factual sources triangulate:

| comparison | p50 | p90 | max |
|---|---|---|---|
| SAM (surface) → Managed Streets | **1.00 m** | 2.75 m | 109.7 m |
| Boston `STREETS` → SAM (surface) | **10.64 m** | 26.50 m | 56.26 m |

Two independently produced City datasets agree with each other **to within a metre**, and both sit a median
**10.64 m** from Boston's hand-authored geometry — which matches Stage 1D's 9.12 m per-face displacement and
`ANCHORS.json`'s 24.7 m median landmark error, measured three different ways. **Stage 1D is strongly
corroborated.**

---

## B–C. Baseline and resources

`HEAD == origin/main == 919a6c8`, clean, 0/0, no merge state, remote `EugeneYip/Boston`, three auxiliary
worktrees untouched. Memory 31% free, swap headroom 1,347 MB, load 4.05, **three `xcodebuild` running and
untouched**, disk 118 GiB. No WebGL. Work is web research plus a few seconds of Node.

## D. Catalogs searched, and what was found

Searched Analyze Boston (`data.boston.gov`), BostonMaps Open Data, MassGIS / MassDOT open data, and the
MassGIS datalayer metadata. Candidates found and assessed:

| # | candidate | publisher | status |
|---|---|---|---|
| 1 | **Boston Street Segments (SAM System)** | Boston Maps | **PRIMARY** |
| 2 | **City of Boston Managed Streets** | Boston Maps (MassDOT/MassGIS lineage) | **SECONDARY** |
| 3 | MassGIS–MassDOT Roads (`EOTROADS_ARC`) | MassGIS / MassDOT | COMPARISON_ONLY — parent of #2; #2 is the same linework already republished by the City under an explicit PDDL record, so #2 supersedes it for this purpose |
| 4 | Sidewalk Centerline | Boston Maps | SEMANTICALLY_WRONG for a road backbone — sidewalk lines, and created 2011 |
| 5 | OpenStreetMap | OSM contributors | COMPARISON_ONLY — not needed; two PDDL sources already settle the question, so no OSM data was loaded |

**OSM was not used.** Both surviving candidates are public-domain City publications, so the ODbL question
never had to be opened. That is the cleanest possible outcome under existing project policy.

## E. Licensing — pinned from the machine-readable record

Not inferred from publisher identity, and not read off an ArcGIS UI label. Taken from the CKAN package API,
which is the catalog's own authoritative field:

```
GET https://data.boston.gov/api/3/action/package_show?id=boston-street-segments-sam-system
  license_id    : odc-pddl
  license_title : Open Data Commons Public Domain Dedication and License (PDDL)
  license_url   : http://www.opendefinition.org/licenses/odc-pddl
  organization  : Boston Maps
  metadata_modified : 2026-09-13T14:03:37
```

```
GET https://data.boston.gov/api/3/action/package_show?id=city-of-boston-managed-streets
  license_id    : odc-pddl   (same title/url)
  organization  : Boston Maps
  metadata_modified : 2024-12-05T23:35:39
```

| question | answer |
|---|---|
| **A. Access** | Yes — ArcGIS REST query, plus GeoJSON / CSV / SHP / KML downloads from the catalog |
| **B. Legal basis** | **ODC-PDDL-1.0**, a public-domain dedication. The same licence already accepted in this project for Buildings with Roof Breaks |
| **C. Redistribution** | Permitted. PDDL dedicates the database to the public domain |
| **D. Commercial use** | Permitted, unrestricted |
| **E. Derivative works** | Permitted — transform, clip, simplify, normalize |
| **F. Attribution** | **Not required** by PDDL. Credit given as project policy, as for Roof Breaks |
| **G. Service vs data rights** | Kept separate. The FeatureServer's own `licenseInfo` and `copyrightText` are **empty** for SAM; the licence comes from the catalog record, not from the endpoint's accessibility. Managed Streets' service carries `copyrightText: "Massachusetts Department of Transportation (MassDOT), MassGIS"`, which is a credit string, not a licence grant — its licence likewise comes from the CKAN record |
| **H. Third-party components** | Managed Streets embeds MassDOT Road Inventory linework, hence the MassDOT/MassGIS credit. SAM shows no third-party restriction |

**MassGIS discipline observed.** The Stage 1A.2 MassGIS *Building Structures* conclusion was **not**
generalised to roads. The MassGIS–MassDOT Roads layer is recorded as COMPARISON_ONLY and is not relied on:
the City's own PDDL republication is used instead, so no MassGIS-specific terms question needs resolving.
`mass.gov` returned HTTP 403 to automated fetch and `maps.massgis.state.ma.us` presents a certificate for a
different host — neither was worked around, and no conclusion rests on either.

## F. Semantics — stated, not assumed

| | SAM | Managed Streets |
|---|---|---|
| **what the line is** | street centreline carrying **address ranges** (`L_F_ADD`/`L_T_ADD`/`R_F_ADD`/`R_T_ADD`), one-way, z-levels and routing costs — an **addressing/routing centreline** | **MassDOT Road Inventory** centreline clipped to City-of-Boston jurisdiction — a **road-inventory centreline** |
| **what it is NOT** | a surveyed pavement or carriageway centreline | the same, and additionally a **jurisdictional subset**, not a complete street network |
| geometry | `esriGeometryPolyline` | `esriGeometryPolyline` |
| native CRS | EPSG:2249 / WKID 102686, NAD83 Massachusetts Mainland, **US survey feet** | same |
| width attributes | **none** | none |
| topology attributes | `ONEWAY`, `F_ZLEV`/`T_ZLEV`, `FT_COST`/`TF_COST`, `SPEEDLIMIT`, `CFCC`, `ROUTE_ID`, `ownership`, `NBHD_L`/`NBHD_R` | `CLASS`, `RDTYPE`, `ADMIN_TYPE`, `ROUTE_ID` |
| layer | `SAM_Boston_Segments_tbl` | `Boston_owned_streets01122022` |

**Neither source carries authoritative road width, and neither is asked to.** Stage 1E's question is
geographic registration. Factual centreline position and procedural street-section width stay strictly
separate, and **no carriageway width was inferred from building-wall distance** anywhere in this stage.

**Vintage discipline.** SAM's catalog record says *updated nightly* and its `metadata_modified` was observed
at 2026-09-13 — that is the **record's** cadence, not proof of when any particular line was surveyed. No
per-feature geometry capture date is published, and this report does not claim one. Managed Streets' lineage
is explicit and older: MassDOT 2017 year-end Road Inventory, conflated 2014–15 with MassGIS base streets,
updated against 2017–18 ortho imagery, clipped 2022-01-12, CKAN last modified 2024-12-05.

## G. Probe method

Canonical Stage 1A bbox, unchanged: WGS84 42.347703 / −71.082431 / 42.351297 / −71.077569.

One test, applied **symmetrically** to Boston's streets and to each candidate: sample every 2.0 m along the
road reference line, cast a ray out each side to 60 m, and record the first factual building boundary met.
That gives `dL`, `dR`, the **midline offset** `(dR − dL)/2`, and the **wall-to-wall** section `dL + dR`.
Factual geometry is the accepted PDDL Roof Breaks layer, cross-checked against MassGIS Structures.

**Projection, independently checked.** SAM was re-fetched in its native EPSG:2249 and passed through the
Stage 1A local inverse Lambert Conformal Conic; against the service's own EPSG:4326 output the residual is
**mean 0.966 m, worst 0.967 m over 11 vertices** — a *constant* offset across every vertex, which is the
signature of the known NAD83↔WGS84 datum difference that Stage 1A's check deliberately isolates, not a
projection fault. It applies equally to the buildings, which travel the same path, so the road-vs-building
comparison is unaffected.

## H. Back Bay coverage and topology

| | SAM | Managed |
|---|---|---|
| features in bbox | **52** | 40 |
| polylines / vertices | 52 / 172 | 40 / 158 |
| total length | **6,371.7 m** | 5,896.5 m |
| distinct street names | **20** | 17 |
| endpoint nodes / junctions | 42 / **20** | 38 / 11 |
| dangling endpoints | 13 | 16 |
| duplicate endpoint pairs | **0** | 1 |
| multipart features | 0 | 0 |
| segment length min / median / max | 0.52 / 28.5 / 469.0 m | 0.07 / 32.1 / 202.1 m |

Both carry **Newbury, Boylston, Commonwealth, Exeter, Fairfield, Dartmouth, Huntington, Blagden, Stuart** and
the Public Alleys. SAM additionally has Ring Rd, Clarendon Sq, Exeter Plz and the Turnpike; Managed has
Public Alley 439 which SAM lacks. Dangling endpoints are overwhelmingly bbox clipping, not broken topology.

## I. Registration results

### Width-independent pathology — see §A.

### Width-sensitivity sweep

A centreline source has no authoritative width, so the honest form is a sweep. **None of these widths is a
truth claim**; the question is whether a plausible street section can exist around the line at all. Percentage
of factual (PDDL) building area falling inside a corridor of the given diagnostic half-width:

| half-width | 3 m | 5 m | 7 m | **9 m** | 10 m |
|---|---|---|---|---|---|
| **Boston `STREETS`** | 9.01 | 14.83 | 20.92 | **26.93** | 29.98 |
| SAM surface | 0.35 | 1.72 | 3.41 | **5.97** | 7.82 |
| Managed | 0.65 | 1.93 | 3.48 | **5.85** | 7.42 |

At 9 m — close to Boston's own `corridorHalf` of 8.76 m for a `street` — the factual sources swallow **~4.5×
less** real building than Boston's hand-authored geometry. Stage 1C's independently measured 21% for Boston
sits inside this curve as expected.

### Per-street midline offset, and a caveat that matters

| street | Boston | SAM surface | Managed |
|---|---|---|---|
| **Newbury** | 11.05 m | 3.58 m | **2.67 m** |
| **Boylston** | 7.15 m | 2.92 m | **2.03 m** |
| **Exeter** | 5.60 m | 3.68 m | **3.07 m** |
| **Fairfield** | 7.82 m | 8.16 m | **5.87 m** |
| Commonwealth | 6.95 m | 19.77 m | 20.71 m |
| Huntington | 2.90 m | 9.99 m | 8.85 m |

On the four undivided streets the factual sources are **2–4× better**. Commonwealth and Huntington go the
other way, and the reason is a limitation of the metric rather than of the data: **midline offset assumes an
undivided street.** Commonwealth Avenue is a divided boulevard with a ~24 m planted mall — Boston models it
correctly as two carriageways at ±23 m — so a single factual centreline for one carriageway is ~20 m from the
wall midpoint *by construction*. Huntington carries a light-rail reservation. The metric penalises a correct
carriageway line; the pathology metric does not, and there the factual sources score 0.0% on Commonwealth
while **Boston's `Commonwealth Avenue Inbound` scores 100%**.

This is recorded rather than smoothed away, and it is why the verdict rests on the width-independent
pathology and the pairwise agreement, not on midline offset.

## J. Ranking

**PRIMARY — Boston Street Segments (SAM System).** It wins on suitability, not on pathology alone (Managed is
nominally 0.00% against SAM-surface's 0.23%):

- **topology a backbone actually needs** — `ONEWAY`, `F_ZLEV`/`T_ZLEV` for bridges and tunnels,
  `FT_COST`/`TF_COST` for routing, `SPEEDLIMIT`, address ranges, `CFCC` class;
- **a complete street network**, where Managed is explicitly a jurisdictional subset — 52 features / 20 names
  / 6,372 m against 40 / 17 / 5,896 m;
- **better connectivity** — 20 junction nodes against 11 — and **no duplicate geometry**, where Managed has one
  duplicate endpoint pair;
- **self-describing exceptions** — its tunnel and plaza features are identified by its own published
  attributes, which is what let the 8.84% be explained rather than argued away;
- **current** — nightly record updates, against Managed's 2017 Road Inventory lineage.

**Its weaknesses, stated plainly:** the semantics are an addressing/routing centreline, not a surveyed
pavement centreline; there is no width; divided boulevards need explicit handling; the service carries no
licence text of its own, so the licence rests on the catalog record; and no per-feature geometry vintage is
published.

**SECONDARY — City of Boston Managed Streets.** Useful as an independent cross-check — it agreed with SAM to
p50 1.00 m, which is what turns one source into corroborated evidence — and as MassDOT-lineage class and route
attribution. Not suitable as the backbone: subset coverage, no one-way or z-level, older lineage.

## K. Topology suitability — `USABLE_AFTER_NORMALIZATION`

Not `DIRECTLY_USABLE`, and the gap is specific and bounded: 42 endpoint nodes with 20 junctions and no
duplicates form a clean graph, but it is an **endpoint-only** graph. Boston's `RoadNetwork.build()` already
does exactly the missing work — hashes segments, finds true crossings, snaps dangling endpoints, splits at
intersections — so the normalization required is the pipeline the project already owns.

- **road rendering / parcel + frontage generation** — plausible. `buildPlots` consumes centreline polylines
  plus a width model, and the width model is procedural and stays that way.
- **traffic / routing** — plausible and better than today: `ONEWAY`, `FT_COST`/`TF_COST` and `SPEEDLIMIT` are
  exactly the attributes a routing graph wants, and Boston currently hand-authors one-way flags.
- **z-levels** — `F_ZLEV`/`T_ZLEV` give bridge/tunnel separation that `boston-geo.js` encodes ad hoc.
- **divided boulevards** — needs a deliberate decision. Comm Ave is the test case and Boston's existing
  two-carriageway model is the better structure.

## L. Fixture and provenance

`research/gis-stage1e/backbay-roads.json` — **39,066 bytes**, 52 SAM features (44 surface) plus the 40
Managed features for the head-to-head, all in Boston local X/Z metres at mm precision, deterministically
sorted. Raw extracts stay in gitignored `cache/`; `provenance.json` pins catalog URLs, CKAN API endpoints,
licence ids, service URLs, the exact bbox query, native CRS, transform path and raw SHA-256s
(`sam 647830c587888f61…`, `managed 3d8ca23cd3300535…`).

**No premature normalization:** nothing was straightened, merged, snapped, simplified or mapped onto Boston's
road classes, and no procedural width was added. The only selection is the source's own `ZLEV`/`CFCC` filter,
and both filtered and unfiltered sets are retained.

`probe.mjs` reads the **committed fixture**, never the network cache. Rerun verified **byte-identical**.

## M. Gates and verdict

| gate | result |
|---|---|
| **Licence** | **PASS** — ODC-PDDL-1.0 pinned from the CKAN API; redistribution, derivatives and commercial use permitted; no attribution required |
| **Semantics** | **PASS with a stated limit** — an addressing/routing centreline, sufficient for geographic registration, not a pavement centreline and not a width source |
| **Technical** | **PASS** — 42.35% → 0.23% width-independent pathology; ~4.5× less real building swallowed at every diagnostic width; no catastrophic topology defect; all key streets present; deterministic extraction |
| **Stage 1D corroboration** | **PASS** — two independent factual sources agree to 1.00 m and both sit 10.64 m from Boston, against Stage 1D's 9.12 m and ANCHORS' 24.7 m |

# Stage 1E: PASS · SAM is `STAGE_1E_PRIMARY_READY`

**Does new road data materially unlock Stage 1C's factual buildings?** The evidence says yes but does not yet
prove it. Stage 1C failed because six Back Bay streets implied a factual wall-to-wall width between −6.3 m and
+2.6 m — impossible sections caused by Boston's roads cutting through real blocks. With a road line that is
inside a building 0.23% of the time instead of 42%, that specific failure mode is removed. **Proving the
Stage 1C frontage actually becomes admissible requires generating parcels from the factual centrelines, which
is Stage 2A and is not authorised here.**

**Is the factual building data still usable?** Yes, unchanged and now better supported: it is what the road
sources were validated against.

## N. Limitations

1. Back Bay only — 400 m box, 52 features. Nothing citywide is claimed.
2. Neither source publishes per-feature geometry vintage; "nightly" is a record cadence.
3. Neither carries authoritative width. Street sections remain procedural.
4. Midline offset is invalid for divided boulevards (§I) and the verdict does not rest on it.
5. The ~0.97 m NAD83↔WGS84 datum offset is measured and unresolved, as in Stage 1A. It is common to roads and
   buildings, so it cancels in this comparison, but it would matter for absolute placement.
6. Fairfield Street improves least (7.82 → 5.87 m) and is not explained.
7. Topology is endpoint-only; crossings must be built.
8. MassGIS's own road terms were never resolved — deliberately routed around, not answered.

## O. Owner decision required next

**Stage 1E is complete and stops here.** Nothing was activated, no flag exists, `STREETS` is untouched.

1. **Authorise Stage 2A — factual road backbone, Back Bay isolated runtime prototype, default OFF.** This is
   what the evidence now supports: build `RoadNetwork` from the SAM fixture inside the Back Bay box only,
   regenerate parcels from it, and measure whether Stage 1C's impossible sections disappear. *This is the
   recommendation.* It is a genuinely larger change than any stage so far — it moves the geometry every other
   system derives from — and Stage 1D established the mitigating fact that all of those systems **regenerate at
   `City.init()`**, so there is no migration, only regeneration.
2. **Close the programme with the diagnosis complete.** Legitimate: the blocker is now named and a clean source
   is identified, and that is a sufficient resting point.
3. **Widen Stage 1E first** — extend the source probe citywide before committing to a runtime prototype, to
   learn whether Back Bay's result generalises.

**Not authorised and not recommended under any option:** replacing `STREETS`, road migration, parcel
regeneration in production, traffic/sidewalk/routing migration, collision changes, default-on, deployment, or
citywide rollout.

---

*Stage 1E. Research and bounded probe only. `src/` untouched; Boston is bit-for-bit the city it was at
`919a6c8`. Not pushed, not deployed, not enabled.*
