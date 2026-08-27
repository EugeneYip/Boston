import * as THREE from 'three';

/**
 * Character — the procedural humanoid shared by the crowd and the player.
 *
 * ## Why the animation lives on the GPU
 * A city needs hundreds of walking people. `THREE.SkinnedMesh` cannot be
 * instanced, so hundreds of skeletons means hundreds of draw calls and hundreds
 * of per-frame bone-matrix solves on the CPU — against a whole-game CPU budget
 * of about 3 ms. So the skeleton is solved **once, offline**, for a handful of
 * looping clips, and the resulting skinning matrices are baked into a small
 * texture (48 x 150 half-float, ~115 KB). Every character in the world is then
 * one instance in an `InstancedMesh`, and the vertex shader looks up its own
 * clip and phase. The whole crowd is two draw calls; the CPU only ever advances
 * a phase scalar per person.
 *
 * ## Why rigid bind rather than weighted skinning
 * One bone per vertex costs 6 texture fetches; two costs 12. The artifact that
 * normally forces weighted skinning — the "candy wrapper" pinch at a bending
 * joint — is avoided the way PS2-era characters avoided it: an overlapping
 * sphere sits at every joint that bends more than a few degrees, so the limb
 * swivels *inside* a ball of geometry and no gap can ever open. At the ranges a
 * pedestrian is actually seen from, this is indistinguishable from real skinning
 * and costs half as much.
 *
 * ## Anatomy of the rig
 * 16 bones, authored against a 1.75 m reference figure with the origin between
 * the feet. Every bone's rest transform is a pure translation, so the inverse
 * bind matrix is just `translate(-restWorld)` and the baked matrix is
 * `boneWorld * translate(-restWorld)` — no matrix inversion anywhere.
 *
 * Per-vertex the mesh carries `aGirth`, the radial offset of the vertex from its
 * bone's axis, which lets one geometry cover every build from slight to heavy by
 * scaling the cross-section without touching limb length.
 */

export const REF_HEIGHT = 1.75;          // metres, the height the rig is authored at
export const NB = 16;                    // bones
export const FRAMES = 24;                // frames per clip
export const ROWS_PER_CLIP = FRAMES + 1; // +1: the last row repeats frame 0 so the
                                         //     shader can interpolate across the loop

/** Bone ids. Left/right are the *character's* left and right (facing -Z). */
export const BONE = {
  pelvis: 0, spine: 1, chest: 2, head: 3,
  armL: 4, foreL: 5, handL: 6,
  armR: 7, foreR: 8, handR: 9,
  thighL: 10, shinL: 11, footL: 12,
  thighR: 13, shinR: 14, footR: 15,
};

const PARENT = [-1, 0, 1, 2, 2, 4, 5, 2, 7, 8, 0, 10, 11, 0, 13, 14];

/** Local rest translation of each bone from its parent. */
const OFFSET = new Float32Array([
  0, 0.94, 0,        // pelvis  (root)
  0, 0.12, 0,        // spine
  0, 0.18, 0,        // chest
  0, 0.20, 0,        // head (neck joint)
  0.190, 0.155, 0,   // armL
  0, -0.28, 0,       // foreL
  0, -0.26, 0,       // handL
  -0.190, 0.155, 0,  // armR
  0, -0.28, 0,       // foreR
  0, -0.26, 0,       // handR
  0.09, -0.02, 0,    // thighL
  0, -0.45, 0,       // shinL
  0, -0.41, 0,       // footL
  -0.09, -0.02, 0,   // thighR
  0, -0.45, 0,       // shinR
  0, -0.41, 0,       // footR
]);

/** World-space rest position of every bone. */
export const REST = (() => {
  const r = new Float32Array(NB * 3);
  for (let b = 0; b < NB; b++) {
    const p = PARENT[b];
    const px = p < 0 ? 0 : r[p * 3], py = p < 0 ? 0 : r[p * 3 + 1], pz = p < 0 ? 0 : r[p * 3 + 2];
    r[b * 3] = px + OFFSET[b * 3];
    r[b * 3 + 1] = py + OFFSET[b * 3 + 1];
    r[b * 3 + 2] = pz + OFFSET[b * 3 + 2];
  }
  return r;
})();

/** Clip order in the animation texture. `clipRow(name)` gives the base row. */
export const CLIPS = ['idle', 'walk', 'jog', 'run', 'sit', 'crouch'];
export const CLIP_ROW = {};
for (let i = 0; i < CLIPS.length; i++) CLIP_ROW[CLIPS[i]] = i * ROWS_PER_CLIP;

/**
 * Ground distance covered by one full two-step cycle of each locomotion clip, at
 * the reference height. Phase rate = speed / (cycleLength * height/REF_HEIGHT),
 * which is what stops the feet skating.
 */
export const CYCLE_LENGTH = { idle: 1, walk: 1.50, jog: 2.10, run: 3.00, sit: 1, crouch: 1.05 };
/** Speed each clip is authored for — used to pick a clip for a given speed. */
export const CLIP_SPEED = { idle: 0, walk: 1.42, jog: 3.10, run: 5.40, sit: 0, crouch: 0.95 };

/* ========================================================================== */
/*  Pose                                                                       */
/* ========================================================================== */

