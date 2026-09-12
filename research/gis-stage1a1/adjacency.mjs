/** Shared-boundary adjacency over the Stage 1A PDDL fixture, in world metres. */
import { readFileSync } from 'node:fs';
export const fx = JSON.parse(readFileSync(new URL('../gis-stage1a/fixture.json', import.meta.url), 'utf8'));

const K = (p) => p[0].toFixed(2) + ',' + p[1].toFixed(2);
/** Length of boundary shared between two parts, by matching undirected vertex pairs. */
export function buildAdjacency() {
  const edgeOwners = new Map();           // "a|b" (sorted) -> [featureIndex,...]
  fx.features.forEach((f, idx) => {
    for (const ring of f.derived.rings)
      for (let i = 0; i < ring.length; i++) {
        const a = K(ring[i]), b = K(ring[(i + 1) % ring.length]);
        if (a === b) continue;
        const k = a < b ? a + '|' + b : b + '|' + a;
        if (!edgeOwners.has(k)) edgeOwners.set(k, []);
        const arr = edgeOwners.get(k);
        if (!arr.includes(idx)) arr.push(idx);
      }
  });
  const shared = new Map();                // "i|j" -> metres of shared boundary
  for (const [k, owners] of edgeOwners) {
    if (owners.length < 2) continue;
    const [ax, az] = k.split('|')[0].split(',').map(Number);
    const [bx, bz] = k.split('|')[1].split(',').map(Number);
    const L = Math.hypot(bx - ax, bz - az);
    for (let i = 0; i < owners.length; i++)
      for (let j = i + 1; j < owners.length; j++) {
        const kk = owners[i] < owners[j] ? `${owners[i]}|${owners[j]}` : `${owners[j]}|${owners[i]}`;
        shared.set(kk, (shared.get(kk) || 0) + L);
      }
  }
  return shared;
}
/** Perimeter of a feature's outer ring, metres. */
export function perimeter(f) {
  const r = f.derived.rings[0];
  let p = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; p += Math.hypot(r[j][0] - r[i][0], r[j][1] - r[i][1]); }
  return p;
}
/** Connected components over a predicate. Deterministic: ascending index order. */
export function components(n, linked) {
  const parent = [...Array(n).keys()];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (const [a, b] of linked) uni(a, b);
  const g = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i); }
  return [...g.values()].sort((p, q) => p[0] - q[0]);
}
