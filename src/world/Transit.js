import * as THREE from 'three';
import { MeshBuf, makeOpaqueMaterial } from './BuildingKit.js';
import RoadNetwork from './RoadNetwork.js';
import { GROUP, groups } from '../physics/PhysicsWorld.js';

/**
 * Green Line E surface infrastructure, in the Huntington reservation.
 *
 * Wave B2A gave the road a central reserved median and proved that nothing
 * drives in it. This puts the railway in it: two tracks and a sparse centre-pole
 * catenary along the reserved span, sharing the building atlas and material so
 * the whole railway costs one draw call and no new texture.
 *
 * ## What is factual and what is authored
 *
 * FACTUAL. That there is a two-track surface reservation on Huntington past
 * Northeastern, that the E runs on it, and that standard gauge is 1.435 m.
 * `docs/neu/GREEN_LINE_E.json` carries the MBTA-sourced station and platform
 * anchors and the licence trail.
 *
 * PROJECT-AUTHORED LOCAL TRACK ALIGNMENT, ANCHORED TO THE FACTUAL HUNTINGTON
 * CORRIDOR. The MBTA's own route shape is a single coarse polyline -- 8 vertices
 * across 320 m -- shared by both directions, so it cannot supply two track
 * centres at all, and measured against this project's Huntington it sits a
 * systematic 5.9 m to one side (median over 1.2 km, all one sign). That offset is
 * the known road-position error recorded in `docs/neu/GAPS.json`, not a discovery
 * about the median, and it is far larger than the geometry being placed. So the
 * tracks are laid symmetrically about the corridor centre, which B2A established
 * as the reservation, and the centre-to-centre spacing is authored.
 *
 * ## No platforms
 *
 * Deliberately. Two tracks plus two side platforms need 10.25 m of reservation
 * and there are 7.00 m: the width left for a platform inside the reservation is
 * 0.38 m. The arithmetic is in `GREEN_LINE_E.json`. A station needs the
 * reservation to widen locally with kerbside parking suspended, which is what
 * real stops do and what "the median widens to 48 ft" describes -- and B2A's
 * median is per EDGE, while the frontage edge is 389 m long and carries the
 * parking bay the starter SUV resolves against. Sub-edge granularity is the
 * missing capability, and inventing a 0.38 m platform to avoid saying so would be
 * worse than the gap.
 *
 * A reservation carrying rails and wire with no stop is not incoherent: the stop
 * is one point on 1.2 km of railway.
 */

/** Rail-to-rail, ONE track. Standard gauge; the MBTA Green Line is standard. */
const GAUGE = 1.435;
/**
 * Track centre-to-centre. AUTHORED, not measured: the MBTA route shape is one
 * polyline for both directions and cannot yield two centres. 3.40 m is ordinary
 * for street-running light rail and it keeps the outer rail at 2.42 m, inside the
 * reservation's 3.50 m half-width with a metre to spare.
 */
const TRACK_CTR = 3.40;
const RAIL_W = 0.075;        // head width, m
const RAIL_H = 0.14;         // head above the reservation surface, m
const POLE_EVERY = 30;       // m between catenary masts
const POLE_H = 6.4;          // m
const WIRE_H = 5.6;          // contact wire height above the surface, m
const STEP = 12;             // m between rail stations, matching the road ribbon

/**
 * Platform edge to TRACK CENTRE: 4'-9" on tangent track, from the MBTA's own
 * light rail design criteria (GLX Design Criteria Manual, 2014). Note the datum
 * -- from the track centre, not from the rail: measured from the nearer rail the
 * same clearance is 1.4478 - 0.7175 = 0.7303 m, and quoting a setback without
 * saying which it is has already cost this project one wrong cross-section.
 */
const PLAT_SETBACK = 1.4478;
/** Platform width. AUTHORED: no MBTA extent for this stop exists. */
const PLAT_W = 2.00;
/**
 * Shy offset between the platform's back face and the travelled lane's edge.
 * AUTHORED. Without it the deck fills the reservation and a raised 0.34 m face
 * stands on the lane line for 46 m at a time; the road section is declared wide
 * enough to pay for it, and this is where the deck gives it back.
 */
