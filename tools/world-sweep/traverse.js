/**
 * BOSTON — dynamic traversal sweep (browser half).
 *
 * Drives ONE renderer along a canonical route and records structural telemetry
 * at every sample. It deliberately does NOT settle between samples: settling is
 * what the static sweep does, and a world that is always settled can never show
 * a streaming hole, a stale LOD or a camera that drops through a kerb.
 *
 * There is no universal motion score here and there should not be. Camera
 * motion changes most pixels by definition, so a frame-to-frame image
 * difference measures the camera, not the world. Everything flagged is a
 * STRUCTURAL discontinuity — an LOD bucket that jumped, geometry that appeared
 * or vanished, a draw-call spike, a ground elevation step — and pixels are only
 * captured afterwards, around the samples that were already flagged.
 *
 * Dev-only. Nothing in `src/` imports it.
 *
 *   const { runRoute, findEvents } = await import('/tools/world-sweep/traverse.js');
 */

/** Batches worth watching for LOD transitions: the families with a real
 *  silhouette, not the flat decals. */
const WATCH = ['carSedanA', 'carSuvA', 'carVanA', 'busCity', 'lampCobra', 'lampTwin',
               'busShelter', 'tree_planeLondon0', 'tree_redMaple0', 'veg_shrub'];

function lodCounts(B) {
  const out = {};
  const grab = (sys) => {
    const bs = sys && sys.batcher && sys.batcher.batches;
    if (!bs) return;
    for (const k of WATCH) {
      const b = bs.get && bs.get(k);
      if (!b || !b._counts) continue;
      out[k] = b._counts.slice();
    }
  };
  grab(B.engine.systems.get('props'));
  grab(B.engine.systems.get('vegetation'));
  return out;
}

/** One cheap pass over the scene: what is drawable right now. */
function sceneCounts(B) {
  let inst = 0, meshes = 0, instMeshes = 0;
  B.engine.scene.traverse((o) => {
    if (!o.visible) return;
    if (o.isInstancedMesh) { inst += o.count; instMeshes++; meshes++; }
    else if (o.isMesh) meshes++;
  });
  return { inst, meshes, instMeshes };
}

/**
 * @param {object} B      window.__boston
 * @param {object} route  one entry from `routes.json`
 * @param {object} opts   { frames = 2, fov = 55, tod = 11, weather = 'clear' }
 */
export async function runRoute(B, route, opts = {}) {
  const e = B.engine;
  const info = e.renderer.info;
  const city = e.systems.get('city');
  const net = city && city.roads;
  const g = (x, z) => city.groundHeight(x, z);
  const frames = opts.frames ?? 2;
  const pts = route.pts;

  const poseAt = (i) => {
    const a = pts[i];
    const b = pts[Math.min(pts.length - 1, i + Math.max(1, Math.round(14 / route.step)))];
    const gy = g(a[0], a[1]);
    return {
      pos: [a[0], gy + route.eye, a[1]],
      look: [b[0], g(b[0], b[1]) + route.eye * 0.85, b[1]],
      groundY: gy,
    };
  };

  // Warm up ONCE at the start: full settle, so the route measures movement
  // rather than the cost of arriving.
  const p0 = poseAt(0);
  let warm = null;
  try {
    warm = await B.capture({ pos: p0.pos, look: p0.look, fov: opts.fov ?? 55,
                             tod: opts.tod ?? 11, weather: opts.weather ?? 'clear' });
  } catch (err) { return { id: route.id, err: String(err && err.message || err) }; }

  const err0 = B.errors.length, gl0 = B.glFaults.length;
  const samples = [];
  for (let i = 0; i < pts.length; i++) {
    const p = poseAt(i);
    B.setCamera(p.pos, p.look, opts.fov ?? 55);
    B.step(frames);
    const sc = sceneCounts(B);
    const ne = net && net.nearestEdge(pts[i][0], pts[i][1]);
    const ed = ne && net.edges[ne.edgeId];
    let roadDy = null;
    if (ed) {
      const sp = net.sample(ne.edgeId, ne.t);
      if (sp && Number.isFinite(sp.y)) roadDy = +(sp.y - p.groundY).toFixed(2);
    }
    samples.push({
      i, d: +(i * route.step).toFixed(0),
      groundY: +p.groundY.toFixed(2), camY: +p.pos[1].toFixed(2),
      roadDy, roadDist: ne ? +ne.distance.toFixed(1) : null,
      draws: info.render.calls, tris: info.render.triangles,
      inst: sc.inst, meshes: sc.meshes,
      settled: B.settled() ? 1 : 0,
      lod: lodCounts(B),
      err: B.errors.length - err0, gl: B.glFaults.length - gl0,
    });
  }
  return { id: route.id, cat: route.cat, kind: route.kind, district: route.district,
           note: route.note, n: samples.length, step: route.step,
           warmStreamed: warm && warm.streamed, samples };
}

