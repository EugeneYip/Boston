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

## Landmark collision: the drawn triangles are the collider

**Owner: `Landmarks._addColliders`.** One `RigidBodyDesc.fixed()` for all twenty
landmarks, carrying one `ColliderDesc.trimesh` each, grouped
`groups(GROUP.STATIC, 0xFFFF)` to match the building contract. Released in
`dispose()` with the meshes.

**`keepout` is NOT a collision footprint and must never be used as one.** In
`src/data/landmarks.js` it is the radius inside which the generic building
generator must not place anything -- 150 m at Fenway, 130 m at Zakim, 128 m at
Faneuil. Extruding those discs would wall off whole blocks of open street, which
is the exact defect that was removed from `Buildings._addColliders` one batch
earlier. Landmarks are individually modelled and carry no footprint polygon, so
the rendered geometry is the only honest description of their shape.

**How the slice works.** Every landmark is emitted into one shared `MeshBuf`
inside the `for (const d of LANDMARKS)` loop in `init`. `MeshBuf.build(false)`
copies indices through 1:1 and leaves positions in world space, so recording
`mb.ni` either side of each builder call gives an exact index range into the
finished geometry. `this.parts` holds those ranges; each becomes one trimesh with
its vertices compacted out of the 44k-vertex merged buffer. If you ever make
`build()` reorder or weld, this breaks -- the ranges are the whole mechanism.

**Taking the shape from the geometry is what makes the awkward cases work, and
they need no special case.** Fenway's bowl is open to the sky (verified: no
vertical hit above the centre) and its field is a drawn ground-level surface, so
the collider is a floor there rather than a lid. The space under the Zakim deck
has 26-45 m of clearance and is fully walkable -- three traversals covered the
whole 11.1 m free-run distance with zero stalled frames. Faneuil's colonnade and
every arch stay open because there are no triangles in them.

**Deliberately not collidable.** The Zakim cables and the Citgo sign are separate
meshes (`zakim_cables`, `citgo_sign`) and never enter the shared buffer, so they
are excluded for free -- catching a player on a suspension cable would be worse
than passing through one. The glass buffer is excluded too: curtain walls are
coincident with the opaque shell they hang on, so including them would only
duplicate surfaces.

**A trimesh is a surface, not a volume.** A capsule teleported inside a landmark
reports no overlap from `intersectionsWithShape`, because it intersects no
triangle. That is expected and is NOT evidence that the landmark is hollow --
interior-point coverage, which is the right test for the building cuboids, means
nothing here. Traversal is the only test that does. The drivable chassis has
`setCcdEnabled(true)` and soft-CCD prediction, so it does not tunnel: measured
head-on at 14.1-14.4 m/s it stops with its centre 2.39-2.48 m out, half a sedan,
nose flush.

**Measured contracts.** Player, 60 trials over all 20 landmarks at three bearings:
56 of 58 valid trials stopped by the landmark collider, distance from the stop
point to the nearest visible triangle median **0.32 m** (min 0.29, max 0.81) --
capsule radius 0.30 plus the KCC's 0.02 offset -- with **0** trials stopping more
than 1 m out and **0** unable to retreat. Open ground wrongly blocked: 0 of 200
samples at Zakim, Faneuil, TD Garden, Prudential and Hancock; 7 of 200 at Fenway,
all within 0.9 m of real geometry. Camera: orbit intrusion fell from **68 of 180**
angles to **8 of 216** (see below). Cost: 20 colliders, 22,078 collision
triangles, ~1 MB, one-time build, and a `world.step()` cost indistinguishable
from noise with the colliders switched on or off (0.006-0.038 ms either way).

**Camera vs landmarks: CLOSED.** It was 10 of 216 orbit angles behind a landmark
surface. Two hypotheses were wrong before the real one: it is not a vertical blind
spot (the lift is 0.20 m and `FAN` already has a centre ray `[0, 0]`), and the
"extra un-lifted pivot ray" cannot help because the mismatch is lateral, not
vertical -- in all ten failures that ray's `toi` was LARGER than the existing fan's.

