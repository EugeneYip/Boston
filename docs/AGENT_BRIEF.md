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
