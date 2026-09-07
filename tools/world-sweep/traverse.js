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
import { readLuma, frameStats } from './sweep.js';

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

/* --------------------------- night / weather ------------------------------ */

/**
 * `LightManager` flag and type bits, mirrored from src/gfx/LightManager.js.
 *
 * Read rather than re-derived: the manager keeps every source in flat typed
 * arrays and re-aims a FIXED pool of real THREE lights at the most important
 * ones near the camera each frame, so what a night route has to observe is not
 * "how bright is it" but WHICH sources hold a real light this frame and which
 * are standing in with additive proxy geometry. That set changes as the camera
 * moves, which is the whole reason this is a dynamic test and not a static one.
 */
const F_ENABLED = 1, F_AUTONIGHT = 8;
const T_STREET = 0, T_HEADLIGHT = 1, T_SIGN = 2, T_TAIL = 3, T_WINDOW = 4;

/**
 * Lamp family, in BOTH the taxonomies the project already uses, because they
 * are different questions and the static night subset was stratified by the
 * first one:
 *
 *   fixture — `Props.js` puts a `lampCobra` head on a davit arm 9.2 m up on
 *             ordinary streets, and a `lampAcorn` or `lampTwin` 3.85 m up in a
 *             heritage district. Height above ground separates them.
 *   lamping — `LightManager.buildStreetLights` colours the source LED, MERCURY
 *             or SODIUM. Chroma separates those.
 *
 * Reported as `cobra-led`, `acorn-sodium` and so on, so a night event can be
 * attributed to a fixture, to a lamping, or to neither.
 */
function lampFamily(r, g, b, hAboveGround) {
  const mx = Math.max(r, g, b) || 1e-6;
  const sat = (mx - Math.min(r, g, b)) / mx;
  const lamping = sat < 0.18 ? 'led' : b >= g ? 'mercury' : 'sodium';
  const fixture = hAboveGround == null ? 'unknown'
    : hAboveGround >= 6 ? 'cobra' : 'acorn';
  return `${fixture}-${lamping}`;
}

/**
 * Structural lighting state at the camera. No pixels here — this is the
 * "why" that a luminance jump gets attributed to.
 */
