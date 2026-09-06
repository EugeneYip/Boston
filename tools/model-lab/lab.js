/**
 * BOSTON — Model Lab.
 *
 * A modeling change has to be judged on pixels, and Boston's own runtime cannot
 * currently supply them: a cold boot is ~5 minutes and the Browser pane recycles
 * the tab every 30-60 s. This page renders the SAME buildings from the SAME
 * generator in about a second, by running the spec chain and stopping before the
 * game (see `world.js`).
 *
 * Not a viewer, not an editor, not content. It exists to make BEFORE/AFTER
 * captures reproducible:
 *
 *   - the render target is a FIXED 1000 x 640 backing store, CSS-scaled to fit,
 *     so a capture does not change when the pane is resized;
 *   - the camera is derived from the model's own bounds and a named preset, so
 *     the same building at the same preset frames identically before and after
 *     a geometry change;
 *   - lighting is constant. No time of day, no weather, no exposure adaptation --
 *     each of those has already produced a false reading on this project.
 *
 * Drive it from `window.__lab`; `?spec=4211&lod=1&view=street` sets the opening
 * state. `__lab.ready` is true once the world is built and a frame has been
 * drawn -- wait on that, never on a timer.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildWorld } from './world.js';
import { edgeReport, bounds } from './analysis.js';
import {
  MeshBuf, GlassBuf, buildAtlas, buildRoomAtlas, buildMacroNoise,
  makeOpaqueMaterial, makeGlassMaterial,
} from '../../src/world/BuildingKit.js';
import { buildBuilding } from '../../src/world/Facades.js';

const W = 1000, H = 640;
const qs = new URLSearchParams(location.search);
const hud = document.getElementById('hud');
const t0 = performance.now();

/* -------------------------------------------------------------------------- */
/* Renderer, lighting, ground                                                 */
/* -------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);                    // fixed: a capture must not depend on the display
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;  // the game's tone curve
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('wrap').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x93a8bd);
const camera = new THREE.PerspectiveCamera(42, W / H, 0.25, 4000);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

// One hard key at a fixed bearing. Relief is what this lab is for and relief is
// only legible as shadow -- an ambient-only setup would hide the very defect
// being hunted. The bearing is deliberately oblique so a front wall and a flank
// are never lit the same.
const sun = new THREE.DirectionalLight(0xfff3e2, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xaac7e8, 0x3a3630, 0.5));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshStandardMaterial({ color: 0x74746f, roughness: 0.97, metalness: 0 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* -------------------------------------------------------------------------- */
/* Real building materials                                                    */
/* -------------------------------------------------------------------------- */

// The production atlases and the production shaders. Not a stand-in: a facade
// whose relief reads well under a plain grey material can still read flat once
// the real normal map and the real window mask are on it.
const atlas = buildAtlas();
const rooms = buildRoomAtlas();
const macro = buildMacroNoise();
const matOpaque = makeOpaqueMaterial(atlas, rooms, macro);
const matGlass = makeGlassMaterial(rooms);
// Daylight. `Buildings.update` drives these from time of day; the lab pins them.
matOpaque.userData.uniforms.uNight.value = 0;
matGlass.userData.uniforms.uNight.value = 0;
matGlass.userData.uniforms.uDayInterior.value = 0.46;

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

const world = buildWorld();
const specs = world.specs;

/* -------------------------------------------------------------------------- */
/* Model construction                                                         */
/* -------------------------------------------------------------------------- */

const content = new THREE.Group();
scene.add(content);

let state = {
  spec: clampIdx(+(qs.get('spec') ?? 0)),
  lod: clampLod(+(qs.get('lod') ?? 0)),
  view: qs.get('view') || 'threequarter',
  radius: +(qs.get('radius') ?? 0),           // 0 = the target building alone
  buildMs: 0, tris: 0, glassTris: 0,
};

function clampIdx(i) { return Math.max(0, Math.min(specs.length - 1, i | 0)); }
function clampLod(l) { return l === 1 || l === 2 ? l : 0; }

function clearContent() {
  for (const o of [...content.children]) {
    content.remove(o);
    o.geometry?.dispose();
  }
}

/**
 * Which specs to emit: the target, plus every neighbour whose centre is within
 * `radius` metres of it. Neighbours are what make a party wall judgeable -- a
 * flank that is genuinely buried against the house next door is not a defect,
 * and only its context can say which it is.
 */
function selection(i, radius) {
  const t = specs[i];
  if (!(radius > 0)) return [i];
  const out = [];
  for (let k = 0; k < specs.length; k++) {
    const s = specs[k];
    if (Math.hypot(s.cx - t.cx, s.cz - t.cz) <= radius) out.push(k);
  }
  return out;
}

