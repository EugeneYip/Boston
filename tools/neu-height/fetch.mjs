/**
 * Pull the Boston 3D building attributes covering the Northeastern envelope.
 *
 *   node tools/neu-height/fetch.mjs [--force]
 *
 * Cache is gitignored. Nothing here is imported by `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { I3SLayer } from './i3s.mjs';
import { LAYER, BBOX, WANT } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(HERE, '.cache');

const force = process.argv.includes('--force');
const L = new I3SLayer(LAYER);

fs.mkdirSync(CACHE, { recursive: true });
const info = await L.layerInfo();
fs.writeFileSync(path.join(CACHE, 'layer.json'), JSON.stringify({
  name: info.name, version: info.version, store: info.store,
  heightModelInfo: info.heightModelInfo, elevationInfo: info.elevationInfo,
  spatialReference: info.spatialReference, serviceUpdateTimeStamp: info.serviceUpdateTimeStamp,
}, null, 1));
const attrs = await L.attributeMap();
const keys = WANT.map(n => ({ name: n, ...attrs.get(n) })).filter(a => a.key);
console.log(`layer "${info.name}" v${info.version}; ${keys.length}/${WANT.length} wanted attributes present`);

const leaves = await L.leavesIn(BBOX);
fs.writeFileSync(path.join(CACHE, 'leaves.json'), JSON.stringify(leaves, null, 1));
console.log(`${leaves.length} leaf nodes intersect the envelope, ` +
  `${leaves.reduce((s, l) => s + (l.featureCount || 0), 0)} features`);

const jobs = [];
for (const l of leaves) for (const a of keys)
  jobs.push({ res: l.resource, key: a.key, file: path.join(CACHE, `${l.resource}_${a.key}.bin`) });
let done = 0, failed = 0, i = 0;
async function worker() {
  while (i < jobs.length) {
    const j = jobs[i++];
    if (!force && fs.existsSync(j.file)) { done++; continue; }
    const buf = await L.attributeBlob(j.res, j.key);
    if (!buf) { failed++; continue; }
    fs.writeFileSync(j.file, buf); done++;
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`attribute blobs: ${done} ok, ${failed} failed, of ${jobs.length}`);
console.log(`cache at ${path.relative(process.cwd(), CACHE)}`);
