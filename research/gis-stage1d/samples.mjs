/**
 * Stage 1D — the diagnostic sample set, and the semantics behind it.
 *
 * SEMANTIC DISCIPLINE (traced in phase 1, see the report §E):
 *
 *   CURRENT_ROAD_CENTERLINE      `RoadNetwork.edges[i].pts` — the hand-authored
 *                                polyline from `src/data/boston-geo.js`.
 *   corridorHalf(e)              `e.halfRoad + KERB(0.16) + e.walk`
 *                                (`src/world/RoadNetwork.js:60`).
 *   PROCEDURAL BUILDING FRONT    `_frontageLine(e, side)` offsets the centreline
 *                                by `corridorHalf(e) * side`
 *                                (`src/world/RoadNetwork.js`). So the procedural
 *                                front wall is the BACK OF THE FOOTWAY, and
 *                                PROCEDURAL_WALL_TO_WALL = 2 * corridorHalf.
 *   PROCEDURAL_WALL_MIDLINE      identically the centreline: the offset is
 *                                `* side` with side in {-1,+1} and nothing
 *                                downstream moves the line laterally —
 *                                `_clearFrontage` only deletes spans of it and
 *                                `_fitDepth` only shortens depth. Asymmetric
 *                                frontage generation is therefore impossible by
 *                                construction, and hypothesis F is excluded on
 *                                code grounds rather than statistics.
 *
 * A sample is one point on a procedural front line where BOTH allowed factual
 * sources see a wall and agree within Stage 1C's tolerance. `d` is the signed
 * distance from that procedural front line to the factual wall, positive
 * outward (away from the carriageway, into the block).
 */
import { buildEnvelopes, arc, atArc } from '../gis-stage1c/envelope.mjs';
import { corridorHalf } from '../../src/world/RoadNetwork.js';

export const TOL_M = 0.5;          // Stage 1C source-agreement tolerance, reused unchanged

export function buildSamples() {
  const { F, faces, byFace, provenance } = buildEnvelopes();
  const net = F.world.net;
  const out = [];
  for (const rec of byFace) {
    const f = rec.face;
    const e = net.edges[f.edgeId];
    const ch = corridorHalf(e);
    for (const s of rec.samples) {
      if (s.pd === null || s.md === null || s.dis > TOL_M) continue;
      const { p, u } = atArc(f, f.cum, s.s);
      out.push({
        faceKey: f.key, edgeId: f.edgeId, side: f.side, street: f.street, type: e.type,
        s: s.s, x: p.x, z: p.z, ux: u.x, uz: u.z,
        d: (s.pd + s.md) / 2, dis: s.dis, corridorHalf: ch,
        pOid: s.pOid, mOid: s.mOid,
      });
    }
  }
  // Deterministic order: no Map/Set iteration order leaks into committed output.
  out.sort((a, b) => a.edgeId - b.edgeId || a.side - b.side || a.s - b.s);
  return { F, faces, byFace, provenance, samples: out, net };
}

/** Distance from a point to the nearest junction node of the road graph. */
export function junctionDistance(net, x, z) {
  let best = Infinity;
  for (const n of net.nodes) {
    if (!n || (n.deg !== undefined && n.deg < 3)) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < best) best = d;
  }
  return best;
}
