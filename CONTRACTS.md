# Cross-system interfaces
Agents build against these. If you own a contract, you MUST implement it exactly.
If you consume one, code against it even if the other agent hasn't landed yet —
guard with `const c = ctx.get('city'); if (!c?.roads) return;` so a missing system
degrades instead of crashing.

---
## `city` — owned by the City/Roads agent (`src/world/City.js`, `Roads.js`, `Terrain.js`, `Water.js`)
```js
city.groundHeight(x, z) -> number          // terrain elevation, metres
city.districtAt(x, z)   -> 'backBay' | 'beaconHill' | 'northEnd' | 'financial'
                         | 'fenway' | 'seaport' | 'southEnd' | 'charlestown'
                         | 'cambridge' | 'water' | 'park' | null
                         // null = "no neighbourhood here". Two distinct cases,
                         // both formerly and wrongly reported as 'financial':
                         // outside the baked raster (beyond +/-3310 m), and
                         // inside it where the grid holds the 0 sentinel --
                         // 41% of raster cells. Use city.districts.inRaster(x,z)
                         // to tell them apart. Non-finite input returns null.
city.plots[].district   -> same union, nullable for the same reason
city.roads = {
  nodes: [{ id, x, z, y }],
  edges: [{ id, a, b, lanes, width, oneway, type, speed, name }],
                                           // type: 'highway'|'arterial'|'street'|'alley'
  laneCenter(edgeId, laneIndex) -> [{x,y,z}]      // polyline, in travel direction
  sample(edgeId, t) -> { x, y, z, heading }       // t in 0..1
  nearestEdge(x, z) -> { edgeId, t, distance } | null
  outgoing(nodeId) -> [edgeId]
}
city.sidewalks = { /* same shape as roads; peds walk these */ }
city.plots = [{ id, polygon: [{x,z}], district, zoning, maxHeight, frontage: {a,b} }]
city.spawnPoints = [{ x, y, z, heading, kind: 'road'|'parking'|'sidewalk' }]
```

---
## `materials` — owned by the Materials agent (`src/gfx/TextureFactory.js`, `Materials.js`)
```js
materials.get(name) -> THREE.Material       // cached, shared, never null (falls back)
materials.names() -> string[]
```
Required names (others welcome):
`asphalt`, `asphalt_worn`, `concrete`, `concrete_stained`, `sidewalk`, `cobblestone`,
`brick_red`, `brick_brown`, `brownstone`, `granite`, `limestone`, `glass_tower`,
`glass_dark`, `window_lit`, `metal_painted`, `metal_rusty`, `steel_brushed`,
`roof_tar`, `roof_gravel`, `wood_painted`, `grass`, `dirt`, `water`, `foliage`,
`road_line_white`, `road_line_yellow`, `car_paint`, `chrome`, `tire`, `glass_car`.

Any material that should darken/gloss in rain sets:
```js
m.userData.wetnessRough = m.roughness;      // dry value
m.userData.wetnessColor = m.color.clone();
```
`ctx.assets.setWetness(0..1)` then works automatically.

---
## `vehicles` — owned by the Vehicle agent (`src/physics/Vehicle.js`, `src/world/VehicleModels.js`)
```js
vehicles.types -> ['sedan','suv','taxi','police','sports','van','bus','truck','pickup']
vehicles.spawn(type, { x, y, z }, headingRadians) -> Vehicle
vehicles.despawn(v)
Vehicle = {
  type, body /* Rapier */, mesh /* THREE.Object3D */,
  setInput({ throttle 0..1, brake 0..1, steer -1..1, handbrake 0..1 }),
  speed,          // m/s, signed (negative = reversing)
  gear, rpm, wheelsOnGround,
  position, quaternion,
  seats: [{ name:'driver'|'passenger', localPos }],
  headlightsOn, sirenOn,
  applyDamage(impulse, worldPoint),
  dispose(),
}
```