/**
 * Leg keyframes: [phase, hip, knee, ankle] in radians.
 *
 * Sign convention falls out of the rig: every bone's rest axis points down its
 * own -Y, so a positive rotation about local X swings the distal end **forward**
 * (toward -Z). Hip positive = leg forward. Knee negative = flexion (the shin
 * folds backward). Ankle positive = toes up.
 */
const WALK_LEG = [
  [0.00, 0.42, -0.06, 0.02],   // heel strike, leg reaching forward
  [0.12, 0.24, -0.19, -0.10],  // loading, foot flat
  [0.25, 0.04, -0.10, -0.05],  // mid stance, body passing over the foot
  [0.38, -0.20, -0.06, -0.02], // terminal stance, heel lifting
  [0.50, -0.36, -0.62, -0.38], // toe off
  [0.62, -0.10, -1.15, -0.05], // mid swing, peak knee flexion
  [0.75, 0.28, -0.75, 0.10],   // swinging through
  [0.88, 0.46, -0.28, 0.06],   // terminal swing, knee extending
  [1.00, 0.42, -0.06, 0.02],
];
const JOG_LEG = [
  [0.00, 0.55, -0.28, -0.05],
  [0.10, 0.30, -0.48, -0.12],
  [0.22, 0.02, -0.30, -0.06],
  [0.34, -0.32, -0.22, 0.00],
  [0.44, -0.52, -0.75, -0.42],
  [0.56, -0.20, -1.55, -0.20],  // heel tucked up behind
  [0.70, 0.35, -1.35, -0.05],   // knee drive
  [0.85, 0.62, -0.72, 0.02],
  [1.00, 0.55, -0.28, -0.05],
];
const RUN_LEG = [
  [0.00, 0.62, -0.42, -0.08],
  [0.08, 0.34, -0.66, -0.15],
  [0.20, -0.02, -0.40, -0.06],
  [0.32, -0.40, -0.28, 0.02],
  [0.42, -0.62, -0.95, -0.50],
  [0.54, -0.22, -2.05, -0.25],
  [0.68, 0.45, -1.75, -0.10],
  [0.84, 0.78, -0.95, 0.00],
  [1.00, 0.62, -0.42, -0.08],
];
const CROUCH_LEG = [
  [0.00, 0.62, -1.32, 0.38],
  [0.25, 0.34, -1.44, 0.44],
  [0.50, 0.06, -1.30, 0.36],
  [0.75, 0.34, -1.62, 0.50],
  [1.00, 0.62, -1.32, 0.38],
];

const _leg = { hip: 0, knee: 0, ankle: 0 };
function sampleLeg(table, p) {
  p -= Math.floor(p);
  let i = 0;
  while (i < table.length - 2 && table[i + 1][0] <= p) i++;
  const a = table[i], b = table[i + 1];
  const span = b[0] - a[0];
  let t = span > 1e-6 ? (p - a[0]) / span : 0;
  t = t * t * (3 - 2 * t);                       // smoothstep: keyframes are sparse
  _leg.hip = a[1] + (b[1] - a[1]) * t;
  _leg.knee = a[2] + (b[2] - a[2]) * t;
  _leg.ankle = a[3] + (b[3] - a[3]) * t;
  return _leg;
}

const TAU = Math.PI * 2;

/**
 * Evaluate one clip at phase `p`, writing Euler XYZ per bone into `rot`
 * (length NB*3) and a root translation offset into `root` (length 3).
 */