/** Build the current selection at the current LOD and put it in the scene. */
function rebuild() {
  clearContent();
  const list = selection(state.spec, state.radius);
  const mb = new MeshBuf(Math.max(4096, list.length * 1200));
  const gb = new GlassBuf(Math.max(1024, list.length * 120));
  const t = performance.now();
  for (const k of list) buildBuilding(specs[k], mb, gb, state.lod);
  state.buildMs = performance.now() - t;
  state.tris = mb.ni / 3;
  state.glassTris = gb.ni / 3;
  state.count = list.length;
  // `build(false)` keeps world-space positions, so `analysis.js` and the scene
  // agree about where a triangle is without any origin bookkeeping.
  const go = mb.build(false);
  if (go) {
    const m = new THREE.Mesh(go, matOpaque);
    m.castShadow = true; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    content.add(m);
  }
  const gg = gb.build(false);
  if (gg) {
    const m = new THREE.Mesh(gg, matGlass);
    m.castShadow = false; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    content.add(m);
  }
  state.mb = mb;
  frame();
}

/* -------------------------------------------------------------------------- */
/* Camera presets                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Named viewpoints, all derived from the TARGET building's own bounds so the
 * same preset frames the same building identically whatever else is on screen.
 *
 * `az` is measured from the target's front-edge outward normal, so `street`
 * really does stand in the street this building addresses rather than at some
 * fixed world bearing that would face a different side of every building.
 */
const VIEWS = {
  street:       { az: 0,    el: 0.06, fit: 1.30, eye: 1.65 },
  threequarter: { az: 0.62, el: 0.24, fit: 1.55 },
  flank:        { az: 1.57, el: 0.16, fit: 1.45 },
  rear:         { az: 3.14, el: 0.20, fit: 1.50 },
  corner:       { az: 0.90, el: 0.12, fit: 1.60, eye: 1.80 },
  above:        { az: 0.62, el: 0.85, fit: 1.60 },
};

/** Outward normal of the target's first front edge; falls back to +Z. */
function frontNormal(spec) {
  const poly = spec.poly;
  const i = spec.front.size ? [...spec.front][0] : 0;
  const a = poly[i], b = poly[(i + 1) % poly.length];
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  return { x: dz / L, z: -dx / L };
}

function frame() {
  const spec = specs[state.spec];
  const bb = bounds(state.mb);
  const t = specBounds(spec);
  const v = VIEWS[state.view] || VIEWS.threequarter;

  ground.position.set(t.cx, spec.base - 0.02, t.cz);
  ground.scale.set(2400, 2400, 1);

  // Distance that fits the TARGET, not the whole selection: adding neighbours
  // for context must not silently zoom the subject out.
  const span = Math.max(t.w, t.d, t.h);
  const dist = (span * v.fit) / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 0.5 + span * 0.35;

  const n = frontNormal(spec);
  const base = Math.atan2(n.x, n.z);
  const a = base + v.az;
  const ce = Math.cos(v.el);
  const px = t.cx + Math.sin(a) * dist * ce;
  const pz = t.cz + Math.cos(a) * dist * ce;
  const py = spec.base + (v.eye !== undefined && v.el < 0.1
    ? v.eye
    : Math.sin(v.el) * dist + t.h * 0.42);
  camera.position.set(px, py, pz);
  // Aim a little below centre: a street-level reading of a facade is about its
  // lower half, and centring the mass puts the sky in most of the frame.
  camera.lookAt(t.cx, spec.base + t.h * (v.el < 0.1 ? 0.34 : 0.46), t.cz);
  camera.updateProjectionMatrix();

  // Shadow volume around the whole selection, so a neighbour still casts onto
  // the subject.
  const r = Math.max(bb.w, bb.d, bb.h) * 0.75 + 12;
  sun.target.position.set(t.cx, spec.base + t.h * 0.4, t.cz);
  sun.position.set(t.cx - r * 0.8, spec.base + t.h * 0.5 + r * 1.1, t.cz + r * 0.62);
  const c = sun.shadow.camera;
  c.left = -r; c.right = r; c.top = r; c.bottom = -r;
  c.near = 0.5; c.far = r * 4 + 60;
  c.updateProjectionMatrix();
  render();
}

/** Footprint + height bounds of one spec, without needing its mesh. */
function specBounds(spec) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of spec.poly) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  return { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
           w: x1 - x0, d: z1 - z0, h: spec.h };
}