const PLAT_BUFFER = 0.45;
/**
 * Platform surface above TOP OF RAIL. 8 inches, again from the GLX criteria,
 * which record 8" now and 14" "in the future ... to accommodate level boarding
 * into the Type 9 LRVs". Northeastern is not that future: the MBTA's own
 * facility data for this stop lists a PORTABLE_BOARDING_LIFT per direction, one
 * of which is the definition of a stop without level boarding. So: 8 inches.
 */
const PLAT_ATR = 0.2032;
const RAMP_RUN = 4.2;        // m of end ramp, about 1:12 for a 0.34 m rise
/**
 * Metres the ramp's toe is sunk INTO the reservation it lands on.
 *
 * A ramp whose toe stops exactly at the surface presents a knife edge, and a
 * capsule controller arriving along the surface catches on it: measured, the
 * player stood still for 150 frames at s=246.1, grounded, 23 mm up, against a
 * ramp that was geometrically flush to 0.2 mm. Burying the toe means the capsule
 * first meets the ramp where it is already proud of the ground, with a slope
 * normal instead of a vertical sliver. `Roads.VERGE_BURY` is the same 0.06 m for
 * the same reason at the top of the graded verge.
 */
const RAMP_BURY = 0.06;
const TACTILE_W = 0.55;      // m of warning strip along the platform edge
const SHELTER_L = 6.0;       // m
const SHELTER_H = 2.55;      // m to the underside of the canopy
const SIGN_H = 2.30;         // m to the middle of the name panel

const COL = {
  rail:   [0.56, 0.57, 0.59],
  wire:   [0.30, 0.31, 0.33],
  pole:   [0.52, 0.53, 0.52],
  bracket:[0.44, 0.45, 0.46],
  plat:   [0.615, 0.610, 0.596],   // ordinary broom-finished concrete
  platEdge:[0.740, 0.726, 0.680],  // the warning strip, worn buff
  kerbFace:[0.560, 0.556, 0.545],
  shelter:[0.315, 0.322, 0.318],
  canopy: [0.665, 0.672, 0.668],   // pale metal, so the roof is not a dark slab
  glass:  [0.72, 0.76, 0.75],
  green:  [0.000, 0.516, 0.239],   // #00843D, the Green Line's own colour
  signBack:[0.140, 0.145, 0.148],
};

export default class Transit {
  static id = 'transit';
  static label = 'Green Line E surface infrastructure';
  static deps = ['assets'];