function poseAt(clip, p, rot, root) {
  rot.fill(0); root[0] = root[1] = root[2] = 0;
  const th = p * TAU;
  const set = (b, x, y, z) => { rot[b * 3] = x; rot[b * 3 + 1] = y; rot[b * 3 + 2] = z; };

  if (clip === 'sit') {
    const br = Math.sin(th) * 0.010;
    set(BONE.pelvis, -0.10, 0, 0);
    set(BONE.spine, -0.02 + br, 0, 0);
    set(BONE.chest, -0.04 + br, 0, 0);
    set(BONE.head, 0.10, 0, 0);
    for (const s of [1, -1]) {
      const arm = s > 0 ? BONE.armL : BONE.armR;
      const fore = s > 0 ? BONE.foreL : BONE.foreR;
      const hand = s > 0 ? BONE.handL : BONE.handR;
      set(arm, 0.62, 0, s * 0.30);
      set(fore, 1.16, 0, s * -0.16);
      set(hand, 0.30, 0, 0);
      const thigh = s > 0 ? BONE.thighL : BONE.thighR;
      const shin = s > 0 ? BONE.shinL : BONE.shinR;
      const foot = s > 0 ? BONE.footL : BONE.footR;
      set(thigh, 1.46, 0, s * 0.10);
      set(shin, -1.30, 0, 0);
      set(foot, -0.14, 0, 0);
    }
    return;
  }

  if (clip === 'idle') {
    const breathe = Math.sin(th);
    const sway = Math.sin(th * 0.5);
    root[0] = sway * 0.007;
    root[1] = -0.004 + breathe * 0.004;
    set(BONE.pelvis, 0, sway * 0.022, sway * -0.012);
    set(BONE.spine, 0.030 + breathe * 0.010, sway * -0.014, 0);
    set(BONE.chest, 0.018 + breathe * 0.012, sway * -0.020, 0);
    set(BONE.head, -0.020 - breathe * 0.008, sway * 0.030, 0);
    for (const s of [1, -1]) {
      const arm = s > 0 ? BONE.armL : BONE.armR;
      const fore = s > 0 ? BONE.foreL : BONE.foreR;
      set(arm, 0.03 + breathe * 0.012 * s, 0, s * 0.20);
      set(fore, 0.22 + breathe * 0.020, 0, 0);
      const thigh = s > 0 ? BONE.thighL : BONE.thighR;
      const shin = s > 0 ? BONE.shinL : BONE.shinR;
      const foot = s > 0 ? BONE.footL : BONE.footR;
      set(thigh, 0.015, s * 0.05, s * 0.02);
      set(shin, -0.055, 0, 0);
      set(foot, 0.010, s * 0.10, 0);
    }
    return;
  }

  // -- locomotion ----------------------------------------------------------
  let table = WALK_LEG, armK = 0.62, elbow0 = 0.18, elbowK = 0.55;
  let lean = 0.035, bobA = 0.020, swayA = 0.020, pelvisTwist = 0.09, chestTwist = 0.12;
  let splay = 0.115, crouch = 0;
  if (clip === 'jog') {
    table = JOG_LEG; armK = 0.78; elbow0 = 0.95; elbowK = 0.55;
    lean = 0.105; bobA = 0.036; swayA = 0.016; pelvisTwist = 0.13; chestTwist = 0.18;
    splay = 0.12;
  } else if (clip === 'run') {
    table = RUN_LEG; armK = 0.92; elbow0 = 1.32; elbowK = 0.50;
    lean = 0.175; bobA = 0.050; swayA = 0.012; pelvisTwist = 0.17; chestTwist = 0.24;
    splay = 0.20;
  } else if (clip === 'crouch') {
    table = CROUCH_LEG; armK = 0.34; elbow0 = 0.70; elbowK = 0.30;
    lean = 0.30; bobA = 0.012; swayA = 0.022; pelvisTwist = 0.05; chestTwist = 0.07;
    splay = 0.20; crouch = -0.315;
  }

  const L = sampleLeg(table, p);
  const hipL = L.hip, kneeL = L.knee, ankL = L.ankle;
  const R = sampleLeg(table, p + 0.5);
  const hipR = R.hip, kneeR = R.knee, ankR = R.ankle;

  root[0] = Math.sin(th) * swayA;
  root[1] = crouch - Math.cos(th * 2) * bobA;

  set(BONE.pelvis, -lean * 0.25, Math.sin(th) * pelvisTwist, -Math.sin(th) * 0.05);
  set(BONE.spine, lean * 0.45, Math.sin(th) * -chestTwist * 0.35, 0);
  set(BONE.chest, lean * 0.55, Math.sin(th) * -chestTwist, 0);
  set(BONE.head, -lean * 0.75, Math.sin(th) * chestTwist * 0.55, 0);

  set(BONE.thighL, hipL, 0.03, 0.03);
  set(BONE.shinL, kneeL, 0, 0);
  set(BONE.footL, ankL, 0.08, 0);
  set(BONE.thighR, hipR, -0.03, -0.03);
  set(BONE.shinR, kneeR, 0, 0);
  set(BONE.footR, ankR, 0, 0);

  // Arms counter-swing: the left arm goes forward with the right leg.
  const swingL = -hipL * armK, swingR = -hipR * armK;
  set(BONE.armL, swingL, 0, splay);
  set(BONE.foreL, elbow0 + elbowK * Math.max(0, swingL), 0, -0.06);
  set(BONE.handL, 0.10, 0, 0);
  set(BONE.armR, swingR, 0, -splay);
  set(BONE.foreR, elbow0 + elbowK * Math.max(0, swingR), 0, 0.06);
  set(BONE.handR, 0.10, 0, 0);
}

/* ========================================================================== */
/*  Animation texture                                                          */
/* ========================================================================== */

let _animTex = null;
let _animUniforms = null;

/**
 * Bake every clip into one texture: 3 RGBA texels per bone hold the rows of the
 * 3x4 skinning matrix, one texture row per animation frame.
 *
 * `NearestFilter` is deliberate. Hardware filtering along U would blend adjacent
 * matrix *columns* into nonsense; the shader interpolates between frames itself.
 */
