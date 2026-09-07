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

## Parks are the city's, not Props' (2026-09-06)

`boston-geo.js` authors NINETEEN named parks; `Districts` builds grass and
hardscape meshes for all of them and `City._publish` exposes the list as
`city.parks`. `Props.parkPolys()` was two hand-typed rings approximating the
Common and the Public Garden, and Props used those instead — knowing 43.4% of
the city's 733,897 m2 of park and, because the rings did not match the authored
ones, planting 376 street trees inside real parks.

**`L.parks` is the exclusion set** (everything a street tree keeps out of,
including the `reserveOnly` Commonwealth Avenue Mall corridor, which is a
no-build strip rather than lawn). **`L.parkAreas` is the planting set** and drops
the reserve-only rings, exactly as `Districts` skips them when building grass.
Each carries `area` and `fill` — the ring's share of its own bounding box —
because both consumers need them and both used to guess.

### Rejection samplers must pay for the shape they sample

Park furniture ran a flat 320 attempts per park; park trees took their count from
the BOUNDING BOX. Both make polygon shape the content budget:

    furniture/ha   2.2 (Esplanade) - 361.6 (Post Office Square)   165x
    trees/ha      14.1 - 50.2

The Esplanade fills 0.06 of its bounding box, the Common 0.69. Scale the target
by real polygon area and divide attempts by `fill`. Density targets are keyed to
`kind`, because hardscape carries more seating and fewer trees than lawn:

    furniture/ha   plaza 60, formal 55, lawn 25, mall 22
    trees/ha       mall 42, lawn 32, formal 26, plaza 12

### Nothing is planted in the water

The Public Garden's ring includes its lagoon. Use `L.inWater(x, z)`, which tests
the exact terrain rings from `city.waterPolys` with a bbox reject in front — NOT
`districtAt`, which returned 'water' for only 95 of 105 known-wet points. That is
a 20 m raster being honest, and not good enough to decide whether a tree is in a
pond.

### Park lamps and the light pool

Park lamps DO push `_lampSites`. That is fine and does not change the real-light
budget: `_buildLightPool` allocates a fixed pool — 20 anchors at `high`, 8 at
`low` — and `_updateLightPool` selects the nearest sites for them. More sites buy
better selection near the player, never more lights.

## The junction-in-carriageway metric is closed (2026-09-06)

Of the 413 junction props whose position falls inside some carriageway:

    A  genuinely wrong placement                15   3.6%
    B  several carriageways genuinely overlap   35
    C  inside the junction box itself          363

96.4% are standing on real road surface at a junction, which is what a junction
is. **Do not target zero on this metric.** 15 items out of 158,785 props is not
worth a cycle.

## World coverage, measured (2026-09-06)

6 x 6 km world box, 20 m grid: water 19.0%, open 65.9%, building 8.6%,
carriageway 3.1%, park 1.9%, public realm 1.6%. Most of the "open" is beyond the
built city.

Inside NAMED neighbourhoods is the number that matters, and it is not parks:

    district      km2   bldg%  street%  park%  OPEN%   roadKm/km2
    cambridge    5.28      5       2      0     93        0.8
    charlestown  1.58      7       5      0     87        3.3
    fenway       1.75     17       7      0     76        3.1
    seaport      1.89     22       7      0     71        3.1
    southEnd     1.96     29      13      0     58        6.5
    backBay      1.08     33      34      1     32       20.9
    beaconHill   0.37     42      20      0     38       12.0

Cambridge holds 4.3 km of street and 325 buildings across 5.28 km2 — a
twenty-sixth of Back Bay's street density. Buildings come from parcels and
parcels come from roads, so this is a STREET GRAPH coverage gap, not a park or
vegetation one. Closing it means authoring tens of kilometres of real street
geometry, which is content scope and an owner decision, not an autonomous one.

## Street-graph coverage — OWNER DEFERRED (recorded 2026-09-06)

The sparse road coverage measured above (Cambridge 93% open at 0.8 roadKm/km2,
Charlestown 87%, Fenway 76%, Seaport 71%) is real, is understood, and is **not
an autonomous repair**. Buildings follow parcels and parcels follow roads, so
closing it means authoring tens of kilometres of real Boston street geometry —
content scope, and an owner decision.

