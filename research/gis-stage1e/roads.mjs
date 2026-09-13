/**
 * Stage 1E — the factual road candidates, projected into Boston local X/Z.
 *
 * Both candidates are City of Boston / Boston Maps publications carrying
 * **ODC-PDDL-1.0** in the Analyze Boston CKAN record — the same licence already
 * accepted in this project for Buildings with Roof Breaks. Licence evidence and
 * exact provenance are in `provenance.json`.
 *
 * Semantics matter more than the title (see the report §F):
 *   SAM     — street centreline carrying ADDRESS RANGES, one-way, z-levels and
 *             routing costs. An addressing/routing centreline, NOT a surveyed
 *             pavement centreline.
 *   MANAGED — MassDOT Road Inventory linework clipped to City-of-Boston
 *             jurisdiction. A road-inventory centreline, also not a surveyed
 *             pavement centreline, and a JURISDICTIONAL SUBSET.
 *
 * Projection is production `geo()`, unchanged — the same path the PDDL and
 * MassGIS building sources already take, so the road and building frames are
 * commensurable by construction.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { geo } from '../../src/core/Geo.js';

const CACHE = new URL('./cache/', import.meta.url);

function load(file, label) {
  const raw = readFileSync(new URL(file, CACHE));
  const d = JSON.parse(raw.toString());
  if (d.spatialReference?.wkid !== 4326) throw new Error(`${label}: expected EPSG:4326, got ${d.spatialReference?.wkid}`);
  return { raw, d };
}
/** ArcGIS polyline paths -> Boston local X/Z polylines. */
function paths(f) {
  return (f.geometry?.paths || []).map((p) => p.map(([lon, lat]) => {
    const g = geo(lat, lon);
    return { x: g.x, z: g.z };
  })).filter((p) => p.length >= 2);
}

export function loadRoadCandidates() {
  const out = {};
  {
    const { raw, d } = load('sam_roads_4326.json', 'SAM');
    out.sam = {
      key: 'sam', label: 'Boston Street Segments (SAM System)',
      sha256: createHash('sha256').update(raw).digest('hex'),
      features: d.features.map((f) => ({
        id: f.attributes.SEGMENT_ID, oid: f.attributes.OBJECTID,
        name: [f.attributes.PRE_DIR, f.attributes.ST_NAME, f.attributes.ST_TYPE, f.attributes.SUF_DIR]
          .filter(Boolean).join(' ').trim(),
        cfcc: f.attributes.CFCC, oneway: f.attributes.ONEWAY,
        zlev: [f.attributes.F_ZLEV, f.attributes.T_ZLEV],
        speed: f.attributes.SPEEDLIMIT, ownership: f.attributes.ownership,
        paths: paths(f),
      })),
    };
  }
  {
    const { raw, d } = load('mgd_roads_4326.json', 'MANAGED');
    out.managed = {
      key: 'managed', label: 'City of Boston Managed Streets',
      sha256: createHash('sha256').update(raw).digest('hex'),
      features: d.features.map((f) => ({
        id: f.attributes.RD_SEG_ID, oid: f.attributes.FID,
        name: (f.attributes.STREETNAME || f.attributes.STREET_NAM || '').trim(),
        cfcc: null, oneway: null, zlev: null,
        klass: f.attributes.CLASS, rdtype: f.attributes.RDTYPE, adminType: f.attributes.ADMIN_TYPE,
        paths: paths(f),
      })),
    };
  }
  return out;
}

/** Every polyline of a candidate as one flat list, with its feature. */
export function polylines(cand) {
  const out = [];
  for (const f of cand.features) for (const p of f.paths) out.push({ f, pts: p });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = loadRoadCandidates();
  for (const k of ['sam', 'managed']) {
    const cand = c[k], pl = polylines(cand);
    let len = 0, verts = 0;
    for (const p of pl) { verts += p.pts.length; for (let i = 1; i < p.pts.length; i++) len += Math.hypot(p.pts[i].x - p.pts[i-1].x, p.pts[i].z - p.pts[i-1].z); }
    const names = [...new Set(cand.features.map((f) => f.name).filter(Boolean))].sort();
    console.log(`${cand.label}`);
    console.log(`  sha256 ${cand.sha256.slice(0, 16)}  features ${cand.features.length}  polylines ${pl.length}  vertices ${verts}  length ${len.toFixed(0)} m`);
    console.log(`  ${names.length} distinct names: ${names.join(' | ')}`);
    const multi = cand.features.filter((f) => f.paths.length > 1).length;
    console.log(`  multipart features: ${multi}\n`);
  }
}
