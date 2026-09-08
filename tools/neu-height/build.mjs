/**
 * Cache -> `docs/neu/HEIGHT_MEASUREMENTS.json`.
 *
 *   node tools/neu-height/fetch.mjs && node tools/neu-height/build.mjs
 *
 * Evidence only. Nothing here is imported by `src/`, and no mesh is committed —
 * the repository gets measurements, not the city's 3D model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geo } from '../../src/core/Geo.js';
import { I3SLayer, decodeAttribute } from './i3s.mjs';
import { LAYER, BBOX, WANT } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const OUT = path.join(HERE, '../../docs/neu');
if (!fs.existsSync(CACHE)) { console.error('no cache — run tools/neu-height/fetch.mjs'); process.exit(1); }

const FT = 0.3048;
const layerMeta = JSON.parse(fs.readFileSync(path.join(CACHE, 'layer.json'), 'utf8'));
const leaves = JSON.parse(fs.readFileSync(path.join(CACHE, 'leaves.json'), 'utf8'));
const attrs = await new I3SLayer(LAYER).attributeMap();

const rows = [];
for (const l of leaves) {
  const cols = {}; let n = null, ok = true;
  for (const name of WANT) {
    const a = attrs.get(name); if (!a) { ok = false; break; }
    const f = path.join(CACHE, `${l.resource}_${a.key}.bin`);
    if (!fs.existsSync(f)) { ok = false; break; }
    cols[name] = decodeAttribute(fs.readFileSync(f), a.kind);
    if (n === null) n = cols[name].length;
    else if (cols[name].length !== n) { ok = false; break; }
  }
  if (!ok || !n) continue;
  for (let i = 0; i < n; i++) {
    const r = {}; for (const k of WANT) r[k] = cols[k][i];
    if (r.Centr_Lat == null || r.Height_Ft == null) continue;
    if (r.Status === 'Approved Demo') continue;
    rows.push({ ...r, ...geo(r.Centr_Lat, r.Centr_Lon), hM: r.Height_Ft * FT });
  }
}
const byId = new Map();
for (const r of rows) if (!byId.has(r.OBJECTID)) byId.set(r.OBJECTID, r);
const objects = [...byId.values()];

// `Height_Ft` is a DIFFERENCE, `Z_Max_Ft - Gnd_El_Ft`. Verified across the whole
// extract with zero deviation, which is what makes it usable: a difference is
// datum-independent, and the absolute Z of this layer is NOT reconcilable with
// USGS 3DEP (see HEIGHT_SOURCE.md).
const identity = objects.filter(r => r.Z_Max_Ft != null && r.Gnd_El_Ft != null)
  .map(r => Math.abs(r.Height_Ft - (r.Z_Max_Ft - r.Gnd_El_Ft)));
const identityMax = identity.length ? Math.max(...identity) : null;

const inv = JSON.parse(fs.readFileSync(path.join(OUT, 'BUILDING_INVENTORY.json'), 'utf8'));
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = /\b(HALL|BUILDING|CENTER|CENTRE|THE|OF|AND|UNIVERSITY|NORTHEASTERN|AV|AVENUE|ST|STREET)\b/g;
const toks = s => new Set(norm(s).replace(STOP, ' ').split(' ').filter(w => w.length > 2));
const nameScore = (a, b) => { const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let h = 0; for (const t of A) if (B.has(t)) h++; return h / Math.min(A.size, B.size); };

// A hero building is a building. This layer models porches, kiosks and entrance
// canopies as separate objects down to 1.7 ft, and nearest-centroid alone put
// Ell Hall on a 2.1 m canopy.
const MIN_HERO_M = 8;
function locate(b) {
  const [x, z] = b.worldXZ;
  const R = Math.max(45, Math.sqrt(b.footprintM2 || 400) * 1.4);
  const near = objects.map(r => ({ r, d: Math.hypot(r.x - x, r.z - z) })).filter(o => o.d <= R);
  const tall = near.filter(o => o.r.hM >= MIN_HERO_M);
  if (!tall.length) return { kind: 'UNRESOLVED', why: near.length ? 'only sub-8 m objects in range' : 'no object in range' };
  const scored = tall.map(o => ({ ...o, ns: nameScore(b.name, o.r.Name) }));
  const named = scored.filter(o => o.ns >= 0.5).sort((p, q) => q.ns - p.ns || p.d - q.d);
  if (named.length) return { via: 'name', best: named[0] };
  scored.sort((p, q) => p.d - q.d);
  const best = scored[0];
  const rival = scored.find(o => o !== best && o.d < best.d + 20 && Math.abs(o.r.hM - best.r.hM) > 4);
  return { via: 'proximity', best, rival };
}

const hero = inv.buildings.filter(b => b.priority === 'HERO_A' || b.priority === 'HERO_B');
const found = hero.map(b => ({ b, m: locate(b) }));
const claims = new Map();
for (const f of found) if (f.m.best) claims.set(f.m.best.r.OBJECTID, [...(claims.get(f.m.best.r.OBJECTID) || []), f.b.name]);

const measurements = found.map(({ b, m }) => {
  const r = m.best?.r ?? null;
  const shared = r ? (claims.get(r.OBJECTID) || []).filter(n => n !== b.name) : [];
  const storeys = b.storeys.osmLevels ?? null;
  const mPerStorey = (r && storeys) ? r.hM / storeys : null;
  let confidence, note;
  if (!r) { confidence = 'UNRESOLVED'; note = m.why; }
  else if (m.rival) { confidence = 'CONFLICT'; note = `rival object ${m.rival.r.OBJECTID} at ${m.rival.d.toFixed(0)} m is ${m.rival.r.hM.toFixed(1)} m`; }
  else if (mPerStorey != null && (mPerStorey < 2.9 || mPerStorey > 6.6)) {
    confidence = 'CONFLICT'; note = `${r.hM.toFixed(1)} m over ${storeys} storeys = ${mPerStorey.toFixed(2)} m/storey`;
  } else if (shared.length) {
    confidence = 'COMPLEX';
    note = `one 3D object covers ${shared.length + 1} inventory buildings — a complex height, valid for massing the group, not for this building alone`;
  } else { confidence = 'MEASURED'; note = null; }
  return {
    name: b.name, priority: b.priority, confidence, note,
    objectId: r?.OBJECTID ?? null, sourceName: r?.Name ?? null, parcelId: r?.Parcel_ID ?? null,
    matchVia: m.via ?? null, matchDistanceM: m.best ? +m.best.d.toFixed(1) : null,
    heightM: r ? +r.hM.toFixed(1) : null, heightFt: r?.Height_Ft ?? null,
    groundElFt: r?.Gnd_El_Ft ?? null, zMaxFt: r?.Z_Max_Ft ?? null, zMinFt: r?.Z_MIn_Ft ?? null,
    modelLod: r?.Model_LOD ?? null, surveyDate: r?.Survey_Dt ?? null, qaFlag: r?.QA_Flag ?? null,
    storeysCrossCheck: storeys, metresPerStorey: mPerStorey != null ? +mPerStorey.toFixed(2) : null,
    sharesObjectWith: shared.length ? shared : null,
  };
});
const tally = (p) => measurements.filter(m => m.priority === p)
  .reduce((a, m) => (a[m.confidence] = (a[m.confidence] || 0) + 1, a), {});

fs.writeFileSync(path.join(OUT, 'HEIGHT_MEASUREMENTS.json'), JSON.stringify({
  _generated: 'generated by tools/neu-height/build.mjs — do not hand-edit',
  source: { layer: 'Boston 3D Buildings (Existing)', service: LAYER,
    publisher: 'City of Boston Planning Department (BPDA)', licence: 'PDDL (via data.boston.gov)',
    serviceUpdateTimeStamp: layerMeta.serviceUpdateTimeStamp,
    heightModelInfo: layerMeta.heightModelInfo, elevationInfo: layerMeta.elevationInfo,
    caveat: 'The publisher states this layer is "intended for visualization purposes only".' },
  method: {
    heightField: 'Height_Ft',
    identity: 'Height_Ft === Z_Max_Ft - Gnd_El_Ft',
    identityMaxDeviation: identityMax,
    unit: 'US survey feet — confirmed against an independent OSM height tag on EXP (184.6 ft = 56.3 m vs 56.69 m tagged)',
    doNotUse: 'Z_Max_Ft - Z_MIn_Ft. Z_MIn_Ft is the model\'s lowest vertex, which runs to -50 ft on towers; that difference overstates a tower by ~15 m.',
    minHeroHeightM: MIN_HERO_M,
  },
  envelope: BBOX,
  objectsInEnvelope: objects.length,
  counts: { HERO_A: tally('HERO_A'), HERO_B: tally('HERO_B') },
  measurements,
}, null, 1) + '\n');
console.log('objects in envelope:', objects.length, '| identity max deviation:', identityMax);
console.log('HERO_A', JSON.stringify(tally('HERO_A')));
console.log('HERO_B', JSON.stringify(tally('HERO_B')));
