/**
 * Footprints and heights for the Northeastern hero buildings, from
 * **Boston Buildings with Roof Breaks** (City of Boston, PDDL).
 *
 *   node tools/neu-height/footprints.mjs
 *
 * Why this exists, given `HEIGHT_MEASUREMENTS.json` already reports heights:
 * those came from Boston's 3D scene layer, and they are systematically HIGH.
 * Checked against buildings whose heights are independently known:
 *
 *              Boston 3D    this layer   truth
 *   Prudential   233.6 m      228.0 m    228 m
 *   200 Clarendon    --       240.2 m    241 m
 *
 * and on the Krentzman quadrangle the 3D figures imply 4.9-5.9 m per storey
 * against this layer's 3.7-4.3, where 3.7 is what a 1938 institutional building
 * actually measures. The 3D `Height_Ft` appears to take the top of the whole
 * modelled mass — plausible on a merged object, wrong for a named building.
 *
 * This layer wins on accuracy AND carries the geometry: it is polygons split by
 * ROOF BREAK, each part with its own `ROOF_ELEV_2010`, `GRND_ELEV_2010` and
 * `BLDG_HGT_2010`. That is tiered massing, ready to extrude, from one
 * public-domain source.
 *
 * Its weakness is vintage: a 2010 snapshot, so anything built since is absent
 * (ISEC 2017, EXP 2024) and towers can fragment. Matching therefore takes the
 * TALLEST part within the building's own footprint radius, never the part under
 * its centroid — the centroid of a tower usually lands on its podium, which is
 * how a 21-storey Lightview first measured 2.6 m.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geo } from '../../src/core/Geo.js';
import { ringCentroid, inPoly } from '../neu-audit/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const OUT = path.join(HERE, '../../docs/neu');
const FT = 0.3048;
const SERVICE = 'https://gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer/9';
/** Krentzman / Huntington opening cluster plus margin. */
const BBOX = '-71.0940,42.3335,-71.0830,42.3425';

fs.mkdirSync(CACHE, { recursive: true });
const raw = path.join(CACHE, 'boston_buildings.json');
if (!fs.existsSync(raw) || process.argv.includes('--force')) {
  const q = new URLSearchParams({
    where: '1=1', geometry: BBOX, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outSR: '4326', f: 'json',
    outFields: 'OBJECTID,PART_USE,GRND_ELEV_2010,ROOF_ELEV_2010,BLDG_HGT_2010,Land_Use,BRA_Land_Use,IEL_TYPE',
    returnGeometry: 'true',
  });
  const r = await fetch(`${SERVICE}/query?${q}`);
  if (!r.ok) throw new Error(`Boston Buildings: HTTP ${r.status}`);
  fs.writeFileSync(raw, await r.text());
  console.log('fetched Boston Buildings parts');
}
const parts = JSON.parse(fs.readFileSync(raw, 'utf8')).features
  .filter(f => +f.attributes.BLDG_HGT_2010 > 0)
  .map(f => {
    const rings = f.geometry.rings.map(r => r.map(([lo, la]) => geo(la, lo)));
    const c = ringCentroid(rings[0]);
    return { id: f.attributes.OBJECTID, rings, c, areaM2: Math.round(c.area),
      heightM: +(f.attributes.BLDG_HGT_2010 * FT).toFixed(2),
      roofElevM: +(f.attributes.ROOF_ELEV_2010 * FT).toFixed(2),
      gndElevM: +(f.attributes.GRND_ELEV_2010 * FT).toFixed(2),
      landUse: f.attributes.Land_Use ?? null };
  });
// identity check, same discipline as the 3D layer
const bad = parts.filter(p => Math.abs((p.roofElevM - p.gndElevM) - p.heightM) > 0.2).length;

const inv = JSON.parse(fs.readFileSync(path.join(OUT, 'BUILDING_INVENTORY.json'), 'utf8'));
const meas = JSON.parse(fs.readFileSync(path.join(OUT, 'HEIGHT_MEASUREMENTS.json'), 'utf8'));
const measBy = new Map(meas.measurements.map(m => [m.name, m]));