/**
 * Structural discontinuities along a route. Thresholds are deliberately blunt:
 * this produces candidates to ATTRIBUTE, not verdicts.
 */
export function findEvents(run, opt = {}) {
  const S = run.samples || [];
  const ev = [];
  const relJump = (a, b, frac, floor) =>
    Math.abs(b - a) > Math.max(floor, frac * Math.max(1, Math.abs(a)));
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    if (relJump(a.draws, b.draws, opt.draws ?? 0.25, 40)) {
      ev.push({ kind: 'drawJump', i, d: b.d, from: a.draws, to: b.draws });
    }
    if (relJump(a.inst, b.inst, opt.inst ?? 0.20, 400)) {
      ev.push({ kind: 'instJump', i, d: b.d, from: a.inst, to: b.inst });
    }
    if (Math.abs(b.meshes - a.meshes) > (opt.meshes ?? 14)) {
      ev.push({ kind: 'meshDelta', i, d: b.d, from: a.meshes, to: b.meshes });
    }
    // Ground elevation is a smooth field; a step between two samples 2-6 m
    // apart is terrain or a road shelf, not a hill.
    const dy = Math.abs(b.groundY - a.groundY);
    if (dy > (opt.groundStep ?? 1.2)) {
      ev.push({ kind: 'groundStep', i, d: b.d, from: a.groundY, to: b.groundY, dy: +dy.toFixed(2) });
    }
    if (b.roadDy != null && Math.abs(b.roadDy) > (opt.roadDy ?? 3) &&
        (a.roadDy == null || Math.abs(a.roadDy) <= (opt.roadDy ?? 3))) {
      ev.push({ kind: 'roadShelf', i, d: b.d, roadDy: b.roadDy, roadDist: b.roadDist });
    }
    for (const k of Object.keys(b.lod)) {
      const x = a.lod[k], y = b.lod[k];
      if (!x || !y) continue;
      for (let L = 0; L < Math.min(x.length, y.length); L++) {
        if (relJump(x[L], y[L], opt.lod ?? 0.5, 12)) {
          ev.push({ kind: 'lodJump', i, d: b.d, batch: k, lod: L, from: x[L], to: y[L] });
        }
      }
    }
    if (b.err > a.err) ev.push({ kind: 'error', i, d: b.d, n: b.err - a.err });
    if (b.gl > a.gl) ev.push({ kind: 'glFault', i, d: b.d, n: b.gl - a.gl });
  }
  // Streaming: a run of unsettled samples means the world could not keep up.
  let run0 = -1;
  for (let i = 0; i <= S.length; i++) {
    const un = i < S.length && !S[i].settled;
    if (un && run0 < 0) run0 = i;
    if (!un && run0 >= 0) {
      const len = i - run0;
      if (len >= (opt.unsettled ?? 4)) {
        ev.push({ kind: 'unsettled', i: run0, d: S[run0].d, samples: len,
                  metres: +(len * run.step).toFixed(0) });
      }
      run0 = -1;
    }
  }
  return ev;
}

/** Route-level aggregate, for the dynamic half of the regression baseline. */
export function summarise(run, events) {
  const S = run.samples || [];
  const q = (k, f) => {
    const v = S.map(s => s[k]).filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? +v[Math.floor(v.length * f)].toFixed(2) : null;
  };
  const by = {};
  for (const e of events) by[e.kind] = (by[e.kind] || 0) + 1;
  return {
    id: run.id, cat: run.cat, kind: run.kind, district: run.district, n: S.length,
    draws: [q('draws', 0.1), q('draws', 0.5), q('draws', 0.9)],
    inst: [q('inst', 0.1), q('inst', 0.5), q('inst', 0.9)],
    meshes: [q('meshes', 0.1), q('meshes', 0.5), q('meshes', 0.9)],
    unsettledPct: S.length ? +(100 * S.filter(s => !s.settled).length / S.length).toFixed(1) : null,
    events: by, nEvents: events.length,
  };
}