  constructor() {
    this.meshes = [];
    this.stats = null;
    this._ownsMaterial = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    const city = ctx.get('city');
    if (!city?.net || !city.roads?.sample) return;

    // Share the building atlas and material. A railway that needed its own
    // material would cost a draw call per chunk for the whole street.
    const b = ctx.get('buildings');
    if (b?.matOpaque) {
      this.matOpaque = b.matOpaque;
    } else {
      const a = ctx.get('assets');
      const nh = ctx.get('neuHero');
      if (nh?.matOpaque) this.matOpaque = nh.matOpaque;
      else {
        this.matOpaque = makeOpaqueMaterial(a?.atlas, a?.rooms, a?.macro);
        this._ownsMaterial = true;
      }
    }

    const mb = new MeshBuf(16384);
    const root = new THREE.Group();
    root.name = 'transit';

    let railTris = 0, poleTris = 0, wireTris = 0, spans = 0, metres = 0, poles = 0;
    let platTris = 0, platforms = 0, colliders = 0, lights = 0;
    this._bodies = []; this._lights = [];
    this._physics = ctx.physics ?? ctx.get('physics');
    this._lighting = ctx.get('lighting');
    this._onCollider = () => { colliders++; };
    this._onLight = () => { lights++; };
    const surf = (x, z, nearY) => city.surfaceHeight(x, z, nearY);

    for (const e of city.net.edges) {
      const M = e.median || 0;
      if (M <= 0) continue;
      spans++;
      metres += e.length;
      const half = TRACK_CTR / 2;
      const rails = [-half - GAUGE / 2, -half + GAUGE / 2, half - GAUGE / 2, half + GAUGE / 2];
      const n = Math.max(2, Math.round(e.length / STEP));
      // One frame per station: position, tangent and the right-hand normal, all
      // from the published road sampler so the railway follows the same curve the
      // carriageway does rather than a chord of its own.
      const F = [];
      for (let i = 0; i <= n; i++) {
        const s = city.roads.sample(e.id, i / n);
        const h = s.heading;
        F.push({ x: s.x, z: s.z, y: s.y, dx: Math.sin(h), dz: -Math.cos(h),
                 rx: Math.cos(h), rz: Math.sin(h) });
      }
      const at = (f, o) => [f.x + f.rx * o, f.z + f.rz * o];

      // --- rails: four continuous lines of head, one box per station ---------
      const before0 = mb.ni;
      for (const o of rails) {
        for (let i = 0; i < F.length - 1; i++) {
          const a = at(F[i], o), c = at(F[i + 1], o);
          const mx = (a[0] + c[0]) * 0.5, mz = (a[1] + c[1]) * 0.5;
          const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
          if (L < 0.05) continue;
          const rot = Math.atan2(c[0] - a[0], c[1] - a[1]);
          const y = surf(mx, mz, F[i].y) + RAIL_H * 0.5;
          // `sz` is the run so the box lies ALONG the rail; `rotY` from the same
          // atan2(dx, dz) the road uses, so a curve reads as a polyline of heads
          // rather than a row of crosswise sleepers.
          mb.box(mx, y, mz, RAIL_W, RAIL_H, L + 0.04, rot, 'metal_dark', COL.rail);
        }
      }
      railTris += mb.ni - before0;

      // --- catenary: centre masts with a bracket over each track ------------
      const before1 = mb.ni;
      const every = Math.max(1, Math.round(POLE_EVERY / (e.length / n)));
      for (let i = 0; i < F.length; i += every) {
        const f = F[i];
        const base = surf(f.x, f.z, f.y);
        // `mb.box` puts +local z along `(sin rotY, cos rotY)`, so a bracket that
        // has to reach ACROSS the tracks wants its long axis on z with
        // `rotY = atan2(rx, rz)` -- the same relationship the rails use with the
        // tangent. Putting the length on local x instead points it down the track.
        const across = Math.atan2(f.rx, f.rz);
        mb.box(f.x, base + POLE_H * 0.5, f.z, 0.22, POLE_H, 0.22, across, 'concrete', COL.pole);
        // One bracket arm over both tracks. The mast stands on the reservation
        // centreline between the tracks, which is only viable because the authored
        // 3.40 m spacing leaves 1.59 m from track centre to the mast face against
        // a 1.43 m vehicle envelope -- 0.16 m, and the reason centre-pole
        // reservations are spaced the way they are.
        mb.box(f.x, base + WIRE_H + 0.30, f.z, 0.12, 0.12, TRACK_CTR + 0.7,
          across, 'metal_dark', COL.bracket);
        poles++;
      }
      poleTris += mb.ni - before1;

      // --- contact wire: one per track --------------------------------------
      const before2 = mb.ni;
      for (const o of [-half, half]) {
        for (let i = 0; i < F.length - 1; i++) {
          const a = at(F[i], o), c = at(F[i + 1], o);
          const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
          if (L < 0.05) continue;
          const mx = (a[0] + c[0]) * 0.5, mz = (a[1] + c[1]) * 0.5;
          const rot = Math.atan2(c[0] - a[0], c[1] - a[1]);
          const y = surf(mx, mz, F[i].y) + WIRE_H;
          mb.box(mx, y, mz, 0.05, 0.05, L + 0.02, rot, 'metal_dark', COL.wire);
        }
      }
      wireTris += mb.ni - before2;

      // --- platforms, where a local station section widened the reservation --
      const before3 = mb.ni;
      for (const q of e.sections || []) {
        for (const pf of q.platforms || []) {
          this._platform(mb, city, e, q, pf, F, at);
          platforms++;
        }
      }
      platTris += mb.ni - before3;
    }

    const geom = mb.build();
    if (geom) {
      const m = new THREE.Mesh(geom, this.matOpaque);
      // Rails and wire cast almost nothing and the wire self-shadows badly at
      // this thickness, so neither casts. The reservation already receives.
      m.castShadow = false; m.receiveShadow = true;
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.name = 'transit_green_line_e';
      root.add(m);
      this.meshes.push(m);
    }
    ctx.scene.add(root);
    this.root = root;

    this.stats = {
      spans, metres: +metres.toFixed(0), poles,
      railTris: railTris / 3, poleTris: poleTris / 3, wireTris: wireTris / 3,
      platTris: platTris / 3,
      tris: geom ? geom.index.count / 3 : 0,
      draws: geom ? 1 : 0,
      gauge: GAUGE, trackCentres: TRACK_CTR,
      platformSetback: PLAT_SETBACK, platformWidth: PLAT_W,
      platformAboveRail: PLAT_ATR,
      colliders, lights, platforms,
      note: platforms
        ? `${platforms} side platforms on the widened station section; setback `
          + `${PLAT_SETBACK} m from track centre and ${PLAT_ATR} m over top of rail, `
          + 'both from the MBTA GLX Design Criteria Manual'
        : 'no platforms: nothing declared a station section on a median edge',
    };
    console.info(`[transit] Green Line E: ${spans} reserved spans, ${metres | 0} m, `
      + `${poles} masts, ${platforms} platforms, ${(this.stats.tris) | 0} tris, `
      + `${this.stats.draws} draw, ${colliders} colliders`);
  }