The defect was the **shoulder**. `_apply` swept with the full `shoulder` and then
placed the camera at `shoulder * shrink`, `shrink = min(1, _dist / dist)`. Those
agree only when `shrink === 1`, i.e. only when the sweep found nothing; whenever it
did shorten the arm, the camera moved laterally into a column that was never
probed. Instrumented at 200 Clarendon yaw 190: desired 3.35, shoulder 0.46, arm
1.50, shrink 0.448, camera at lateral 0.21. Hand-cast down the same direction --
lateral 0.46 (swept) no hit at all; lateral 0.21 (actual) landmark at toi 0.71.

`_apply` now re-probes at the shoulder the camera will occupy and keeps the tighter
answer, capped by `SHOULDER_PASSES = 2`. A shorter arm gives a smaller shoulder, so
the sequence decreases monotonically and cannot oscillate; seeded from the smoothed
live arm it was stable after ONE pass on all ten failures and unchanged by a second.
Ray cost is unchanged when unobstructed (`q` is 1, so it breaks immediately -- about
1 sweep / 5 casts per frame) and doubles only when pinned (2 sweeps / 10 casts).
Driving is untouched: that path passes `shoulder = 0`.

**Do not replace the first sweep.** The reverted earlier attempt swept only at
`shoulder * shrink` -- one guessed offset instead of the full-shoulder sweep -- and
let the camera into a car. This keeps the original sweep and only ever takes a
tighter result on top of it, so it cannot expose anything the old code caught.

**Do not use a shoulder corridor.** Sampling offsets between full and actual
shoulder was measured too: 3 samples also closed all 10, but 5 samples collapsed
every failure to the 0.27 m floor, because taking a minimum across columns the
camera never occupies over-shortens. Iteration keeps 0.27-0.567 where the corridor
keeps 0.27.

Verified in the Pages build: landmark orbit 0 behind of 216 angles across six sites
(tower, glass tower, church, State House, Fenway exterior, Zakim); bus beside the
player 0 camera-inside of 36; open street arm 3.35 at all 36 angles with 0 at the
floor. In dev additionally: parked sedan / SUV / pickup / van / bus 0 inside over
180 angles, moving traffic with 12 proxies 0 inside, four procedural buildings 0
inside over 144 angles, kerb and carriageway arm 3.35 with 0 at floor.

**The cost, stated plainly.** Where the player is already pressed against a large
structure the arm reaches the 0.27 m floor at more angles: at a building, steady
state with a 40-frame hold, 21 of 36 -> 27 of 36, and buildings gain nothing from
this since they were already at zero penetrations. Open ground, kerbs, the sedan
case and driving are all unaffected.

## Vehicle paint: what owns the pale, samey look

**Hidden-pane pixels ARE trustworthy — the old warning is superseded.**
`Engine.resize()` floors a collapsed container to 1280x720, so a hidden Browser
pane still renders at a real size (measured 1920x1080 with `document.hidden`
true). It can still read 1x1 transiently during boot; call `engine.resize()` and
step, which is what `capture()` already does. Proof protocol used here, and worth
repeating before trusting any pixel claim: A/A on a car body gave dRGB
(-0.2,-1.2,-2.1); changing only the paint colour gave (-46.0,+41.7,-9.1); a sky
control region moved (-0.2,-0.4,-0.4); restoring returned inside the A/A floor.
Region-local, ~22:1 signal to noise, and demonstrably not a stale buffer.

**Protocol that matters:** hold ONE car, ONE camera and ONE light and mutate only
the material. Respawning per colour lets auto-exposure re-adapt and produced a
completely wrong reading here (tonal range 4.4 instead of 14.3).

**Owner 1, fixed earlier: the 5-bit snap ran in linear space.** See `f896627`.
Rendered confirmation: navy and dark green used to collapse onto the same
`#003232` and rendered at (32.6,50.3,63.4) and (32.5,50.1,63.3) -- an inter-car
distance of **0.2**. After the sRGB snap they render (35.3,48.4,69.2) and
(35.2,50.2,55.6), distance **13.7**. Dark red's magenta cast is gone (blue 55.1
-> 46.4) and the white control is unchanged.

