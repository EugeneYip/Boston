# AI_HANDOFF.md — cold-start orientation

You are taking over **BOSTON**, an open-world Three.js game set in a geographically
accurate Boston. This file assumes you know nothing and have only this repository.
It is written to be useful to any coding AI, not just the one that started it.

---

## 0. READ THIS FIRST — canonical repository, checkpoint, status

### Canonical repository
**`/Volumes/Projects/boston`**, on an external SSD.

**If `/Volumes/Projects` is not mounted, STOP.** Do not silently fall back to,
recreate, or use another Boston checkout. Verify at the start of every session:

```bash
mount | grep /Volumes/Projects     # must be mounted
pwd                                # /Volumes/Projects/boston
git rev-parse --show-toplevel      # /Volumes/Projects/boston
git status -sb
```

An older copy at `~/Desktop/boston` was renamed `boston-OLD-DO-NOT-USE` and is stale.
Anything referring to `~/Desktop/boston` predates the migration of 2026-08-31.

### Current checkpoint (2026-08-31)
Local `HEAD` is **`11c02f9`** (B1, the grade highlight shoulder).
The last commit confirmed pushed to `origin/main` is **`19f32f4`** (Wave A).

**Pushes are performed manually by the repository owner.** Do not assume
`origin/main` contains the newest commit, and do not push. Check with
`git status -sb` and `git log --oneline origin/main..HEAD`.

### Where the project stands
The city is geographically real and materially complete: road graph, terrain, water,
buildings with facades and bays, landmarks, props, vegetation, traffic, pedestrians,
a player vehicle and a full HDR post chain. **Visual quality is the active problem,
not content.** The last hostile critic pass scored it **6/10** against the standing
bar (a stranger should not instantly pick it as the browser render rather than GTA V).

Recent completed sequence, newest last:
- SSD migration to `/Volumes/Projects/boston`
- road grit / material attribution investigations
- night lighting and lamp-pool placement (pools were buried under the road surface)
- precipitation rebuilt from clean HEAD
- vehicle headlights and tail lamps (previously: no vehicle emitted any light)
- a static real-light slot floor, so headlights cannot starve street lamps
- fresh critic pass on `9bd5e55`
- **Wave A** road material rebalance — `19f32f4`
- **B1** grade highlight shoulder and overcast black/white points — `11c02f9`

---

## 1. Orient yourself (10 minutes)
Read in this order:
1. `AGENTS.md` — rules, stack, exact validation commands.
2. `ARCHITECTURE.md` — the binding engine contract (coordinate system, system lifecycle,
   performance budget).
3. `docs/CURRENT_STATE.md` — what works, what's broken, what's next. **The single most
   important file. Keep it current.**
4. `CONTRACTS.md` — only the sections for the systems you'll touch.

Then prove the project runs, exactly as in `AGENTS.md`:
`npm install` → `npm run check` (parsecheck AND scopecheck) → `npm run verify`
(HMR-free, port **5290** — use this rather than `npm run dev` for anything you intend
to measure) → check `window.__boston.bootReport.failed` is `[]`, `__boston.glFaults`
is `[]`, `__boston.errors` is `[]`, and `validate().ok` is true.

## 2. How the codebase is shaped
- `src/core/` — engine, event bus, settings, input, geo projection, capture harness,
  profiler. Shared foundation; change carefully.
- `src/gfx/` — render pipeline, materials, sky/clouds/weather/fog, lighting, shadows.
- `src/world/` — city graph, roads, terrain, water, buildings, landmarks, props,
  vegetation, vehicle models.
- `src/physics/` — Rapier world, vehicle dynamics, tire model.
- `src/ui/`, `src/audio/`, `src/ai/`, `src/gameplay/` — as named.
- `src/main.js` discovers systems with `import.meta.glob`. **Drop a new system file in and
  it loads automatically**; a file that doesn't exist yet is simply skipped. This is
  deliberate — it lets many agents build in parallel without breaking each other's boot.

## 3. How this project is built (the loop)
The working method is an autonomous build/critique/repair loop:
1. **Fresh critic or measurement pass** against the current build. Never work an old
   backlog: findings on this project go stale within one or two waves, and several
   whole waves have been spent on defects that had already been fixed.
2. **One narrowly scoped specialist** per defect, owning a disjoint set of files.
3. **The integrating agent independently verifies** the specialist's claims by
   re-measuring, rather than accepting reported numbers. This has caught real errors
   in both directions — including in its own previous commits.
4. **Sequential commit**, one per verified change, with the evidence in the message.
5. Update the continuity docs only if something material changed.
6. **Manual push by the repository owner.**
7. Back to a fresh measurement.

Specialists are expected to **disprove their own briefs** and frequently do. A brief
is a hypothesis; the measurement decides. Say so plainly rather than forcing a target.

**Concurrency is capped for machine safety, not preference — see §7.**

If you are a single agent without the ability to fan out, work the ranked list in
`docs/CURRENT_STATE.md` §Next priorities from the top. It is kept in
highest-leverage-first order.