function render() {
  renderer.render(scene, camera);
  const s = specs[state.spec];
  const info = renderer.info;
  hud.textContent =
    `#${state.spec}  ${s.style}  ${s.district}  lod ${state.lod}` +
    (state.count > 1 ? `  (+${state.count - 1} nbrs)` : '') + '\n' +
    `${s.storeys} storeys  h ${s.h.toFixed(1)} m  front ${[...s.front].join(',')}/${s.poly.length}` +
    `  view ${state.view}\n` +
    `tris ${state.tris}  glass ${state.glassTris}  draws ${info.render.calls}` +
    `  build ${state.buildMs.toFixed(1)} ms\n` +
    `world ${world.timing.total} ms   boot ${(bootMs | 0)} ms`;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

let bootMs = 0;

const api = {
  ready: false,
  world, specs, scene, camera, renderer, state,

  /** Show building `i` (an index into the real city's spec array). */
  show(i, opt = {}) {
    state.spec = clampIdx(i);
    if (opt.lod !== undefined) state.lod = clampLod(opt.lod);
    if (opt.view !== undefined) state.view = opt.view;
    if (opt.radius !== undefined) state.radius = opt.radius;
    rebuild();
    return api.metrics();
  },
  setLOD(l) { state.lod = clampLod(l); rebuild(); return api.metrics(); },
  setView(v) { state.view = v; frame(); return api.metrics(); },
  setRadius(r) { state.radius = r; rebuild(); return api.metrics(); },

  /** Free camera, for anything the presets do not cover. */
  look(pos, at) { camera.position.set(...pos); camera.lookAt(...at); render(); },

  /** Per-footprint-edge geometry report for the current target at the current LOD. */
  edges() {
    const spec = specs[state.spec];
    const mb = new MeshBuf(4096), gb = new GlassBuf(512);
    buildBuilding(spec, mb, gb, state.lod);
    return edgeReport(spec, mb);
  },

  metrics() {
    const s = specs[state.spec];
    return {
      spec: state.spec, style: s.style, district: s.district, lod: state.lod,
      view: state.view, storeys: s.storeys, h: +s.h.toFixed(2),
      front: [...s.front], edges: s.poly.length,
      tris: state.tris, glassTris: state.glassTris,
      draws: renderer.info.render.calls,
      programs: renderer.info.programs?.length ?? 0,
      buildMs: +state.buildMs.toFixed(2),
      bounds: bounds(state.mb),
    };
  },

  /** Indices of specs matching a filter — how you find something to look at. */
  find(f = {}) {
    const out = [];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      if (f.style && s.style !== f.style) continue;
      if (f.district && s.district !== f.district) continue;
      if (f.minH !== undefined && s.h < f.minH) continue;
      if (f.maxH !== undefined && s.h > f.maxH) continue;
      if (f.fronts !== undefined && s.front.size !== f.fronts) continue;
      if (f.minStoreys !== undefined && s.storeys < f.minStoreys) continue;
      out.push(i);
      if (out.length >= (f.limit ?? 40)) break;
    }
    return out;
  },

  /** PNG data URL of the current frame — a capture that is not a screenshot. */
  capture() { render(); return renderer.domElement.toDataURL('image/png'); },

  /**
   * Per-tile pixel digest of the current frame.
   *
   * "Did my change alter only the region it should have?" is the question every
   * modeling cycle has to answer, and answering it by eye across two
   * screenshots is exactly how a regression somewhere else in the frame gets
   * missed. This splits the frame into a `cols` x `rows` grid and hashes each
   * tile, so the answer is a list of which tiles moved.
   *
   * The canvas is read back through a 2D context in the SAME tick as the
   * render: the WebGL context has no `preserveDrawingBuffer`, so a later read
   * would return an empty buffer rather than an obviously wrong one.
   */
  digest(cols = 8, rows = 5) {
    render();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(renderer.domElement, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    const tw = Math.floor(W / cols), th = Math.floor(H / rows);
    const out = [];
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        let h = 2166136261 >>> 0, lum = 0, n = 0;
        for (let y = ry * th; y < (ry + 1) * th; y++) {
          for (let x = rx * tw; x < (rx + 1) * tw; x++) {
            const i = (y * W + x) * 4;
            h ^= px[i]; h = Math.imul(h, 16777619) >>> 0;
            h ^= px[i + 1]; h = Math.imul(h, 16777619) >>> 0;
            h ^= px[i + 2]; h = Math.imul(h, 16777619) >>> 0;
            lum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; n++;
          }
        }
        out.push({ tile: rx + ',' + ry, h: h.toString(16), lum: +(lum / n).toFixed(2) });
      }
    }
    return out;
  },
};

window.__lab = api;

rebuild();
bootMs = performance.now() - t0;
render();
api.ready = true;
console.info(`[model-lab] ready in ${bootMs | 0} ms — ${specs.length} specs, ` +
  `world ${world.timing.total} ms`, world.timing);