**Owner 2, fixed here: `carPaint` metalness was 0.78.** Automotive basecoat is a
dielectric with metallic flake, and the gloss is carried by `clearcoat: 1.0`, so
metalness was never buying the shine. At 0.78 only 22% of albedo survived as
diffuse, and the fleet's tonal range collapsed: a white car rendered just **22.0**
luma above a black one, with black 45.2, dark red 45.4 and navy 45.9 inside 0.7 of
each other. Sweep, everything else held:

    metalness   0.78  0.60  0.45  0.30  0.15  0.00
    tonal range 22.0  30.7  37.4  44.1  49.8  54.9
    mean chroma 30.7  32.7  33.9  34.7  35.3  35.8
    white clip     0%    0%    0%    0%    0%    0%

Shipped **0.30**. Verified across daylight, overcast, dusk, night and rain: range
roughly doubles in all five, white clipping 0% everywhere, black crush unchanged.

**Parked cars are a DIFFERENT material path, and the two disagree.** Parked props
render through the shared `prop_surf` material (one material across 107 instanced
prop meshes) with per-surface parameters from `SURF` in `StreetFurniture.js`:
`carPaint: [0.34, 0.05, 1.0, 1.25]` = roughness, metalness, clearcoat, envScale.
So parked cars have ALWAYS been metalness **0.05** while moving and drivable cars
were 0.78 -- despite the comment on that very line saying the envScale is chosen
"so a parked car and a driving one of the same colour agree". Shipping 0.30
narrows the gap but does not close it. Do not "fix" this by editing `prop_surf`'s
scalar metalness: it is shared with every other prop in the city.

**Speckle is NOT owned by the vehicle material — do not tune the flake terms.**
Turning off the flake normal, the clearcoat normal and both ORM maps together
moved body high-frequency energy by **-1.9%** against an A/A floor of +/-0.03, and
a flat road patch measures MORE high-frequency energy (25.31) than the car body
(21.16). Whatever reads as chalky is a scene-wide postprocess term, not paint
microstructure.

**Palette is not the owner either.** Weighted by the real `Traffic.MIX` the fleet
is 55.7% near-neutral with median chroma 0.031, but median luminance is only 0.125
and 27.3% is genuinely dark, so it explains "samey" and not "pale". It was left
alone deliberately.

## Scene-wide speckle is film grain (2026-09-05)

**Owner: `RenderPipeline.options.grain`, now 0.0075 (was 0.015).** Not the vehicle
material -- all vehicle micro terms off together move body high-frequency energy by
1.9%. Not sharpening: `sharpen` is `taaOn ? 0.34 : 0.0` and TAA is off, so
LensFinal's CAS filter is inert. There is no dither pass and no FXAA. The live
chain is FrameState, Render, N8AO, atmosphere, AutoExposure, Velocity (disabled),
SSR (disabled), Lens, [LensComposite+Exposure+ToneMapping+Grade], [SMAA],
[LensFinal+FilmGrain].

**The metric.** High-pass RMS after subtracting a 3x3 box blur, on flat interior
patches well away from silhouettes, scene and camera frozen. Validated before use:
an injected 8x grain perturbation moved it +6.98 on road against an A/A floor of
0.035, and restoring returned within 0.004. Sky (0.37) ranks far below road (1.19)
which ranks far below detailed regions (11-15), so it separates high frequency from
lighting gradients.

**Spatial share, against the grain-off texture floor:**

    condition   road hp: floor -> with grain    grain's share
    daylight            0.615 -> 1.189             48%
    overcast            0.699 -> 1.893             63%
    dusk                0.512 -> 1.801             72%
    night               0.479 -> 2.451             80%

Night is worst because `isoBoost` in `FilmGrainEffect` raises the live amplitude to
0.0203, 2.4x the daylight 0.0085.

