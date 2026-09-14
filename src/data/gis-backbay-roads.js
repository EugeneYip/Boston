/**
 * Back Bay factual road centrelines — GENERATED, do not hand-edit.
 *
 *   node research/gis-stage2a3/build-candidate.mjs
 *
 * Stage 2A.3 prototype data. DEFAULT OFF: nothing imports this unless
 * `?gisRoads=1` is present. See `src/world/GisRoads.js`.
 *
 * Source      Boston Street Segments (SAM System), Boston Maps, City of Boston
 * Licence     ODC-PDDL-1.0 — https://data.boston.gov/dataset/boston-street-segments-sam-system
 * Service     https://gisportal.boston.gov/arcgis/rest/services/SAM/Live_SAM_Address/FeatureServer/3
 * Layer       SAM_Boston_Segments_tbl
 * Retrieved   2026-09-13
 * Raw sha256  647830c587888f6133be66cd762cdc1a6bff4f961ed5541515946184220c6450
 * Projection  service EPSG:4326, then production src/core/Geo.js geo()
 *
 * SEMANTICS. Addressing / routing centrelines, not surveyed pavement centrelines,
 * and SAM carries no authoritative width. Only centreline geometry, street
 * identity, ZLEV and one-way sense are factual. Width, lanes, class, footway,
 * kerb and parking stay procedural, inherited from Boston's own entry for the
 * street of that name.
 *
 * CONTAINMENT (Stage 2A.3). Factual geometry is CLIPPED TO THE CORE so it cannot
 * create junctions outside it, and Boston's own streets are cut ON THE LOT GRID
 * just beyond the core — never mid-edge — so `buildPlots`' per-edge lot phase is
 * preserved and every lot outside the seam regenerates where the baseline put
 * it. Clipped streets carry the matching slice of every per-vertex array
 * (`median`, `y`, `bridge`); Stage 2A kept them whole, which misaligned
 * Huntington's median and caused the `nuniv` station section to be refused.
 *
 * SEAM PORTS. Each factual endpoint on the core boundary is paired with the
 * hand-authored crossing of the SAME concept, the SAME boundary face and the
 * same order along that face, and joined by a synthetic `transitionConnector`
 * to that crossing's lot-grid cut stub. A port with no such counterpart is
 * TERMINAL and carries `noSnap`, listing the endpoint indices that
 * `RoadNetwork.build()`'s 21 m dangling-endpoint snap must leave alone —
 * without it the port is adopted by whatever edge is nearest and splits it
 * mid-edge, re-phasing that edge's lots for its whole length.
 *
 * EXCLUSIONS. Grade-separated features are dropped, not flattened: the Turnpike
 * runs under Back Bay at ZLEV -1 and its ramps at -2..0. `Exeter PLZ` is a
 * pedestrian plaza (CFCC A71).
 */
export const GIS_ROADS_SOURCE = {
 "dataset": "Boston Street Segments (SAM System)",
 "publisher": "Boston Maps, City of Boston",
 "licence": "ODC-PDDL-1.0",
 "catalog": "https://data.boston.gov/dataset/boston-street-segments-sam-system",
 "service": "https://gisportal.boston.gov/arcgis/rest/services/SAM/Live_SAM_Address/FeatureServer/3",
 "layer": "SAM_Boston_Segments_tbl",
 "retrieved": "2026-09-13",
 "rawSha256": "647830c587888f6133be66cd762cdc1a6bff4f961ed5541515946184220c6450",
 "semantics": "Street centreline carrying address ranges, one-way, z-levels and routing costs. An addressing/routing centreline — NOT a surveyed pavement or carriageway centreline.",
 "core": {
  "x0": -1380.4601077,
  "x1": -980.4960386,
  "z0": 454.51956,
  "z1": 854.60364
 },
 "surfaceFilter": "F_ZLEV >= 0 AND T_ZLEV >= 0 AND CFCC != A71",
 "excludedFeatures": 8,
 "containment": "factual geometry clipped to the core; Boston streets cut on the lot grid just beyond it; seam ports paired by (concept, boundary face, order along face)",
 "seamMaxBeyondCoreM": 216.15
};