  /**
   * One side platform, on the reservation widened for it.
   *
   * The cross-section is the MBTA's, not this project's: the deck runs from
   * 1.4478 m outboard of its track centre -- their 4'-9" -- to the reservation
   * edge, which the section put at half of 10.30 m. That is 2.00 m of platform by
   * construction rather than by choice, and if the declared width ever stops
   * agreeing with the declared reservation the platform gets NARROWER instead of
   * hanging over a rail.
   *
   * The deck is 8 inches above top of rail, so a train's floor is a step up, not
   * level. That is the honest reading of the MBTA's own facility record for this
   * stop, which lists a portable boarding lift for each direction.
   */
  _platform(mb, city, e, q, pf, F, atF) {
    const sd = pf.side;
    const inner = TRACK_CTR / 2 + PLAT_SETBACK;          // 3.1478 m
    const at = (d) => {
      const s = city.roads.sample(e.id, Math.max(0, Math.min(1, d / e.length)));
      const h = s.heading;
      return { x: s.x, z: s.z, y: s.y, rx: Math.cos(h), rz: Math.sin(h),
               dx: Math.sin(h), dz: -Math.cos(h) };
    };
    const surf = (x, z, nearY) => city.surfaceHeight(x, z, nearY);
    // Outer edge is the reservation edge THE ROAD PUBLISHES, sampled locally, so
    // the deck can never be wider than the band that was widened for it.
    const outerAt = (d) => {
      const loc = RoadNetwork.sectionAt(e, d);
      const res = (loc ? loc.median : (e.median || 0)) / 2;
      // The deck is PLAT_W wide, or whatever the reservation leaves after the shy
      // offset if that is less. It shrinks rather than overhanging a rail or
      // standing on the lane line, and it says so.
      const room = res - PLAT_BUFFER;
      if (room < inner + PLAT_W - 1e-6 && !this._warnedNarrow) {
        this._warnedNarrow = true;
        console.warn(`[transit] platform on edge ${e.id} narrowed to `
          + `${(room - inner).toFixed(2)} m: a ${PLAT_W} m deck plus a `
          + `${PLAT_BUFFER} m shy offset needs ${((inner + PLAT_W + PLAT_BUFFER) * 2).toFixed(2)} m `
          + `of reservation and there are ${(res * 2).toFixed(2)}`);
      }
      return Math.max(inner + 0.4, Math.min(inner + PLAT_W, room));
    };

    const s0 = pf.s0, s1 = pf.s1, L = s1 - s0;
    const STEPS = Math.max(6, Math.round(L / 3));
    const deckTop = RAIL_H + PLAT_ATR;                   // 0.3432 m over the surface

    // --- deck, in short runs so it follows the curve and the local width ----
    for (let i = 0; i < STEPS; i++) {
      const da = s0 + (L * i) / STEPS, db = s0 + (L * (i + 1)) / STEPS;
      const dm = (da + db) * 0.5;
      const f = at(dm);
      const o = outerAt(dm);
      const mid = (inner + o) * 0.5 * sd, wid = o - inner;
      const cx = f.x + f.rx * mid, cz = f.z + f.rz * mid;
      const run = db - da;
      const rot = Math.atan2(f.dx, f.dz);
      // Ramp the last RAMP_RUN at each end down to the reservation, so neither
      // end is a 0.34 m wall across a surface people and rails cross.
      const eDist = Math.min(dm - s0, s1 - dm);
      const hgt = deckTop * Math.min(1, eDist / RAMP_RUN);
      const base = surf(cx, cz, f.y);
      mb.box(cx, base + hgt * 0.5, cz, wid, Math.max(0.03, hgt), run + 0.03,
        rot, 'concrete', COL.plat);
      // Warning strip along the platform edge, the one cue that reads as
      // "stand back" at any distance. Proud by 12 mm, like a real tactile.
      const tx = f.x + f.rx * (inner + TACTILE_W * 0.5) * sd;
      const tz = f.z + f.rz * (inner + TACTILE_W * 0.5) * sd;
      mb.box(tx, base + hgt + 0.006, tz, TACTILE_W, 0.012, run + 0.03,
        rot, 'concrete', COL.platEdge);
      // A distinct kerb face on the track side. Without it the deck's front is
      // the same concrete as its top and the platform reads as paint at any
      // distance where the 0.34 m rise is a few pixels -- which is most of them.
      if (hgt > 0.05) {
        const kx = f.x + f.rx * (inner + 0.035) * sd;
        const kz = f.z + f.rz * (inner + 0.035) * sd;
        mb.box(kx, base + hgt * 0.5, kz, 0.07, hgt, run + 0.03,
          rot, 'granite', COL.kerbFace);
      }
    }

    // --- collision: one box for the level deck, one sloped box per ramp -----
    const P = this._physics;
    if (P?.addBox) {
      const lvl0 = s0 + RAMP_RUN, lvl1 = s1 - RAMP_RUN;
      const mkBox = (da, db, y0, y1) => {
        const dm = (da + db) * 0.5, f = at(dm), o = outerAt(dm);
        const mid = (inner + o) * 0.5 * sd;
        const cx = f.x + f.rx * mid, cz = f.z + f.rz * mid;
        const base = surf(cx, cz, f.y);
        const run = db - da, rise = y1 - y0;
        const pitch = Math.atan2(rise, run);
        const len = Math.hypot(run, rise);
        const yaw = Math.atan2(f.dx, f.dz);
        // Yaw about +Y to lie along the track, then pitch about the platform's
        // own cross-axis so a ramp is a real slope for the controller rather
        // than the flight of 50 mm steps the visual is made of.
        const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const qp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
        const rot = qy.multiply(qp);
        const half = { x: (o - inner) / 2, y: 0.09, z: len / 2 };
        const cy = base + (y0 + y1) / 2 - 0.09 * Math.cos(pitch);
        const b = P.addBox(half, { x: cx, y: cy, z: cz }, rot,
          { group: groups(GROUP.STATIC, 0xFFFF), friction: 0.92 });
        this._bodies.push(b); this._onCollider();
      };
      if (lvl1 > lvl0) mkBox(lvl0, lvl1, deckTop, deckTop);
      mkBox(s0, Math.min(lvl0, s1), -RAMP_BURY, deckTop);
      mkBox(Math.max(lvl1, s0), s1, deckTop, -RAMP_BURY);
    }

    // --- canopy and name panel, at the boarding end -------------------------
    // Placed a third along from the ramp so it is on the level deck and not over
    // a rail. Backed on to the traffic side, open to the track, which is which
    // way round a shelter faces when the platform is an island in a road.
    const cd = s0 + Math.max(RAMP_RUN + 1.2, L * 0.34);
    const f = at(cd), o = outerAt(cd);
    const post = (od, ad, h, w) => {
      const x = f.x + f.rx * od * sd + f.dx * ad;
      const z = f.z + f.rz * od * sd + f.dz * ad;
      const base = surf(x, z, f.y) + deckTop;
      mb.box(x, base + h * 0.5, z, w, h, w, Math.atan2(f.dx, f.dz), 'metal_dark', COL.shelter);
    };
    const backO = o - 0.14, frontO = inner + 0.55;
    for (const ad of [-SHELTER_L / 2 + 0.15, SHELTER_L / 2 - 0.15]) {
      post(backO, ad, SHELTER_H, 0.09);
      post(frontO, ad, SHELTER_H, 0.09);
    }
    const cX = f.x + f.rx * ((backO + frontO) / 2) * sd, cZ = f.z + f.rz * ((backO + frontO) / 2) * sd;
    const cBase = surf(cX, cZ, f.y) + deckTop;
    const yaw = Math.atan2(f.dx, f.dz);
    mb.box(cX, cBase + SHELTER_H + 0.05, cZ, backO - frontO + 0.35, 0.10, SHELTER_L,
      yaw, 'metal_panel', COL.canopy);
    // Green Line green, on the canopy fascia facing the track. The route colour
    // is the identity; there is no lettering, and see the class note for why.
    const fx = f.x + f.rx * (frontO - 0.14) * sd, fz = f.z + f.rz * (frontO - 0.14) * sd;
    mb.box(fx, cBase + SHELTER_H - 0.03, fz, 0.08, 0.30, SHELTER_L, yaw, 'paint_green', COL.green);
    // Glazed back, so it reads as a shelter rather than a table.
    const bx = f.x + f.rx * backO * sd, bz = f.z + f.rz * backO * sd;
    mb.box(bx, cBase + SHELTER_H * 0.62, bz, 0.05, SHELTER_H * 0.72, SHELTER_L - 0.4,
      yaw, 'spandrel', COL.glass);

    // Name panel: a blade on its own post at the ramp end of the deck, in the
    // route colour with a dark back.
    const nd = s0 + RAMP_RUN * 0.6;
    const nf = at(nd), nO = inner + 0.6;
    const nx = nf.x + nf.rx * nO * sd, nz = nf.z + nf.rz * nO * sd;
    const nBase = surf(nx, nz, nf.y) + deckTop * 0.5;
    const nYaw = Math.atan2(nf.dx, nf.dz);
    mb.box(nx, nBase + SIGN_H * 0.5, nz, 0.10, SIGN_H, 0.10, nYaw, 'metal_dark', COL.pole);
    mb.box(nx, nBase + SIGN_H, nz, 0.06, 0.44, 1.90, nYaw, 'paint_green', COL.green);
    mb.box(nx + nf.rx * 0.05 * sd, nBase + SIGN_H, nz + nf.rz * 0.05 * sd,
      0.04, 0.44, 1.90, nYaw, 'sign', COL.signBack);

    // --- lighting: two dusk-to-dawn sources per platform -------------------
    // Registered with the city's own light manager, so they cost no draw call and
    // come on with every other street light rather than needing a system.
    const LM = this._lighting;
    if (LM?.registerLight) {
      for (const ad of [-SHELTER_L * 0.35, SHELTER_L * 0.35]) {
        const lx = f.x + f.rx * ((backO + frontO) / 2) * sd + f.dx * ad;
        const lz = f.z + f.rz * ((backO + frontO) / 2) * sd + f.dz * ad;
        const gy = surf(lx, lz, f.y) + deckTop;
        const h = LM.registerLight(null, { type: 'street', position: [lx, gy + SHELTER_H - 0.1, lz],
          groundY: gy, range: 14, intensity: 46, color: '#fff4dc',
          poolRadius: 4.4, haloSize: 0.5, dynamic: false, autoNight: true });
        if (h && h !== null) { this._lights.push(h); this._onLight(); }
      }
    }
  }

  /** Nothing animates yet: no vehicle, no wire sag, no signals. */
  report() { return this.stats; }

  dispose() {
    for (const m of this.meshes) { m.geometry?.dispose(); m.parent?.remove(m); }
    this.meshes.length = 0;
    for (const b of this._bodies || []) { try { this._physics?.remove(b); } catch { /* gone */ } }
    if (this._bodies) this._bodies.length = 0;
    for (const h of this._lights || []) { try { h.release?.(); } catch { /* gone */ } }
    if (this._lights) this._lights.length = 0;
    this.root?.parent?.remove(this.root);
    if (this._ownsMaterial) this.matOpaque?.dispose();
  }
}
