import * as THREE from 'three';
import { WORLD } from '../core/Geo.js';
import Terrain from './Terrain.js';
import Districts from './Districts.js';
import { buildParkPaths } from './ParkPaths.js';
import RoadNetwork from './RoadNetwork.js';
import Roads from './Roads.js';
import Water from './Water.js';

/**
 * Boston.
 *
 * This system composes the four pieces that actually make the place — the
 * ground, the neighbourhood map, the street graph and the water — and publishes
 * the `city` contract that the rest of the game builds on. Buildings take their
 * parcels from here, traffic and pedestrians take their graphs from here,
 * lighting takes its lamp posts from here, and every one of them resolves
 * elevation through the single `groundHeight()` raster so nothing ever
 * disagrees about where the ground is.
 *
 * Build order matters and is not negotiable:
 *   terrain raster -> districts raster (needs water) -> road graph (needs
 *   terrain) -> pavement graph -> parcels (needs districts) -> geometry.
 */
export default class City {
  static id = 'city';
  static label = 'Boston';
  static deps = ['assets', 'physics'];

  async init(ctx) {
    const t0 = performance.now();
    const scene = ctx.scene;
    const materials = ctx.get('materials');
    const T = {};
    let tm = performance.now();
    const mark = (k) => { T[k] = Math.round(performance.now() - tm); tm = performance.now(); };

    // --- ground ------------------------------------------------------------
    this.terrain = new Terrain();
    this.terrain.bake();
    mark('terrain');

    // --- street graph ------------------------------------------------------
    // Built before the terrain mesh: the roads decide their own elevation
    // profile, then stamp it back into the raster so the ground never pokes
    // through the carriageway and `groundHeight()` is true on the street.
    this.net = new RoadNetwork(this.terrain);
    this.net.build();
    mark('graph');
    this.terrain.stampRoads(this.net);
    mark('stamp');

    // --- neighbourhoods ----------------------------------------------------
    // Baked before the ground mesh, because the terrain needs to know which
    // parts of the city are park and which are built up so it can stop
    // painting downtown Boston as a lawn.
    this.districts = new Districts(this.terrain);
    this.districts.bake();
    mark('districts');

    const URBAN = new Set(['financial', 'backBay', 'beaconHill', 'northEnd',
                           'seaport', 'southEnd', 'charlestown']);
    this.terrain.build(scene, this._terrainMaterial(materials), (x, z) => {
      if (this.districts.inPark(x, z)) return 1;
      const d = this.districts.districtAt(x, z);
      if (d === 'park' || d === 'water') return 1;
      return URBAN.has(d) ? 0.10 : 0.85;
    });
    mark('ground');
    // Park circulation. Derived from the park polygons, the street graph and
    // the water rings — the walks a park needs to read as a park rather than as
    // a green rectangle with trees on it. See `ParkPaths.js`.
    const pp = buildParkPaths({ parks: this.districts.parkPolys, net: this.net,
                                water: this.terrain.bodies });
    this.parkPaths = pp.paths;
    this.parkEntrances = pp.entrances;
    this.districts.build(scene, materials, this.net, pp.paths);
    mark('parks');

    this.net.buildSidewalks();
    mark('pavement');
    this.net.buildPlots(
      (x, z) => this.districts.districtAt(x, z),
      (x, z) => this.districts.isReserved(x, z));
    this.net.buildSpawns();
    mark('parcels');

    // --- geometry ----------------------------------------------------------
    this.roadMesh = new Roads(this.net, this.terrain);
    this.roadMesh.build(scene, materials, ctx.assets);
    if (this.roadMesh.decals) scene.add(this.roadMesh.decals);
    mark('roads');

    this.waterSys = new Water(this.terrain);
    this.waterSys.build(scene);
    mark('water');

    this._publish();
    this._colliders(ctx);
    mark('colliders');

    const ms = performance.now() - t0;
    const s = this.net.stats();
    console.info(`[city] ${s.edges} edges / ${s.nodes} nodes / ${s.km} km of street, ` +
      `${this.plots.length} parcels, ${this.spawnPoints.length} spawns, ` +
      `${(this.roadMesh.triangles / 1000) | 0}k road tris, ${ms | 0}ms`);
    console.debug('[city] timing', T);
    ctx.bus.emit('city:ready', this);
  }

