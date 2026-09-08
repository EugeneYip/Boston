# Boston 3D Buildings — how the heights were obtained

Companion to `HEIGHT_MEASUREMENTS.json`. Reproduce with:

```bash
node tools/neu-height/fetch.mjs && node tools/neu-height/build.mjs
```

## Source

| | |
|---|---|
| dataset | **Boston 3D Buildings (Existing)** |
| publisher | City of Boston Planning Department (BPDA); ArcGIS item owner `jcowart_bpda`, portal org "Boston Maps" |
| service | `tiles.arcgis.com/tiles/sFnw0xNflSi8J0uh/.../Bos3d_Existing_MP/SceneServer` |
| item id | `d01bebadca584c249960f1eb6080f88c` |
| created / modified | 2025-04-17 / **2026-06-11** |
| format | I3S **SceneServer**, 3DObject, `meshpyramids` profile, store version 1.10 |
| horizontal CRS | EPSG:4326 |
| vertical | `vcsWkid 5773`; `heightModelInfo` = gravity-related, EGM96_height; `elevationInfo.unit` = **us-foot** |
| licence | **PDDL** — via the City's own portal record on `data.boston.gov`, which names this exact service |

**Two corrections to the earlier note that recommended this source.** The ArcGIS
item's own `licenseInfo` and `accessInformation` are **empty**; the PDDL comes
from the `data.boston.gov` record, and it is that record — same service URL, same
item id, publisher "Boston Maps" — which carries the dedication. And the
publisher states the layer is **"intended for visualization purposes only"**.
That is a fitness-for-purpose caveat, not a licence restriction, but it belongs
next to every number taken from it.

## The heights did not need the meshes

The obvious reading of "I3S SceneServer" is that heights must be recovered by
decoding geometry. They do not. A 3D Object scene layer publishes a full
per-feature **attribute table** beside the geometry, and Boston's carries
`Height_Ft`, `Gnd_El_Ft`, `Z_Max_Ft`, `Z_MIn_Ft`, `Centr_Lat`, `Centr_Lon`,
`Name`, `Parcel_ID`, `Model_LOD`, `Survey_Dt` and `QA_Flag`.

`tools/neu-height/i3s.mjs` therefore reads attributes and never touches a vertex.
It is ~120 lines and supports exactly this dataset: the node-page index, a
bounding-box filter over node OBBs, and the three attribute encodings the layer
uses. Format assumptions are documented in the file. The one that costs an hour
if missed: **value arrays are aligned to their element size**, so a Float64 array
starts at byte 8, not byte 4 — read it from 4 and every value comes back NaN,
which is indistinguishable from this layer's null encoding.

36 leaf nodes cover the Northeastern envelope; **4,616 buildings**, 504 attribute
blobs, no mesh downloaded and none committed.

## Which field is the height, and why

**`Height_Ft === Z_Max_Ft − Gnd_El_Ft`, with a maximum deviation of 0 across all
4,616 objects.** Height is therefore a *difference*, which is what makes it usable
here: a difference is datum-independent, and the absolute Z of this layer is not
reconcilable with USGS 3DEP (below).

**Do not use `Z_Max_Ft − Z_MIn_Ft`.** `Z_MIn_Ft` is the model's lowest vertex, not
the building base: it runs to **−46 to −50 ft** on the towers, so that difference
overstates a tower by roughly 15 m. This is precisely the trap of assuming
`minZ` is the base.

**Unit is US survey feet**, established against evidence that had no part in
producing it: EXP measures `Height_Ft` 184.6 → **56.3 m**, against an
independently tagged OSM height of **56.6928 m** — 0.7% apart. Four storey
controls agree independently: Lightview 82.8 m / 21 = 3.94 m per storey,
International Village 75.1 / 22 = 3.41, East Village 71.3 / 17 = 4.19, West
Village H 69.7 / 16 = 4.36. Outside the campus, the Prudential reads 233.6 m
against a real roof height near 228 m.

## Absolute Z is NOT reconciled — deliberately

Ten campus ground samples compared against USGS 3DEP give a mean difference of
−2.96 m with a **3.51 m spread**. A datum shift is a constant; a spread that wide
is the signature of a unit or local-datum mismatch, and `Gnd_El_Ft` values
(median 3.36, max 59.91) read as plausible *metres* while `Height_Ft` is provably
*feet*. The two cannot both be right, the identity above holds exactly in one
unit, and this spike did not need to settle it.

So, per the brief: **height is recovered from internal building geometry, and
absolute Z remains unresolved.** Nothing downstream should treat `Gnd_El_Ft` or
`Z_Max_Ft` as an elevation in the game's own vertical frame without settling this
first.

## Matching, and what it cannot do

Matched to `BUILDING_INVENTORY.json` by name token overlap first, then centroid
proximity within a footprint-scaled radius. Two rules earn their place:

- **Objects under 8 m are not hero buildings.** The layer models porches, kiosks
  and entrance canopies separately, down to 1.7 ft, and plain nearest-centroid
  put **Ell Hall on a 2.1 m canopy**.
- **One 3D object often covers several inventory buildings.** Six St Stephen
  Street entries share one 19 m terrace object; Ell shares with Curry, Richards
  with Hayden, Dodge with Hastings, Cargill with Stearns. Those are recorded as
  `COMPLEX` — a real height for the group, not resolvable to one building.

`COMPLEX` is a statement about resolution, not about reliability. For a connected
quadrangle of uniform height it is the architecturally correct unit anyway.
