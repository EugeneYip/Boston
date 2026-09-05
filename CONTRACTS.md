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