export function animationTexture() {
  if (_animTex) return { texture: _animTex, uniforms: _animUniforms };

  const W = NB * 3, H = CLIPS.length * ROWS_PER_CLIP;
  const data = new Uint16Array(W * H * 4);
  const half = THREE.DataUtils.toHalfFloat;

  const rot = new Float32Array(NB * 3);
  const root = new Float32Array(3);
  const local = []; const world = [];
  for (let i = 0; i < NB; i++) { local.push(new THREE.Matrix4()); world.push(new THREE.Matrix4()); }
  const e = new THREE.Euler(0, 0, 0, 'ZYX');
  const q = new THREE.Quaternion();
  const t = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const skin = new THREE.Matrix4();
  const bindInv = new THREE.Matrix4();

  for (let c = 0; c < CLIPS.length; c++) {
    const clip = CLIPS[c];
    for (let f = 0; f < ROWS_PER_CLIP; f++) {
      // The final row repeats frame 0 so interpolation wraps the loop cleanly.
      poseAt(clip, (f % FRAMES) / FRAMES, rot, root);
      for (let b = 0; b < NB; b++) {
        e.set(rot[b * 3], rot[b * 3 + 1], rot[b * 3 + 2]);
        q.setFromEuler(e);
        t.set(OFFSET[b * 3], OFFSET[b * 3 + 1], OFFSET[b * 3 + 2]);
        if (b === 0) { t.x += root[0]; t.y += root[1]; t.z += root[2]; }
        local[b].compose(t, q, one);
        const p = PARENT[b];
        if (p < 0) world[b].copy(local[b]);
        else world[b].multiplyMatrices(world[p], local[b]);
        bindInv.makeTranslation(-REST[b * 3], -REST[b * 3 + 1], -REST[b * 3 + 2]);
        skin.multiplyMatrices(world[b], bindInv);
        const m = skin.elements;   // column-major
        const row = c * ROWS_PER_CLIP + f;
        for (let r = 0; r < 3; r++) {
          const o = (row * W + b * 3 + r) * 4;
          data[o] = half(m[r]);          // m[r + 0*4]
          data[o + 1] = half(m[4 + r]);
          data[o + 2] = half(m[8 + r]);
          data[o + 3] = half(m[12 + r]);
        }
      }
    }
  }

  _animTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  _animTex.minFilter = _animTex.magFilter = THREE.NearestFilter;
  _animTex.wrapS = _animTex.wrapT = THREE.ClampToEdgeWrapping;
  _animTex.generateMipmaps = false;
  _animTex.needsUpdate = true;
  _animTex.name = 'char_anim';

  _animUniforms = {
    uCharAnim: { value: _animTex },
    uCharAnimSize: { value: new THREE.Vector2(W, H) },
  };
  return { texture: _animTex, uniforms: _animUniforms };
}

/* ========================================================================== */
/*  Geometry                                                                   */
/* ========================================================================== */

/** Vertex zones select which per-instance colour a vertex takes. */
const Z_SKIN = 0, Z_TOP = 1, Z_BOT = 2, Z_SHOE = 3, Z_HAIR = 4, Z_SLEEVE = 5;

class Build {
  constructor() {
    this.pos = []; this.nrm = []; this.bone = []; this.girth = [];
    this.zs = []; this.idx = [];
    this.seed = 12345;
  }
  rnd() {   // deterministic: the mesh must be identical every boot
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  /**
   * Zone and baked shade travel in one float — `zone * 2 + shade`, with shade
   * kept safely inside [0,2). Vertex attribute slots are a scarce resource once
   * instancing has taken four of them for the matrix.
   */
  v(x, y, z, nx, ny, nz, bone, gx, gy, gz, zone, shade) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    const L = Math.hypot(nx, ny, nz) || 1;
    this.nrm.push(nx / L, ny / L, nz / L);
    this.bone.push(bone);
    this.girth.push(gx, gy, gz);
    const s = Math.max(0.05, Math.min(1.95, shade * (0.975 + this.rnd() * 0.05)));
    this.zs.push(zone * 2 + s);
    return i;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  geometry(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aBone', new THREE.Float32BufferAttribute(this.bone, 1));
    g.setAttribute('aGirth', new THREE.Float32BufferAttribute(this.girth, 3));
    g.setAttribute('aZoneShade', new THREE.Float32BufferAttribute(this.zs, 1));
    g.setIndex(this.idx);
    // The vertex shader moves everything, so an authored bounding volume is a
    // lie. Instanced crowd meshes are culled by the system instead.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    g.name = name;
    return g;
  }
}

/**
 * Ambient occlusion, baked per vertex. Nothing sells "rendered plastic" like a
 * limb that is exactly as bright underneath as it is on top.
 */
function shadeFor(nx, ny, nz, y, crease) {
  const up = ny * 0.5 + 0.5;
  const out = Math.abs(nx) * 0.30 + Math.max(0, -nz) * 0.16;
  let s = 0.58 + 0.34 * up + out;
  s *= 1 - crease * 0.42;
  return Math.max(0.42, Math.min(1.06, s));
}

/** A vertical tapered tube. Every limb in the rig is one of these. */
function tube(B, cx, cz, y0, y1, r0, r1, sides, bone, zone, opt = {}) {
  const gs = opt.girth ?? 1;
  const flat = opt.flat ?? 1;          // z-radius multiplier (limbs are not round)
  const crease0 = opt.crease0 ?? 0, crease1 = opt.crease1 ?? 0;
  const slope = (r0 - r1) / Math.max(1e-4, Math.abs(y1 - y0));
  const rings = [];
  for (let k = 0; k < 2; k++) {
    const t = k, y = y0 + (y1 - y0) * t, r = r0 + (r1 - r0) * t;
    const crease = crease0 + (crease1 - crease0) * t;
    const ring = [];
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ca * r, dz = sa * r * flat;
      const nx = ca, nz = sa / Math.max(0.35, flat);
      ring.push(B.v(cx + dx, y, cz + dz, nx, slope * Math.sign(y1 - y0) * 0.6, nz,
        bone, dx * gs, 0, dz * gs, zone,
        shadeFor(nx, slope * 0.6, nz, y, crease)));
    }
    rings.push(ring);
  }
  for (let j = 0; j < sides; j++) {
    const j2 = (j + 1) % sides;
    B.quad(rings[0][j], rings[0][j2], rings[1][j2], rings[1][j]);
  }
  return rings;
}

/**
 * A low-poly ellipsoid — heads, hands and every joint that bends. `phiMax` under
 * PI makes it a cap rather than a full solid, which is how the hair gets to sit
 * on the head without swallowing the face.
 */