---
## `traffic` / `peds` — owned by the AI agent
```js
traffic.vehicles -> Vehicle[]         // AI-driven, live
traffic.setDensity(0..1)
peds.actors -> [{ position, velocity, state }]
peds.setDensity(0..1)
```
Both must react to `ctx.bus.emit('player:wanted', level)`.

---
## `player` — owned by the Gameplay agent
```js
player.position, player.velocity
player.mode -> 'onFoot' | 'driving'
player.vehicle -> Vehicle | null
player.health, player.wanted
ctx.bus.emit('player:enterVehicle', v) / ('player:exitVehicle', v)
```

---
## Cars are three different things, and each owns its collision separately

Nothing in Boston called "a car" shares one representation. Visual placement is
not gameplay collision, and getting a car to *look* right on the road says
nothing about whether anything can hit it.

| | drawn by | physics representation | collides with |
|---|---|---|---|
| **parked cars** | `Props.js`, one InstancedMesh per model | 17,282 static cuboids on one shared fixed body, built from `batch.mats` | `PROP` vs `CHARACTER` only |
| **AI traffic** | `Traffic.js`, `VehicleVisual` / shell LODs | none on the cars themselves; ≤12 pooled kinematic boxes shadow traffic within 22 m of the on-foot player | `VEHICLE` vs `CHARACTER` only |
| **drivable vehicle** | `VehicleFactory` / `Vehicle.js` | full Rapier raycast vehicle, chassis + suspension casts | chassis `VEHICLE` vs everything; wheel rays `WHEEL` vs `STATIC\|PROP\|WATER` |

Traffic stays path-driven on purpose: a full raycast-vehicle solve costs about
21 ms for 60 cars. Do not "fix" a traffic collision problem by promoting traffic
cars to real vehicles, and do not create hundreds of rigid bodies to give the
player something to bump into — the proxy pool exists for exactly that.

The narrow filters are load-bearing. Parked-car boxes are invisible to the
drivable vehicle's suspension because those rays cast as `WHEEL` and `PROP` is in
their mask but `CHARACTER` is not; traffic proxies are invisible to each other,
to parked cars, and to the drivable chassis for the same kind of reason. Widening
either filter re-couples systems that were deliberately kept apart.

Two consequences worth knowing before filing a bug:
- Traffic brakes for the player because `Traffic._injectPlayer` puts him into the
  lane list as a stationary obstacle, and IDM does the rest. That lookup needs an
  *exact* arc length on the lane: half of all lanes run against the edge they
  were offset from, so anything derived from `nearestEdge().t` is mirrored on
  those. Use `Path.nearestS`.
- The character controller only resolves movement the character *asked for*, so
  a kinematic box driving into a standing capsule is never pushed back by it.
  That is why a **stationary** player is protected by prevention rather than
  reaction: `Traffic._clampToPlayer` runs immediately before `_pose` commits a
  car's body transform and refuses a step that would land on him, bisecting back
  along the arc to the last clear position. Do not replace it with a push-out --
  one was tried and removed, because the controller cannot clear an initial
  penetration and shoving the player directly can post him inside a wall.
- The clamp exists because the lane ghost is *bookkeeping* and a car's body is
  not: measured, a shell sits up to 3.46 m from the centreline its ghost is keyed
  to, and a lane change re-keys the car instantly while the shell crosses over
  gradually. Braking is still the visible defence and does almost all the work --
  the clamp fired in 2 of 26 staged encounters and never at all while the player
  is off the carriageway. If it starts firing constantly, something upstream is
  wrong; do not tune the clamp to compensate.

---
## Getting off the road is free — the movement system routes, you do not

Boston is a free-roam city, so crossing from the carriageway back to the
pavement is available **anywhere**, including straight opposite a parked car.
The player never has to find the gap between two cars, and there is no marker,
arrow or designated entrance. Two mechanisms in `Player` deliver that, and both
matter.

