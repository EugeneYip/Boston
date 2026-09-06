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
import {
  VEHICLE_TYPES, VehicleVisual, createMaterialKit, getVehicleGeometry,
} from '../../src/world/VehicleModels.js';

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
  mode: qs.get('veh') ? 'vehicle' : 'building',
  spec: clampIdx(+(qs.get('spec') ?? 0)),
  lod: clampLod(+(qs.get('lod') ?? 0)),
  view: qs.get('view') || 'threequarter',
  radius: +(qs.get('radius') ?? 0),           // 0 = the target building alone
  veh: { type: qs.get('veh') || 'sedan', color: 0x9aa3ad },
  buildMs: 0, tris: 0, glassTris: 0,
};

function clampIdx(i) { return Math.max(0, Math.min(specs.length - 1, i | 0)); }
function clampLod(l) { return l === 1 || l === 2 ? l : 0; }

function clearContent() {
  for (const o of [...content.children]) {
    content.remove(o);
    // Vehicle roots are cached `VehicleVisual`s sharing geometry through
    // `_geoCache`; disposing them would destroy the next scene's meshes too.
    if (!o.userData.shared) o.geometry?.dispose();
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

/** Count triangles actually submitted by a subtree, per material name. */
function countTris(root) {
  let tris = 0, meshes = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    let p = o.parent, vis = true;
    while (p && vis) { if (!p.visible) vis = false; p = p.parent; }
    if (!vis) return;
    const g = o.geometry;
    if (!g) return;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    meshes++;
  });
  return { tris, meshes };
}

/** Put one vehicle, at one LOD, at the origin. */
function rebuildVehicle() {
  clearContent();
  const t = performance.now();
  const vis = vehicleVisual(state.veh.type, state.veh.color);
  // `setWheel` early-returns unless the visual is at LOD 0, so pose while it is.
  vis.setLod(0);
  poseStatic(vis);
  vis.setLod(state.lod);
  vis.root.position.set(0, 0, 0);
  vis.root.rotation.set(0, 0, 0);
  vis.root.userData.shared = true;
  content.add(vis.root);
  state.buildMs = performance.now() - t;
  const c = countTris(vis.root);
  state.tris = c.tris;
  state.glassTris = 0;
  state.meshes = c.meshes;
  state.count = 1;
  state.mb = null;
  frame();
}