function blob(B, cx, cy, cz, rx, ry, rz, sides, rings, bone, zone, opt = {}) {
  const gs = opt.girth ?? 1;
  const crease = opt.crease ?? 0;
  const yBias = opt.yBias ?? 0;
  const phiMax = opt.phiMax ?? Math.PI;
  const closed = phiMax >= Math.PI - 1e-4;
  const grid = [];
  for (let i = 0; i <= rings; i++) {
    const v = i / rings, phi = v * phiMax;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const row = [];
    if (i === 0 || (i === rings && closed)) {
      const y = cy + cp * ry;
      row.push(B.v(cx, y, cz, 0, cp, 0, bone, 0, cp * ry * gs * yBias, 0, zone,
        shadeFor(0, cp, 0, y, crease)));
    } else {
      for (let j = 0; j < sides; j++) {
        const a = (j / sides) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = ca * sp * rx, dy = cp * ry, dz = sa * sp * rz;
        row.push(B.v(cx + dx, cy + dy, cz + dz, ca * sp / rx, cp / ry, sa * sp / rz,
          bone, dx * gs, dy * gs * yBias, dz * gs, zone,
          shadeFor(ca * sp, cp, sa * sp, cy + dy, crease)));
      }
    }
    grid.push(row);
  }
  // Rings run top-to-bottom, so the winding matches `tube`: upper ring first.
  for (let i = 0; i < rings; i++) {
    const a = grid[i], b = grid[i + 1];
    if (a.length === 1) { for (let j = 0; j < b.length; j++) B.tri(a[0], b[(j + 1) % b.length], b[j]); }
    else if (b.length === 1) { for (let j = 0; j < a.length; j++) B.tri(a[j], a[(j + 1) % a.length], b[0]); }
    else for (let j = 0; j < a.length; j++) {
      const j2 = (j + 1) % a.length;
      B.quad(a[j], a[j2], b[j2], b[j]);
    }
  }
}

/**
 * An axis-aligned box. Shoes and hands.
 *
 * `taper` narrows the -Z end (a shoe's toe) in X and drops its top face, while
 * the sole stays flat on the ground — a wedge, not a shrunken cube.
 */
function box(B, cx, cy, cz, hx, hy, hz, bone, zone, opt = {}) {
  const gs = opt.girth ?? 1;
  const crease = opt.crease ?? 0;
  const taper = opt.taper ?? 1;
  const F = [
    [[1, 0, 0], [1, 1, 1], [1, -1, 1], [1, -1, -1], [1, 1, -1]],
    [[-1, 0, 0], [-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]],
    [[0, 1, 0], [1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]],
    [[0, -1, 0], [-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]],
    [[0, 0, 1], [-1, 1, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1]],
    [[0, 0, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1], [-1, 1, -1]],
  ];
  for (const f of F) {
    const n = f[0];
    const q = [];
    for (let k = 1; k <= 4; k++) {
      const s = f[k];
      const front = s[2] < 0;
      const dx = s[0] * hx * (front ? taper : 1);
      const dy = s[1] > 0 ? hy * (front ? 2 * taper - 1 : 1) : -hy;
      const dz = s[2] * hz;
      q.push(B.v(cx + dx, cy + dy, cz + dz, n[0], n[1], n[2], bone,
        dx * gs, 0, dz * gs * 0.35, zone,
        shadeFor(n[0], n[1], n[2], cy + dy, crease)));
    }
    B.quad(q[0], q[1], q[2], q[3]);
  }
}

/**
 * Build the humanoid mesh.
 * @param {number} lod 0 = full (~470 tris, used within ~45 m), 1 = simplified
 *   (~190 tris) for the rest of the crowd.
 */
