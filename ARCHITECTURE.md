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
- **< 3.5M triangles** rendered per frame. LOD everything past 150m.
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