**The kerb.** `_move` bleeds horizontal speed when the controller reports no
progress, so he cannot shove at a wall and shoot sideways when it ends. A kerb is
not a wall, and Rapier's autostep only lifts him when the horizontal step he asks
for is big enough to land on top: against a real 0.28 m Boston kerb, 0.2-2.0 m/s
all fail and 3.0 m/s clears it. The bleed drove him under that floor, so contact
bled the speed and the lost speed starved the step. `_stepUpAhead` exempts a
climbable rise from the bleed, probing two distances because some kerbs ramp over
about a metre rather than stepping.

**The cars.** `_kerbBypass` steers around them. Parked cars stay exactly as solid
as they look -- they are **not** shrunk, and must not be: the channel between a
car's kerb-side face and the pavement is 0.29-0.34 m against a capsule needing
0.64 m, so fitting through would cost a third of the collider's half-width and he
would walk visibly through the doors. Instead, when a crossing is blocked by a
PROP collider (the durable owner tag) and the street says pavement lies a few
metres the way he is pushing, he is steered along the car's own long axis toward
whichever end he is nearer, latched so he cannot dither, and released the moment
it stops blocking him. Only the direction handed to the controller changes.

Measured over 36 trials on four streets, holding one unchanging intent with no
steering along the kerb: **36 of 36** reached the pavement in 1.60-2.20 s, worst
penetration into a visible car body **0.000**. Cars remain solid to a direct
approach -- nose-on, flank-from-the-pavement and tail-on all stop him with the
assist never engaging.

The assist deliberately ignores moving traffic, drivable vehicles, buildings and
walls; it is for decorative kerbside parking only. **The previous rule here --
that the path exists and the player should lean along the flank to find a slot
1.75 m away -- is superseded and is no longer the product behaviour.**

---
## Kerbs: how the step is supposed to feel

Crossing a kerb keeps the player's speed. Holding a steady jog at an ordinary
0.285 m kerb, actual travel dips below 80% of approach for a **median 0.033 s
and no more than 0.05 s**, bottoming around 2.4 m/s of a 3.40 m/s approach and
returning to 3.37 m/s immediately. If that ever becomes a visible near-stop
again, something has regressed.

It is `Player._stepOver` that delivers this, and it exists because **Rapier's
autostep never fires on Boston's kerbs**. The road collider comes from the far
LOD, three times coarser longitudinally, so a kerb is a ramp of conflicting
faces -- one contact reported normals of 1.00, 0.21, 0.62 and 0.66 at once --
not the clean vertical step autostep wants. The controller reads it as a
walkable slope and slides up it, which is what ate the speed: 0.50 m/s minimum
and 0.167 s under 80%. Do not try to tune this with controller settings.
Autostep height, its landing-width requirement, and slope climb angles from 35
to 52 degrees were all swept and it never stepped once; asking for extra upward
movement (0.10, 0.18, 0.30 m) produced byte-identical profiles.

`_stepOver` raises the capsule by the rise the walking surface reports ahead,
only after checking the raised pose is clear, and lets the controller do the
same horizontal move from there. It cannot climb what it should not, because the
rise comes from the walking surface: a parked car reports none.

---
## Vehicle cabins: what is modelled and what is not

Every vehicle body is a hollow loft. There is **no seat, dashboard or floor
geometry anywhere**, and LOD1 does not even carry `under`. What exists is an
*occluder*: `cabinShell` builds a dark shell inside the greenhouse so you cannot
see through a car or a bus to the street behind it. Do not describe this as a
vehicle interior -- it is exterior-view occlusion and nothing more.

| | cabin occluder | glazing |
|---|---|---|
| moving traffic + drivable, LOD0/LOD1 | yes | `glass_car`, 0.30 opacity, double-sided |
| parked props (built from LOD1/LOD2) | yes, inherited | opaque body class -- see below |
| any vehicle, LOD2 shell | **no, deliberately** | LOD2 carries no glass at all |

LOD2 is left bare on purpose: the distant shell has no glass, so there is
nothing to see through and a cabin there would be invisible cost. Cost where it
is built is 32-56 triangles per vehicle, 0.4-0.7% of that vehicle's LOD0, on the
existing `under` / `trimDark` buckets -- no new material and no new draw call.

