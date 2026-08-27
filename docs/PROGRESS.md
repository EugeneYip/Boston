# BOSTON — build log

Append one entry per critic iteration. Newest at the bottom.

| iter | date | overall | biggest failures | actions taken |
|------|------|---------|------------------|---------------|
| 0 | 2026-08-26 | n/a | Foundation only: engine, HDR post stack, Rapier, capture harness. Placeholder city is a grid of boxes. | Launched wave 1: materials, city/roads, atmosphere, lighting, vehicles, render pipeline. |
| 1 | 2026-08-27 | ~2/10 | Session limit killed all 10 agents mid-work, but 32k lines survived and all 70 files parse. Boot crashed on a `const` decrement in Vegetation (fixed). **City.js was never written** — the orchestrator that publishes `city.plots`/`roads`/`groundHeight`, so Buildings falls back to synthesized parcels and the skyline is untextured boxes. Landmarks.js missing entirely. **5 fps at street level** (636 draws, 3.81M tris) vs 60 fps budget; 24 fps on skyline. Crushed black shadows, blown-out ground, flat cloudless sky, no aerial perspective. | Resumed 6 cut-off agents with targeted priorities (city→City.js keystone, buildings→Landmarks.js + LOD facades, lighting→crushed blacks, atmosphere→missing clouds, materials→albedo calibration, render→per-stage ms audit). Launched a dedicated profiler agent to produce an evidence-backed cost breakdown. Cleaned City-composed helpers out of the loader list. |