/** Build the current selection at the current LOD and put it in the scene. */
function rebuild() {
  if (state.mode === 'vehicle') return rebuildVehicle();
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

/**
 * Vehicle viewpoints, in metres from the car, at the distances the game
 * actually switches LOD: LOD 0 below 32 m, LOD 1 to 115 m, shell beyond.
 * `az` is measured from the direction the car faces, so "front" is its front
 * whichever way the model happens to be authored.
 */
const V_VIEWS = {
  // `fit` is a multiplier, not a distance: a 12.28 m bus framed at the 7.5 m
  // that suits a 4.86 m sedan is a wall of white filling the frame. Views that
  // judge the MODEL scale with it, and scale on the axis they actually look
  // along -- length for the side and hero, face size for front and rear, or a
  // bus ends up further away for its front than a sedan is for its flank.
  v_hero:       { az: 0.62, el: 0.17, fit: 1.55, on: 'length', aim: 0.42 },
  v_side:       { az: 1.57, el: 0.10, fit: 1.65, on: 'length', aim: 0.38 },
  v_front:      { az: 0.00, el: 0.11, fit: 3.80, on: 'face',   aim: 0.38 },
  v_rear:       { az: 3.14, el: 0.11, fit: 3.80, on: 'face',   aim: 0.38 },
  // Eye height, at each LOD boundary, framed the same so the transition is
  // judged on what actually changes rather than on framing.
  v_at30:       { az: 0.62, el: 0.02, dist: 30,   aim: 0.85, eye: 1.62 },
  v_at34:       { az: 0.62, el: 0.02, dist: 34,   aim: 0.85, eye: 1.62 },
  v_at110:      { az: 0.62, el: 0.02, dist: 110,  aim: 0.85, eye: 1.62 },
  v_at120:      { az: 0.62, el: 0.02, dist: 120,  aim: 0.85, eye: 1.62 },
};

function frameVehicle() {
  const v = V_VIEWS[state.view] || V_VIEWS.v_hero;
  const fs = vehicleFrontSign(state.veh.type);
  const g = getVehicleGeometry(state.veh.type);
  const d = g.spec.def;

  ground.position.set(0, 0, 0);
  ground.scale.set(600, 600, 1);

  // az 0 looks the car in the face: stand off along its forward axis.
  const dist = v.dist !== undefined
    ? v.dist
    : v.fit * (v.on === 'face' ? Math.max(d.W, d.H) : Math.max(d.L, d.H));
  // `aim` is a fraction of vehicle height for the scaling views and an absolute
  // height for the fixed-distance LOD ones, so a bus is not aimed at its wheels.
  const aimY = v.dist !== undefined ? v.aim : v.aim * d.H;
  const a = v.az;
  const ce = Math.cos(v.el);
  const px = Math.sin(a) * dist * ce;
  const pz = fs * Math.cos(a) * dist * ce;
  const py = v.eye !== undefined ? v.eye : Math.sin(v.el) * dist + d.H * 0.55;
  camera.position.set(px, py, pz);
  camera.lookAt(0, aimY, 0);
  camera.updateProjectionMatrix();

  // Key from the front-RIGHT, i.e. the same quarter `v_hero`, `v_front` and
  // `v_side` all look from.
  //
  // The building path lights from a fixed world bearing, which is fine for a
  // building because it has no front. A car does: `anchors.head` puts the nose
  // at -z. Inheriting the building sun put it at +z, squarely behind every car,
  // so the whole front fascia rendered unlit and read as a black wedge punched
  // through the bumper. That is not a modelling defect and chasing it as one
  // wasted a cycle -- the third lighting/pose artefact this lab has produced
  // that looks exactly like broken geometry. `v_rear` is deliberately backlit;
  // judge tail geometry on silhouette, not on shading.
  const r = Math.max(d.L, d.W, d.H) * 1.3 + 3;
  sun.target.position.set(0, d.H * 0.4, 0);
  sun.position.set(r * 0.8, d.H * 0.5 + r * 1.1, -r * 0.62);
  const sc = sun.shadow.camera;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
  sc.near = 0.5; sc.far = r * 4 + 40;
  sc.updateProjectionMatrix();
  render();
}

function frame() {
  if (state.mode === 'vehicle') return frameVehicle();
  const spec = specs[state.spec];
  const bb = bounds(state.mb);
  const t = specBounds(spec);
  // An explicit viewpoint stands a stated distance out along the target's own
  // front normal. That is how a LOD band gets judged at the distance it
  // actually applies at -- LOD 1 runs 175-410 m, and a preset that frames the
  // building nicely is not standing anywhere near there.
  if (state.view && typeof state.view === 'object') {
    const n = frontNormal(spec);
    const i0 = spec.front.size ? [...spec.front][0] : 0;
    const a = spec.poly[i0], b = spec.poly[(i0 + 1) % spec.poly.length];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const d = state.view.dist ?? 200;
    ground.position.set(t.cx, spec.base - 0.02, t.cz);
    ground.scale.set(2400, 2400, 1);
    camera.position.set(mx + n.x * d, spec.base + (state.view.eye ?? 34), mz + n.z * d);
    camera.lookAt(mx, spec.base + (state.view.aim ?? 8), mz);
    camera.updateProjectionMatrix();
    const r0 = Math.max(bb.w, bb.d, bb.h) * 0.75 + 12;
    sun.target.position.set(t.cx, spec.base + t.h * 0.4, t.cz);
    sun.position.set(t.cx - r0 * 0.8, spec.base + t.h * 0.5 + r0 * 1.1, t.cz + r0 * 0.62);
    const sc = sun.shadow.camera;
    sc.left = -r0; sc.right = r0; sc.top = r0; sc.bottom = -r0;
    sc.near = 0.5; sc.far = r0 * 4 + 60;
    sc.updateProjectionMatrix();
    render();
    return;
  }
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
  const info = renderer.info;
  if (state.mode === 'vehicle') {
    const d = getVehicleGeometry(state.veh.type).spec.def;
    hud.textContent =
      `${state.veh.type}  lod ${state.lod}  view ${state.view}\n` +
      `L ${d.L.toFixed(2)}  W ${d.W.toFixed(2)}  H ${d.H.toFixed(2)} m` +
      `  wheelbase ${(d.axles[d.axles.length - 1] - d.axles[0]).toFixed(2)} m\n` +
      `tris ${state.tris}  meshes ${state.meshes}  draws ${info.render.calls}\n` +
      `world ${world.timing.total} ms   boot ${(bootMs | 0)} ms`;
    return;
  }
  const s = specs[state.spec];
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
/* Vehicles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The real `VehicleVisual`, not a re-assembly of it.
 *
 * `getVehicleGeometry` hands back three LODs of loose `BufferGeometry`, and it
 * would be easy — and wrong — to hang them on meshes here. `VehicleVisual` is
 * what production puts on the road: it also places the number plates, the eight
 * lamp emitters, and the wheels, which exist ONLY at LOD 0 because LOD 1 and 2
 * bake them into the body. Re-assembling would quietly drop exactly the parts
 * whose disappearance across a LOD transition this lab exists to measure.
 *
 * Materials come from `createMaterialKit(null)`, the kit's own locally-authored
 * fallback, deliberately rather than from the `Materials` system: `Materials.init`
 * assigns `ctx.scene.environment`, which would relight every building scene and
 * invalidate the standing benchmark. This mission is geometry, vehicle paint is
 * closed, and the fallback keeps the env-probe and auto-exposure confounds that
 * have burned this project before well out of the way.
 */
let _kit = null;
const _vehCache = new Map();

function vehicleVisual(type, color) {
  const key = type + ':' + color;
  let v = _vehCache.get(key);
  if (v) return v;
  if (!_kit) _kit = createMaterialKit(null);
  v = new VehicleVisual(type, { kit: _kit, color, castShadow: true });
  poseStatic(v);
  _vehCache.set(key, v);
  return v;
}

/**
 * Put the car on its suspension.
 *
 * `VehicleVisual` builds each wheel at `p[1] - rest`, i.e. FULL DROOP, because
 * production drives the pose every frame through `setWheel(i, susLen, ...)` from
 * the real suspension solve. A lab that only constructs the visual and never
 * poses it renders a car standing on stilts, with a finger of daylight between
 * every tyre and its arch — which reads exactly like a modelling defect and is
 * not one. This was the first thing this lab appeared to "find" about vehicles.
 *
 * Static ride height is the compression `buildSpec` sized the spring for:
 * `susLen = rest * (1 - sqRatio)`, which puts the wheel centre at `tyreR` and
 * the tyre exactly on the ground.
 */
function poseStatic(v) {
  const sq = v.spec.def.sqRatio;
  for (let i = 0; i < v.wheels.length; i++) {
    v.setWheel(i, v.wheels[i].cfg.rest * (1 - sq), 0, 0);
  }
}

/**
 * Which way the car faces, read from its own headlight anchors rather than
 * assumed. Returns the +z sign that points forward.
 */
function vehicleFrontSign(type) {
  const g = getVehicleGeometry(type);
  const head = g.anchors && g.anchors.head;
  if (head && head.length) return Math.sign(head[0].z) || -1;
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Standing benchmark scenes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Fixed subjects, fixed cameras, fixed bands. `band` is the horizontal slice of
 * the frame that holds the subject -- sky and bare ground carry no gradient and
 * only dilute `detail()`.
 *
 * Indices are into the real city and are stable as long as the parcel chain is:
 * `Buildings._buildSpecs` seeds each spec from its plot id, and the plot list
 * is sorted by distance from the centre.
 */
const SCENES = [
  // 185 m stone tower, close. Stands for the 111 stone towers.
  { name: 'stoneTower_lod0', spec: 2509, lod: 0, view: 'threequarter', band: [80, 340] },
  { name: 'stoneTower_lod1', spec: 2509, lod: 1, view: 'threequarter', band: [80, 340] },
  // 181 m glass tower. Stands for the 154 curtain-wall buildings.
  { name: 'glassTower_lod1', spec: 4551, lod: 1, view: 'threequarter', band: [80, 340] },
  // A Back Bay block seen from 230 m: inside the LOD 1 band, elevated enough
  // that rooflines are the silhouette. Stands for the low brownstone fabric,
  // which is most of the city.
  { name: 'backBay_lod1', spec: 345, lod: 1, radius: 190,
    view: { dist: 230, eye: 34, aim: 8 }, band: [230, 340] },
  { name: 'backBay_lod0', spec: 345, lod: 0, radius: 190,
    view: { dist: 230, eye: 34, aim: 8 }, band: [230, 340] },
  // A 1920s setback tower with a stepped granite crown, seen from just below
  // the parapet. Stands for the 133 buildings with setbacks and the 111 towers
  // over 60 m, and is the scene where inset geometry is most legible.
  { name: 'crownTower_lod1', spec: 261, lod: 1, radius: 0,
    view: { dist: 88, eye: 92, aim: 99 }, band: [60, 300] },
  // A mansard row from 180 m, looking down onto the roofline. Stands for the
  // 2,686 buildings -- 27% of Boston -- that carry a mansard, whose dormers are
  // the single most recognisable thing about a Back Bay or South End skyline.
  { name: 'mansardRow_lod1', spec: 345, lod: 1, radius: 70,
    view: { dist: 180, eye: 44, aim: 13 }, band: [180, 330] },
  { name: 'mansardRow_lod0', spec: 345, lod: 0, radius: 70,
    view: { dist: 180, eye: 44, aim: 13 }, band: [180, 330] },
  // Control: one rowhouse at conversational distance. LOD 0 close-up work
  // should not be disturbed by anything aimed at distance.
  { name: 'rowhouse_lod0_ctrl', spec: 345, lod: 0, radius: 70,
    view: { dist: 17, eye: 6, aim: 6 }, band: [40, 420] },

  // --- vehicles ----------------------------------------------------------
  // The classes differ by body, not just by scale: sedan and suv share a
  // silhouette family, pickup and bus do not. Distances are the ones the game
  // actually switches at -- LOD 0 below 32 m, LOD 1 to 115 m, shell beyond.
  { name: 'veh_sedan_hero',  veh: 'sedan',  lod: 0, view: 'v_hero',  band: [120, 400] },
  { name: 'veh_sedan_front', veh: 'sedan',  lod: 0, view: 'v_front', band: [120, 400] },
  { name: 'veh_sedan_side',  veh: 'sedan',  lod: 0, view: 'v_side',  band: [120, 400] },
  { name: 'veh_suv_hero',    veh: 'suv',    lod: 0, view: 'v_hero',  band: [120, 400] },
  { name: 'veh_pickup_hero', veh: 'pickup', lod: 0, view: 'v_hero',  band: [120, 400] },
  { name: 'veh_bus_hero',    veh: 'bus',    lod: 0, view: 'v_hero',  band: [100, 400] },
  { name: 'veh_van_front',   veh: 'van',    lod: 0, view: 'v_front', band: [120, 400] },
  // LOD tiers, framed identically so a transition is judged on what changes.
  { name: 'veh_sedan_lod1',  veh: 'sedan',  lod: 1, view: 'v_at34',  band: [280, 380] },
  { name: 'veh_sedan_lod2',  veh: 'sedan',  lod: 2, view: 'v_at120', band: [300, 360] },
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

let bootMs = 0;

const api = {
  ready: false,
  world, specs, scene, camera, renderer, state,

  /** Show one vehicle at one LOD. `type` is any of `VEHICLE_TYPES`. */
  showVehicle(type, opt = {}) {
    state.mode = 'vehicle';
    if (type) state.veh.type = type;
    if (opt.color !== undefined) state.veh.color = opt.color;
    if (opt.lod !== undefined) state.lod = clampLod(opt.lod);
    if (opt.view !== undefined) state.view = opt.view;
    rebuild();
    return api.vehicleMetrics();
  },

  vehicleTypes: () => VEHICLE_TYPES.slice(),

  /** Geometry facts for one vehicle at every LOD, without rendering it. */
  vehicleMetrics(type = state.veh.type) {
    const g = getVehicleGeometry(type);
    const d = g.spec.def;
    const lods = g.lods.map((l, i) => {
      let tris = 0;
      const mats = [];
      for (const [name, bg] of l.geos) {
        tris += (bg.index ? bg.index.count : bg.attributes.position.count) / 3;
        mats.push(name);
      }
      // Wheels exist only at LOD 0; 1 and 2 bake them into the body.
      let wheelTris = 0;
      if (i === 0 && g.wheel) {
        for (const [, bg] of g.wheel.geos) {
          wheelTris += (bg.index ? bg.index.count : bg.attributes.position.count) / 3;
        }
        wheelTris *= g.spec.wheels.length;
      }
      return { lod: i, bodyTris: tris, wheelTris, tris: tris + wheelTris,
               materials: mats.length, names: mats };
    });
    return {
      type, body: d.body, L: +d.L.toFixed(2), W: +d.W.toFixed(2), H: +d.H.toFixed(2),
      wheelbase: +(d.axles[d.axles.length - 1] - d.axles[0]).toFixed(2),
      tyreR: d.tyreR, track: d.track, lods,
      drawn: state.mode === 'vehicle' ? { tris: state.tris, meshes: state.meshes } : null,
    };
  },

  /** Show building `i` (an index into the real city's spec array). */
  show(i, opt = {}) {
    state.mode = 'building';
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

  /**
   * The standing benchmark. One call gives every number a modeling cycle needs
   * for a BEFORE or an AFTER, and -- more importantly -- gives the SAME numbers
   * across cycles, so a later change cannot quietly undo an earlier one.
   *
   * Every scene names the population it stands for. Controls are scenes the
   * change under test is expected NOT to move; a control that moves is the
   * finding, not a rounding error.
   */
  bench(extra = []) {
    const out = {};
    for (const sc of [...SCENES, ...extra]) {
      if (sc.veh) api.showVehicle(sc.veh, { lod: sc.lod, view: sc.view });
      else api.show(sc.spec, { lod: sc.lod, radius: sc.radius ?? 0, view: sc.view });
      out[sc.name] = {
        tris: state.tris + state.glassTris,
        detail: api.detail(sc.band[0], sc.band[1]),
        d: api.digest(10, 8),
      };
    }
    return out;
  },

  /** Compare two `bench()` results. */
  diff(before, after) {
    const out = {};
    for (const k of Object.keys(after)) {
      if (!before[k]) continue;
      const b = before[k], a = after[k];
      out[k] = {
        tris: b.tris === a.tris ? b.tris + ' (=)' : b.tris + ' -> ' + a.tris +
              '  ' + (a.tris >= b.tris ? '+' : '') + (100 * (a.tris / b.tris - 1)).toFixed(1) + '%',
        detail: b.detail.toFixed(3) + ' -> ' + a.detail.toFixed(3) +
                '  ' + (a.detail >= b.detail ? '+' : '') + (100 * (a.detail / b.detail - 1)).toFixed(1) + '%',
        tilesMoved: a.d.filter((t, i) => t.h !== b.d[i].h).length + '/' + a.d.length,
      };
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
  /**
   * Mean luminance gradient over a horizontal band of the frame.
   *
   * The acceptance metric for MODELING, as opposed to tone. Mean tile
   * luminance -- the obvious thing to reach for -- cannot see this class of
   * change at all: replacing a blank wall with a windowed one moved the Back
   * Bay block's mean from 138.28 to 138.09 out of 140, which reads as noise,
   * while gradient energy over the same pixels moved 19.7 -> 22.1. Detail is
   * high-frequency by definition, so measure the high frequencies.
   *
   * Pass the band that actually contains the subject. Sky and empty ground are
   * gradient-free and only dilute the number.
   */
  detail(y0 = 0, y1 = H) {
    render();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(renderer.domElement, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    const lum = (k) => px[k] * 0.299 + px[k + 1] * 0.587 + px[k + 2] * 0.114;
    let sum = 0, n = 0;
    for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) {
      for (let x = 1; x < W - 1; x++) {
        const k = (y * W + x) * 4;
        sum += Math.abs(lum(k + 4) - lum(k - 4)) +
               Math.abs(lum(k + W * 4) - lum(k - W * 4));
        n++;
      }
    }
    return n ? +(sum / n).toFixed(4) : 0;
  },

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