Two traps if you touch this. These geometries are **indexed**, so
`position.count / 3` is vertices over three and will make a 56-triangle addition
look like 7. And the shell is emitted in **both windings** deliberately: the
buckets it rides are FrontSide, which way a face should point depends on which
window you are looking through, and orienting them by the documented winding
rule produced geometry that measured present at exactly the right coordinates
and changed not one pixel.

---
## Building collision: what is solid, when, and how big

**Buildings have always had colliders.** `CaptureHarness.unstick` carries a comment
saying they do not -- "Buildings have no physics colliders -- only terrain and roads
do" -- which was wrong when it was written (`f9dc75f`) and is wrong now.
`Buildings._addColliders` has built one collider per building since the baseline
commit. A collider inventory that finds none has almost certainly been taken at
`time.frame === 0`: nothing has streamed yet, so no chunk is at LOD 0 and the
building population is genuinely zero *at that instant*. Step the engine before
counting.

**Ownership and shape.** One `RigidBodyDesc.fixed()` per LOD-0 chunk, one
`ColliderDesc.cuboid` per building on it, oriented to the footprint's longest edge.
Groups are `groups(GROUP.STATIC, 0xFFFF)`. They were previously left at Rapier's
default, which made every building a member of every group -- CHARACTER, WHEEL,
TRIGGER, PROJECTILE, WATER -- by accident rather than intent. STATIC preserves every
interaction that actually exists: the player capsule, the camera ray
(`STATIC|PROP|VEHICLE`), the vehicle chassis, and the suspension ray
(`STATIC|PROP|WATER`) all still test true against it.

**A box is exact here, not an approximation.** 10,045 of the 10,048 footprints are
convex quads and the other 3 are convex pentagons; footprint area over oriented-box
area is 1.000 at every percentile, with only 3 buildings below 0.9. Do not "upgrade"
this to a trimesh or a footprint-prism decomposition -- there is no accuracy to buy,
and a trimesh of the rendered shell would drag in window and cornice relief.

**The two ways this went wrong, so they are not reintroduced.** `ang` is a BEARING,
`atan2(dx, dz)`, measured from +Z toward +X. The projection that measures the
half-extents is the frame a Three Y-rotation of **`+ang`** produces: local +Z along
the longest edge. Rotating the collider by `-ang` mirrors the box about that edge --
same size, wrong place. Median 7.96 m of real facade then lay outside its own
collider, 9,949 buildings over 1 m and 3,177 over 10 m. Separately, half-extents
taken as `max(|u|)` about the **centroid** and applied symmetrically inflate any
footprint whose centroid is off-centre in its own bounding rectangle: 7,050 of
10,048 by more than 0.5 m, worst 3.56 m, and every surplus metre is invisible wall
standing in the street. Centre the box on the extents, not on the centroid.

**Streaming and reach.** Colliders are added when a chunk reaches LOD 0
(`r0 = 175 * scale`, scale from `drawDist/2200` clamped to 0.55-1.4) and are NOT
dropped when it falls back to LOD 1 -- `_stepChunk` calls `_disposeChunk(ch, false)`
across an LOD swap and `_addColliders` early-returns on an existing `ch.body`. They
are released only when the chunk unloads past `r1 = 410 * scale`. So collision
covers everything within 175 m of the camera plus anything that has been there since
it last unloaded. The player cannot outrun it: a chunk enters r0 175 m ahead, which
is 13 s at the drivable car's ~13 m/s, and a dense chunk finishes in about 0.45 s at
the steady 6 ms/frame `_pump` budget.

**Cost.** One cuboid per building, no trimesh, no per-frame collider churn. The
worst chunk measured (84 buildings, Back Bay) takes **1.2 ms** to build its whole
body, 14.3 microseconds per building, once. In the densest place measured the world
carries 523 building colliders of 16,565 total; `world.step()` averaged
0.006-0.018 ms over batches of 200.