**Do not re-audit this every loop.** It has now been measured twice and the
answer will not change until someone authors the streets. Nothing in `src/`
should be changed on account of it, and no approximate street layout should be
invented to fill it.

## Park circulation (2026-09-06)

`src/world/ParkPaths.js` derives the walks inside every authored park. It is
procedural and **Boston-INSPIRED, not surveyed** — no path geometry is authored
anywhere in the project, and none was invented from memory. Everything comes
from geometry the city already owns:

| decides | comes from |
|---|---|
| topology (spine vs perimeter loop) | the polygon's SHAPE |
| character (surface, width, regularity) | the park's `kind` |
| entrances | the street graph |
| clipping | the water rings and the carriageways |

**Shape decides topology, not `kind`, because `kind` cannot see it.** The
Greenway measures 1508 x 377 and the Esplanade 1610 x 130 only because their
own bends widen the box. Both fill under half of it. `shapeOf` calls a polygon
linear at `elongation >= 3` **or** `fill <= 0.45`; a ribbon that fills 17% of
its bounding box is still a ribbon.

Roles: `spine` (ribbon centreline, traced by cross-section sweep), `loop`
(perimeter, from the same `insetPoly` the building setbacks use), `diagonal`
(lawn desire lines between gates), `axis` (formal squares), `shore` (bank walk),
`cross`, `spur`. `plaza` parks get NOTHING — City Hall Plaza and Copley are
already unbroken hardscape, so a path there is concrete on concrete.

Surfaces are `sidewalk` (paved: lawn kinds) and `dirt` (stone dust: formal and
mall). Both are already built for the road atlas, so all nineteen parks'
circulation costs **two draw calls, 8,736 triangles and zero new textures**.

Published as `city.parkPaths` / `city.parkEntrances`. Props exposes
`L.onPath(x, z, pad)` and `L.pathsByPark`; nothing may be planted or placed on
a walk, and park furniture is placed ALONG one.

### The lawn is not the ground

A park path must take its height from the **lawn triangulation**, never from
`terrain.groundHeight`. The lawn is a chord across up to 26 m of terrain, so
over a rise it floats: measured at path samples it sits up to **0.66 m** above
the true ground, and 45% of samples are under a lawn more than 5 cm high. A
path laid on `groundHeight + lift` is buried in grass for nearly half its
length. `Districts._lawnY` samples the triangles `build` just emitted.

### An authored park ring is NOT the park's edge

Several rings are traced around the OUTSIDE of the streets that bound them.
**152 of Boston Common's 254 boundary samples lie within 0.5 m of a road
CENTRELINE**, and all 157 of the Public Garden's are inside a carriageway.
`Districts` compensates by dropping every lawn triangle whose centroid lands on
a road; every other consumer of `parkPolys` must compensate too.

Two consequences, both now handled:

- **Gates** step off the road along its own NORMAL and let the polygon choose
  the side. Reading direction from the ring fails on 60% of the Common.
- **Street trees** test `L.inParkSurface`, not `L.inPark`. Of 939 kerbside
  positions the ring rejected, **938 were standing on real pavement** — the
  tree-lined perimeter of every major park in the city.

Where the grass actually stops was measured and is fine: along every park
perimeter the gap between the back of the footway and the first lawn triangle
is p50 0.0 m and p75 0.0 m, with only 47 of 499 samples over 3 m. The
park/pavement transition is a MATERIAL seam, not a gap.

### Park furniture

`PARK_FURN_PER_HA` is a placement budget and is now **enforced by counting
placements**. It used to bound only the attempt count, so realized density was
whatever the rejection rate happened to leave; biasing candidates onto the
walks raised acceptance and silently added 230 benches and 674 lamps.

72% of candidates come from beside a walk, the rest from anywhere in the park.
Anything drawn from a walk faces it (96.9% of benches, median dot 0.998).
Furniture claims a 2.4 m radius against other furniture as it is placed —
`clear()` cannot do this, it tests street TREE sites and nothing else.

## Tree repetition — CLOSED (2026-09-06)

