/**
 * Stage 1E — normalize the PRIMARY candidate into a bounded, committed Back Bay
 * fixture, and pin its provenance.
 *
 *   node research/gis-stage1e/normalize.mjs
 *
 * Network acquisition happens once, into `cache/` (gitignored). This step turns
 * the pinned raw extract into a small deterministic artifact so the probe never
 * needs the network again.
 *
 * DELIBERATELY NOT DONE here: no straightening, no segment merging, no
 * intersection snapping, no vertex simplification, no mapping onto Boston's road
 * classes, no procedural width. The fixture records what the source says. The
 * only selection applied is the source's own `ZLEV`/`CFCC` surface-street
 * filter, and both the filtered and unfiltered sets are retained so the choice
 * stays visible.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadRoadCandidates, polylines } from './roads.mjs';

const r3 = (v) => Math.round(v * 1000) / 1000;
const cands = loadRoadCandidates();

/** Topology of a candidate, measured on the raw source geometry. */
function topology(cand) {
  const ends = new Map();
  const key = (p) => `${Math.round(p.x * 100)}_${Math.round(p.z * 100)}`;
  let verts = 0, len = 0, minSeg = Infinity;
  const segLens = [];
  for (const { pts } of polylines(cand)) {
    verts += pts.length;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      len += d; segLens.push(d); if (d < minSeg) minSeg = d;
    }
    for (const p of [pts[0], pts[pts.length - 1]]) ends.set(key(p), (ends.get(key(p)) || 0) + 1);
  }
  const deg = [...ends.values()];
  segLens.sort((a, b) => a - b);
  // Coincident duplicates: two polylines whose endpoint pair matches.
  const pairs = new Map();
  for (const { pts } of polylines(cand)) {
    const a = key(pts[0]), b = key(pts[pts.length - 1]);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  return {
    features: cand.features.length, polylines: polylines(cand).length, vertices: verts,
    totalLengthM: r3(len),
    endpointNodes: ends.size,
    danglingEndpoints: deg.filter((v) => v === 1).length,
    junctionNodes: deg.filter((v) => v >= 3).length,
    pairedEndpoints: deg.filter((v) => v === 2).length,
    duplicateEndpointPairs: [...pairs.values()].filter((v) => v > 1).length,
    multipartFeatures: cand.features.filter((f) => f.paths.length > 1).length,
    segmentLengthM: { min: r3(segLens[0]), median: r3(segLens[Math.floor(segLens.length / 2)]), max: r3(segLens[segLens.length - 1]) },
  };
}

const isSurface = (f) => (f.zlev?.[0] ?? 0) >= 0 && (f.zlev?.[1] ?? 0) >= 0 && f.cfcc !== 'A71';

const fixture = {
  schemaVersion: 'boston-gis-stage1e/backbay-roads/0.1.0',
  what: 'Bounded Back Bay extract of the Stage 1E PRIMARY factual road candidate, in Boston local X/Z metres. RESEARCH FIXTURE — not runtime data, not in src/.',
  primary: 'sam',
  source: {
    dataset: 'Boston Street Segments (SAM System)',
    publisher: 'Boston Maps, City of Boston',
    catalog: 'https://data.boston.gov/dataset/boston-street-segments-sam-system',
    packageId: 'b9b8b634-f28a-410f-9727-b53d0d006308',
    service: 'https://gisportal.boston.gov/arcgis/rest/services/SAM/Live_SAM_Address/FeatureServer/3',
    layerName: 'SAM_Boston_Segments_tbl',
    licence: 'ODC-PDDL-1.0 (odc-pddl), per the Analyze Boston CKAN record',
    licenceUrl: 'http://www.opendefinition.org/licenses/odc-pddl',
    attribution: 'Boston Maps / City of Boston. PDDL imposes no attribution requirement; credit is given as project policy.',
    sourceCRS: 'EPSG:4326 (requested outSR=4326; native service SR is EPSG:2249 / WKID 102686, NAD83 Massachusetts Mainland ftUS)',
    transformPath: 'ArcGIS service reprojection to EPSG:4326, then production src/core/Geo.js geo() to Boston local X/Z',
    retrieved: '2026-09-13',
    rawSha256: cands.sam.sha256,
    semantics: 'Street centreline carrying address ranges, one-way, z-levels and routing costs. An addressing/routing centreline — NOT a surveyed pavement or carriageway centreline.',
  },
  bboxWgs84: { s: 42.347703, w: -71.082431, n: 42.351297, e: -71.077569 },
  surfaceFilter: 'F_ZLEV >= 0 AND T_ZLEV >= 0 AND CFCC != A71',
  features: cands.sam.features
    .slice()
    .sort((a, b) => a.id - b.id || a.oid - b.oid)
    .map((f) => ({
      segmentId: f.id, objectId: f.oid, name: f.name,
      cfcc: f.cfcc, oneway: f.oneway, zlev: f.zlev, speedLimit: f.speed, ownership: f.ownership,
      surface: isSurface(f),
      paths: f.paths.map((p) => p.map((q) => [r3(q.x), r3(q.z)])),
    })),
  // The SECONDARY candidate travels with the fixture too, so the offline probe
  // can reproduce the head-to-head without re-acquiring anything.
  secondary: {
    dataset: 'City of Boston Managed Streets', publisher: 'Boston Maps, City of Boston',
    licence: 'ODC-PDDL-1.0 (odc-pddl), per the Analyze Boston CKAN record',
    service: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/City_of_Boston_Managed_Streets/FeatureServer/0',
    rawSha256: cands.managed.sha256,
    semantics: 'MassDOT Road Inventory centreline clipped to City-of-Boston jurisdiction. A road-inventory centreline; a JURISDICTIONAL SUBSET, not a complete street network.',
    features: cands.managed.features.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || a.oid - b.oid).map((f) => ({
      segmentId: f.id, objectId: f.oid, name: f.name, klass: f.klass, rdtype: f.rdtype, adminType: f.adminType,
      paths: f.paths.map((p) => p.map((q) => [r3(q.x), r3(q.z)])),
    })),
  },
};
const body = JSON.stringify(fixture, null, 1) + '\n';
writeFileSync(new URL('./backbay-roads.json', import.meta.url), body);

