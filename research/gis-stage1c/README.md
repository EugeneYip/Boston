# Stage 1C workspace — streetwall hybrid (FAIL, before runtime)

Headless analysis only. **No runtime code was produced**: the frozen gate reports zero high-confidence faces,
so there was no defensible transform to implement and nothing to render.

| file | what it answers |
|---|---|
| `sources.mjs` | loads the two ALLOWED sources (PDDL Roof Breaks, MassGIS Structures) and projects them with production `geo()`. Never opens the LEGAL-UNKNOWN DOIT cache. |
| `frames.mjs` | phase 1 — the current procedural streetwall: 43 block faces, ordered by Boston's own frontage chain |
| `envelope.mjs` → `envelope.json` | phases 2–3 — first-hit ray profile and source-to-source agreement |
| `classify.mjs` → `classify.json` | phases 4–5 — per-face metrics, candidate runs, tolerance sweep |
| `roadcheck.mjs` → `roadcheck.json` | the decisive diagnostic: building-line signal, or road-placement artefact? |
| `gate.mjs` → `gate.json` | the frozen gate `stage1c-streetwall/1.0.0` and the classification |

Run order: `sources` → `frames` → `envelope` → `classify` → `roadcheck` → `gate`.

**Result: FAIL.** See `../GIS_HYBRID_WORLD_STAGE1C_STREETWALL_HYBRID_2026-09-13.md`. Two numbers carry it:
the sources agree on the first street-facing wall to within **0.25 m on 79.6%** of Back Bay frontage, and
**21% of factual building area lies inside a Boston road corridor** — six streets have an implied factual
width between −6.3 m and +2.6 m against a procedural 17.5 m. The constraint is real and is expressed in a
frame Boston does not share.