14 live tree meshes over 7,928 instances is **not** a visible defect. Among the
five nearest neighbours within 22 m, the share that are visible clones — same
mesh, yaw within 15 degrees, scale within 8% — is:

    Back Bay streets 0.14%   Comm Ave Mall 0.17%
    Esplanade        0.22%   Boston Common 0.36%

Same-mesh-regardless-of-pose runs 7.9-15.2%, which is what a small species
palette looks like and is correct. Per-instance rotation and scale already do
the work. Do not multiply stored assets on this evidence.

## Park walk edging (2026-09-06)

Park walks carry a **granite kerb** along their primary circulation. No new
material family was created and none is needed: `granite` is already a
registered surface (tile 2.4 m, `#8b8a86`, roughness 0.78, relief 0.012, ashlar
joints) used by Landmarks and by `stoneTower` trim, and it is the New England
kerbstone the real parks are edged with. Total surface inventory suitable for
park ground — `asphalt`, `asphalt_worn`, `sidewalk`, `sidewalk_brick`,
`cobblestone`, `dirt`, `grass`, `granite`, `limestone`, `concrete`,
`concrete_stained`, `brick_red/brown` — was checked before writing any geometry.

Form: two quads per side per span, a chamfered top from the walk surface out to
the kerb line, then the face down to the lawn. `KERB_W` 0.30 m, `KERB_H` 0.10 m.
Heights come from the same lawn triangulation the walks use.

**Hierarchy is by ROLE.** `loop`, `spine`, `diagonal` and `shore` are primary
circulation and are kerbed; `spur`, `cross` and `axis` stay flush, because a
20 m link to a gate is a way through the grass, not a built street.

**Spans are decimated** — a vertex is kept on a turn over 0.045 rad or a 12 m
run. That is what makes it affordable: 22,688 m of kerb costs 7,240 triangles,
**0.32 tris per metre**, where a flat 3 m span rate would have cost 1.33.

**A kerb may not run across another walk.** Every kerb vertex is tested against
every other path's ribbon on a 24 m hash and the span is dropped. Boston Common's
diagonals cross its loop and each other at 33 points.

## Park walk connectivity (2026-09-06)

More than one connected component per park is usually CORRECT, and a metric
that targets one is wrong. The Rose Kennedy Greenway genuinely is fifteen
pieces with a cross street between each; the Back Bay Fens is nine. Boston
Common and the Public Garden are one each, which is also correct.

What is not correct is a CONNECTOR that connects nothing. Only `cross` and
`spur` runs are eligible to be dropped, and only when they touch no other run.
Spine and loop fragments are left alone.

## Audited and sound — park surfaces (2026-09-06)

- **Path junctions need no hardscape.** The ribbons overlap coplanar, share one
  merged mesh and one material, and carry world-planar UV, so an X reads
  continuous with no z-fighting, no pinched triangles and no grass wedge. Do
  not build a junction paving system for parks.
- **The park/pavement gap** is p50 0.0 m and p75 0.0 m (measured last pass).
- **Kerb geometry**: 0 degenerate triangles, longest edge 17.2 m, triangle
  areas p50 0.75 m2 / max 2.67 m2 — no spikes at any turn in the network.

## Whole-world audit, 2026-09-06 — measured clean

Recorded so the next pass does not re-derive them:

- **Prop grounding on bridges.** 47 props sit more than 1.5 m below a bridge
  deck (Longfellow, North Washington, Mass Ave). **All 47 are explained**: each
  matches the elevation of a surface road passing under the bridge, and zero are
  orphaned. 1,824 props on those decks are correctly on them.
- **The `nearestEdge` elevation trap.** Measuring a prop against
  `nearestEdge -> sample().y` reports every ground family at p99 ~10-13 m and
  max ~13.9 m. That is the buried Central Artery: I-93 North is `bridged` with
  roadY -11.7 m under terrain at +9.3 m, so Greenway surface furniture above
  the tunnel reads as "floating 21 m". Always confirm against the road the prop
  actually belongs to.
- **Road decal density.** 89,486 instances, 1,097 per km over 81.6 km of public
  street, and the per-district spread is 1,010-1,255/km. No starved district.
  `decal_crosswalk/stopBar/arrow/paintFaded` remain at 0 by design.