**Temporally it is almost the entire defect.** Scene AND camera frozen, per-pixel
temporal RMS: road 0.006 with grain off against 0.99 with it on; wall 0.004
against 0.92. So 99% of the crawl on flat surfaces is grain. Sky keeps 0.30 of
residual crawl with grain off -- that is the atmosphere pass, not grain, and it was
not investigated.

**Detail is not touched, and that is the acceptance test.** On high-detail regions
gradient energy is 46.413 / 46.321 / 46.308 at grain 0.015 / 0.0075 / 0 -- grain is
0.2% of what is there. Any future "fix" that lowers detail-region gradient energy
is blurring the image and is wrong.

**Measured in the Pages build after the change**, same site and regions: road
1.189 -> 0.798, wall 1.123 -> 0.758, sky 0.376 -> 0.254, removing 68% of the
removable excess on road and wall. Passes 11 and programs 71, unchanged.

**Do not remove grain entirely** and do not reach for resolution or blur. If it is
still too strong, the next lever is `isoCap` (1.85) in `FilmGrainEffect`, which
targets night specifically, not the base amplitude again.

## Corner stickiness: not reproducible as a movement defect (2026-09-05)

Measured in the Pages build, not inferred. A re-entrant corner was produced
deliberately -- press into a building corner vertex for 150 frames, which wedges
the player with three of twelve probe bearings returning TWO overlapping building
colliders -- and compared against a flat-facade control.

    state                     velocity while pressing   frames to exceed 2.0 m/s
    flat facade                          0.05                     3
    re-entrant corner                    0.02                     3

From the wedged corner, rotating input to a free direction recovers to the full
3.40 m/s jog in **3 frames, about 50 ms**, travelling 2.32-2.34 m in 45 frames --
slightly FURTHER than the flat-wall control managed (1.64-2.19 m). The anti-wall
bleed does drive velocity to ~0.02 while the player pushes into geometry, which is
exactly its job; it does not prevent recovery.

Two cautions before anyone reopens this. Ninety press frames is NOT enough to wedge
him -- a shorter press slides him past the corner at full speed and reads as a
false pass -- so use 150. And this is a change from what earlier batches saw (2 of
8 directions free at a landmark corner); the most likely explanation is `a70e884`,
which stopped `_move` feeding the step-over a stale `_bypass` vector, but that
causation is unproven because it was not re-tested against a revert.

Treat this as "not reproducible on this build", not as "fixed".

## Parked and moving paint: two paths, one appearance

**The two paths are deliberately different and stay different.** Moving and
drivable cars render through `Materials.carPaint` (a `MeshPhysicalMaterial` per
snapped colour, with flake normal and ORM maps). Parked cars render through the
shared `prop_surf` material with per-vertex `aSurf` parameters from
`SURF.carPaint` in `StreetFurniture.js` -- `[roughness 0.34, metalness 0.05,
clearcoat 1.0, envScale 1.25]` -- which is what keeps 33k props in one draw call.
The contract is **same paint colour -> perceptually coherent appearance**, NOT
identical parameters.

**Measured, same geometry / camera / light / exposure / source colour**, by
substituting the parameter tuples on one body at runtime (RGB distance over
white, silver, navy, dark red and mid blue; the A/A noise floor is about 2.1 and
a full colour change is about 46):

    parked 0.05 vs moving 0.78 (before the metalness fix)   mean 9.44, max 12.15
    parked 0.05 vs moving 0.30 (today)                      mean 3.33, max  4.46
    parked 0.15 vs moving 0.30                              mean 2.26, max  3.13
    parked 0.30 vs moving 0.30                              mean 0.60, max  0.96

`8cab8f6` cut the parked-moving mismatch by 65% as a side effect of fixing the
moving path. What is left, 3.33, is about 1.6x the noise floor.

**`SURF.carPaint` was deliberately NOT changed.** Metalness is the dominant term
in the residual -- moving it 0.05 -> 0.30 accounts for most of the remaining gap --
but parked 0.05 has the BETTER tonal range of the two, so matching it to 0.30
would trade rendered quality for parameter symmetry. If the difference is ever
judged visible, `SURF.carPaint[1]` is the single lever and it touches only the
carPaint slot, not the other prop classes. Do not raise it merely because the
moving path says 0.30.