function lightState(B, pos, ground) {
  const lm = B.engine.systems.get('lighting')?.manager;
  if (!lm || !lm._flags) return null;
  const R = 120, R2 = R * R;
  let nAct = 0, nOvl = 0, nHead = 0, nTail = 0, nWin = 0, nSign = 0;
  let dLamp = Infinity, famR = 0, famG = 0, famB = 0, famH = null, powSum = 0;
  for (let i = 0, n = lm._count; i < n; i++) {
    const fl = lm._flags[i];
    if (!(fl & F_ENABLED)) continue;
    // A clock-gated source contributes nothing at midday; counting it would
    // make a daylight control run look identically lit to a night one.
    const clock = (fl & F_AUTONIGHT) ? lm.night : 1;
    const gain = lm._gain[i] * clock;
    if (gain <= 0.01) continue;
    const dx = lm._px[i] - pos[0], dy = lm._py[i] - pos[1], dz = lm._pz[i] - pos[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > R2) continue;
    nAct++;
    powSum += lm._power[i] * gain;
    // "Overlapping" means the camera is inside the source's reach, which is
    // the only definition that does not depend on where the camera looks.
    const r = lm._range[i];
    if (d2 < r * r) nOvl++;
    const ty = lm._type[i];
    if (ty === T_HEADLIGHT) nHead++;
    else if (ty === T_TAIL) nTail++;
    else if (ty === T_WINDOW) nWin++;
    else if (ty === T_SIGN) nSign++;
    else if (ty === T_STREET && d2 < dLamp) {
      dLamp = d2; famR = lm._cr[i]; famG = lm._cg[i]; famB = lm._cb[i];
      famH = lm._py[i] - ground(lm._px[i], lm._pz[i]);
    }
  }
  // Which sources hold one of the real pooled lights, and how hard they burn.
  let nReal = 0, realSum = 0;
  const a = lm._assigned;
  if (a) for (let k = 0; k < lm.poolSize; k++) if (a[k] >= 0) nReal++;
  for (const L of [...(lm.pointPool || []), ...(lm.spotPool || [])]) realSum += L.intensity || 0;
  return {
    night: +(lm.night ?? 0).toFixed(3),
    nAct, nOvl, nHead, nTail, nWin, nSign, nReal,
    realSum: +realSum.toFixed(1), powSum: +powSum.toFixed(1),
    dLamp: dLamp === Infinity ? null : +Math.sqrt(dLamp).toFixed(1),
    fam: dLamp === Infinity ? null : lampFamily(famR, famG, famB, famH),
    lampH: famH == null ? null : +famH.toFixed(2),
    assigned: a ? Array.from(a.slice(0, lm.poolSize)) : null,
  };
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
  /**
   * Frames per sample comes from the route's intended SPEED, not from a
   * constant. A flat 2 frames on a 6 m drive step is 3 m per frame, which is
   * 648 km/h, and at that velocity `Buildings` is behind for 82.5% of a route.
   * The same route at 50 km/h is behind for 10%. `opts.stress` restores the
   * flat cadence deliberately, and a stress run must be labelled as one.
   */
  // `mps` is the speed the route ASKS for; `frames` is what the engine gets
  // stepped between samples to deliver it. The previous version clamped this to
  // 24, which silently converted every 2 m pedestrian step into 5 m/s — faster
  // than `jog`, slower than `sprint`, and reported in prose as walking. The cap
  // is now high enough that no gameplay speed reaches it, and when it does bind
  // the run says so instead of quietly running fast.
  const FRAME_CAP = 240;
  const want = Math.max(1, Math.round((route.step / (route.mps || 1.5)) * 60));
  const frames = opts.frames ?? (opts.stress ? 2 : Math.min(FRAME_CAP, want));
  const clamped = !opts.frames && !opts.stress && want > FRAME_CAP;
  // Realistic speed and full route length are not affordable together: 300
  // samples at 24 frames is 7,200 frames for one walk. Stress mode covers the
  // whole route for breadth; the realistic pass measures a bounded section,
  // which is where a LOD pop or a streaming stall would show anyway.
  const pts = opts.stress ? route.pts : route.pts.slice(0, opts.maxSamples ?? 40);

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
    // Pixels are opt-in: a canvas readback per sample is affordable on a 14-route
    // night pass and pure overhead on a daylight LOD pass that ignores it.
    const px = opts.luma ? frameStats(readLuma(B)) : null;
    const ls = opts.lights ? lightState(B, p.pos, g) : null;
    samples.push({
      i, d: +(i * route.step).toFixed(0),
      groundY: +p.groundY.toFixed(2), camY: +p.pos[1].toFixed(2),
      roadDy, roadDist: ne ? +ne.distance.toFixed(1) : null,
      draws: info.render.calls, tris: info.render.triangles,
      inst: sc.inst, meshes: sc.meshes,
      settled: B.settled() ? 1 : 0,
      lod: lodCounts(B),
      err: B.errors.length - err0, gl: B.glFaults.length - gl0,
      ...(px ? { mean: px.mean, blown: px.blown, dark: px.dark,
                 detail: px.detail, p99: px.p99 } : {}),
      ...(ls ? { L: ls } : {}),
    });
  }
  // The achieved speed, not the requested one. These agree to within the
  // rounding of one frame unless `frames` was overridden or the cap bound, and
  // reporting both is what makes a mislabelled traversal impossible.
  const mpsGot = (route.step / frames) * 60;
  return { id: route.id, cat: route.cat, kind: route.kind, district: route.district,
           note: route.note, n: samples.length, step: route.step,
           cls: opts.stress ? 'STRESS_FAST' : (route.cls || null),
           mps: route.mps, mpsGot: +mpsGot.toFixed(2), frames, clamped,
           mode: opts.stress ? 'stress' : 'realistic',
           kmh: +(mpsGot * 3.6).toFixed(1),
           tod: opts.tod ?? 11, weather: opts.weather ?? 'clear',
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
  /**
   * Did a jump STAY jumped? A sample that spikes and is back to where it started
   * two samples later is the frame a chunk rebuilt on, not a cost the world
   * carries. This matters more than it sounds: on the first run 209 of 310
   * events were `drawJump`, and stepping two extra frames at the same camera
   * made every one of them vanish — draws went 794, 792, 783, 772, 771, 769
   * where the 2-frame sampling had read a 150-draw, 1.05M-triangle spike.
   * Measuring the sampler, not the game.
   */
  /**
   * Absolute-threshold sibling of `persists`, for the luminance fractions. A
   * clipping spike that is gone two samples later is a bright object passing
   * the camera; one that stays is the exposure sitting in the wrong place.
   */
  const absPersists = (arr, i, key, from, tol) => {
    for (let k = i + 1; k <= Math.min(arr.length - 1, i + 2); k++) {
      if (Math.abs(arr[k][key] - from) <= tol) return 'transient';
    }
    return 'sustained';
  };
  const persists = (i, key, from) => {
    for (let k = i + 1; k <= Math.min(S.length - 1, i + 2); k++) {
      if (!relJump(from, S[k][key], (opt[key] ?? 0.25) * 0.6, 24)) return false;
    }
    return true;
  };
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    if (relJump(a.draws, b.draws, opt.draws ?? 0.25, 40)) {
      ev.push({ kind: 'drawJump', i, d: b.d, from: a.draws, to: b.draws,
                span: persists(i, 'draws', a.draws) ? 'sustained' : 'transient' });
    }
    if (relJump(a.inst, b.inst, opt.inst ?? 0.20, 400)) {
      ev.push({ kind: 'instJump', i, d: b.d, from: a.inst, to: b.inst,
                span: persists(i, 'inst', a.inst) ? 'sustained' : 'transient' });
    }
    if (Math.abs(b.meshes - a.meshes) > (opt.meshes ?? 14)) {
      ev.push({ kind: 'meshDelta', i, d: b.d, from: a.meshes, to: b.meshes });
    }
    // A STEP is a change of slope, not a slope. Flagging |dy| alone reported
    // eleven "steps" that were all Bunker Hill Street and Rutherford Avenue
    // descending smoothly and monotonically — 16 m of fall over 24 m is a
    // drumlin, not a defect. Compare against the previous gradient instead.
    if (i >= 2) {
      const prevDy = a.groundY - S[i - 2].groundY;
      const dy = b.groundY - a.groundY;
      const kink = Math.abs(dy - prevDy);
      if (kink > (opt.groundKink ?? 1.5)) {
        ev.push({ kind: 'groundKink', i, d: b.d, prevDy: +prevDy.toFixed(2),
                  dy: +dy.toFixed(2), kink: +kink.toFixed(2) });
      }
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
    /* --- night / weather transitions -------------------------------------
     * Only evaluated when the run carried pixels (`opts.luma`) or light state
     * (`opts.lights`), so a daylight LOD pass produces exactly the events it
     * produced before. Absolute thresholds, not fractional: at night the mean
     * luminance is near zero and every fractional test becomes infinitely
     * sensitive to it.
     */
    if (b.blown != null) {
      if (b.blown - a.blown > (opt.blown ?? 0.02)) {
        ev.push({ kind: 'clipJump', i, d: b.d, from: a.blown, to: b.blown,
                  span: absPersists(S, i, 'blown', a.blown, (opt.blown ?? 0.02) * 0.6) });
      }
      if (b.dark - a.dark > (opt.dark ?? 0.06)) {
        ev.push({ kind: 'crushJump', i, d: b.d, from: a.dark, to: b.dark,
                  span: absPersists(S, i, 'dark', a.dark, (opt.dark ?? 0.06) * 0.6) });
      }
      // Adaptation is supposed to move; a STEP in it is what reads as a pump.
      if (Math.abs(b.mean - a.mean) > (opt.luma ?? 0.05)) {
        ev.push({ kind: 'lumaJump', i, d: b.d, from: a.mean, to: b.mean,
                  span: absPersists(S, i, 'mean', a.mean, (opt.luma ?? 0.05) * 0.6) });
      }
    }
    if (b.L && a.L) {
      if (Math.abs(b.L.nOvl - a.L.nOvl) > (opt.ovl ?? 3)) {
        ev.push({ kind: 'ovlJump', i, d: b.d, from: a.L.nOvl, to: b.L.nOvl,
                  fam: b.L.fam, dLamp: b.L.dLamp });
      }
      // The fixed pool re-aims every frame. What matters is not that the set
      // changed but that the TOTAL real-light intensity stepped, because that
      // is the part a proxy has to make up for.
      if (relJump(a.L.realSum, b.L.realSum, opt.real ?? 0.35, 60)) {
        ev.push({ kind: 'realJump', i, d: b.d, from: a.L.realSum, to: b.L.realSum,
                  nReal: b.L.nReal, dLamp: b.L.dLamp, fam: b.L.fam });
      }
      if (Math.abs(b.L.nHead - a.L.nHead) > (opt.head ?? 2)) {
        ev.push({ kind: 'headJump', i, d: b.d, from: a.L.nHead, to: b.L.nHead });
      }
      if (Math.abs(b.L.nWin - a.L.nWin) > (opt.win ?? 40)) {
        ev.push({ kind: 'winJump', i, d: b.d, from: a.L.nWin, to: b.L.nWin });
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
/** p10/p50/p90 of a nested light-state field. */
function qL(S, k) {
  const v = S.map(s => s.L && s.L[k]).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return [0.1, 0.5, 0.9].map(f => +v[Math.floor(v.length * f)].toFixed(1));
}

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
    ...(S.length && S[0].mean != null ? {
      mean: [q('mean', 0.1), q('mean', 0.5), q('mean', 0.9)],
      blown: [q('blown', 0.1), q('blown', 0.5), q('blown', 0.9)],
      dark: [q('dark', 0.1), q('dark', 0.5), q('dark', 0.9)],
    } : {}),
    ...(S.length && S[0].L ? {
      night: S[0].L.night,
      nAct: qL(S, 'nAct'), nOvl: qL(S, 'nOvl'), nReal: qL(S, 'nReal'),
      realSum: qL(S, 'realSum'),
      fams: [...new Set(S.map(s => s.L && s.L.fam).filter(Boolean))].sort(),
    } : {}),
    cls: run.cls, mps: run.mps, mpsGot: run.mpsGot, kmh: run.kmh,
    mode: run.mode, tod: run.tod, weather: run.weather,
    events: by, nEvents: events.length,
  };
}