**What this buys, measured.** Open street wrongly blocked by a building collider:
23.2% -> 0% in the Financial District, 6.4% -> 0% in Back Bay, ~1.8% -> 0% in the
North and South Ends (n = 220 open points per site). Interior points blocked by
their own building: 1,200 of 1,200 across 40 buildings, 4 in each of 10 districts.
Player walking at a facade, 40 trials: 0 entered, and where a building is what
stopped him the stop distance is a median of **0.32 m** -- capsule radius 0.30 plus
the KCC's 0.02 offset, i.e. the geometric minimum. Drivable sedan at 13.3 m/s
head-on and at 30 degrees off the normal: chassis never enters, stops 2.4 m out
(half a sedan, so nose flush), tilt under 8 degrees, reverses out 8-10 m.

**Known not solid.** Landmarks have no colliders of any kind, and `isReserved` keeps
procedural buildings off their footprints, so they get no building collider either.
Measured 0 of 5 interior sample points blocked at 200 Clarendon (241 m), the
Prudential Tower (229 m), the Custom House (151 m), the State House, Faneuil Hall
and Trinity Church -- you can walk straight through all of them. Do not fix this by
extruding `keepout`: that is a generator exclusion radius, up to 150 m at Fenway and
128 m at Faneuil, and using it as a collider would recreate exactly the
invisible-wall defect described above.

## Parked cars are glazed differently from moving ones

`CAR_SLOT` routes parked-car glazing onto the body's opaque class, not onto the
shared `prop_glass`. That is deliberate. `prop_glass` is a bus shelter's
material -- pale blue-grey at 0.20 opacity -- and a car body is empty: no LOD
produces the `interior` bucket `CAR_SLOT` names, and LOD1 (what parked cars use
up close) also drops `under`, so there is no floor either. Clear glazing over
that shell let you see straight through a parked car and out the far side.
Moving cars were never affected because `VehicleModels` glazes them at 0.62
opacity on near-black.

If you ever want real transparent car glass, close the shell first.

---
## Escape belongs to the browser, not to Boston

Escape is not bound to anything, is not in the `keydown` preventDefault list, and
no code reads it. What the player sees when they press it is browser chrome —
Safari's own "your pointer is hidden" notice — releasing pointer lock or leaving
fullscreen.

Boston only *observes* the consequences: `Input` listens to `pointerlockchange`
and `fullscreenchange` (plus the webkit-prefixed variant) and updates
`mouse.locked` / `fullscreen`. `mouse.locked` gates mouse-look accumulation and
`CameraRig`; nothing pauses, opens the menu, or touches `settings.timeScale`.
`KeyP` is the pause key and fullscreen is toggled from the pause menu.

So a report that "Escape does something" is expected and correct: the camera
stops following the mouse because the browser dropped the lock. Do not add an
Escape binding to "fix" it, and do not conclude Boston owns the key from a grep
for the string — trace the indirect path through those two events instead.

---
## `lighting` — owned by the Lighting agent
```js
lighting.sun            // THREE.DirectionalLight
lighting.registerLight(obj3d, { type:'street'|'headlight'|'sign', range, intensity })
lighting.sunDir         // THREE.Vector3, normalised, points FROM the sun toward origin
```
Street lights, window emissives and headlights must switch on between roughly
18:30 and 06:30 driven by `ctx.time.timeOfDay`.

---
## Events on `ctx.bus`
| event | payload | emitted by |
|---|---|---|
| `engine:ready` | engine | core |
| `resize` | `{w,h}` | core |
| `quality:changed` | – | settings UI |
| `weather:set` | `'clear'|'rain'|...` | capture harness / weather UI |
| `physics:contact` | `{h1,h2,started}` | physics |
| `player:enterVehicle` / `player:exitVehicle` | Vehicle | gameplay |
| `player:wanted` | level 0..5 | gameplay |
| `vehicle:collision` | `{ vehicle, impulse, point }` | vehicles |