**Far/shell LOD shares the moving material and keeps its colour.** Traffic owns
the shell banks (`traffic_shell_<type>_near` / `_far`), not `VehicleFactory` --
`vf.pools` stays empty and a manually spawned car never enters the shell path, so
do not try to exercise shells by spawning one. The paint bank uses
`car_paint:ffffff` from the same `Materials.carPaint` family, at metalness 0.30,
roughness 0.26, clearcoat 1, with `instanceColor` carrying the per-car tint --
sampled live: dark red (0.314, 0.015, 0.020), grey (0.462, 0.479, 0.503), navy
(0.093, 0.130, 0.175). So body colour survives into the far LOD and there is no
separate pale shell material. `near` and `far` banks differ only in `castShadow`.
The trim bank is a plain `MeshStandardMaterial` with no instance colour, which is
correct -- trim is uniformly dark.

**Batching invariants that must survive any future change here.** `prop_surf`
stays ONE material across 220 instanced prop meshes; the shell banks are backed by
2 `carPaint` instances total and tint per instance. Never assign per-car
materials: there are 15,994 parked cars. Measured with everything live: 459 draw
calls, 2.07M triangles, 77 programs.

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

## Building modelling: the Model Lab, and what it found (2026-09-06)

`tools/model-lab/` exists because the full runtime could not supply pixels: a
Boston cold boot is ~5 minutes and the Browser pane recycles the tab every
30-60 s. Six consecutive attempts across two sessions never reached a first
frame; the lab boots in 1.9 s warm.

**The specs never needed the engine.** Terrain raster -> street graph ->
neighbourhood raster -> parcels -> `Buildings._buildSpecs` is pure arithmetic
over typed arrays. Only the mesh steps hanging off it touch a scene, and none
of those feed the specs. `world.js` runs the real chain and stops, so all 10,048
REAL buildings arrive in ~0.7 s with no WebGL, in Node or in the browser. The
lab therefore shows production buildings, not fixtures: building 4,211 in the
lab is building 4,211 in Boston.

    node tools/model-lab/audit.mjs exposure   street exposure vs `spec.front`
    node tools/model-lab/audit.mjs lod        LOD cost and wall articulation
    node tools/model-lab/audit.mjs edges <i>  one building, edge by edge
    http://127.0.0.1:5290/tools/model-lab/    the visual lab (`npm run verify`)

`__lab.bench()` runs nine fixed scenes and `__lab.diff(before, after)` compares
them. Dev-only: Vite builds the root `index.html` alone, so nothing here ships.

### Measurement traps this pass paid for

1. **Mean tile luminance cannot see a modelling change.** Replacing blank walls
   with windowed ones moved a Back Bay block from 138.28 to 138.09 out of 140 --
   noise -- while gradient energy over the same pixels moved 19.7 -> 22.1.
   Detail is high-frequency by definition. Use `__lab.detail(y0, y1)`, and give
   it the band that holds the subject; sky and bare ground only dilute it.
2. **Gradient energy rewards broken geometry.** A hole showing sky is the
   highest-contrast thing a frame can contain, so `detail()` fell 20% when the
   crown's missing ledges were closed. It answers "did detail survive this LOD",
   never "is this shape correct". Pixels decide the second question.
3. **Triangle count cannot see relief.** A flat wall subdivided a hundred times
   scores the same as a modelled one. `analysis.js` reports RELIEF, the spread
   of triangle offsets perpendicular to each footprint edge: a flat wall is
   0.000 and a real Boston facade is a few centimetres.
4. **A hidden Browser pane does NOT invalidate the lab.** It renders to its own
   fixed 1000x640 buffer and reads it back directly, so `digest()` and
   `detail()` stay valid; only `computer{screenshot}` needs compositing. This
   was checked, not assumed: with the pane hidden, benchmark scenes a change
   could not touch came back bit-identical to values captured while it was
   visible. (This does not license measuring the GAME with a hidden pane.)
