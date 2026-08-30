# BOSTON — Engine Architecture Contract
**Every agent MUST read this before writing code. Violations break the build for everyone.**

## Stack
- `three@0.171.0` (bare import `'three'`, addons via `'three/examples/jsm/...'`)
- `postprocessing@6.39` (pmndrs) for the HDR effect stack
- `@dimforge/rapier3d-compat@0.20` for rigid-body physics
- Vite dev server on port **5273**. `npm run dev`.
- Plain ES modules. No TypeScript. No JSX. No new dependencies without approval.

## Coordinate system (NON-NEGOTIABLE)
- **Y up.** 1 world unit = **1 meter**.
- **+X = East. -Z = North.** (North is -Z so the minimap reads like a real map.)
- **Origin (0,0,0)** = center of Boston Common, at ground level.
- Sea level = `y = 0`. Ground meshes sit at their real elevation above that.
- Playable area: roughly **x ∈ [-3000, 3000], z ∈ [-3000, 3000]** (6km x 6km).
- Convert real lat/lon with `src/core/Geo.js` → `geo(lat, lon)` returns `{x, z}`. ALWAYS use it;
  never hand-place a real landmark by eyeballing numbers.

## Units & conventions
- Angles in **radians**. Speeds in **m/s** (display km/h or mph in UI only).
- Time `dt` in **seconds**.
- Colors authored in **sRGB** via `new THREE.Color().setStyle('#rrggbb')`;
  renderer output is ACES-tonemapped HDR. Do NOT bake in your own gamma.
- Every light intensity is **physically based** (`renderer.useLegacyLights = false` semantics).
  Sun ~ 3–6 directional intensity, streetlights 20–80 W-equivalent point/spot.

## System module contract
Every subsystem is a class in its own file, default-exported:

```js
export default class TrafficSystem {
  static id = 'traffic';               // unique, stable, camelCase
  static deps = ['city', 'physics'];   // ids that must init first
  async init(ctx) {}                   // build meshes, register bodies
  update(dt, ctx) {}                   // per-frame, variable dt (clamped <= 0.1)
  fixedUpdate(fdt, ctx) {}             // optional, exactly 1/60 s, physics-locked
  lateUpdate(dt, ctx) {}               // optional, after camera solve
  dispose() {}                         // free GPU resources; must be leak-free
}
```

`ctx` (the engine context) exposes:
- `ctx.scene`, `ctx.camera`, `ctx.renderer`, `ctx.composer`
- `ctx.physics` — Rapier world wrapper (`src/physics/PhysicsWorld.js`)
- `ctx.assets` — texture/material cache (`src/gfx/Assets.js`)
- `ctx.settings` — quality settings, live-tunable
- `ctx.bus` — event bus: `ctx.bus.on(evt, fn)`, `ctx.bus.emit(evt, payload)`
- `ctx.get('someId')` — fetch another system instance
- `ctx.time` — `{ elapsed, dt, frame, timeOfDay /* 0..24 */ }`

## Performance budget (hard limits, enforced by the critic)
- **60 fps at 1920x1080** on Apple Silicon integrated GPU.
- **< 1200 draw calls** per frame. Use `InstancedMesh` / merged geometry aggressively.
- **< 3.5M triangles in the CAMERA pass** per frame. LOD everything past 150m.
  Shadow-cascade re-submission is budgeted separately at **< 2.5M**, so total
  `renderer.info.render.triangles` may reach ~6M without being over budget.
  This distinction matters: `renderer.info` counts every pass, so a raw reading
  is *not* comparable to the camera budget. Two agents independently reported
  a "triangle overrun" from the raw number and reached opposite conclusions
  about the cause. Measured at `st_beaconhill`: 4.78M reported = 2.81M camera
  (356 draws, inside budget) + 1.97M shadows.
  To separate them, set `renderer.shadowMap.autoUpdate = false`, render once to
  an offscreen target and read `info` for that render alone. **Never toggle
  `shadowMap.enabled` or `light.castShadow`** — both change shader defines and
  recompile every material in the scene.
  **Drain before you record.** After `autoUpdate = false`, each cascade's
  `needsUpdate` keeps accumulating, so the first frame after re-enabling renders
  *all* of them and reads ~3.0M. Step ~4 frames before recording a peak; a critic
  pass reported an inflated breach from exactly this artefact.
  **Read a peak, not a frame.** Cascades refresh on a round-robin, so per-frame
  totals are multi-modal — at one point the intervals `[1,2,3,4]` all divided
  frame 0, so one frame in six carried every cascade while the median carried a
  third of that. Report peak and mean over ≥24 settled frames.
  Measured 2026-08-30 at `d925cc1`, both **inside** budget: `night_neon` shadow
  peak 2.22M / mean 2.03M against a 2.51M camera pass; `st_beaconhill` 1.75M /
  1.59M against 1.82M. Where the shadow triangles actually come from, attributed
  per cascade by wrapping `renderBufferDirect`: Buildings LOD-0 chunks 45%, Props
  34%, the LOD-2 shell 18% — **not** the shell, which two separate analyses had
  blamed for ~2M. `src/world/Props.js` is now the largest single item: each prop
  type is one city-wide `InstancedMesh`, so its bounding sphere intersects every
  cascade and all 400k triangles are submitted to all three every frame.
- **< 1.5 GB** GPU memory. Textures procedural or <= 1024px, always with mipmaps.
- No per-frame allocations in `update()`. Reuse scratch vectors (module-scope `_v3`).

## Rendering rules
- Nothing writes to `renderer.render()` directly except `src/gfx/RenderPipeline.js`.
- All materials go through `ctx.assets` so they share texture memory and can be
  re-tuned globally (wetness, time-of-day tint, quality level).
- Every surface must have, at minimum: albedo, roughness, normal. Metalness where real.
- Emissive windows/signs are driven by `ctx.time.timeOfDay` via the material registry.

## File ownership
Agents edit ONLY the files they own. To change a shared file, request it in your report
instead of editing. Shared/locked: `src/core/*`, `ARCHITECTURE.md`, `index.html`, `package.json`.

## Definition of done
Your system runs at 60fps, has zero console errors, zero `NaN` in transforms, disposes
cleanly, and **looks photoreal enough that a hostile critic comparing it side-by-side with a
GTA V screenshot cannot immediately call which is the game engine demo.**