export function buildCharacterGeometry(lod = 0) {
  const B = new Build();
  const hi = lod === 0;
  const S = hi ? 7 : 5;            // limb sides
  const R = REST;
  const px = (b) => R[b * 3], py = (b) => R[b * 3 + 1];

  // -- torso: one loft, split across pelvis / spine / chest ------------------
  const TORSO = [
    // y,    rx,    rz,   bone,        zone
    [0.855, 0.128, 0.098, BONE.pelvis, Z_BOT],
    [0.905, 0.142, 0.104, BONE.pelvis, Z_TOP],
    [1.000, 0.132, 0.098, BONE.pelvis, Z_TOP],
    [1.060, 0.134, 0.099, BONE.spine, Z_TOP],
    [1.150, 0.152, 0.106, BONE.spine, Z_TOP],
    [1.240, 0.170, 0.113, BONE.chest, Z_TOP],
    [1.345, 0.178, 0.108, BONE.chest, Z_TOP],
    [1.410, 0.150, 0.089, BONE.chest, Z_TOP],
  ];
  const ringsT = [];
  for (let i = 0; i < TORSO.length; i++) {
    const [y, rx, rz, bone, zone] = TORSO[i];
    const ring = [];
    for (let j = 0; j < S + 1; j++) {
      const a = (j / (S + 1)) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ca * rx, dz = sa * rz;
      const ny = i === 0 ? -0.5 : i === TORSO.length - 1 ? 0.5 : 0;
      ring.push(B.v(dx, y, dz, ca / rx, ny, sa / rz, bone,
        dx, 0, dz, zone, shadeFor(ca, ny, sa, y, i === 0 ? 0.35 : 0)));
    }
    ringsT.push(ring);
  }
  // Rings run bottom-to-top here, the reverse of `tube`, so the winding flips.
  for (let i = 0; i < ringsT.length - 1; i++) {
    const a = ringsT[i], b = ringsT[i + 1];
    for (let j = 0; j < a.length; j++) {
      const j2 = (j + 1) % a.length;
      B.quad(a[j], b[j], b[j2], a[j2]);
    }
  }
  const capB = B.v(0, 0.845, 0, 0, -1, 0, BONE.pelvis, 0, 0, 0, Z_BOT, 0.5);
  for (let j = 0; j < ringsT[0].length; j++) {
    B.tri(ringsT[0][j], ringsT[0][(j + 1) % ringsT[0].length], capB);
  }
  const top = ringsT[ringsT.length - 1];
  const capT = B.v(0, 1.425, 0, 0, 1, 0, BONE.chest, 0, 0, 0, Z_TOP, 1.0);
  for (let j = 0; j < top.length; j++) B.tri(top[j], capT, top[(j + 1) % top.length]);

  // -- head ------------------------------------------------------------------
  tube(B, 0, 0, 1.385, 1.475, 0.052, 0.048, hi ? 6 : 4, BONE.head, Z_SKIN,
    { girth: 0.3, crease0: 0.55, crease1: 0.1 });
  blob(B, 0, 1.585, -0.004, 0.093, 0.116, 0.104, hi ? 8 : 5, hi ? 6 : 4,
    BONE.head, Z_SKIN, { girth: 0.22, yBias: 0.2 });
  // Hair. Pushed back and slightly narrower front-to-back than the skull, so its
  // front surface falls *inside* the face and only the crown, temples and back
  // break the surface — an ellipsoid centred on the head would simply paint the
  // whole face brown and every character would read as a featureless egg.
  blob(B, 0, 1.592, 0.023, 0.0995, 0.120, 0.100, hi ? 8 : 5, hi ? 4 : 3,
    BONE.head, Z_HAIR, { girth: 0.2, yBias: 0.2, crease: 0.1, phiMax: Math.PI * 0.70 });

  // -- limbs -----------------------------------------------------------------
  for (const s of [1, -1]) {
    const arm = s > 0 ? BONE.armL : BONE.armR;
    const fore = s > 0 ? BONE.foreL : BONE.foreR;
    const hand = s > 0 ? BONE.handL : BONE.handR;
    const thigh = s > 0 ? BONE.thighL : BONE.thighR;
    const shin = s > 0 ? BONE.shinL : BONE.shinR;
    const foot = s > 0 ? BONE.footL : BONE.footR;
    const ax = px(arm), lx = px(thigh);

    // shoulder ball — fills the armpit and stops the deltoid tearing on swing
    if (hi) blob(B, ax, py(arm), 0, 0.062, 0.062, 0.058, 6, 4, arm, Z_TOP, { girth: 1, crease: 0.3 });
    tube(B, ax, 0, py(arm), py(fore), 0.052, 0.041, S, arm, Z_TOP,
      { flat: 0.92, crease0: 0.3 });
    if (hi) blob(B, ax, py(fore), 0, 0.043, 0.043, 0.041, 6, 3, fore, Z_SLEEVE, { girth: 1 });
    tube(B, ax, 0, py(fore), py(hand) + 0.01, 0.042, 0.032, S, fore, Z_SLEEVE, { flat: 0.9 });
    box(B, ax, py(hand) - 0.035, -0.004, 0.030, 0.050, 0.021, hand, Z_SKIN,
      { girth: 0.6, crease: 0.2 });

    // hip ball, thigh, knee ball, shin, shoe
    if (hi) blob(B, lx, py(thigh), 0, 0.082, 0.078, 0.078, 6, 4, thigh, Z_BOT, { girth: 1, crease: 0.35 });
    tube(B, lx, 0, py(thigh), py(shin), 0.086, 0.062, S, thigh, Z_BOT,
      { flat: 0.94, crease0: 0.4 });
    if (hi) blob(B, lx, py(shin), 0, 0.062, 0.060, 0.060, 6, 3, shin, Z_BOT, { girth: 1 });
    tube(B, lx, 0, py(shin), py(foot) + 0.015, 0.061, 0.040, S, shin, Z_BOT, { flat: 0.9 });
    // The sole sits exactly on y = 0 and the shoe top overlaps the shin tube, so
    // no ring gap can open at the ankle when the foot rotates.
    box(B, lx, 0.040, -0.046, 0.046, 0.040, 0.116, foot, Z_SHOE,
      { girth: 0.45, crease: 0.25, taper: 0.80 });
  }

  return B.geometry(lod === 0 ? 'character_lod0' : 'character_lod1');
}

/* ========================================================================== */
/*  Material                                                                   */
/* ========================================================================== */

const DECL = /* glsl */`
attribute float aBone;
attribute vec3  aGirth;
attribute float aZoneShade;   // zone * 2 + baked ambient occlusion
attribute vec4  aAnim;     // clipRowBase, phase 0..1, build, seed
attribute vec3  aTop;
attribute vec3  aBot;
attribute vec3  aSkin;
uniform sampler2D uCharAnim;
uniform vec2 uCharAnimSize;
varying vec4 vChar;        // rgb tint, a roughness multiplier

mat4 charBone(float row, float bone) {
  float u = (bone * 3.0 + 0.5) / uCharAnimSize.x;
  float du = 1.0 / uCharAnimSize.x;
  float v = (row + 0.5) / uCharAnimSize.y;
  vec4 r0 = texture2D(uCharAnim, vec2(u, v));
  vec4 r1 = texture2D(uCharAnim, vec2(u + du, v));
  vec4 r2 = texture2D(uCharAnim, vec2(u + du * 2.0, v));
  return mat4(r0.x, r1.x, r2.x, 0.0,
              r0.y, r1.y, r2.y, 0.0,
              r0.z, r1.z, r2.z, 0.0,
              r0.w, r1.w, r2.w, 1.0);
}
`;

