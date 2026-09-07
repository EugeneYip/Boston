/**
 * Pull the external factual sources for the Northeastern hero-district audit
 * into a local cache. Network-bound; run it before `build.mjs`.
 *
 *   node tools/neu-audit/fetch.mjs [--force]
 *
 * The cache is deliberately NOT committed. OpenStreetMap extracts are ODbL, and
 * a repository copy of the raw extract is a redistributed database with
 * share-alike obligations attached; the committed artefacts under `docs/neu/`
 * are derived factual tables with attribution instead. See docs/neu/SOURCES.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(HERE, '.cache');

/** The audit envelope, as a south,west,north,east box for Overpass. */
export const BBOX = '42.3300,-71.1000,42.3480,-71.0780';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const NEU_ARCGIS = 'https://services5.arcgis.com/S8KZ4xiwVgqpYP63/arcgis/rest/services';

const force = process.argv.includes('--force');

// Overpass answers 406 to a request with no User-Agent, whatever the query says.
const UA = { 'User-Agent': 'boston-neu-audit/1.0 (github.com/boston; factual district audit)' };

async function save(name, body) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, name), body);
  console.log(`  wrote ${name} (${(body.length / 1024).toFixed(0)} KiB)`);
}
function have(name) {
  const p = path.join(CACHE, name);
  return !force && fs.existsSync(p) && fs.statSync(p).size > 0;
}

async function overpass(name, query) {
  if (have(name)) return console.log(`  ${name} cached`);
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: UA, body: new URLSearchParams({ data: query }) });
      if (!r.ok) { console.log(`  ${ep} -> ${r.status}`); continue; }
      const text = await r.text();
      if (!text.startsWith('{')) { console.log(`  ${ep} -> non-JSON`); continue; }
      return save(name, text);
    } catch (e) { console.log(`  ${ep} -> ${e.message}`); }
  }
  throw new Error(`could not fetch ${name} from any Overpass mirror`);
}

async function json(name, url) {
  if (have(name)) return console.log(`  ${name} cached`);
  const r = await fetch(url, { headers: { ...UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return save(name, await r.text());
}

const QUERIES = {
  'campus.json': `[out:json][timeout:90];
    (way["amenity"="university"](${BBOX}); relation["amenity"="university"](${BBOX}););
    out geom;`,
  'roads.json': `[out:json][timeout:90];
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${BBOX});
    out geom;`,
  'buildings.json': `[out:json][timeout:90];way["building"](${BBOX});out geom;`,
  'transit.json': `[out:json][timeout:120];
    (node["railway"~"^(station|stop|halt|tram_stop)$"](${BBOX});
     node["public_transport"="station"](${BBOX});
     way["railway"~"^(rail|light_rail|subway|tram)$"](${BBOX}););
    out geom;`,
  'realm.json': `[out:json][timeout:120];
    (way["highway"~"^(footway|path|pedestrian|steps|cycleway)$"](${BBOX});
     way["leisure"~"^(park|garden|pitch|common)$"](${BBOX});
     way["landuse"~"^(grass|recreation_ground)$"](${BBOX});
     way["place"="square"](${BBOX}););
    out geom;`,
  // City-wide anchors for the georeference check. Named rather than by wikidata
  // id: three ids guessed from memory in an earlier pass resolved to Melbourne
  // and to the Huntington Library in California. Names inside a Boston bbox,
  // with the tags kept in the output so the match stays checkable, do not fail
  // that way.
  'anchors.json': `[out:json][timeout:180];
    ( way(29551702); way(29718019); way(29719177); way(29742438); way(29869880);
      way(212124093); way(29650592); way(240376785); way(405843558); way(29560864);
      relation(63755); relation(64066); relation(11188464); relation(63938); );
    out geom;`,
};

console.log('OpenStreetMap (ODbL) via Overpass:');
for (const [name, q] of Object.entries(QUERIES)) await overpass(name, q);

console.log('Northeastern University ArcGIS (official):');
await json('neu_buildings.json',
  `${NEU_ARCGIS}/Buildings_ALL/FeatureServer/29/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json`);
await json('neu_entrances.json',
  `${NEU_ARCGIS}/AccessibleEntrance/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json`);

console.log('MBTA (official):');
await json('mbta.json',
  'https://api-v3.mbta.com/stops?filter%5Blatitude%5D=42.339473&filter%5Blongitude%5D=-71.087571&filter%5Bradius%5D=0.012');

console.log(`\ncache ready at ${path.relative(process.cwd(), CACHE)}`);
