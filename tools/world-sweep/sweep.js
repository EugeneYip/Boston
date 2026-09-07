/**
 * BOSTON — world-sweep runner (browser half).
 *
 * Steps ONE renderer through the canonical viewpoints and reduces each frame to
 * a compact evidence record. It is a DETECTOR, not the product: its job is to
 * say which of fifty views is unlike the others and hand back enough context to
 * find the owner. There is no universal visual-quality scalar here and no
 * attempt to invent one.
 *
 * Settling is not reimplemented. `CaptureHarness.capture` already teleports,
 * un-sticks the camera from geometry, waits on `settled()` for up to 600 frames
 * and then advances 60 more; it reports `streamed` so a view that never settled
 * can be discarded rather than believed.
 *
 * Dev-only. Nothing here ships, and nothing in `src/` imports it.
 *
 *   const { runSweep } = await import('/tools/world-sweep/sweep.js');
 *   const rows = await runSweep(window.__boston, views, { tod: 11 });
 */

/** Downsampled frame, as luminance in 0..1. Null when the buffer is degenerate. */
export function readLuma(B, W = 96, H = 54) {
  const src = B.engine.renderer.domElement;
  const gl = B.engine.renderer.getContext();
  if (gl.drawingBufferWidth < 2 || gl.drawingBufferHeight < 2) return null;
  const c = readLuma._c || (readLuma._c = document.createElement('canvas'));
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // Render and sample in the SAME task. The context is created without
  // `preserveDrawingBuffer`, so the colour buffer is only guaranteed valid
  // until the browser next composites; `step(1)` draws and `drawImage`
  // immediately after still sees it. Verified non-black, 5184/5184 pixels.
  B.step(1);
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const out = new Float32Array(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  }
  return { W, H, lum: out };
}

/** Statistics that separate a blank slab from a busy street. */
export function frameStats(f) {
  if (!f) return null;
  const { W, H, lum } = f;
  const s = Float32Array.from(lum).sort();
  const q = (t) => +s[Math.min(s.length - 1, Math.floor(s.length * t))].toFixed(4);
  let mean = 0;
  for (let i = 0; i < lum.length; i++) mean += lum[i];
  mean /= lum.length;
  let dark = 0, blown = 0;
  for (let i = 0; i < lum.length; i++) { if (lum[i] < 0.02) dark++; if (lum[i] > 0.97) blown++; }

  // Mean |gradient| — detail. A flat wall or an empty sky scores near zero.
  let g = 0, gn = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      g += Math.abs(lum[i] - lum[i + 1]) + Math.abs(lum[i] - lum[i + W]);
      gn += 2;
    }
  }

  // Largest share of the frame inside one narrow luminance band. This is the
  // blank-slab / grey-collapse detector: a good street frame spreads across
  // many bands, a wall at 20 cm puts most of the frame in one.
  const BANDS = 24, hist = new Int32Array(BANDS);
  for (let i = 0; i < lum.length; i++) hist[Math.min(BANDS - 1, (lum[i] * BANDS) | 0)]++;
  let top = 0;
  for (let i = 0; i < BANDS; i++) if (hist[i] > top) top = hist[i];

  // FNV-1a over quantised luminance: cheap regression digest across commits.
  let h = 0x811c9dc5;
  for (let i = 0; i < lum.length; i++) {
    h ^= Math.min(255, (lum[i] * 255) | 0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  // A coarse 4x3 spatial summary. Twelve numbers is enough to say WHERE a frame
  // changed -- sky, near ground, left facade -- without storing an image, and
  // it survives traffic moving through one tile.
  const TX = 4, TY = 3, tiles = new Array(TX * TY).fill(0), tn = new Array(TX * TY).fill(0);
  for (let y = 0; y < H; y++) {
    const ty = Math.min(TY - 1, ((y / H) * TY) | 0);
    for (let x = 0; x < W; x++) {
      const t = ty * TX + Math.min(TX - 1, ((x / W) * TX) | 0);
      tiles[t] += lum[y * W + x]; tn[t]++;
    }
  }
  for (let i = 0; i < tiles.length; i++) tiles[i] = +(tiles[i] / (tn[i] || 1)).toFixed(3);

  return {
    mean: +mean.toFixed(4), p01: q(0.01), p50: q(0.5), p99: q(0.99),
    dark: +(dark / lum.length).toFixed(4), blown: +(blown / lum.length).toFixed(4),
    detail: +(g / gn).toFixed(5), flat: +(top / lum.length).toFixed(4),
    tiles, digest: h.toString(16),
  };
}

/**
 * What the camera is actually looking at, and how far away. One
 * `intersectObjects` call over a list gathered per view — the previous
 * per-object loop over ~950 meshes was the slowest thing in the sweep.
 */
function probeAhead(B, THREE) {
  const e = B.engine;
  // Static geometry only. An InstancedMesh raycast tests every instance, and a
  // 15,000-instance batch made this the slowest call in the sweep; nearest
  // PROP distance comes from the spatial index instead.
  const targets = [];
  e.scene.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh && o.visible) targets.push(o);
  });
  const ray = new THREE.Raycaster();
  ray.far = 400;
  const dir = new THREE.Vector3();
  e.camera.getWorldDirection(dir);
  ray.set(e.camera.getWorldPosition(new THREE.Vector3()), dir);
  let hits = [];
  try { hits = ray.intersectObjects(targets, false); } catch { /* one bad mesh */ }
  if (!hits.length) return { aheadM: null, aheadName: 'sky' };
  return { aheadM: +hits[0].distance.toFixed(1),
           aheadName: hits[0].object.name || hits[0].object.type };
}

