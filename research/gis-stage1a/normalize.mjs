/**
 * Stage 1A normalizer — raw ArcGIS JSON -> schema-v0-candidate fixture.
 *
 *   node research/gis-stage1a/normalize.mjs
 *
 * Deterministic: sorts by source id, rounds to a fixed precision, and emits
 * stable key order. Running it twice must produce byte-identical output.
 *
 * This is a SCHEMA CANDIDATE, not the production canonical schema. It writes
 * only into research/gis-stage1a/ and imports production code read-only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { geo } from '../../src/core/Geo.js';
import { BBOX_WGS84, BBOX_WORLD } from './bbox.mjs';

export const SCHEMA_VERSION = 'boston-gis-stage1a/schema-v0-candidate/0.1.0';
export const ADAPTER_VERSION = 'research/gis-stage1a/normalize.mjs@0.1.0';
const FT_TO_M = 0.3048;                  // international foot; see README on unit evidence
const P = 2;                             // decimal places for world metres
const r = (v) => +v.toFixed(P);

/** Signed area of a ring in XZ, 2x. Positive = CCW in a +X/+Z right-handed read. */
export function area2(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    s += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return s;
}
/** Do segments ab and cd properly cross? Used for the self-intersection scan. */
function crosses(a, b, c, d) {
  const s = (p, q, t) => Math.sign((q[0] - p[0]) * (t[1] - p[1]) - (q[1] - p[1]) * (t[0] - p[0]));
  const d1 = s(a, b, c), d2 = s(a, b, d), d3 = s(c, d, a), d4 = s(c, d, b);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}
export function selfIntersects(ring) {
  const n = ring.length;
  if (n > 400) return null;                        // skipped, reported as such
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;        // adjacent through the closure
      if (crosses(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function normalize(raw) {
  const out = [], rejected = [];
  for (const f of raw.features) {
    const A = f.attributes, id = A.OBJECTID;
    const src = f.geometry?.rings;
    if (!src || !src.length) { rejected.push({ id, reason: 'no-geometry' }); continue; }
    // Ring 0 is the outer ring in Esri order; later rings may be holes (opposite winding).
    const rings = [];
    let bad = null;
    for (const ring of src) {
      // Esri closes rings by repeating the first vertex. Drop the repeat.
      const pts = ring.slice(0, ring.length - 1 > 2 &&
        ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1 : ring.length);
      const world = pts.map(([lon, lat]) => { const p = geo(lat, lon); return [r(p.x), r(p.z)]; });
      if (world.length < 3) { bad = 'ring-under-3-vertices'; break; }
      if (world.some(([x, z]) => !Number.isFinite(x) || !Number.isFinite(z))) { bad = 'non-finite'; break; }
      if (Math.abs(area2(world)) / 2 < 1.0) { bad = 'area-under-1m2'; break; }
      rings.push(world);
    }
    if (bad) { rejected.push({ id, reason: bad }); continue; }
    // Normalize winding: outer ring CCW, holes CW. Deterministic regardless of source order.
    if (area2(rings[0]) < 0) rings[0].reverse();
    for (let i = 1; i < rings.length; i++) if (area2(rings[i]) > 0) rings[i].reverse();

    const gnd = A.GRND_ELEV_2010, roof = A.ROOF_ELEV_2010, hgt = A.BLDG_HGT_2010;
    const hasH = Number.isFinite(hgt);
    // Invariant fields (sourceFamily, dataset, featureClass, licence, sourceCrs,
    // transform, source units) are hoisted to the file-level `source` block
    // rather than repeated 218 times. This is the same shape `neu-hero.js` uses
    // with NEU_HERO_SOURCE, and it is serialization, not data reduction.
    out.push({
      id: `bos-rb-${id}`,
      sourceId: String(id),
      sourceTimestamp: A.Added ?? null,
      fact: {
        heightFt: hasH ? +hgt.toFixed(3) : null,
        groundElevFt: Number.isFinite(gnd) ? +gnd.toFixed(3) : null,
        roofElevFt: Number.isFinite(roof) ? +roof.toFixed(3) : null,
        partUse: A.PART_USE ?? null,
        landUse: A.Land_Use ?? null,
        braLandUse: A.BRA_Land_Use ?? null,
        ielType: A.IEL_TYPE ?? null,
        shapeAreaFt2: Number.isFinite(A.Shape__Area) ? +A.Shape__Area.toFixed(2) : null,
      },
      derived: {
        rings,                                     // world metres, outer first
        areaM2: +(Math.abs(area2(rings[0])) / 2).toFixed(2),
        heightM: hasH ? +(hgt * FT_TO_M).toFixed(2) : null,
        heightBasis: hasH ? 'BLDG_HGT_2010 x 0.3048' : null,
      },
      confidence: hasH ? 'FACT_IF_PRESENT' : 'FACT_GEOMETRY_ONLY',
    });
  }
  out.sort((p, q) => (p.sourceId.length - q.sourceId.length) || p.sourceId.localeCompare(q.sourceId));
  rejected.sort((p, q) => p.id - q.id);
  return { features: out, rejected };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rawTxt = readFileSync(new URL('./cache/roofbreaks_4326.json', import.meta.url), 'utf8');
  const raw = JSON.parse(rawTxt);
  const { features, rejected } = normalize(raw);
  const fixture = {
    schemaVersion: SCHEMA_VERSION,
    adapterVersion: ADAPTER_VERSION,
    source: {
      sourceFamily: 'city-of-boston',
      dataset: 'boston-buildings-with-roof-breaks',
      featureClass: 'BUILDING_PART',      // the layer's unit is the roof-break part
      licence: 'ODC-PDDL-1.0',
      sourceCrs: 'EPSG:6492',
      sourceLinearUnit: 'ftUS',
      elevationUnit: 'ft',
      transform: 'ArcGIS query outSR=4326 -> src/core/Geo.js geo()',
    },
    area: { bboxWgs84: BBOX_WGS84, bboxWorld: BBOX_WORLD },
    coordinates: { frame: 'boston-local', units: 'metres', axes: '+X east, -Z north', decimals: P,
                   projection: 'src/core/Geo.js geo() — UNCHANGED' },
    counts: { source: raw.features.length, normalized: features.length, rejected: rejected.length },
    rejected,
    features,
  };
  // Compact, but one feature per line so a diff stays readable. Rings are
  // emitted inline rather than pretty-printed: at 4,575 coordinate pairs,
  // pretty-printing cost 288 KiB of whitespace and no information.
  const json = '{\n' + Object.entries(fixture).map(([k, v]) =>
    k === 'features'
      ? ' "features": [\n' + v.map(f => '  ' + JSON.stringify(f)).join(',\n') + '\n ]'
      : ' ' + JSON.stringify(k) + ': ' + JSON.stringify(v)
  ).join(',\n') + '\n}\n';
  writeFileSync(new URL('./fixture.json', import.meta.url), json);
  console.log(`[normalize] source ${raw.features.length} -> normalized ${features.length}, rejected ${rejected.length}`);
  console.log(`[normalize] rawSha256 ${createHash('sha256').update(rawTxt).digest('hex').slice(0, 16)}`);
  console.log(`[normalize] fixture ${(json.length / 1024).toFixed(1)} KiB  sha256 ${createHash('sha256').update(json).digest('hex').slice(0, 16)}`);
  if (rejected.length) console.log('[normalize] rejections:', JSON.stringify(rejected));
}