5. **Half-plane "is it outside the footprint" tests assume convexity.** One
   parcel in 3,350 is non-convex, and it read as 10 m of geometry escaping its
   plot in all three LODs at once -- which is the tell that the test, not the
   geometry, was wrong.

### Population facts, measured over all 10,048

    footprint edges                        40,195
    street-exposed (open street within 3 m) 26.1%
    buildings with a mansard                2,686   27%
    buildings taller than 24 m              1,564   15.6%
    buildings with setbacks                   133   all `stoneTower`
    curtain-wall buildings                    154
    corner buildings (>=2 street edges)       460
    non-convex or sliver footprints        ~0.03%

Front-elevation density collapses with height at LOD 0 -- 9.95 tri/m2 at
12-18 m, 0.56 at 120-200 m. That is mostly CORRECT and was deliberately left
alone: a sill at 150 m is sub-pixel from the street, and `frontStorey` keeps
full detail below 24 m, which is what a pedestrian walks past.

### Invariant: the shell must stay inside the detailed mesh

`buildShell` insets 0.25 m and drops 0.30 m so LOD 2 can never z-fight LOD 0/1.
Measured across 3,350 buildings, the worst shell-minus-LOD0 outward margin is
-0.489 m. Re-run that check after touching `insetPoly`, `buildShell` or any
roof: it is the guarantee that stops the whole city shimmering.

## The production boot gate: 26 systems, not 22 (2026-09-06)

`bootReport.loaded` counts the OPTIONAL list only. `main.js` registers four core
systems unconditionally before it runs -- `render`, `assets`, `physics`,
`capture` -- so a healthy boot is:

    engine.order.length      === 26     <- the real gate
    bootReport.loaded.length === 22     <- of 23 optional
    bootReport.missing       === ['Missions.js']   (not yet built)
    bootReport.failed        === []
    __boston.errors          === []
    __boston.glFaults        === []
    __boston.validate().ok   === true
    physics.world live, ~16k colliders, ~56 bodies

Reporting "22 systems loaded" as if it were the total understates the gate by
the four that can never fail late. Read `engine.order`, which is also what the
`[boston] active:` console line prints.

**The production build boots in under 20 s.** The ~4 minutes this project
assumed came from a cold dev server doing on-demand transforms. `npm run
build:pages` then `boston-pages` is the fast path, and the tab now survives
90 s+, which is long enough to query and photograph.

## Street furniture: the models were never the problem (2026-09-06)

Same shape of finding as the building pass. Every prop inspected is well made --
`buildTrafficMast` alone has a tapered mast arm, three heads with visored lenses,
a hung street blade and a controller cabinet -- and every defect found was a
RULE about where things go or what data reaches them.

Measured in the running game, within 30 m of a six-way downtown junction:

    before   48 objects / 23 types, of which the footway held
             6 ped signals, 2 mast arms, 9 signs, 1 bench, 1 rack, 1 grate
             and zero hydrants, bins, meters, bollards or lamps
    after    63 objects / 27 types

Every kerbside rule in the segment loop places along the segment INTERIOR --
hydrants start 20-70 m in and stop 10 m short, bins 14-50 and 8, meters 7 and 7,
signs 6 and 6. Junctions are segment ENDS. The one place a pedestrian stands was
excluded from all of them by construction, and the junction pass itself only
placed signals, one blade and the drains.

### Traps in this system, paid for

1. **`populate`'s `take` shares ONE rng across every type.** Adding any `take`
   call shifts the acceptance stream for everything whose `prob` is below 1, so
   unrelated counts move a few percent. Measured, not guessed: over 19 sampled
   types after the corner kit, 16 identical and lampTwin +5, benchPark +1,
   planter -5. Budget the noise; do not chase it.