/**
 * Spatial index of every prop, parked car, vegetation instance and building,
 * built ONCE per sweep. Counting them per view instead was 250,000 distance
 * tests a frame and most of the sweep's runtime.
 */
export function buildIndex(B) {
  const e = B.engine;
  const C = 32;
  const cells = new Map();
  const add = (kind, x, z) => {
    const k = `${Math.floor(x / C)},${Math.floor(z / C)}`;
    let l = cells.get(k);
    if (!l) cells.set(k, l = []);
    l.push(kind, x, z);
  };
  const isCar = (k) => /^car[A-Z]/.test(k);
  const eat = (sys, kindOf) => {
    const bs = sys && sys.batcher && sys.batcher.batches;
    if (!bs) return;
    for (const [key, b] of bs) {
      const m = b.mats;
      if (!m) continue;
      const kind = kindOf(key);
      if (kind < 0) continue;
      for (let i = 0; i < m.length / 16; i++) add(kind, m[i * 16 + 12], m[i * 16 + 14]);
    }
  };
  eat(e.systems.get('props'), (k) => (k.startsWith('decal_') ? -1 : isCar(k) ? 1 : 0));
  eat(e.systems.get('vegetation'), () => 2);
  const specs = e.systems.get('buildings') && e.systems.get('buildings').specs;
  if (Array.isArray(specs)) for (const b of specs) if (b.cx !== undefined) add(3, b.cx, b.cz);
  return { C, cells };
}

/** What is actually AROUND the camera, from the systems' own instance data
 *  rather than from the picture. A frame whose prop count halves has lost
 *  props, whatever its luminance says. */
function nearbyCounts(idx, x, z, R = 70) {
  const out = [0, 0, 0, 0];
  if (!idx) return { nProps: 0, nParked: 0, nVeg: 0, nBuildings: 0 };
  const { C, cells } = idx;
  const R2 = R * R, r = Math.ceil(R / C);
  const cx = Math.floor(x / C), cz = Math.floor(z / C);
  for (let a = -r; a <= r; a++) {
    for (let b = -r; b <= r; b++) {
      const l = cells.get(`${cx + a},${cz + b}`);
      if (!l) continue;
      for (let i = 0; i < l.length; i += 3) {
        const dx = l[i + 1] - x, dz = l[i + 2] - z;
        if (dx * dx + dz * dz < R2) out[l[i]]++;
      }
    }
  }
  return { nProps: out[0], nParked: out[1], nVeg: out[2], nBuildings: out[3] };
}