  /**
   * Ground material.
   *
   * Deliberately `dirt`, not `grass`: the terrain is what shows in the gaps
   * between buildings across the whole built-up city, and a grass texture there
   * makes Boston look like it was built on a golf course. The lawns are a
   * separate mesh in Districts, which is where `grass` belongs. Vertex colours
   * still push the outskirts and riverbanks green.
   */
  _terrainMaterial(materials) {
    const src = materials?.get?.('dirt');
    let m;
    if (src) {
      // Through the registry, not a bare clone. A private clone is invisible to
      // `Assets.setWetness`, and this material is the entire ground plane —
      // 110k triangles measured — so in rain the carriageway darkened and
      // sheened while the ground it runs across stayed bone dry, with a visible
      // step at every kerb.
      //
      // The reflection probe is not a change here: a clone inherits `envMap`
      // from its already-adopted source, so this material carried the probe
      // before and carries it now. Being in the registry means it is also
      // re-pointed when the probe is rebuilt on a quality change, instead of
      // holding a stale texture the way a private clone did.
      m = materials.assets.variant('ground_terrain', src, (x) => {
        x.vertexColors = true;
        x.color.setRGB(1, 1, 1);
      });
    } else {
      m = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.97, metalness: 0.0,
      });
      m.userData.wetnessRough = 0.97;
      m.userData.wetnessColor = m.color.clone();
    }
    // Only the standalone fallback is ours to free; a registry variant is
    // disposed by Assets.
    this._ownTerrainMat = src ? null : m;
    return m;
  }

  // -- the contract ---------------------------------------------------------

  _publish() {
    const net = this.net;
    this._ground = { y: 0, kind: 'ground', edgeId: -1, offset: 0 };

    /** @type {(x:number,z:number)=>number} terrain elevation in metres */
    this.groundHeight = (x, z) => this.terrain.groundHeight(x, z);
    this.districtAt = (x, z) => this.districts.districtAt(x, z);

    this.roads = {
      nodes: net.nodes,
      edges: net.edges,
      laneCenter: (edgeId, laneIndex) => net.laneCenter(edgeId, laneIndex),
      sample: (edgeId, t) => net.sample(edgeId, t),
      nearestEdge: (x, z) => net.nearestEdge(x, z),
      outgoing: (nodeId) => net.outgoing(nodeId),
      laneCount: (edgeId) => net.edges[edgeId]?.lanes ?? 0,
      /**
       * Centreline of the kerbside parking bay, or null where a street has
       * none (alleys, cobbled lanes, the highways). Every edge also carries
       * `edge.parking = { width, offset }` for direct placement.
       */
      parkingLane: (edgeId, side) => net.parkingLane(edgeId, side),
      /**
       * Is kerbside parking allowed `s` metres along this edge?
       *
       * True everywhere on a street with a bay, EXCEPT inside a local station
       * section that suspends it. Everything that puts a car at the kerb has to
       * ask -- the parked-car props and the starter-SUV solver both do -- or the
       * suspension is paint over cars still standing in the platform.
       */
      parkingAllowed: (edgeId, s) => {
        const e = net.edges[edgeId];
        if (!e?.parking) return false;
        const loc = RoadNetwork.sectionAt(e, s);
        return loc ? loc.parking : true;
      },
      /** Local cross-section `s` metres along an edge, or null if it has none. */
      sectionAt: (edgeId, s) => {
        const e = net.edges[edgeId];
        return e ? RoadNetwork.sectionAt(e, s) : null;
      },
    };
    this.sidewalks = net.sidewalks;
    this.plots = net.plots;
    this.spawnPoints = net.spawnPoints;

    // Extras the minimap, weather and audio systems look for.
    this.bounds = { minX: WORLD.minX, maxX: WORLD.maxX, minZ: WORLD.minZ, maxZ: WORLD.maxZ };
    this.waterPolys = this.terrain.bodies.map(b => ({
      name: b.name, polygon: b.pts, points: b.pts, level: b.level,
    }));
    this.water = this.waterPolys;            // minimap reads `city.water` as polygons
    this.parks = this.districts.parkPolys;
    this.parkPolys = this.districts.parkPolys;
    // Published for the same reason the parks are: Props and Vegetation must
    // not plant on a walk, and furniture wants to know where the walks are.
    this.parkPaths = this.parkPaths || [];
    this.parkEntrances = this.parkEntrances || [];
    this.districtPolys = this.districts.polys;

    /**
     * Height of what is actually drawn — carriageway, pavement, or terrain.
     *
     * Use this, not `groundHeight`, to stand anything on the ground. The raster
     * is stamped below the carriageway on purpose so the ground can never poke
     * through asphalt, which makes `groundHeight` 0.4-0.6 m too low anywhere
     * near a street.
     * @param {number} x @param {number} z
     * @param {number} [nearY] disambiguates a bridge deck from the ground below
     * @returns {number}
     */
    this.surfaceHeight = (x, z, nearY) => {
      const s = this.roadMesh.surfaceAt(x, z, nearY);
      return s ? s.y : this.terrain.groundHeight(x, z);
    };

    /**
     * As `surfaceHeight`, but says what the surface is, so a caller can put a
     * lamp post on the pavement and a manhole on the carriageway.
     * @returns {{y:number, kind:'road'|'pavement'|'ground'}}
     */
    this.surfaceAt = (x, z, nearY) => {
      const s = this.roadMesh.surfaceAt(x, z, nearY);
      if (s) return s;
      this._ground.y = this.terrain.groundHeight(x, z);
      return this._ground;
    };

    /** Water surface level at a point, or null on dry land. */
    this.waterAt = (x, z) => this.terrain.waterAt(x, z);
    /** True where nothing may be built. */
    this.isReserved = (x, z) => this.districts.isReserved(x, z);
    /** Surface normal — props and parked cars tilt to it. */
    this.groundNormal = (x, z, out) => this.terrain.normalAt(x, z, out);
  }

  // -- physics --------------------------------------------------------------

  /**
   * A single heightfield for the ground plus one trimesh per road chunk.
   * The road colliders come from the low-detail carriageway geometry, which is
   * ~8x lighter than the marked-up version and identical where it matters.
   */
  _colliders(ctx) {
    const p = ctx.physics;
    if (!p?.world) return;
    this._physics = p;
    this.bodies = [];
    try {
      this.bodies.push(this.terrain.addCollider(p, this.net));
    } catch (e) {
      console.warn('[city] heightfield collider failed, falling back to a plane', e);
      const b = p.world.createRigidBody(p.RAPIER.RigidBodyDesc.fixed());
      p.world.createCollider(p.RAPIER.ColliderDesc
        .cuboid(WORLD.maxX, 0.5, WORLD.maxZ).setTranslation(0, -0.5, 0), b);
      this.bodies.push(b);
    }
    for (const ch of this.roadMesh.chunks.values()) {
      if (!ch.farMesh) continue;
      try { this.bodies.push(p.addTrimesh(ch.farMesh)); } catch { /* degenerate chunk */ }
    }
  }

  // -- runtime --------------------------------------------------------------

  update(dt, ctx) {
    this.roadMesh.update(ctx.camera);
    const sky = ctx.get('sky');
    this.waterSys.update(dt, sky?.sunDir, sky?.zenithColor, sky?.horizonColor);
  }

  dispose() {
    this.roadMesh?.dispose();
    this.waterSys?.dispose();
    this.districts?.dispose();
    this.terrain?.dispose();
    this._ownTerrainMat?.dispose();
    const p = this._physics;
    if (p) for (const b of this.bodies || []) p.world.removeRigidBody(b);
  }
}