2. **A per-type cap that binds silently converts new candidates into thinning.**
   `bin` was at 1300 with 886 placed; the corner kit's ~500 new sites would have
   been paid for out of mid-block. Check `cand` against `cap` before adding
   sites. Instance count is not a draw-time cost here -- chunked and
   distance-culled -- so raising a cap is cheap.
3. **`density` is applied twice** in `want = min(keep, cap*density/cand) *
   density`. Inert at `high` (density 1.0); at `medium` (0.7) a cap-bound type
   gets `cap * 0.49` instead of `cap * 0.7`. Not fixed here -- flagged.
4. **Match props to `props.layout.segments`, never to the nearest road edge.**
   Verifying the ONE WAY arrows against nearest-edge scored ~50% for every
   candidate arrow axis, which reads like "no signal" and nearly buried a real
   finding. The nearest one-way edge to a sign standing 0.5 m behind the kerb is
   often not its own. Against the layout segments the placement actually walked:
   221/221, zero unmatched.
5. **A boolean can hide a whole axis.** `makeSegment` stored `oneway:
   !!opts.oneway`, so 113 segments that run against their own direction were
   indistinguishable from the 145 that do not, and no consumer could have been
   correct. Fixing the sign selection alone was a no-op, and the numbers caught
   it: every placed sign came back on an `oneway > 0` segment against a graph
   holding 114 negative edges.

## Vehicle models: proportions verified, LOD ladder verified (2026-09-06)

Audited all nine classes in the Model Lab against real dimensions. Nothing was
wrong with the proportions and the LOD ladder is well tuned; both were checked
rather than assumed, and both cost a cycle to disprove.

    class     L x W x H          wheelbase   LOD0 / LOD1 / LOD2 tris
    sedan     4.86 1.84 1.47       2.85       12040 / 4796 / 432
    suv       4.92 1.96 1.79       2.85       12384 / 4928 / 408
    van       5.56 2.00 2.19       3.32       11756 / 4632 / 408
    pickup    5.97 2.06 1.92       3.63       11824 / 4692 / 408
    truck     7.68 2.46 2.66       4.50       12028 / 5884 / 552
    bus      12.28 2.60 3.25       7.55       12680 / 5584 / 552

Track/width sits at 0.81-0.86 on every class and a tyre's outer face is 0.01-0.10
m inboard of the body side -- correct. LOD switches at 32 m and 115 m; measured
at constant distance, a 91% triangle drop (LOD1 -> LOD2 on a sedan) costs 6% of
gradient energy and moves 4 of 320 tiles. **Do not spend cycles on the vehicle
LOD ladder.**

### Two lab artefacts that look exactly like modelling defects

- **Wheels at full droop.** `VehicleVisual` builds each wheel at `p[1] - rest`
  because production poses them every frame from the suspension solve via
  `setWheel`. A lab that only constructs the visual renders a car on stilts.
  Static ride height is `rest * (1 - sqRatio)`.
- **A sun behind the car.** `anchors.head` puts a nose at -z; the building
  path's fixed world bearing put the key light at +z, so every front fascia
  rendered unlit and read as a black wedge punched through the bumper.

Both were chased as real defects first. When a vehicle looks broken in the lab,
check the pose and the light before touching geometry.

## Kerbside placement: segments are chords, roads are not (2026-09-06)

The single largest world-quality defect found so far, and it had been documented
and deferred in `Props.surfaceY` the whole time: *"edge 245 is a 643 m curve
whose chord leaves a kerbside prop 12 m from the real road. The lateral drift is
a separate defect and is not fixed here."*

`L.segments` are the straight CHORD between two graph nodes. Chord-to-polyline
deviation over the 509 city segments:

    p50   0.00 m     most streets really are straight
    p75   0.80 m
    p90   4.56 m
    p99  52.47 m
    max 155.06 m     edge 56, Boylston Street, an 875 m curve

On 46 segments -- 17.7 km, a quarter of the network by length -- it exceeds the
carriageway's own half-width, so props authored "1.05 m behind the kerb" were
in the road or inside the buildings behind it.