/** The opening composition. Deliberately not the whole campus. */
const CLUSTER = ['Ell Hall', 'Richards Hall', 'Hayden Hall', 'Dodge Hall', 'Curry Student Center',
  'Cabot Center (& Barletta Natatorium)', 'Mugar Life Sciences Building', 'Ryder Hall',
  'Egan Engineering/Science Research Center', 'Shillman Hall', 'Hastings Hall', 'Dana Research Center'];

const out = [];
for (const name of CLUSTER) {
  const b = inv.buildings.find(x => x.name === name);
  if (!b) { out.push({ name, status: 'NOT_IN_INVENTORY' }); continue; }
  const [x, z] = b.worldXZ;
  const R = Math.max(24, Math.sqrt((b.footprintM2 || 400) / Math.PI) * 1.35);
  const near = parts.filter(p => Math.hypot(p.c.x - x, p.c.z - z) <= R)
                    .sort((p, q) => q.heightM - p.heightM);
  const m3 = measBy.get(name);
  if (!near.length) { out.push({ name, status: 'NO_FOOTPRINT', note: '2010 layer has no part here — post-2010 build?' }); continue; }
  const st = b.storeys.osmLevels ?? null;
  const tall = near[0];
  out.push({
    name, priority: b.priority, status: 'OK',
    heightM: tall.heightM,
    tiers: near.map(p => ({ objectId: p.id, heightM: p.heightM, areaM2: p.areaM2, landUse: p.landUse })),
    partCount: near.length,
    totalFootprintM2: near.reduce((s, p) => s + p.areaM2, 0),
    storeysCrossCheck: st,
    metresPerStorey: st ? +(tall.heightM / st).toFixed(2) : null,
    boston3dHeightM: m3?.heightM ?? null,
    boston3dExcessM: m3?.heightM != null ? +(m3.heightM - tall.heightM).toFixed(1) : null,
    boston3dConfidence: m3?.confidence ?? null,
  });
}
const ok = out.filter(o => o.status === 'OK');
const excess = ok.map(o => o.boston3dExcessM).filter(v => v != null).sort((a, b) => a - b);
fs.writeFileSync(path.join(OUT, 'HERO_FOOTPRINTS.json'), JSON.stringify({
  _generated: 'generated by tools/neu-height/footprints.mjs — do not hand-edit',
  source: { dataset: 'Boston Buildings with Roof Breaks', publisher: 'City of Boston (Boston Maps)',
    service: SERVICE, licence: 'PDDL (odc-pddl) via data.boston.gov', vintage: '2010 snapshot',
    fields: 'GRND_ELEV_2010 / ROOF_ELEV_2010 / BLDG_HGT_2010, US feet',
    identity: 'ROOF_ELEV - GRND_ELEV === BLDG_HGT', identityFailures: bad },
  validation: {
    prudentialM: 228.0, prudentialTruthM: 228, clarendonM: 240.2, clarendonTruthM: 241,
    note: 'sub-metre against two landmark towers whose heights are independently known',
  },
  supersedes: {
    file: 'HEIGHT_MEASUREMENTS.json',
    reason: 'Boston 3D Height_Ft is systematically high — +5.6 m on the Prudential, and it implies 4.9-5.9 m per storey on the Krentzman quadrangle against this layer\'s 3.7-4.3.',
    excessOverThisLayerM: excess.length ? { min: excess[0], median: excess[Math.floor(excess.length/2)], max: excess[excess.length-1] } : null,
  },
  clusterCount: out.length, resolved: ok.length,
  buildings: out,
}, null, 1) + '\n');
console.log(`parts ${parts.length}, identity failures ${bad}`);
console.log(`cluster resolved ${ok.length}/${out.length}`);
for (const o of ok)
  console.log(`  ${o.name.slice(0,30).padEnd(31)} ${String(o.heightM).padStart(6)} m  ${String(o.metresPerStorey ?? '-').padStart(5)} m/st  tiers=${o.partCount}  3D was +${o.boston3dExcessM}`);