const provenance = {
  schemaVersion: 'boston-gis-stage1e/provenance/0.1.0',
  retrieved: '2026-09-13',
  note: 'Raw extracts live in research/gis-stage1e/cache/ and are gitignored. Re-acquire with the recorded query; the hashes below pin exactly what this stage measured.',
  candidates: [
    {
      key: 'sam', status: 'PRIMARY',
      dataset: 'Boston Street Segments (SAM System)', publisher: 'Boston Maps, City of Boston',
      catalog: 'https://data.boston.gov/dataset/boston-street-segments-sam-system',
      ckanApi: 'https://data.boston.gov/api/3/action/package_show?id=boston-street-segments-sam-system',
      licenceId: 'odc-pddl', licenceTitle: 'Open Data Commons Public Domain Dedication and License (PDDL)',
      licenceUrl: 'http://www.opendefinition.org/licenses/odc-pddl',
      service: 'https://gisportal.boston.gov/arcgis/rest/services/SAM/Live_SAM_Address/FeatureServer/3',
      query: '/query?where=1=1&geometry=-71.082431,42.347703,-71.077569,42.351297&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json',
      rawFile: 'cache/sam_roads_4326.json', rawSha256: cands.sam.sha256,
      nativeSR: 'EPSG:2249 / WKID 102686 (NAD83 Massachusetts Mainland, US survey feet)',
      updateCadence: 'nightly (per the catalog record); CKAN metadata_modified observed 2026-09-13',
    },
    {
      key: 'managed', status: 'SECONDARY',
      dataset: 'City of Boston Managed Streets', publisher: 'Boston Maps, City of Boston',
      catalog: 'https://data.boston.gov/dataset/city-of-boston-managed-streets',
      ckanApi: 'https://data.boston.gov/api/3/action/package_show?id=city-of-boston-managed-streets',
      licenceId: 'odc-pddl', licenceTitle: 'Open Data Commons Public Domain Dedication and License (PDDL)',
      licenceUrl: 'http://www.opendefinition.org/licenses/odc-pddl',
      service: 'https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/City_of_Boston_Managed_Streets/FeatureServer/0',
      layerName: 'Boston_owned_streets01122022',
      copyrightText: 'Massachusetts Department of Transportation (MassDOT), MassGIS',
      rawFile: 'cache/mgd_roads_4326.json', rawSha256: cands.managed.sha256,
      nativeSR: 'EPSG:2249 / WKID 102686 (NAD83 Massachusetts Mainland, US survey feet)',
      lineage: 'Clipped from the MassGIS-MassDOT Roads layer (EOTROADS_ARC); MassDOT 2017 year-end Road Inventory, conflated 2014-15 with MassGIS base streets, updated against 2017-18 ortho imagery. Jurisdictional subset: City-of-Boston-managed streets only.',
      ckanLastModified: '2024-12-05',
    },
  ],
  topology: { sam: topology(cands.sam), managed: topology(cands.managed) },
};
writeFileSync(new URL('./provenance.json', import.meta.url), JSON.stringify(provenance, null, 1) + '\n');

console.log(`fixture  backbay-roads.json  ${body.length} bytes  sha256 ${createHash('sha256').update(body).digest('hex').slice(0, 16)}`);
console.log(`  ${fixture.features.length} features, ${fixture.features.filter((f) => f.surface).length} surface`);
console.log('\ntopology:');
for (const k of ['sam', 'managed']) {
  const t = provenance.topology[k];
  console.log(`  ${k.padEnd(8)} features ${String(t.features).padStart(3)}  vertices ${String(t.vertices).padStart(4)}  length ${String(t.totalLengthM).padStart(9)} m  ` +
    `nodes ${String(t.endpointNodes).padStart(3)}  junctions ${String(t.junctionNodes).padStart(3)}  dangling ${String(t.danglingEndpoints).padStart(3)}  ` +
    `dupPairs ${t.duplicateEndpointPairs}  multipart ${t.multipartFeatures}  seg min/med/max ${t.segmentLengthM.min}/${t.segmentLengthM.median}/${t.segmentLengthM.max} m`);
}
