> ## SUPERSEDED — DO NOT FOLLOW THIS FILE'S PATHS OR INSTRUMENTS
>
> Retained for historical context only. Two things in it are actively dangerous:
>
> 1. It points at **`/Users/eugene/Desktop/boston/...`**, which is the OLD checkout,
>    now renamed `boston-OLD-DO-NOT-USE`. The canonical repository is
>    **`/Volumes/Projects/boston`**. See `AGENTS.md`.
> 2. It presents **`measureFps()`** and **`stats().fps` / `stats().ms`** as trustworthy.
>    They are not — they read a throttled rAF cadence and one reported 71.74 ms for a
>    frame that cost 6.5 ms. See `AI_HANDOFF.md` §6 for the instruments that work.
>
> **Read `AI_HANDOFF.md` instead.**

# Agent brief — read this first, every time

You are one of several agents building **BOSTON**, an open-world game in Three.js whose
explicit quality bar is *"a hostile critic comparing your screenshot side-by-side with
GTA V should not be able to instantly pick which one is the browser demo."*

## Before you write a line
1. Read `/Users/eugene/Desktop/boston/ARCHITECTURE.md` — engine contract, coordinate
   system, perf budget. Non-negotiable.
2. Read `/Users/eugene/Desktop/boston/CONTRACTS.md` — the interface you must implement
   or consume.
3. Look at existing code in `src/core/` for house style.

## Rules
- **Only edit files you own.** Listed in your task. Need a change elsewhere? Say so in
  your report; don't reach into another agent's files.
- `npm run dev` is already running on **http://localhost:5273**. Do not start another
  server, do not change the port.
- No new npm dependencies without saying so in your report first.
- Match the existing code style: ES modules, 2-space indent, JSDoc on public methods,
  comments that explain *why* not *what*.
- Everything must dispose cleanly and allocate nothing per-frame in `update()`.

## Verifying your own work (do this — do not hand back unverified code)
The preview tab is usually backgrounded, so `requestAnimationFrame` is throttled to zero.
Never rely on the normal loop when automating. Use the harness:

```js
await window.__boston.ready()
await window.__boston.capture({ shot: 'hero_skyline' })   // parks camera, steps, renders
window.__boston.stats()                                    // { fps, ms, draws, tris, ... }
window.__boston.shotNames()                                // named viewpoints
await window.__boston.capture({ pos:[x,y,z], look:[x,y,z], tod: 19.5, weather:'rain' })
```

Drive it with the browser tools:
- `mcp__Claude_Browser__navigate` to `http://localhost:5273`
- `mcp__Claude_Browser__javascript_tool` to run the harness calls above
- `mcp__Claude_Browser__computer` with `action: "screenshot"` to see the result
- `mcp__Claude_Browser__read_console_messages` with `onlyErrors: true` — **must be clean**

A change isn't done until you have looked at a screenshot of it and the console is clean.

## MEASURING PERFORMANCE — read this before quoting any fps number
A backgrounded tab throttles `requestAnimationFrame` to **zero**, and `capture()`/`step()`
drive frames synchronously. **Neither reflects real performance.** fps numbers taken from a
background tab — in either direction, too low or too high — are meaningless, and quoting one
has already sent this project chasing a phantom twice.

To get a real number:
1. `mcp__Claude_Browser__tabs_select` on your tab to front it.
2. `await window.__boston.measureFps(2)` — it measures the natural rAF loop and refuses to
   report at all if `document.hidden` is true.

Always state the resolution and quality preset alongside any fps figure. The budget is
60 fps at 1920x1080 on the `high` preset.

## Definition of done
- Renders correctly at the named shots relevant to your system.
- **60 fps at 1080p**, within the draw-call and triangle budget in ARCHITECTURE.md.
- Zero console errors, zero NaN transforms.
- Reads as photographed reality, not as a tech demo: real-world proportions, surface
  imperfection, colour variation, correct light response.

## Your report back
Short and concrete:
- what you built, file by file
- measured perf (fps / draws / tris) at the shots you tested
- anything you need from another agent
- what you'd do next with more time