/** Factual surface streets, clipped to the core, in the STREETS shape. */
export const GIS_ROADS = [
 {
  "name": "Boylston Street",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.3495165,
    -71.0794993
   ],
   [
    42.34997,
    -71.0778192
   ],
   [
    42.3500356,
    -71.077569
   ]
  ],
  "sam": {
   "segmentId": 978,
   "name": "Boylston ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Dartmouth Street",
  "type": "arterial",
  "lanes": 3,
  "noSnap": [
   0
  ],
  "path": [
   [
    42.3505548,
    -71.077569
   ],
   [
    42.3508992,
    -71.0777342
   ]
  ],
  "sam": {
   "segmentId": 2240,
   "name": "Dartmouth ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Dartmouth Street",
  "type": "arterial",
  "lanes": 3,
  "path": [
   [
    42.3508992,
    -71.0777342
   ],
   [
    42.351281,
    -71.0779105
   ]
  ],
  "sam": {
   "segmentId": 2241,
   "name": "Dartmouth ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Dartmouth Street",
  "type": "arterial",
  "lanes": 3,
  "noSnap": [
   1
  ],
  "path": [
   [
    42.351281,
    -71.0779105
   ],
   [
    42.351297,
    -71.077919
   ]
  ],
  "sam": {
   "segmentId": 2242,
   "name": "Dartmouth ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Fairfield Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "noSnap": [
   1
  ],
  "path": [
   [
    42.350084,
    -71.0823711
   ],
   [
    42.3501974,
    -71.082431
   ]
  ],
  "sam": {
   "segmentId": 2848,
   "name": "Fairfield ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Fairfield Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3496947,
    -71.08218
   ],
   [
    42.3496992,
    -71.0821822
   ],
   [
    42.350084,
    -71.0823711
   ]
  ],
  "sam": {
   "segmentId": 2849,
   "name": "Fairfield ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Fairfield Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3493079,
    -71.081996
   ],
   [
    42.3493164,
    -71.082
   ],
   [
    42.3495225,
    -71.0820966
   ],
   [
    42.3496947,
    -71.08218
   ]
  ],
  "sam": {
   "segmentId": 2850,
   "name": "Fairfield ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.351297,
    -71.0803719
   ],
   [
    42.3511294,
    -71.0802791
   ]
  ],
  "sam": {
   "segmentId": 3000,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3511294,
    -71.0802791
   ],
   [
    42.3507002,
    -71.0800779
   ]
  ],
  "sam": {
   "segmentId": 3001,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3507002,
    -71.0800779
   ],
   [
    42.3503178,
    -71.0798902
   ]
  ],
  "sam": {
   "segmentId": 3002,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3503178,
    -71.0798902
   ],
   [
    42.3501372,
    -71.0798017
   ],
   [
    42.3499378,
    -71.079704
   ]
  ],
  "sam": {
   "segmentId": 3003,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Newbury Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.350944,
    -71.077569
   ],
   [
    42.3508992,
    -71.0777342
   ]
  ],
  "sam": {
   "segmentId": 5660,
   "name": "Newbury ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Newbury Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3508992,
    -71.0777342
   ],
   [
    42.3506001,
    -71.0788319
   ],
   [
    42.3503178,
    -71.0798902
   ]
  ],
  "sam": {
   "segmentId": 5661,
   "name": "Newbury ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Newbury Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3503178,
    -71.0798902
   ],
   [
    42.3498681,
    -71.0815411
   ],
   [
    42.3496947,
    -71.08218
   ]
  ],
  "sam": {
   "segmentId": 5666,
   "name": "Newbury ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Newbury Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3496947,
    -71.08218
   ],
   [
    42.3496266,
    -71.082431
   ]
  ],
  "sam": {
   "segmentId": 5667,
   "name": "Newbury ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley No. 432",
  "type": "alley",
  "lanes": 1,
  "noSnap": [
   1
  ],
  "path": [
   [
    42.350084,
    -71.0823711
   ],
   [
    42.3500679,
    -71.082431
   ]
  ],
  "sam": {
   "segmentId": 5970,
   "name": "Public Alley No. 432",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley No. 433",
  "type": "alley",
  "lanes": 1,
  "path": [
   [
    42.3507002,
    -71.0800779
   ],
   [
    42.350084,
    -71.0823711
   ]
  ],
  "sam": {
   "segmentId": 5971,
   "name": "Public Alley No. 433",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley No. 434",
  "type": "alley",
  "lanes": 1,
  "path": [
   [
    42.351281,
    -71.0779105
   ],
   [
    42.3507002,
    -71.0800779
   ]
  ],
  "sam": {
   "segmentId": 5972,
   "name": "Public Alley No. 434",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley 435",
  "type": "alley",
  "lanes": 1,
  "path": [
   [
    42.351297,
    -71.0778525
   ],
   [
    42.351281,
    -71.0779105
   ]
  ],
  "sam": {
   "segmentId": 5973,
   "name": "Public Alley No. 435",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley No. 440",
  "type": "alley",
  "lanes": 1,
  "noSnap": [
   0
  ],
  "path": [
   [
    42.350503,
    -71.077569
   ],
   [
    42.3499378,
    -71.079704
   ]
  ],
  "sam": {
   "segmentId": 5977,
   "name": "Public Alley No. 440",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley No. 441",
  "type": "alley",
  "lanes": 1,
  "path": [
   [
    42.3499378,
    -71.079704
   ],
   [
    42.3493079,
    -71.081996
   ]
  ],
  "sam": {
   "segmentId": 5978,
   "name": "Public Alley No. 441",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Public Alley 442",
  "type": "alley",
  "lanes": 1,
  "path": [
   [
    42.3493079,
    -71.081996
   ],
   [
    42.3491902,
    -71.082431
   ]
  ],
  "sam": {
   "segmentId": 5979,
   "name": "Public Alley No. 442",
   "cfcc": "A73",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Commonwealth Avenue Outbound",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "mall": true,
  "noSnap": [
   0
  ],
  "path": [
   [
    42.351297,
    -71.081114
   ],
   [
    42.3512524,
    -71.0812771
   ],
   [
    42.3509827,
    -71.0822791
   ],
   [
    42.3509418,
    -71.082431
   ]
  ],
  "sam": {
   "segmentId": 9217,
   "name": "Commonwealth AVE",
   "cfcc": "A25",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3499378,
    -71.079704
   ],
   [
    42.3497181,
    -71.0795972
   ]
  ],
  "sam": {
   "segmentId": 10182,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3497181,
    -71.0795972
   ],
   [
    42.3495165,
    -71.0794993
   ]
  ],
  "sam": {
   "segmentId": 10183,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Fairfield Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3488972,
    -71.0818009
   ],
   [
    42.3490731,
    -71.0818845
   ],
   [
    42.3493079,
    -71.081996
   ]
  ],
  "sam": {
   "segmentId": 11006,
   "name": "Fairfield ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3495165,
    -71.0794993
   ],
   [
    42.3492793,
    -71.079382
   ],
   [
    42.3492632,
    -71.079374
   ],
   [
    42.3490071,
    -71.0792475
   ],
   [
    42.3486973,
    -71.0790943
   ]
  ],
  "sam": {
   "segmentId": 11605,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Boylston Street",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.3491606,
    -71.0808036
   ],
   [
    42.3495165,
    -71.0794993
   ]
  ],
  "sam": {
   "segmentId": 11694,
   "name": "Boylston ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Boylston Street",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.3488972,
    -71.0818009
   ],
   [
    42.349047,
    -71.0812305
   ],
   [
    42.3490501,
    -71.0812186
   ],
   [
    42.3491606,
    -71.0808036
   ]
  ],
  "sam": {
   "segmentId": 11695,
   "name": "Boylston ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Commonwealth Avenue Inbound",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "mall": true,
  "noSnap": [
   1
  ],
  "path": [
   [
    42.3511294,
    -71.0802791
   ],
   [
    42.351297,
    -71.079661
   ]
  ],
  "sam": {
   "segmentId": 12254,
   "name": "Commonwealth AVE",
   "cfcc": "A25",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Commonwealth Avenue Inbound",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "mall": true,
  "noSnap": [
   0
  ],
  "path": [
   [
    42.3505507,
    -71.082431
   ],
   [
    42.3510201,
    -71.0806857
   ],
   [
    42.3511294,
    -71.0802791
   ]
  ],
  "sam": {
   "segmentId": 12256,
   "name": "Commonwealth AVE",
   "cfcc": "A25",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Boylston Street",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.3487252,
    -71.082431
   ],
   [
    42.3487448,
    -71.0823577
   ],
   [
    42.3487909,
    -71.0821893
   ],
   [
    42.3488972,
    -71.0818009
   ]
  ],
  "sam": {
   "segmentId": 12875,
   "name": "Boylston ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Blagden Street",
  "type": "street",
  "lanes": 2,
  "path": [
   [
    42.3490844,
    -71.077569
   ],
   [
    42.3490566,
    -71.0777255
   ],
   [
    42.3488319,
    -71.0785816
   ],
   [
    42.3486973,
    -71.0790943
   ]
  ],
  "sam": {
   "segmentId": 13842,
   "name": "Blagden ST",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Clarendon SQ",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.348118,
    -71.0782871
   ],
   [
    42.3479285,
    -71.0781034
   ]
  ],
  "sam": {
   "segmentId": 16148,
   "name": "Clarendon SQ",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Stuart ST",
  "type": "arterial",
  "lanes": 4,
  "noSnap": [
   1
  ],
  "path": [
   [
    42.3479285,
    -71.0781034
   ],
   [
    42.3479836,
    -71.0779131
   ],
   [
    42.3480366,
    -71.0776708
   ],
   [
    42.3480465,
    -71.077569
   ]
  ],
  "sam": {
   "segmentId": 16149,
   "name": "Stuart ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3486973,
    -71.0790943
   ],
   [
    42.3478717,
    -71.078706
   ]
  ],
  "sam": {
   "segmentId": 16151,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.348118,
    -71.0782871
   ],
   [
    42.3478717,
    -71.078706
   ]
  ],
  "sam": {
   "segmentId": 16154,
   "name": "Huntington AVE",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "noSnap": [
   0
  ],
  "path": [
   [
    42.3487284,
    -71.077569
   ],
   [
    42.348446,
    -71.0778822
   ],
   [
    42.348118,
    -71.0782871
   ]
  ],
  "sam": {
   "segmentId": 16561,
   "name": "Huntington AVE",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.348958,
    -71.077569
   ],
   [
    42.3485491,
    -71.0780678
   ],
   [
    42.3482067,
    -71.0784772
   ],
   [
    42.3480299,
    -71.0786423
   ],
   [
    42.3478717,
    -71.078706
   ]
  ],
  "sam": {
   "segmentId": 19565,
   "name": "Huntington AVE",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.3478717,
    -71.078706
   ],
   [
    42.347703,
    -71.0789146
   ]
  ],
  "sam": {
   "segmentId": 19626,
   "name": "Huntington AVE",
   "cfcc": "A35",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "noSnap": [
   0
  ],
  "path": [
   [
    42.347703,
    -71.0786293
   ],
   [
    42.3477099,
    -71.0786195
   ]
  ],
  "sam": {
   "segmentId": 19794,
   "name": "Huntington AVE",
   "cfcc": "A35",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Ring Road",
  "type": "street",
  "lanes": 2,
  "noSnap": [
   1
  ],
  "path": [
   [
    42.3491606,
    -71.0808036
   ],
   [
    42.3489237,
    -71.0806736
   ],
   [
    42.3481247,
    -71.0802626
   ],
   [
    42.3479277,
    -71.0801526
   ],
   [
    42.3477237,
    -71.0800546
   ],
   [
    42.347703,
    -71.0800444
   ]
  ],
  "sam": {
   "segmentId": 20724,
   "name": "Ring RD",
   "cfcc": "A41",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Stuart ST",
  "type": "arterial",
  "lanes": 4,
  "path": [
   [
    42.3477099,
    -71.0786195
   ],
   [
    42.3477645,
    -71.078525
   ],
   [
    42.3477773,
    -71.0785029
   ],
   [
    42.3478139,
    -71.0784287
   ],
   [
    42.3478468,
    -71.0783515
   ],
   [
    42.347876,
    -71.0782716
   ],
   [
    42.3479012,
    -71.0781894
   ],
   [
    42.3479049,
    -71.0781767
   ],
   [
    42.3479285,
    -71.0781034
   ]
  ],
  "sam": {
   "segmentId": 24055,
   "name": "Stuart ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "path": [
   [
    42.3478717,
    -71.078706
   ],
   [
    42.3477099,
    -71.0786195
   ]
  ],
  "sam": {
   "segmentId": 24061,
   "name": "Exeter ST",
   "cfcc": "A31",
   "zlev": [
    0,
    0
   ]
  }
 }
];

/** Boston streets, clipped to the parts outside the core, per-vertex arrays sliced to match. */
export const GIS_ROADS_CLIPPED = [
 {
  "name": "Commonwealth Avenue Inbound",
  "index": 2,
  "runs": [
   {
    "path": [
     [
      42.34955812043059,
      -71.0887617693674
     ],
     [
      42.350099693236174,
      -71.08657146655298
     ],
     [
      42.35064126604175,
      -71.08438116373856
     ],
     [
      42.3511122,
      -71.0824766
     ]
    ],
    "noSnap": [
     1
    ]
   },
   {
    "path": [
     [
      42.3513006,
      -71.0817147
     ],
     [
      42.3517244116529,
      -71.0800005581097
     ],
     [
      42.352265984458484,
      -71.07781025529528
     ],
     [
      42.352807557264065,
      -71.07561995248085
     ],
     [
      42.35334913006964,
      -71.07342964966644
     ],
     [
      42.35389070287522,
      -71.07123934685201
     ]
    ],
    "noSnap": [
     0
    ]
   }
  ]
 },
 {
  "name": "Commonwealth Avenue Outbound",
  "index": 3,
  "runs": [
   {
    "path": [
     [
      42.353498833596205,
      -71.07106191636137
     ],
     [
      42.35295726079063,
      -71.0732522191758
     ],
     [
      42.35241568798505,
      -71.07544252199023
     ],
     [
      42.35187411517947,
      -71.07763282480465
     ],
     [
      42.351332542373896,
      -71.07982312761906
     ],
     [
      42.351309,
      -71.0799184
     ]
    ],
    "noSnap": [
     1
    ]
   },
   {
    "path": [
     [
      42.3506732,
      -71.0824896
     ],
     [
      42.35024939676274,
      -71.08420373324792
     ],
     [
      42.34970782395716,
      -71.08639403606234
     ],
     [
      42.34916625115158,
      -71.08858433887677
     ]
    ]
   }
  ]
 },
 {
  "name": "Newbury Street",
  "index": 5,
  "runs": [
   {
    "path": [
     [
      42.352715095038185,
      -71.07070705538011
     ],
     [
      42.35215927031667,
      -71.07295499774229
     ],
     [
      42.35160344559516,
      -71.07520294010446
     ],
     [
      42.35104762087364,
      -71.07745088246664
     ],
     [
      42.3510197,
      -71.0775637
     ]
    ]
   },
   {
    "path": [
     [
      42.3497953,
      -71.0825156
     ],
     [
      42.3493801467091,
      -71.08419470955315
     ],
     [
      42.348824321987586,
      -71.08644265191532
     ],
     [
      42.34826849726607,
      -71.0886905942775
     ]
    ]
   }
  ]
 },
 {
  "name": "Boylston Street",
  "index": 6,
  "runs": [
   {
    "path": [
     [
      42.35225,
      -71.06432
     ],
     [
      42.35208,
      -71.066
     ],
     [
      42.35221143583293,
      -71.06833831825875
     ],
     [
      42.35173542184066,
      -71.07026347915354
     ],
     [
      42.351193849035084,
      -71.07245378196797
     ],
     [
      42.3506522762295,
      -71.07464408478238
     ],
     [
      42.35011070342392,
      -71.0768343875968
     ],
     [
      42.3499459,
      -71.077501
     ]
    ]
   },
   {
    "path": [
     [
      42.3487215,
      -71.082453
     ],
     [
      42.34848598500719,
      -71.08340529604008
     ],
     [
      42.34794441220161,
      -71.08559559885451
     ],
     [
      42.34740283939603,
      -71.08778590166892
     ],
     [
      42.346924491055645,
      -71.08910753586161
     ],
     [
      42.34638945757344,
      -71.09027531911302
     ],
     [
      42.34580888246461,
      -71.09155066709076
     ],
     [
      42.34518276572917,
      -71.09293357979485
     ],
     [
      42.3464,
      -71.0993
     ],
     [
      42.3458,
      -71.1032
     ]
    ]
   }
  ]
 },
 {
  "name": "Public Alley 435",
  "index": 10,
  "runs": [
   {
    "path": [
     [
      42.35312367959002,
      -71.07127660937218
     ],
     [
      42.352285666932964,
      -71.07466581477976
     ],
     [
      42.351447654275916,
      -71.07805502018735
     ],
     [
      42.3513019,
      -71.0786444
     ]
    ]
   },
   {
    "path": [
     [
      42.35036,
      -71.0824537
     ],
     [
      42.349771628961804,
      -71.08483343100251
     ],
     [
      42.348933616304755,
      -71.0882226364101
     ]
    ],
    "noSnap": [
     0
    ]
   }
  ]
 },
 {
  "name": "Public Alley 442",
  "index": 11,
  "runs": [
   {
    "path": [
     [
      42.35214400639249,
      -71.0708330331456
     ],
     [
      42.35130599373544,
      -71.07422223855319
     ],
     [
      42.3504871,
      -71.0775343
     ]
    ],
    "noSnap": [
     1
    ]
   },
   {
    "path": [
     [
      42.3492626,
      -71.0824862
     ],
     [
      42.34879195576428,
      -71.08438985477594
     ],
     [
      42.34795394310723,
      -71.08777906018351
     ]
    ]
   }
  ]
 },
 {
  "name": "Exeter Street",
  "index": 16,
  "runs": [
   {
    "path": [
     [
      42.35376042812429,
      -71.08092242522407
     ],
     [
      42.352244064392465,
      -71.08023584636902
     ],
     [
      42.3513325,
      -71.0798231
     ]
    ]
   }
  ]
 },
 {
  "name": "Fairfield Street",
  "index": 17,
  "runs": [
   {
    "path": [
     [
      42.35321885531871,
      -71.0831127280385
     ],
     [
      42.351702491586884,
      -71.08242614918345
     ],
     [
      42.3513277,
      -71.0822564
     ]
    ],
    "noSnap": [
     1
    ]
   }
  ]
 },
 {
  "name": "Blagden Street",
  "index": 21,
  "runs": [
   {
    "path": [
     [
      42.349588103544605,
      -71.07672594998672
     ],
     [
      42.3493853,
      -71.0775461
     ]
    ]
   }
  ]
 },
 {
  "name": "Ring Road",
  "index": 22,
  "runs": []
 },
 {
  "name": "Huntington Avenue",
  "index": 100,
  "runs": [
   {
    "path": [
     [
      42.3498,
      -71.0766
     ],
     [
      42.3492151,
      -71.0775178
     ]
    ],
    "median": [
     0,
     0
    ]
   },
   {
    "path": [
     [
      42.3476985,
      -71.0795565
     ],
     [
      42.34672,
      -71.08025
     ],
     [
      42.34626,
      -71.08066
     ],
     [
      42.34509,
      -71.08215
     ],
     [
      42.34337,
      -71.08418
     ],
     [
      42.34135,
      -71.08672
     ],
     [
      42.34109,
      -71.08717
     ],
     [
      42.34087,
      -71.08767
     ],
     [
      42.33797,
      -71.09491
     ],
     [
      42.33755,
      -71.09607
     ],
     [
      42.33732,
      -71.09695
     ]
    ],
    "median": [
     0,
     0,
     0,
     0,
     0,
     0,
     0,
     7,
     7,
     7,
     7
    ]
   }
  ]
 }
];

/** SYNTHETIC seam joins. NOT factual SAM geometry; they exist only in the transition seam. */
export const GIS_ROADS_CONNECTORS = [
 {
  "name": "Blagden Street",
  "type": "street",
  "lanes": 2,
  "transitionConnector": true,
  "lengthM": 33.55,
  "face": "x1",
  "path": [
   [
    42.3493853,
    -71.0775461
   ],
   [
    42.3490844,
    -71.077569
   ]
  ]
 },
 {
  "name": "Boylston Street",
  "type": "arterial",
  "lanes": 4,
  "transitionConnector": true,
  "lengthM": 1.86,
  "face": "x0",
  "path": [
   [
    42.3487215,
    -71.082453
   ],
   [
    42.3487252,
    -71.082431
   ]
  ]
 },
 {
  "name": "Boylston Street",
  "type": "arterial",
  "lanes": 4,
  "transitionConnector": true,
  "lengthM": 11.45,
  "face": "x1",
  "path": [
   [
    42.3500356,
    -71.077569
   ],
   [
    42.3499459,
    -71.077501
   ]
  ]
 },
 {
  "name": "Commonwealth Avenue Outbound",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "transitionConnector": true,
  "lengthM": 30.28,
  "face": "x0",
  "path": [
   [
    42.3509418,
    -71.082431
   ],
   [
    42.3506732,
    -71.0824896
   ]
  ]
 },
 {
  "name": "Exeter Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "transitionConnector": true,
  "lengthM": 45.32,
  "face": "z0",
  "path": [
   [
    42.3513325,
    -71.0798231
   ],
   [
    42.351297,
    -71.0803719
   ]
  ]
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "transitionConnector": true,
  "lengthM": 28.92,
  "face": "x1",
  "path": [
   [
    42.3492151,
    -71.0775178
   ],
   [
    42.348958,
    -71.077569
   ]
  ]
 },
 {
  "name": "Huntington Avenue",
  "type": "arterial",
  "lanes": 4,
  "transitionConnector": true,
  "lengthM": 52.81,
  "face": "z1",
  "path": [
   [
    42.347703,
    -71.0789146
   ],
   [
    42.3476985,
    -71.0795565
   ]
  ]
 },
 {
  "name": "Newbury Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "transitionConnector": true,
  "lengthM": 20.03,
  "face": "x0",
  "path": [
   [
    42.3496266,
    -71.082431
   ],
   [
    42.3497953,
    -71.0825156
   ]
  ]
 },
 {
  "name": "Newbury Street",
  "type": "street",
  "lanes": 2,
  "oneway": 1,
  "transitionConnector": true,
  "lengthM": 8.44,
  "face": "x1",
  "path": [
   [
    42.3510197,
    -71.0775637
   ],
   [
    42.350944,
    -71.077569
   ]
  ]
 },
 {
  "name": "Public Alley 435",
  "type": "alley",
  "lanes": 1,
  "transitionConnector": true,
  "lengthM": 65.15,
  "face": "z0",
  "path": [
   [
    42.3513019,
    -71.0786444
   ],
   [
    42.351297,
    -71.0778525
   ]
  ]
 },
 {
  "name": "Public Alley 442",
  "type": "alley",
  "lanes": 1,
  "transitionConnector": true,
  "lengthM": 9.26,
  "face": "x0",
  "path": [
   [
    42.3491902,
    -71.082431
   ],
   [
    42.3492626,
    -71.0824862
   ]
  ]
 }
];