## 4. Hard-won lessons — do not relearn these
- **`measureFps()` REFUSES BY DESIGN and always will in the embedded preview pane**:
  `document.hidden` stays `true` there even when the pane is visible, so rAF-based
  numbers are meaningless. `engine.perf`, `stats().fps` and `stats().ms` read that same
  throttled cadence and are garbage — one reported 71.74 ms for a frame that genuinely
  cost 6.5 ms. **Measure with short bursts instead; see §6.**
- **Do not A/B-profile by disabling postprocessing passes.** `postprocessing` rewires its
  ping-pong buffers, so removing a pass can measure *slower*. One run produced
  "MotionBlurPass: −33.95 ms". Use `Profiler.prefixCost()`.
- **Do not GPU-sync inside a pass on a tile GPU.** A mid-chain `finish()`+readback forces a
  tile flush costing tens of ms, which lands on whatever you're bracketing. This alone
  manufactured a "clouds cost 66 ms" figure for something that costs 3.6 ms.
- **Chaining `onBeforeCompile` is dangerous.** Two agents independently intercepting it
  caused mutual infinite recursion whose `RangeError` was swallowed by a bare `catch`,
  surfacing only as a shader with 500 duplicate declarations. Any interceptor must return
  a **stable function identity**, guard re-entry, and be **idempotent per shader object**.
- **Vite statically analyses `import('./literal.js')`** and hard-fails on a missing file.
  That's why system loading uses `import.meta.glob`.
- `postprocessing` merges non-convolution effects into one pass; each convolution effect
  needs its own. `autoRenderToScreen` only recomputes when passes are added or removed —
  **not** when you toggle `enabled`, which yields false blacks while bisecting.

## 5. Two attribution lessons that cost multiple waves each

### Road material — measure spatial scale, not magnitude
Three consecutive critic passes described "soft grey metre-scale strokes" on the
carriageway. Two agents "fixed the cracks"; a third nominated a different term. All
were wrong, and so was commit `481c0c1`, which cut `grit` on the strength of a **4x4
block Laplacian**. That metric is a high-frequency detector, so it convicted `grit`
for being fine-scale rather than for causing the strokes.

**The correct discriminator is correlation length**, not difference magnitude. Take
each term's difference field over a fixed rect, subtract the mean, and find the lag
where the normalised autocorrelation drops below 0.5. Wave A (`19f32f4`) established:

| term | before | after `19f32f4` |
|---|---|---|
| macro | 18.68 sd / 256 px | **6.96 / 128 px** |
| chip | 12.57 / 256 px | **10.79 / 16 px** |
| grit | 7.58 / **2 px** | **9.38 / 2 px** |

`macro`'s **2.7 m octave** was the specific offender — value noise on a 2.7 m lattice
makes ~1.35 m features. `grit` is fine aggregate and was always correct.

**Do not let a future agent "fix" the road by cutting `grit` again without new
evidence.** And note that sparse terms such as `oil` and `joint` cannot be judged by
standard deviation in one crop: a critic pass called them inert because they were
absent from the single rect it measured, and they are in fact spatially gated —
`joint` peaks at 76-100 luma against an A/A maximum of 39-64 on other shots.

### Lighting / vehicles
- Vehicle lights attach to the **physical vehicle**, not to the visual LOD. At 22:00
  all ~80 cars have headlights on but at most ten have a visual inside the 82 m detail
  radius, so registering through the visual lit almost nothing.
- All **9 vehicle types have geometry-specific anchors**. A bus on the sedan defaults
  would have its headlights four metres inside itself (z −6.04 against −2.05).
- Release/lifecycle is **leak-tested**: despawning 80 cars returns exactly 320 slots,
  160 pools and 320 glows, and a second cycle leaks zero.
- The **15 promoted real-light slots are scarce**. `STATIC_FLOOR = 6` in
  `LightManager.js` reserves slots for street lamps so headlights cannot starve them.
  Note the mean-luminance signal *inverts* at any floor above zero: a street lamp is
  broad and 7 m up, a headlight is a narrow cone, so a lamp is worth more mean
  luminance than the headlight displacing it. That is a real property, not a bug.
- **Headlight slot churn is NOT a known defect.** It was investigated and did not
  reproduce — 7 of 15 slots never moved across 40 frames.

## 6. Measurement and instrumentation traps — read before quoting any number
- **Raw per-pixel convergence is invalid.** Film grain is re-randomised every frame at
  ~2.3 luma/pixel, so per-pixel metrics never settle. Use **8x8 block or region
  statistics**, and average several frames per state.
- **Bench in short bursts with idle gaps.** A tight `step()` + `gl.finish()` loop
  throttles the machine after ~50-60 frames: a frozen frame read 4.3 -> ... -> 42.9 ms,
  then 4.3 ms again after a four-second idle. Three separate agents wrongly reported
  frame cost as "unmeasurable" because of this. Discard the first burst after a capture
  (shader compilation) and trust two agreeing bursts, never one long median.
- **`capture()` converges** rather than counting frames and returns `settledFrames`; it
  takes **`holdActors: true`** for deterministic captures, and rain still renders in
  that mode. Night and rain shots can need 20-140 frames, so keep any single browser
  evaluation well under its timeout.