- **Tree scale.** Heights p50 16.4 m, p95 28.3 m, max 38.7 m. Every one of the
  334 trees over 30 m is IN A PARK; zero are on streets, because `SPECIES` for
  street trees excludes American elm and copper beech. The oversized canopy
  visible from a Back Bay street is a Comm Ave Mall elm and is correct.
- **`payStation` at 18 instances** is not dead content. It is a 12% alternative
  to a run of meters per street face and shares the `meter` budget key, so it
  inherits that key's ~25% acceptance.

## The world sweep (2026-09-06)

`tools/world-sweep/` is the standing detector. `viewpoints.mjs` generates 49
deterministic viewpoints from production geometry and writes `viewpoints.json`;
`sweep.js` steps ONE renderer through them and reduces each frame to a compact
record. Dev-only; nothing in `src/` imports it.

    node tools/world-sweep/viewpoints.mjs > tools/world-sweep/viewpoints.json
    // in the page:
    const { runSweep, outliers } = await import('/tools/world-sweep/sweep.js');

Stratification is by gameplay context, not by area: street 14, junction 10,
park 8, traffic 6, skyline 6, water 5. No district exceeds 22% of the sample.
**Check that distribution before trusting a verdict** — a sampler that drifts
into one neighbourhood is a critic that only knows one neighbourhood.

Rules that matter:

- **Settling is `CaptureHarness.capture`'s job, not the sweep's.** It teleports,
  un-sticks, waits on `settled()` up to 600 frames and advances 60 more, and
  reports `streamed`. Do not reimplement it and do not capture on a fixed frame
  count.
- **Read pixels in the same task as the render.** The context has no
  `preserveDrawingBuffer`; `B.step(1)` then `drawImage` works, anything later is
  black. `B.render` is the pipeline OBJECT, not a function.
- **Rank each view against its OWN category** by median absolute deviation. And
  guard the degenerate case: MAD is zero whenever most of a category shares one
  value, which reported z = 10252 for a frame that was 1.5% clipped.
- **Aim a waterfront camera ALONG the bank.** Pointed out to sea it puts half
  the frame in sky and half in flat water and scores as "empty waterfront"
  whatever is behind it. That cost one false lead.

### `tris` is shadow-inclusive — measured, not assumed

`renderer.info.render.triangles` counts the cascade passes. At `street_12`,
5,074,040 total against **2,194,298 with `shadowMap.enabled = false`**: shadows
are **56.8%** of it, and draws 672 vs 368. So a sweep row reading 5M triangles
is not a budget violation; camera-only is comfortably inside 3.5M. Compare
sweep rows against each other, never against a historical camera-only figure.

## Road stamping is cut AND fill (2026-09-06)

`Terrain.stampRoads` used to be "lowest wins" only. That is correct for a road
CUT into a hill — the ground must never poke up through the asphalt — and does
nothing for a road on an EMBANKMENT, where the street graph's own smoothed grade
runs above the natural surface. Charlestown's drumlin is entirely the second
case, and its roads stood on shelves with a cliff down to the terrain beside
them, up to 13.5 m.

The stamp now also RAISES ground to meet a road above it, on a 1:2 batter capped
at 30 m of run. Two constraints are load-bearing:

- **Never raise a cell inside a water body**, or a road beside a river fills it.
- **Only widen the scan box on edges that are actually above the ground beside
  them**, or the flat 95% of Boston pays for Charlestown. Whole spec chain
  1,091 ms, terrain 256 ms.

Building bases are read from `groundHeight` after the stamp, so they follow it:
all 10,048 sit exactly on the terrain, 0 off by more than a metre.

Measuring this needs care. Sample 6 m outside a corridor and DISCARD samples
that fall inside another road's corridor — on that hill two streets 30 m apart
differ by 17 m, which is Charlestown, not a defect. Without that filter the
metric reports its own confusion.

## Shoreline planting (2026-09-06)

58% of Boston's shoreline had nothing on it: measured over 2,130 stations 12 m
inland, Boston Harbor 75.6% bare, the Charles 56.4%, the Mystic 40.5%, Fort
Point Channel 36.2%. Every vegetation pass keyed off a street segment or a park
polygon, and a riverbank is neither.

