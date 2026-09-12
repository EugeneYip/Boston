/**
 * Stage 1A.1 — attach AUDIT-ONLY ground truth to the PDDL roof-break parts.
 *
 * The PDDL layer (Buildings with Roof Breaks) carries NO parent-building
 * identifier: 12 fields on the FeatureServer, and the PDDL CSV download has the
 * same 12. The identifier exists only on
 * `gisportal.boston.gov/.../Assessing/DOIT_buildings/MapServer/2`, whose terms
 * are a warranty DISCLAIMER, not a licence grant, and which no Analyze Boston
 * record names. That service is therefore LEGAL-UNKNOWN and its values are used
 * here exactly as the Northeastern university layer was used: as non-runtime
 * audit evidence. No BUILDING_ID is written into any committed fixture.
 *
 * Join is geometric, because the two services renumber OBJECTID independently
 * (0 of 218 overlap). Two keys, in order:
 *   1. exact ring-0 vertex-0 coordinate
 *   2. fallback: centroid within 2 m AND an identical *_2010 elevation triple
 */
import { readFileSync } from 'node:fs';

const rb = JSON.parse(readFileSync(new URL('../gis-stage1a/cache/roofbreaks_4326.json', import.meta.url), 'utf8'));
const dt = JSON.parse(readFileSync(new URL('../gis-stage1a/cache/doit_buildings_4326.json', import.meta.url), 'utf8'));

const v0 = (f) => { const r = f.geometry.rings[0][0]; return r[0].toFixed(7) + ',' + r[1].toFixed(7); };
const cent = (f) => {
  const r = f.geometry.rings[0];
  let A = 0, x = 0, y = 0;
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length, c = r[i][0] * r[j][1] - r[j][0] * r[i][1];
    A += c; x += (r[i][0] + r[j][0]) * c; y += (r[i][1] + r[j][1]) * c;
  }
  A *= 0.5;
  if (Math.abs(A) < 1e-14) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  return [x / (6 * A), y / (6 * A)];
};
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.001);

export function joinGroundTruth() {
  const byV0 = new Map();
  for (const f of dt.features) byV0.set(v0(f), f);
  const used = new Set();
  const out = [];
  for (const f of rb.features) {
    let g = byV0.get(v0(f)), how = 'vertex0';
    if (g && used.has(g.attributes.OBJECTID)) g = null;
    if (!g) {
      const c = cent(f);
      let best = null, bd = Infinity;
      for (const h of dt.features) {
        if (used.has(h.attributes.OBJECTID)) continue;
        const A = f.attributes, B = h.attributes;
        if (!(same(A.GRND_ELEV_2010, B.GROUND_ELEVATION_2010) &&
              same(A.ROOF_ELEV_2010, B.ROOF_ELEVATION_2010) &&
              same(A.BLDG_HGT_2010, B.BUILDING_HEIGHT_2010))) continue;
        const d = cent(h);
        const m = Math.hypot((d[0] - c[0]) * 82263.28, (d[1] - c[1]) * 111320);
        if (m < bd) { bd = m; best = h; }
      }
      if (best && bd <= 2.0) { g = best; how = `centroid<=2m(${bd.toFixed(2)})`; }
    }
    if (g) used.add(g.attributes.OBJECTID);
    out.push({
      oid: f.attributes.OBJECTID,
      joined: !!g, how: g ? how : null,
      buildingId: g?.attributes.BUILDING_ID ?? null,
      partId: g?.attributes.PART_ID ?? null,
      parcelId: g?.attributes.PARCEL_ID ?? null,
      address: g?.attributes.PART_ADDRESS ?? null,
      floors: g?.attributes.PART_FLOORS ?? null,
      ielType: g?.attributes.IEL_TYPE ?? f.attributes.IEL_TYPE ?? null,
      baseElevNavd88: g?.attributes.BASE_ELEVATION ?? null,
      topSeaLevelNavd88: g?.attributes.TOP_SEA_LEVEL ?? null,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const j = joinGroundTruth();
  const ok = j.filter(x => x.joined);
  const withB = j.filter(x => x.buildingId);
  console.log(`[join] roofbreak parts ${j.length}, joined ${ok.length} (${(100*ok.length/j.length).toFixed(1)}%)`);
  const how = {}; for (const x of ok) how[x.how.split('(')[0]] = (how[x.how.split('(')[0]] || 0) + 1;
  console.log('[join] by key:', JSON.stringify(how));
  console.log(`[join] with a BUILDING_ID: ${withB.length} (${(100*withB.length/j.length).toFixed(1)}%)`);
  const cnt = {}; for (const x of withB) cnt[x.buildingId] = (cnt[x.buildingId] || 0) + 1;
  const dist = {}; for (const v of Object.values(cnt)) dist[v] = (dist[v] || 0) + 1;
  console.log(`[gt]   unique BUILDING_ID: ${Object.keys(cnt).length}`);
  console.log('[gt]   parts-per-building:', JSON.stringify(dist));
  const pid = withB.map(x => x.partId);
  console.log(`[gt]   PART_ID unique ${new Set(pid).size} of ${pid.length}`);
  const iel = {}; for (const x of j) iel[x.ielType ?? 'null'] = (iel[x.ielType ?? 'null'] || 0) + 1;
  console.log('[gt]   IEL_TYPE:', JSON.stringify(iel));
}