const SKIN = /* glsl */`
  float _fr = aAnim.y * ${FRAMES}.0;
  float _f0 = floor(_fr);
  float _ft = _fr - _f0;
  mat4 _mA = charBone(aAnim.x + _f0, aBone);
  mat4 _mB = charBone(aAnim.x + _f0 + 1.0, aBone);
  mat4 _bm = _mA * (1.0 - _ft) + _mB * _ft;
  vec3 _p = position + aGirth * (aAnim.z - 1.0);
  vec3 _skinned = (_bm * vec4(_p, 1.0)).xyz;
`;

const TINT = /* glsl */`
  float _zone  = floor(aZoneShade * 0.5);
  float _shade = aZoneShade - _zone * 2.0;
  vec3 _tint; float _rough;
  float _sd = fract(aAnim.w * 13.17);
  if (_zone < 0.5)      { _tint = aSkin;                     _rough = 0.74; }
  else if (_zone < 1.5) { _tint = aTop;                      _rough = 1.06; }
  else if (_zone < 2.5) { _tint = aBot;                      _rough = 1.02; }
  else if (_zone < 3.5) { _tint = aBot * 0.22 + vec3(0.012); _rough = 0.62; }
  else if (_zone < 4.5) { _tint = mix(vec3(0.016, 0.011, 0.008),
                                      vec3(0.155, 0.092, 0.040),
                                      fract(aAnim.w * 4.31)); _rough = 0.88; }
  else                  { _tint = _sd < 0.24 ? aSkin * 0.94 : aTop;
                          _rough = _sd < 0.24 ? 0.74 : 1.06; }
  vChar = vec4(_tint * _shade, _rough);
`;

/** Stable identity + idempotent, per the recursion incident in AI_HANDOFF.md. */
function charBeforeCompile(shader) {
  if (shader.__charPatched) return;
  shader.__charPatched = true;
  shader.uniforms.uCharAnim = _animUniforms.uCharAnim;
  shader.uniforms.uCharAnimSize = _animUniforms.uCharAnimSize;
  shader.vertexShader = DECL + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <beginnormal_vertex>',
    SKIN + TINT + 'vec3 objectNormal = normalize(mat3(_bm) * normal);');
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>', 'vec3 transformed = _skinned;');
  shader.fragmentShader = 'varying vec4 vChar;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\ndiffuseColor.rgb *= vChar.rgb;');
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <roughnessmap_fragment>',
    '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * vChar.a, 0.05, 1.0);');
}

function charDepthBeforeCompile(shader) {
  if (shader.__charPatched) return;
  shader.__charPatched = true;
  shader.uniforms.uCharAnim = _animUniforms.uCharAnim;
  shader.uniforms.uCharAnimSize = _animUniforms.uCharAnimSize;
  shader.vertexShader = DECL.replace('varying vec4 vChar;', '') + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>', SKIN + 'vec3 transformed = _skinned;');
}

let _charMat = null, _charDepth = null, _refs = 0;

/** The one material every character in the world shares — so, one program. */
export function characterMaterials(ctx) {
  _refs++;
  if (_charMat) return { material: _charMat, depth: _charDepth };
  animationTexture();

  _charMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.86, metalness: 0.0,
    name: 'ped_body',              // must not match Lighting's /facade|building/ adopter
    dithering: true,
  });
  _charMat.userData.wetnessRough = 0.86;
  _charMat.userData.wetnessColor = _charMat.color.clone();
  _charMat.onBeforeCompile = charBeforeCompile;

  _charDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  _charDepth.name = 'ped_depth';
  _charDepth.onBeforeCompile = charDepthBeforeCompile;

  ctx?.assets?.materials?.set?.('ped_body', _charMat);
  return { material: _charMat, depth: _charDepth };
}

/* ========================================================================== */
/*  Crowd mesh                                                                 */
/* ========================================================================== */

const _mtx = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * An `InstancedMesh` of characters. Refilled from scratch every frame — writing
 * a few thousand floats is far cheaper than tracking which slot holds whom, and
 * it means LOD reassignment is free.
 */
