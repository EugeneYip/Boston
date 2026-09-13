/**
 * Stage 2A.3 — pixel diff, against an A/A floor.
 *
 *   node research/gis-stage2a3/capture-diff.mjs
 *
 * A raw A/B pixel percentage is not evidence on its own. Stage 1B.1 spent a
 * round chasing an 11-14% "signal" that turned out to be film grain plus actors
 * spawning differently across page loads, so the candidate is also captured
 * TWICE, from two separate page loads, with the same settings. That A/A pair is
 * the noise floor, and only the amount by which A/B exceeds it is signal.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const DIR = new URL('./captures/', import.meta.url);
const r2 = (v) => Math.round(v * 100) / 100;
const load = (n) => { try { return readFileSync(new URL(`${n}.raw`, DIR)); } catch { return null; } };
function diff(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0, over = 0, px = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    sum += d; if (d > 32) over++; px++;
  }
  return { meanAbsDiff: r2(sum / px), pctOver32: r2((over / px) * 100), pixels: px };
}
const ids = [...new Set(readdirSync(DIR).filter((f) => f.endsWith('.raw'))
  .map((f) => f.replace(/-(control|candidate2?)\.raw$/, '')))].sort();
const out = {};
for (const id of ids) {
  const ab = diff(load(`${id}-control`), load(`${id}-candidate`));
  const aa = diff(load(`${id}-candidate`), load(`${id}-candidate2`));
  out[id] = { ab, aa, signalOverFloor: ab && aa ? r2(ab.pctOver32 - aa.pctOver32) : null };
}
console.log(`${'view'.padEnd(26)} ${'A/B %>32'.padStart(9)} ${'A/A floor'.padStart(10)} ${'signal'.padStart(8)}   meanAbs A/B`);
for (const [id, v] of Object.entries(out)) {
  console.log(`${id.padEnd(26)} ${String(v.ab?.pctOver32 ?? '-').padStart(9)} ${String(v.aa?.pctOver32 ?? 'n/a').padStart(10)} ` +
              `${String(v.signalOverFloor ?? '-').padStart(8)}   ${v.ab?.meanAbsDiff ?? '-'}`);
}
writeFileSync(new URL('./capture-diff.json', import.meta.url), JSON.stringify(
  { schemaVersion: 'boston-gis-stage2a3/capture-diff/0.1.0', canvas: [1920, 1080],
    method: 'A/B against an A/A floor from two separate page loads of the same world; holdActors true.',
    views: out }, null, 1) + '\n');
