/**
 * Stage 1C phase 1 — what Boston's streetwall currently IS.
 *
 *   node research/gis-stage1c/frames.mjs
 *
 * A block face is one `(edgeId, side)` of the road graph. Its parcels are
 * ordered by Boston's own frontage chain — the exact relation
 * `Buildings._superblocks` already uses to walk a row of lots — so no second
 * street graph is invented here. For each face this exposes the ordered
 * frontage polyline, which is the current streetwall, plus each parcel's
 * outward normal taken from its own construction (`polygon[3] - polygon[0]`,
 * which is how `RoadNetwork.buildPlots` extrudes a lot away from the road).
 */
import { buildCurrentWorld } from '../gis-stage1a/current-world.mjs';
import { makeBuilder } from '../gis-stage1b1/pipeline.mjs';
import { frontageChain, centroid } from '../../src/world/GisAssociate.js';
import { BBOX_WORLD as W } from '../gis-stage1a/bbox.mjs';

export const inBox = (c) => c.x >= W.x0 && c.x <= W.x1 && c.z >= W.z0 && c.z <= W.z1;
export const seedOf = (p, i) => (p?.id ?? i) * 2654435761 % 1048573 | 0;

/** Outward = away from the street, straight from the parcel's own extrusion. */
export function outwardOf(plot) {
  const ox = plot.polygon[3].x - plot.polygon[0].x, oz = plot.polygon[3].z - plot.polygon[0].z;
  const l = Math.hypot(ox, oz) || 1;
  return { x: ox / l, z: oz / l };
}

export function buildFrames() {
  const world = buildCurrentWorld();
  const { b, ctx } = makeBuilder(world);
  b._collectPlots(ctx);
  b._clipStats = { clipped: 0, dropped: 0, trimmed: 0, superblocks: 0 };
  const parcels = b._superblocks(b.plots);
  const index = new Map(parcels.map((p, i) => [p.id, i]));
  const chain = frontageChain(parcels);
  const local = parcels.filter((p) => p?.polygon && inBox(centroid(p.polygon)));
  const byId = new Map(local.map((p) => [p.id, p]));

  // Group by block face, then order each face by walking the chain from its head.
  const faces = new Map();
  for (const p of local) {
    if (!Number.isFinite(p.edgeId) || !p.frontage?.a) continue;
    const k = `${p.edgeId}|${p.side > 0 ? 1 : 0}`;
    let f = faces.get(k);
    if (!f) faces.set(k, f = { key: k, edgeId: p.edgeId, side: p.side > 0 ? 1 : 0,
                               street: world.net.edges[p.edgeId]?.name || `edge${p.edgeId}`, members: [] });
    f.members.push(p);
  }
  const out = [];
  for (const f of faces.values()) {
    const set = new Set(f.members.map((p) => p.id));
    const heads = f.members.filter((p) => !set.has(chain.prev.get(p.id)));
    const ordered = [];
    const seen = new Set();
    for (const h of heads.sort((a, c) => a.id - c.id)) {
      for (let id = h.id; id !== undefined && set.has(id) && !seen.has(id); id = chain.next.get(id)) {
        seen.add(id); ordered.push(byId.get(id));
      }
    }
    for (const p of f.members) if (!seen.has(p.id)) ordered.push(p);   // chain-orphans, kept
    // The frontage polyline: p0 of each parcel, plus p1 of the last.
    const poly = ordered.map((p) => ({ x: p.frontage.a.x, z: p.frontage.a.z }));
    const last = ordered[ordered.length - 1];
    poly.push({ x: last.frontage.b.x, z: last.frontage.b.z });
    // Contiguity: does the chain actually hold across the whole ordered list?
    const contiguous = ordered.every((p, i) => i === 0 || chain.next.get(ordered[i - 1].id) === p.id);
    let len = 0;
    for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
    out.push({ ...f, members: ordered, polyline: poly, contiguous,
               frontageM: len, nParcels: ordered.length,
               outward: ordered.map(outwardOf) });
  }
  out.sort((a, c) => c.frontageM - a.frontageM);
  return { world, b, parcels, index, chain, local, faces: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { local, faces, b, index } = buildFrames();
  const renders = local.filter((p) => !!b._specFor(p, seedOf(p, index.get(p.id))).spec).length;
  console.log(`in-box procedural visual units: ${local.length}, of which render: ${renders}`);
  console.log(`block faces: ${faces.length}`);
  console.log('\nstreet                         key     parcels  frontage  contiguous  depth med');
  for (const f of faces.slice(0, 14)) {
    const d = f.members.map((p) => p.depth).sort((a, c) => a - c);
    console.log(`${f.street.padEnd(30)} ${f.key.padEnd(7)} ${String(f.nParcels).padStart(7)} ` +
      `${f.frontageM.toFixed(1).padStart(8)} ${String(f.contiguous).padStart(11)} ${d[Math.floor(d.length / 2)].toFixed(1).padStart(9)}`);
  }
  const tot = faces.reduce((s, f) => s + f.frontageM, 0);
  console.log(`\ntotal in-box frontage ${tot.toFixed(0)} m across ${faces.length} faces; ` +
    `${faces.filter((f) => f.contiguous).length} faces fully contiguous`);
}