/**
 * @param {object} B      window.__boston
 * @param {Array}  views  from `viewpoints.json`
 * @param {object} opts   { tod, weather, fov, only, holdActors }
 */
/** Resolve a stored terrain-independent pose against the CURRENT world. */
export function resolvePose(B, v, fov) {
  const city = B.engine.systems.get('city');
  const g = (x, z) => city.groundHeight(x, z);
  const gy = g(v.at[0], v.at[1]);
  return {
    pos: [v.at[0], gy + v.eye, v.at[1]],
    look: [v.aim[0], g(v.aim[0], v.aim[1]) + v.aimEye, v.aim[1]],
    fov: fov ?? 55,
    groundY: +gy.toFixed(2),
  };
}

/**
 * @param {object}   B      window.__boston
 * @param {Array}    views  from `viewpoints.json`
 * @param {object}   opts   { tod, weather, fov, only, holdActors, splitShadow }
 */
export async function runSweep(B, views, opts = {}) {
  const THREE = await import('three');
  const rows = [];
  const e = B.engine;
  const info = e.renderer.info;
  const city = e.systems.get('city');
  const net = city && city.roads;
  const idx = opts.index || buildIndex(B);
  for (const v of views) {
    if (opts.only && !opts.only.includes(v.id)) continue;
    const pose = resolvePose(B, v, opts.fov);
    let cap = null, err = null;
    try {
      cap = await B.capture({
        pos: pose.pos, look: pose.look, fov: pose.fov,
        tod: opts.tod ?? 11, weather: opts.weather ?? 'clear',
        holdActors: !!opts.holdActors,
      });
    } catch (er) { err = String(er && er.message || er); }
    const stats = frameStats(readLuma(B));
    const probe = err ? {} : probeAhead(B, THREE);

    let instances = 0, visMeshes = 0;
    e.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isInstancedMesh) { instances += o.count; visMeshes++; }
      else if (o.isMesh) visMeshes++;
    });

    // Shadow share, measured rather than guessed. `renderer.info.render` counts
    // the cascade passes, so a raw total is not comparable to any camera-only
    // budget: at street_12 it was 56.8% shadow.
    const draws = info.render.calls, tris = info.render.triangles;
    let camTris = null, camDraws = null;
    if (opts.splitShadow !== false && !err) {
      const was = e.renderer.shadowMap.enabled;
      e.renderer.shadowMap.enabled = false;
      B.step(1);
      camTris = info.render.triangles; camDraws = info.render.calls;
      e.renderer.shadowMap.enabled = was;
      B.step(1);
    }

    // Geometric controls: where the ground, the road and the camera are
    // relative to each other. A road shelf shows up here before it shows up in
    // any picture.
    const ne = net && net.nearestEdge(v.at[0], v.at[1]);
    const ed = ne && net.edges[ne.edgeId];
    let roadDy = null, roadDist = null, roadName = null;
    if (ed) {
      const sp = net.sample(ne.edgeId, ne.t);
      roadDist = +ne.distance.toFixed(1);
      roadName = ed.name || ed.type;
      if (sp && Number.isFinite(sp.y)) roadDy = +(sp.y - pose.groundY).toFixed(2);
    }

    rows.push({
      id: v.id, cat: v.cat, district: v.district, note: v.note,
      at: v.at, eye: v.eye, err,
      groundY: pose.groundY, camY: +pose.pos[1].toFixed(2),
      roadDy, roadDist, roadName,
      draws, tris, camDraws, camTris,
      shadowPct: camTris != null && tris > 0 ? +(100 * (tris - camTris) / tris).toFixed(1) : null,
      instances, visMeshes,
      ...nearbyCounts(idx, v.at[0], v.at[1]),
      streamed: cap && cap.streamed, settled: cap && cap.settledFrames,
      ...(stats || {}), ...probe,
    });
  }
  return rows;
}

