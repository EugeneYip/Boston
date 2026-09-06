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
function readLuma(B, W = 96, H = 54) {
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
function frameStats(f) {
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

  return {
    mean: +mean.toFixed(4), p01: q(0.01), p50: q(0.5), p99: q(0.99),
    dark: +(dark / lum.length).toFixed(4), blown: +(blown / lum.length).toFixed(4),
    detail: +(g / gn).toFixed(5), flat: +(top / lum.length).toFixed(4),
    digest: h.toString(16),
  };
}

/** What the camera is actually looking at, and how far away it is. */
function probeAhead(B, THREE) {
  const e = B.engine;
  const targets = [];
  e.scene.traverse((o) => {
    if ((o.isMesh || o.isInstancedMesh) && o.visible) targets.push(o);
  });
  const ray = new THREE.Raycaster();
  ray.far = 400;
  const dir = new THREE.Vector3();
  e.camera.getWorldDirection(dir);
  ray.set(e.camera.getWorldPosition(new THREE.Vector3()), dir);
  let best = null;
  for (const t of targets) {
    let hits;
    try { hits = ray.intersectObject(t, false); } catch { continue; }
    if (hits.length && (!best || hits[0].distance < best.distance)) {
      best = { distance: hits[0].distance, name: t.name || t.type };
    }
  }
  return best ? { aheadM: +best.distance.toFixed(1), aheadName: best.name }
              : { aheadM: null, aheadName: 'sky' };
}

/**
 * @param {object} B      window.__boston
 * @param {Array}  views  from `viewpoints.json`
 * @param {object} opts   { tod, weather, fov, only, holdActors }
 */
export async function runSweep(B, views, opts = {}) {
  const THREE = await import('three');
  const rows = [];
  const info = B.engine.renderer.info;
  for (const v of views) {
    if (opts.only && !opts.only.includes(v.id)) continue;
    let cap = null, err = null;
    try {
      cap = await B.capture({
        pos: v.pos, look: v.look, fov: opts.fov ?? 55,
        tod: opts.tod ?? 11, weather: opts.weather ?? 'clear',
        holdActors: !!opts.holdActors,
      });
    } catch (e) { err = String(e && e.message || e); }
    const stats = frameStats(readLuma(B));
    const probe = err ? {} : probeAhead(B, THREE);
    let instances = 0, visMeshes = 0;
    B.engine.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isInstancedMesh) { instances += o.count; visMeshes++; }
      else if (o.isMesh) visMeshes++;
    });
    rows.push({
      id: v.id, cat: v.cat, district: v.district, note: v.note,
      pos: v.pos, err,
      draws: info.render.calls, tris: info.render.triangles,
      instances, visMeshes,
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