- **`freeze()` pauses traffic, vehicles, peds AND weather.** Call `pauseActors(false)`
  to see anything animate — otherwise you may conclude moving geometry is static.
- **Traffic spawns to different positions on every page load**, so vehicle-related
  comparisons must be made *within one load*. The same setting measured +0.003 on one
  load and −0.212 on the next.
- **Use `Lighting.toSun` for solar elevation, not `sun.position`** — the latter
  normalises to a bogus 18-32 degree all-day sun. `toSun` gives 3.8 -> 68.9 -> 3.8,
  correct for 42.4N.
- **`cascadeCost()` is not a whole-frame measurement** — it reports 14.4 ms inside a
  5.3 ms frame.
- **Shadow triangles: drain before recording.** After `shadowMap.autoUpdate = false`
  each cascade's `needsUpdate` accumulates, so the first frame after re-enabling renders
  all of them. Step ~4 frames first, and report a peak *and* a mean over >= 24 frames.
- **No backticks inside GLSL template literals** — a backtick terminates the literal.
  `parsecheck` catches it; run `npm run check` after every edit.
- A hidden or collapsed preview pane used to make all of this impossible: the canvas
  collapsed to 0x0 and the GPU produced nothing, which looked exactly like a dead GPU.
  `Engine.resize()` now floors a degenerate viewport, so this should not recur — but if
  `readPixels` ever returns black, **stop and report it** rather than describing a frame
  you cannot see.

## 7. Resource policy — machine safety
- Maximum **2 agents total**; maximum **1 WebGL/browser-heavy agent at a time**.
- Internal free disk should be **>= 6 GiB** before starting heavy visual work.
- Elevated swap pressure is a reason to avoid fan-out.
- If free disk approaches **4-5 GiB**, stop fan-out, close contexts, converge and commit.
- **Close browser/WebGL contexts promptly** after verification. A hidden context still
  holds a full city scene.

**This is an operating-system safety margin, not a repository storage requirement.**
The repository lives on the external SSD and is small. What consumes the *internal*
disk is macOS swap, AI transcripts, browser/WebGL caches and temp files. A three-agent
wave once created three 1 GiB swapfiles and took the machine to the point where a git
object was corrupted mid-write.

## 8. GitHub and worktree safety
**Before deleting or moving a canonical repository, always inspect:**

```bash
git worktree list --porcelain
```

Auxiliary worktrees under `.claude/worktrees` can contain uncommitted work. A clean
main worktree does **not** mean no auxiliary worktree holds valuable state. Orphaned
work has survived in transcripts and scratch before, but recovering it was expensive.

Historical recovery artifacts from the vehicle-light incident are archived at
**`/Volumes/Projects/Archives/boston-vehicle-lights-recovery/`**. Those are forensic
artifacts, not active source — **do not re-apply that patch to current main**; its
content is already in the history.

## 9. Current open work — prioritised, and what NOT to reopen

### Next
- **B2: dusk hue.** `downtown_dusk` reads magenta rather than amber — mean RGB
  140.1 / 76.7 / 79.4, with **green the lowest channel**. Deliberately untouched by B1.
  Re-confirm it still reproduces before acting.

### Known current defects
- **Rain may now read below the grain floor.** The rebuild closed an automatic fail and
  may have overshot; animating, it adds ~1.65/255 of vertical HF against a ~3.3 grain
  floor.
- **`overcast_wide` flatness is a SCENE defect, not a post one** — the HDR buffer spans
  only 4.8 stops where AgX needs about ten. B1 made the display use the range it has;
  it cannot invent shadow. Owner: lighting/atmosphere.
- **`street_level` sky structure is marginal** (sd 4.86 against a >4 bar). Widening it
  needs lower exposure, which reintroduces other problems.
- Shadow crush: the same grade clamp B1 replaced also crushed shadows. A matching toe
  would fix it but raises the black floor and would undo the night black-crush work in
  `98cad4c`. Left deliberately.
- `ToneMappingEffect({ whitePoint, middleGrey })` in `RenderPipeline.js` is **inert** in
  postprocessing 6.39 — those parameters apply only to Reinhard2. Misleading if tuned.

### CLOSED or artifacts — do NOT reopen without new evidence
- **Headlight slot churn** — instrumentation artifact; did not reproduce.
- **`rain_street` ~20-frame oscillation** — capture/convergence artifact, not a scene
  defect; it was `capture()` declaring convergence ~0.8 luma early.
- **Pale / polystyrene parked kerbside cars** — stale, closed.
- **Night black crush** — closed, 8.66% -> ~3.5% below L=2.
- **`golden_hour` camera inside a wall** — closed; the camera was always rescued, but
  the frame was a facade 14 m away. Being outside geometry is not the same as having
  a shot.
- **"`oil`/`joint` are inert"** — crop-specific claim; they are spatially gated.

## 10. Your first commit
Make a local commit as soon as you have a verified-bootable state, before changing
anything substantial. **Do not push** — the repository owner pushes manually.