/** Rank rows against the distribution of their own category. */
export function outliers(rows, keys = ['detail', 'flat', 'dark', 'blown', 'mean', 'tris', 'draws']) {
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.cat)) byCat.set(r.cat, []);
    byCat.get(r.cat).push(r);
  }
  const scored = [];
  for (const [, list] of byCat) {
    for (const k of keys) {
      const vals = list.map(r => r[k]).filter(v => typeof v === 'number').sort((a, b) => a - b);
      if (vals.length < 4) continue;
      const med = vals[vals.length >> 1];
      // Median absolute deviation: robust where a mean would be dragged by the
      // very outlier being looked for. But MAD is ZERO whenever most of a
      // category shares one value -- `blown` is 0 in nine street views out of
      // ten -- and dividing by an epsilon then reports z = 10252 for a frame
      // that is 1.5% clipped. Fall back to the standard deviation there, and
      // say nothing at all when the key is genuinely constant.
      let mad = vals.map(v => Math.abs(v - med)).sort((a, b) => a - b)[vals.length >> 1];
      if (!(mad > 1e-9)) {
        const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length);
        if (!(sd > 1e-9)) continue;
        mad = sd / 1.4826;
      }
      for (const r of list) {
        if (typeof r[k] !== 'number') continue;
        const z = (r[k] - med) / (1.4826 * mad);
        if (Math.abs(z) >= 3) scored.push({ id: r.id, cat: r.cat, key: k, value: r[k], median: +med.toFixed(4), z: +z.toFixed(1) });
      }
    }
  }
  return scored.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

/**
 * Compare a fresh sweep against `baseline.json`, per CATEGORY.
 *
 * Deliberately not per view. A per-view table is only comparable against the
 * exact committed `viewpoints.json` — ids are positional, so regenerating with
 * different quotas renumbers everything — and a single view moving is an
 * outlier to attribute, not a regression. A whole category moving is a
 * regression.
 *
 * Nothing here fails on an exact frame match. Boston has film grain, traffic
 * and pedestrians; measured cross-capture variance is 1.95 by 8x8 block mean
 * against a same-capture floor of 0.46.
 *
 *   const base = await (await fetch('/tools/world-sweep/baseline.json')).json();
 *   compare(rows, base);
 */
export function compare(rows, base) {
  const ABS = { mean: 'meanAbs', detail: 'detailAbs', flat: 'flatAbs',
                dark: 'darkAbs', blown: 'blownAbs' };
  const FRAC = { camDraws: 'camDrawsFrac', camTris: 'camTrisFrac',
                 nProps: 'nPropsFrac', nVeg: 'nVegFrac', nBuildings: 'nBuildingsFrac' };
  const med = (a) => {
    const v = a.filter(Number.isFinite).sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const out = [];
  for (const [cat, want] of Object.entries(base.categories)) {
    const list = rows.filter(r => r.cat === cat);
    if (!list.length) { out.push({ cat, verdict: 'MISSING', detail: 'no views captured' }); continue; }
    if (list.length !== want.n) out.push({ cat, key: 'n', verdict: 'SUSPICIOUS', was: want.n, now: list.length });
    for (const [k, tol] of Object.entries(ABS)) {
      const now = med(list.map(r => r[k])), was = want[k] && want[k][1];
      if (now == null || was == null) continue;
      const d = Math.abs(now - was);
      if (d > base.tolerance[tol]) {
        out.push({ cat, key: k, verdict: 'SUSPICIOUS', was, now: +now.toFixed(4), delta: +d.toFixed(4) });
      }
    }
    for (const [k, tol] of Object.entries(FRAC)) {
      const now = med(list.map(r => r[k])), was = want[k] && want[k][1];
      if (now == null || was == null || was === 0) continue;
      const f = Math.abs(now - was) / was;
      if (f > base.tolerance[tol]) {
        out.push({ cat, key: k, verdict: 'SUSPICIOUS', was, now, frac: +f.toFixed(3) });
      }
    }
  }
  return { clean: out.length === 0, findings: out,
           note: 'SUSPICIOUS is a prompt to attribute, not a failure. Classify as '
               + 'EXPECTED / BENIGN DYNAMIC / SUSPICIOUS / REGRESSION before acting.' };
}