export class CrowdMesh {
  /**
   * @param {number} lod 0 full, 1 simplified
   * @param {number} cap maximum simultaneous characters in this mesh
   */
  constructor(ctx, lod, cap, { castShadow = false, name = 'crowd' } = {}) {
    const { material, depth } = characterMaterials(ctx);
    this.geometry = buildCharacterGeometry(lod);
    this.cap = cap;
    this.n = 0;

    this.aAnim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aTop = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aBot = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aSkin = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [this.aAnim, this.aTop, this.aBot, this.aSkin]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aAnim', this.aAnim);
    this.geometry.setAttribute('aTop', this.aTop);
    this.geometry.setAttribute('aBot', this.aBot);
    this.geometry.setAttribute('aSkin', this.aSkin);

    this.mesh = new THREE.InstancedMesh(this.geometry, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;         // the shader moves every vertex
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = depth;
    this.mesh.count = 0;
    this.mesh.name = name;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  begin() { this.n = 0; }

  /**
   * Add one character. `a` carries its own transform, clip and palette; nothing
   * here allocates.
   */
  push(a) {
    const i = this.n;
    if (i >= this.cap) return false;
    this.n++;
    _pos.set(a.x, a.y, a.z);
    _eul.set(a.tilt || 0, a.yaw, a.lean || 0);
    _quat.setFromEuler(_eul);
    const s = a.h / REF_HEIGHT;
    _scl.set(s, s, s);
    _mtx.compose(_pos, _quat, _scl);
    this.mesh.setMatrixAt(i, _mtx);
    const an = this.aAnim.array, o4 = i * 4;
    an[o4] = a.clipRow; an[o4 + 1] = a.phase; an[o4 + 2] = a.build; an[o4 + 3] = a.seed;
    const o3 = i * 3;
    const t = this.aTop.array, b = this.aBot.array, k = this.aSkin.array;
    t[o3] = a.topR; t[o3 + 1] = a.topG; t[o3 + 2] = a.topB;
    b[o3] = a.botR; b[o3 + 1] = a.botG; b[o3 + 2] = a.botB;
    k[o3] = a.skinR; k[o3 + 1] = a.skinG; k[o3 + 2] = a.skinB;
    return true;
  }

  end() {
    this.mesh.count = this.n;
    if (!this.n) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aAnim.needsUpdate = true; this.aTop.needsUpdate = true;
    this.aBot.needsUpdate = true; this.aSkin.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.mesh.dispose();
    releaseCharacterAssets();
  }
}

/* ========================================================================== */
/*  Appearance                                                                 */
/* ========================================================================== */

const _c = new THREE.Color();

/** Six plausible skin tones, sRGB. */
const SKIN_TONES = [0xf2d3bd, 0xe2b899, 0xc99a72, 0xa9764f, 0x7a5136, 0x4d3222];
/**
 * Outerwear. Boston dresses dark — navy, charcoal, black, olive — and the
 * weighting matters more than the hues: an evenly sampled palette with four
 * light entries in it puts a quarter of the crowd in near-white and the street
 * reads as a lab, not a city. Dark entries are repeated to bias the draw.
 */
const TOP_COLORS = [
  0x232733, 0x232733, 0x1b1f26, 0x1b1f26, 0x16181d, 0x2f3a47, 0x2f3a47,
  0x3b3f46, 0x3b3f46, 0x1f3d52, 0x35476b, 0x2f4a3a, 0x2a2a2e, 0x3a2c28,
  0x545a63, 0x6d3f39, 0x4a2f4a, 0x24352b, 0x5a3b22,
  0x7d848c, 0x8c3b32, 0x7a6a52, 0x8f5a2b, 0x9aa2ab, 0xb5b0a4, 0xc8c3b6,
];
const BOT_COLORS = [
  0x1e2229, 0x262b34, 0x333941, 0x3d4550, 0x2c3a4e, 0x4a4438, 0x5a5346,
  0x21252b, 0x45505e, 0x6b6154, 0x2a2a2a, 0x38343a,
];

/**
 * Fill an actor's appearance fields from a 0..1 random source.
 * Called on spawn only; per-frame code just copies the floats out.
 */
export function dressActor(a, rnd) {
  a.h = 1.54 + rnd() * 0.36;                        // 1.54 - 1.90 m
  if (rnd() < 0.06) a.h = 1.16 + rnd() * 0.22;      // children
  a.build = 0.86 + rnd() * 0.40;
  a.seed = rnd();
  _c.setHex(SKIN_TONES[(rnd() * SKIN_TONES.length) | 0]);
  a.skinR = _c.r; a.skinG = _c.g; a.skinB = _c.b;
  _c.setHex(TOP_COLORS[(rnd() * TOP_COLORS.length) | 0]);
  const jt = 0.86 + rnd() * 0.28;
  a.topR = _c.r * jt; a.topG = _c.g * jt; a.topB = _c.b * jt;
  _c.setHex(BOT_COLORS[(rnd() * BOT_COLORS.length) | 0]);
  const jb = 0.88 + rnd() * 0.24;
  a.botR = _c.r * jb; a.botG = _c.g * jb; a.botB = _c.b * jb;
  return a;
}

/** Choose a locomotion clip for a ground speed, and the phase rate that suits it. */
export function clipForSpeed(v, crouching) {
  if (crouching) return 'crouch';
  if (v < 0.22) return 'idle';
  if (v < 2.30) return 'walk';
  if (v < 4.30) return 'jog';
  return 'run';
}

/** Cycles per second for a character of height `h` moving at `v` on `clip`. */
export function phaseRate(clip, v, h) {
  if (clip === 'idle') return 0.24;
  if (clip === 'sit') return 0.20;
  const len = CYCLE_LENGTH[clip] * (h / REF_HEIGHT);
  return Math.min(3.4, Math.max(0.12, v / len));
}

/**
 * Drop one claim on the shared material/texture. They are freed when the last
 * `CrowdMesh` goes, so peds and player can be disposed in either order.
 */
export function releaseCharacterAssets() {
  if (--_refs > 0) return;
  _refs = 0;
  _charMat?.dispose(); _charDepth?.dispose(); _animTex?.dispose();
  _charMat = _charDepth = _animTex = _animUniforms = null;
}
