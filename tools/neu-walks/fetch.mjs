/**
 * Pull the Sidewalk Centerline geometry for the hero envelope into a local cache.
 * Network-bound; run it before `build.mjs`.
 *
 *   node tools/neu-walks/fetch.mjs [--force]
 *
 * Unlike the audit cache, this source is PDDL, so the DERIVED artefact
 * (`src/data/neu-walks.js`) is committed freely. The raw cache is still kept out
 * of the repository — it is 6,800 ways of city-wide pavement and only a couple of
 * hundred metres of it ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYER, BBOX } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(HERE, '.cache');
export const FILE = path.join(CACHE, 'sidewalks.json');

const UA = { 'User-Agent': 'boston-neu-walks/1.0 (factual district audit)', Accept: 'application/json' };
const PAGE = 2000;                       // the layer's own maxRecordCount

const params = (offset) => new URLSearchParams({
  where: '1=1',
  geometry: JSON.stringify({ xmin: BBOX.w, ymin: BBOX.s, xmax: BBOX.e, ymax: BBOX.n,
                             spatialReference: { wkid: 4326 } }),
  geometryType: 'esriGeometryEnvelope', inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects',
  outFields: 'OBJECTID,TYPE', returnGeometry: 'true', outSR: '4326',
  resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'json',
});

export async function fetchWalks({ force = false } = {}) {
  if (!force && fs.existsSync(FILE) && fs.statSync(FILE).size > 0) {
    console.log('  sidewalks.json cached');
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  }
  let all = [], offset = 0;
  for (let page = 0; page < 12; page++) {
    const r = await fetch(`${LAYER}/query?${params(offset)}`, { headers: UA });
    if (!r.ok) throw new Error(`sidewalks: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`sidewalks: ${JSON.stringify(j.error)}`);
    const f = j.features || [];
    all = all.concat(f);
    console.log(`  page ${page}: ${f.length} (total ${all.length})`);
    if (f.length < PAGE) break;
    offset += f.length;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const out = { _fetched: new Date().toISOString(), features: all };
  fs.writeFileSync(FILE, JSON.stringify(out));
  console.log(`  wrote sidewalks.json (${all.length} ways)`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchWalks({ force: process.argv.includes('--force') });
}