`placeShorePlanting` traces the authored water rings and scatters existing shrub
and grass batches in a 2.5-24 m band. It is bounded by what already OWNS the
ground — park, built district, road corridor, parcel — and deliberately NOT by
distance to a street: that bound left the upper Charles exactly as bare as
before, because no road reaches it. Ground cover is not geography.

## The expanded world sweep (2026-09-06)

126 deterministic viewpoints, up from 49. Stratified by the context a player is
in, not by area:

    street 35  junction 22  local 15  park 14  traffic 12  skyline 10
    water 10   special 8

`local` is a <=2-lane residential street in a named neighbourhood — most of
Boston, which a wide arterial cannot stand in for. `special` is where the world
does something unusual and a rule is therefore most likely to be wrong: bridge
decks, the steepest ground beside a road, the sharpest bends, the tallest
setback towers. District spread: park 21, backBay 15, none 15, fenway 12,
beaconHill 10, cambridge 10, charlestown 10, southEnd 9, financial 8, seaport 7,
northEnd 6, water 3 — nothing over 17%. **Check that spread before trusting a
verdict.**

### Poses are terrain-independent

A viewpoint stores `at: [x, z]` plus an `eye` height above whatever the ground
turns out to be, resolved at capture time. Storing an absolute Y made the
canonical set drift under the world — the embankment fix moved ten of the first
forty-nine cameras, one by 11.3 m. A baseline whose cameras move is not a
baseline. Terrain change now surfaces as the `groundY` metric instead.

### Viewpoint ids are POSITIONAL

`street_05` is the sixth street view in whatever set was generated. Regenerating
with different quotas renumbers everything, so **a baseline is only comparable
against the committed `viewpoints.json`**. To follow a specific place across a
regeneration, key on `at`, not on `id`.

### Validation happens at generation

A pose is rejected before it enters the set if it is inside a parcel, in water,
on a carriageway, or if a march along its aim direction hits a parcel within
26 m. That last one matters: `unstick` would otherwise catch it at capture time
by RETREATING the camera, silently relocating the viewpoint — one park camera in
the 0.41 ha Post Office Square was being moved 50 m because its loop aimed at a
tower 17 m away. All 126 now validate with `unstick` moving zero of them.

### Baseline schema and tolerance policy

`tools/world-sweep/baseline.json` — one row per view, ~40 KB. It is layered
deliberately, because Boston has film grain, traffic and pedestrians:

- **Geometric controls** (`groundY`, `roadDy`, `roadName`) — the half that
  cannot move for a benign reason. A road shelf shows up here before any picture.
- **World metrics** (`camDraws`, `camTris`, `shadowPct`, `nBuildings`, `nProps`,
  `nParked`, `nVeg`) — from the systems' own instance data, not from pixels.
- **Image statistics** (`mean`, percentiles, `dark`, `blown`, `detail`, `flat`,
  a 4x3 tile summary) — tolerant, never exact.

**No exact full-frame digest.** A pixel hash is only legitimate on a proven
deterministic capture — a Model Lab fixture, or `capture({holdActors: true})` on
static surfaces. Production traffic scenes have a measured cross-capture
variance of 1.95 by 8x8 block mean against a same-capture floor of 0.46;
requiring equality there manufactures failures.

Classify a difference as EXPECTED (the change being made), BENIGN DYNAMIC
(traffic, pedestrians, grain), SUSPICIOUS (statistically meaningful, no
explanation yet) or REGRESSION (repeatable and attributable). Do not fail a
sweep because a metric moved.

Runtime ~8 s per view, ~18 min for the full daylight pass. Most of that is
`capture()`'s own warmup and settle, which must not be shortened.

## Night washout — attributed and closed (2026-09-06)

The 49-view sweep found one night view clipping 2.1% of its frame. A 25-view
night subset stratified by lamp family settles it:

    cobra  9 views   median blown 0.0002   max 0.0081
    acorn 12 views   median blown 0.0004   max 0.0046
    twin  12 views   median blown 0.0010   max 0.0046

No family repeats and no context repeats; the worst view in the subset is 0.81%.
Re-measured at the original coordinate the same spot now reads **0.0000**, and
its `aheadM` is 12.4 m where the flagged capture had a bus shelter **1.4 m** from
the camera. It was one near-field object catching a lamp, not a lighting fault.

