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
                         | 'cambridge' | 'water' | 'park'
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
