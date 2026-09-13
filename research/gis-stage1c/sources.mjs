/**
 * Stage 1C — the two ALLOWED factual sources, projected into Boston world X/Z.
 *
 * Allowed, per the Stage 1C authorization and the existing licensing chain:
 *   - Boston "Buildings with Roof Breaks"      ODC-PDDL-1.0
 *   - MassGIS Building Structures (2-D)        MassGIS public record
 *
 * NOT allowed and deliberately not loaded here: City `Assessing/DOIT_buildings`.
 * Its Back Bay extract is still on disk at
 * `research/gis-stage1a/cache/doit_buildings_4326.json` from the Stage 1A audit;
 * it is LEGAL-UNKNOWN, it stays audit-only, and nothing in this file or
 * downstream of it reads that path.
 *
 * Projection is production `geo()`, unchanged and not reimplemented — the same
 * path Stage 1A verified against an independent inverse Lambert Conformal Conic.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { geo } from '../../src/core/Geo.js';

const CACHE = new URL('../gis-stage1a/cache/', import.meta.url);
const CACHE_A1 = new URL('../gis-stage1a1/cache/', import.meta.url);

function load(url, label, licence) {
  const raw = readFileSync(url);
  const d = JSON.parse(raw.toString());
  if (d.spatialReference?.wkid !== 4326) throw new Error(`${label}: expected EPSG:4326, got ${d.spatialReference?.wkid}`);
  return { label, licence, sha256: createHash('sha256').update(raw).digest('hex'),
           count: d.features.length, features: d.features };
}

/** One source polygon in Boston world metres, outer ring only. */
function ring(f) {
  const r = f.geometry?.rings?.[0];
  if (!r || r.length < 4) return null;
  const pts = r.map(([lon, lat]) => { const g = geo(lat, lon); return { x: g.x, z: g.z }; });
  // ArcGIS repeats the first vertex to close the ring; drop it.
  const a = pts[0], b = pts[pts.length - 1];
  if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.z - b.z) < 1e-9) pts.pop();
  return pts.length >= 3 ? pts : null;
}

export function loadSources() {
  const rb = load(new URL('roofbreaks_4326.json', CACHE), 'roofbreaks', 'ODC-PDDL-1.0');
  const ms = load(new URL('massgis_structures_4326.json', CACHE_A1), 'massgis', 'MassGIS public record');
  const pddl = [], massgis = [];
  for (const f of rb.features) {
    const p = ring(f); if (!p) continue;
    pddl.push({ src: 'pddl', oid: f.attributes.OBJECTID, use: f.attributes.PART_USE ?? null, ring: p });
  }
  for (const f of ms.features) {
    const p = ring(f); if (!p) continue;
    // Whitespace-only LOCAL_ID is present in this layer and is truthy in JS;
    // Stage 1A.1 collapsed 34 Back Bay structures into one building before this
    // was caught. Normalise it to null here so it can never be a join key again.
    const local = (f.attributes.LOCAL_ID || '').trim() || null;
    massgis.push({ src: 'massgis', oid: f.attributes.OBJECTID, structId: f.attributes.STRUCT_ID,
                   localId: local, sourceDate: f.attributes.SOURCEDATE ?? null, ring: p });
  }
  return { pddl, massgis,
           provenance: { pddl: { ...rb, features: undefined }, massgis: { ...ms, features: undefined } } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pddl, massgis, provenance } = loadSources();
  console.log(`pddl    ${String(pddl.length).padStart(4)} polygons  sha256 ${provenance.pddl.sha256.slice(0, 16)}  ${provenance.pddl.licence}`);
  console.log(`massgis ${String(massgis.length).padStart(4)} polygons  sha256 ${provenance.massgis.sha256.slice(0, 16)}  ${provenance.massgis.licence}`);
  const withLocal = massgis.filter((m) => m.localId).length;
  console.log(`massgis LOCAL_ID present on ${withLocal}/${massgis.length}; blank-or-whitespace on ${massgis.length - withLocal}`);
  const v = (a) => { const n = a.map((p) => p.ring.length).sort((x, y) => x - y); return `${n[0]}/${n[Math.floor(n.length / 2)]}/${n[n.length - 1]}`; };
  console.log(`ring vertices min/median/max — pddl ${v(pddl)}  massgis ${v(massgis)}`);
}
