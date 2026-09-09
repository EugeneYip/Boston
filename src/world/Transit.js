import * as THREE from 'three';
import { MeshBuf, makeOpaqueMaterial } from './BuildingKit.js';

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

const COL = {
  rail:   [0.56, 0.57, 0.59],
  wire:   [0.30, 0.31, 0.33],
  pole:   [0.52, 0.53, 0.52],
  bracket:[0.44, 0.45, 0.46],
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
      tris: geom ? geom.index.count / 3 : 0,
      draws: geom ? 1 : 0,
      gauge: GAUGE, trackCentres: TRACK_CTR,
      colliders: 0,
      platforms: 0,
      note: 'no platforms: two tracks plus two side platforms need 10.25 m of '
          + 'reservation and there are 7.00 m — see docs/neu/GREEN_LINE_E.json',
    };
    console.info(`[transit] Green Line E: ${spans} reserved spans, ${metres | 0} m, `
      + `${poles} masts, ${(this.stats.tris) | 0} tris, ${this.stats.draws} draw`);
  }

  /** Nothing animates yet: no vehicle, no wire sag, no signals. */
  report() { return this.stats; }

  dispose() {
    for (const m of this.meshes) { m.geometry?.dispose(); m.parent?.remove(m); }
    this.meshes.length = 0;
    this.root?.parent?.remove(this.root);
    if (this._ownsMaterial) this.matOpaque?.dispose();
  }
}