**Always place kerbside things with `L.kerbPoint(s, d, off, side)`**, which
takes the point and tangent off the road graph's real polyline and offsets along
that tangent's normal. It degrades to the chord automatically when the graph
cannot answer, so the synthetic grid layout is unaffected. `L.roadPoint(s, d)`
is the same thing without the lateral offset.

    tree sites in a carriageway   803 -> 53
    tree sites inside a building  784 -> 0
    kerb clearance p1 / p50      -6.95 / 1.05  ->  0.62 / 1.05

### Junctions need the same care, plus one more thing

`j.legs` also carried chord directions; they now come from the first span of the
edge's own polyline. And a junction CORNER clears two carriageways, not one --
the distance you travel along a leg to get clear is set by the road CROSSING it.
Sizing both offsets from `leg.hw` put 682 of 696 ped signals (98%) in the road,
9 m deep on a side street meeting an arterial. `cornerOf(leg)` returns the
along-axis clearance from the crossing leg and the lateral from the leg itself.

    junction props in a carriageway   1203 -> 403   (of 2607)

The 403 that remain are mostly real: several carriageways genuinely overlap
inside a junction box, so at a five- or six-way node a corner clear of its own
leg and the crossing one can still sit inside a third.

### Bridges have no ground

`roadMesh.surfaceAt` returns null beside a deck, `surfaceY` falls back to the
road's own height, and a tree gets planted at deck level over open air. Of 104
trees floating more than a metre, ALL 104 were within 40 m of a bridged edge and
ALL 104 had `surfaceAt` return null. Segments carry `bridged` now and the tree
generator skips them. Anything else ground-planted should too.

## Quality density: applied once, and `high` is the default (2026-09-06)

`Engine` hardcodes `new Settings('high')` and nothing auto-downgrades, so the
shipping default is `high` and `DENSITY.high === 1.0`. Presets are low 0.42,
medium 0.7, high 1.0, ultra 1.15, and changing quality at runtime does NOT
repopulate -- `quality:changed` only invalidates the batcher, so prop counts are
fixed at boot.

`Props.populate` and `Decals.placeDecals` both computed

    prob = min(keep, cap * density / cand) * density
    left = ceil(cap * density)

which applies quality twice to the cap-limited branch: `left` hands a type
`cap * density` and `prob` aims it at `cap * density^2 / cand`. Correct form is
`min(1, density * min(keep, cap / cand))` -- the second multiplication cannot
simply be deleted, because `cand` does not depend on quality and without it a
keep-limited type would place the same count at every preset.

    density        old      new
    1.00 (high)  66270    66270      bit-identical, proven per type
    1.15 (ultra) 67523    67523      bit-identical
    0.70 (med)   39760    46388      66270 x 0.70 = 46389
    0.42 (low)   16244    27833      66270 x 0.42 = 27833

Vegetation was already correct: it applies density linearly and once.

## Vegetation baseline (2026-09-06)

8 species x 2 fixed variants = 16 tree meshes, per-instance variation by
rotation, scale (0.78-1.32), a y-stretch and a lean. 378 / 104 / 6 triangles at
LOD 0 / 1 / 2, switching at 95 / 300 / 900 m. Species are a real Boston palette
(London plane, red maple, littleleaf linden, honey locust, pin oak, plus
American elm, copper beech and weeping willow in parks).

Street-tree SITES are owned by `Props.finishLayout`, not by Vegetation, and are
district-aware: 9-12.5 m spacing in Back Bay, South End, Beacon Hill and parks,
13-20 m elsewhere, 35% of Financial District segments skipped, a 16% chance of a
bare side and a 13% per-site gap. Vacancy is modelled there; do not add more
downstream.

**A count cap on a distance-sorted list is a radius cap.** `treeSites` comes out
ordered centre-first, so `maxTrees = 5200` against 6391 sites did not thin the
city -- it deforested everything past 2325 m. Take a stride, not a prefix. Same
trap `Buildings.js` documents for `MAX_BUILDINGS`.

Population after this pass: 6750 tree instances, 56224 vegetation instances,
157879 props, 99 batches.