Per the decision rule: isolated, therefore documented and left alone. **Global
exposure, tone mapping and B1/B2 stay closed.**

## Road/ground residual, classified (2026-09-06)

All 349 samples where a road sits more than 3 m from the ground 6 m outside its
corridor:

    C  bridge / tunnel context        212   60.7%
    B  another road's stamp owns it    88   25.2%
    D  still-invalid shelf             45   12.9%
    A  legitimate cut / embankment      3    0.9%
    E  terrain sampling artefact        1    0.3%

**Decide ownership by a road's STAMP radius, not its corridor.** An arterial's
stamp reaches zB + BLEND, about 105 m; the corridor-based version of this rule
mis-blamed 51 samples, because a point 40 m from a street 16 m higher up a hill
sits on ground that street correctly owns.

D is left alone: 45 samples of about 4 m on one arterial, against 13.5 m shelves
before the fill landed. They are not a fill underestimate (per-segment
estimation does not move them) and not water-guarded (420-728 m from any water).
Forcing this metric to zero would mean flattening real Charlestown topography.

## Stable semantic view ids (2026-09-06)

A sweep view is named by the world object it came from, never by its position in
the generated list:

    street:e8@0.51:R     junction:n9:e8      local:e19@0.56:R
    traffic:e35@0.50:L   park:boston-common:loop#0
    water:charles-river-basin:v11            skyline:backBay:h105:r0
    special:bridge:e402

`street_05` used to mean "the sixth street view in whatever set was generated",
so a quota change renamed everything downstream and a per-view baseline stopped
matching in silence. Verified by regenerating with street 35 -> 20 and
junction 22 -> 30: **111 views survived with the same id and zero camera
movement**, 15 removed and 8 added, both detectable. The positional label
survives as `ord` for reading tables and is not the identity.

## The dynamic traversal sweep (2026-09-06)

`tools/world-sweep/routes.mjs` generates 23 canonical routes from production
geography; `traverse.js` drives ONE renderer along them and records structural
telemetry per sample. Routes are named the same way — `walk:sidewalk:e8`,
`drive:grade:e503`, `walk:park:boston-common:diagonal`.

    walk-sidewalk 6  walk-park 4  walk-promenade 1
    drive-arterial 4  drive-curve 2  drive-grade 2  drive-bridge 2
    drive-junctions 2                              3,946 samples, ~9 min

Walk routes sample every 2 m, drive every 6 m, stepping 2 frames per sample.
The sweep deliberately **does not settle between samples** — settling is what
the static sweep does, and a world that is always settled can never show a
streaming hole or a stale LOD. It settles ONCE at the route start so the run
measures movement rather than arrival.

**There is no universal motion score, and there must not be.** Camera motion
changes most pixels by definition, so a frame-to-frame image difference measures
the camera. Everything flagged is structural: an LOD bucket that jumped,
geometry that appeared or vanished, a draw spike, a ground discontinuity.

### Two detector traps, both found by being wrong first

**A jump that reverts is the sampler, not the game.** On the first run 209 of
310 events were `drawJump`. Stepping two extra frames at the same cameras made
every one of them vanish: draws read 794, 792, 783, 772, 771, 769 where the
2-frame sampling had reported a 150-draw, 1.05M-triangle spike at exactly 48 m
intervals. Those are the frames a chunk rebuilt on. `findEvents` now marks a
jump `transient` or `sustained` by whether it is still there two samples later,
and only `sustained` deserves attribution.

**A step is a change of SLOPE, not a slope.** Flagging `|dy|` between samples
reported eleven ground "steps", all of them Bunker Hill Street and Rutherford
Avenue descending smoothly and monotonically — 16 m of fall over 24 m is a
drumlin. The detector now compares against the previous gradient (`groundKink`).

**The shadow cascade alternates by design.** Held perfectly still, draws read
766/761 and triangles 2,480k/2,620k on alternating frames. That is the
documented round-robin refresh in `CascadedShadows` (period 2), it is ±5 draws,
and it is not a defect. Any dynamic amplitude below that floor is noise.
