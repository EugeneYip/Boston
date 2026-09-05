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

### Current checkpoint (2026-09-01)
The **static lifecycle audit is closed.** Seven source waves landed on top of B2 —
D1, D4, D5, D2 (+ dependency hardening), D3, D6 — the last being `8e3a825`. The
documentation commit that records them supersedes that SHA. See §9.

**Do not trust this line; verify it.** It is hand-written and has been stale before.
A copied SHA is not a checkpoint — these three commands are:
```
git rev-parse --short HEAD
git rev-parse --short origin/main
git status -sb
```

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
- **B2** dusk hue, magenta to amber — `1beada1`
- **static lifecycle audit** — resource and teardown correctness, seven commits
  through `8e3a825`. No visual change in any of them. See §9.

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

If you are a single agent without the ability to fan out, work **§9 of this file**
from the top. That is the live priority list.

> **Do NOT work `docs/CURRENT_STATE.md` §Next priorities.** That section is an
> **ARCHIVED pre-2026-08-30 performance log**, kept for history. Its numbers are void
> (see `docs/PERF_REPORT.md`), several of its items are already implemented, and its
> top entry would have you trade image quality for frame time that is already free.
> Performance is **not** currently a problem: worst shot ~5 ms against a 16.7 ms budget
> with every budget met.

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

### Dusk grade — the scene was innocent, and the fix direction mattered
`downtown_dusk` read **R > B > G (magenta)** where a real sunset is R > G > B. The
scene was **not** at fault: with `gradeIntensity(0)`, which is a true identity grade,
it already read ~**130.3 / 94.8 / 78.2 — correctly amber**. The time-of-day grade was
removing ~17 points of green everywhere and adding ~10 of saturation. Sky, sun ramp,
exposure and B1's highlight shoulder were all uninvolved. B2 (`1beada1`) changed
**only the 19.7 keyframe**.

Verified before → after: `downtown_dusk` 139.9/76.6/79.3 (R>B>G, sat 53.3%) →
**132.4/88.2/76.6 (R>G>B, sat 46.9%)**, clipping 0.000% both. `golden_hour`
essentially unchanged at 140.7/130.2/127.6, sat 18.1%. `st_southend` clipping stays
0.000% with p99 245.1. `night_neon` mean 46.49, black 3.563% — no material regression.

**The dead end is the important part.** Green was the *minimum* channel, so raising
green fixes the ordering **and** lowers saturation. Lowering blue instead also makes
R > G > B pass — while driving saturation **up** (53.3% → 54.9%) and making the frame
visibly worse. **Do not game the channel-order metric; restore the deficient channel.**

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

**Reading at lifecycle-audit close (2026-09-01):** no WebGL, browser or vite context
was open; internal free ~7 GiB; swap elevated at ~3.35 GiB of 4. Swap did **not** fall
across the audit even though every wave was static/Node-only. Treat these as one
sample, not a new limit — **re-measure before opening a visual/WebGL wave.** The policy
above governs.

**This is an operating-system safety margin, not a repository storage requirement.**
The repository lives on the external SSD and is small. What consumes the *internal*
disk is macOS swap, AI transcripts, browser/WebGL caches and temp files. A three-agent
wave once created three 1 GiB swapfiles and took the machine to the point where a git
object was corrupted mid-write.

## 7b. Deployment — GitHub Pages
Pushing to `main` builds and publishes the site through `.github/workflows/pages.yml`.
No `gh-pages` branch, nothing committed back, `dist/` stays gitignored.

**The base path is not hardcoded.** Boston is a *project* site, so it is served below
`/Boston/`, and `vite.config.js` reads `process.env.BASE_PATH`, which the workflow feeds
from `actions/configure-pages`' `base_path` output. Unset — every local invocation —
means `/`, so `npm run dev`, `npm run preview` and the `:5290` verify server all stay at
the root. A rename, or a move to a user site (where `base_path` is `""`), needs no edit.
`vite.verify.config.js` sets `configFile: false`, so it never reads `vite.config.js` at
all and cannot be affected.

Reproduce the deployed layout locally:
```
npm run build:pages     # BASE_PATH=/Boston/ vite build
npm run preview:pages   # serves the built dist at http://localhost:5291/Boston/
```

**Verified at `/Boston/`:** every asset request 200 with the `/Boston/` prefix, no 404s,
CSS included, and `bootReport.failed []` / `errors []` / `glFaults []` /
`validate().ok true` with a live Rapier world. **No `.wasm` file is emitted at all** —
`@dimforge/rapier3d-compat` inlines it as base64, so there is no WASM fetch to break
under a subpath.

**Known local flakiness, not a deployment problem.** `vite preview` in the embedded
Browser pane often stalls at "Initializing" with no console output and no canvas. It does
this **identically at `/` and at `/Boston/`** — that control is what proves the base is
not involved. Production boot is also genuinely slow (physics 11.4 s, buildings 8.4 s,
city 6.3 s, so ~40 s before the first frame), so give it real time before concluding
anything, and read the console rather than `#stat` for progress. The console buffer
survives navigation, so a "successful" log tail may belong to the previous load.

**One-time repository setting, which no workflow can do for itself:** Settings → Pages →
Build and deployment → Source → **GitHub Actions**. Until that is set the build succeeds
and the deploy step fails.

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
A fresh current-pixels critic ran on 2026-09-01 at `319c092` and its ranked list is in
`docs/CRITIC_REPORT.md`. Its top finding — *night has no highlight range* — was **WITHDRAWN on 2026-09-01 as a
measurement artifact**: p99 153.5 was 8×8 block-mean luma, which averages away sparse
small highlights. Per-pixel max(R,G,B) gives p99 192 / p99.9 251 / max 253 with 0.26% of
pixels ≥240 and no clipping, and the window term supplies ~15% of that population.
**Do not raise night exposure or add windows.** The vehicle entry was then investigated and
also closed: those shapes are `prop:car*` instances from Props, not vehicles, and both
`envMapIntensity` and asset fidelity were disproven as causes — see the report. **Only the
distant-towers entry remains open**, and it is unattributed. Wave 3 of that batch was not
started: macOS expanded swap 5120 → 7168 MiB mid-session, so the batch ended on the
resource rule rather than on findings.

### Daylight hue at `st_southend` — CLOSED, no defect (runtime, 2026-09-01)
Measured on current pixels at `dbcb1d1`, one page load, `holdActors: true`. The old
whole-frame reading reproduces (**R 109.7 / G 103.5 / B 109.5**, M −6.05) — and is
**legitimate scene composition**. Do not reopen it from the whole-frame numbers.

The premise that the pavement classes are "known-neutral" is **false for this scene**,
and that is the whole answer. Both road materials carry their own chroma in the baked
atlas (`src/world/Roads.js`, tile table): asphalt `[0.1079,0.1071,0.1181]` is
**−5.31%** on M/mean, concrete `[0.2866,0.2675,0.2249]` is **+4.53%**. So M on those
surfaces measures the *material*, not the pipeline.

The test that does work is `setAtlas(0, 1)`, which pins albedo to those known means:

| region | albedo M/mean | rendered M/mean | rendered M (0–255) |
|---|---|---|---|
| asphalt, sunlit (n=223) | −5.31% | **−2.96%** | −3.81 |
| asphalt, shadowed (n=11) | −5.31% | **−4.12%** | −3.71 |
| concrete pavement, sunlit (n=35) | **+4.53%** | **+0.66%** | +1.08 |

Every region keeps the **sign** of its input and **shrinks** its magnitude: the pipeline
compresses chroma toward neutral, it does not add a green deficiency. Concrete is
green-*positive* going in and stays green-positive coming out, which a magenta-injecting
pipeline could not do. Sky is B>G>R with **M +2.44** (a blue sky is allowed to be blue);
the upper frame is red brick (R 107.5 / G 93.3 / B 95.7), which is brick's albedo
`[0.3021,0.1114,0.0676]` behaving normally. Whole-frame M is negative because green is
nobody's dominant channel in a red-brick city under a blue sky over grey-blue asphalt.

`gradeIntensity(0)` was run in the same page load for attribution: asphalt M −3.65 →
−2.75, concrete +0.79 → +0.63. The grade contributes about a quarter of asphalt's
deviation and moves the two materials in **opposite** directions — it is acting on each
material's existing hue, not applying a tint. **No source change was made, and the
daylight `ColorGrade` keys were not touched.** Phases 3 and 4 (CPU ablation, GPU
confirmation) were correctly not reached: the gate closed at Phase 2.

**Two traps found while measuring, worth keeping.** Physics raycasting is *not* a valid
proxy for visual sun occlusion here — a ray straight up from the camera hits a
downward-facing collider **1.11 m overhead** (`normal (0,−1,−0.05)`, handle 0) where the
frame plainly shows sky, and using it classified 100% of samples as shadowed. Use
`THREE.Raycaster` over `scene.traverseVisible` meshes instead. And a sampler that closes
over the pixel buffer at definition time will silently return the *first* frame for
every later ablation — three identical result sets is the tell.

### Lifecycle audit (opened after `5f0966d`) — CLOSED
Seven waves, all static/Node-verified, none touching rendering appearance. Each was
re-derived from source before editing rather than taken from the audit report, and the
report was wrong in detail more often than not. **Do not reopen any of these from the
original audit text. Reopening requires new evidence against the current baseline.**

| SHA | Wave | What it actually was |
|---|---|---|
| `cecc01c` | D1 audio | Retired voices left shared noise-source edges connected. 200 churn cycles → **2,222** retained destination edges; now **0**, with live voices still connected and all seven shared kit sources running. Invariant: a voice disconnects only the source→destination pairs it recorded. **Never** call bare `source.disconnect()` on a shared tap. |
| `e5a83a5` | D4 props | Quality rebuild dropped LightManager handles: **20 → 260** registrations over 12 rebuilds; now 20 stable, 0 after teardown. **Correction to the audit:** orphans consumed a real-light *selection candidate*, not a pool quad or halo, and being `F_DYNAMIC` they never touched `STATIC_FLOOR`. |
| `d0bd886` | D5 instrumentation | A throw in `capture()`/`step()`/`measureFrame` stranded the fixed clock delta, a stopped rAF loop, `timeScale`, actor stubs and — unreported — the **camera lock**. Failure injection **13/30 → 0/30**; success paths unchanged. The audit's `pauseActors` double-pause corruption **did not reproduce**. |
| `09ea530` | D2 teardown | `order` is dependency-**first** and dispose walked it forward, freeing providers under live consumers. Now reverse order, best-effort, errors reported after. Also fixed repeat-dispose re-running everything (WASM double-free), renderer double-dispose, and `createMaterialKit.paint()` treating a Materials/Assets-owned carPaint as kit-owned. Vehicle shared geometry needed **no** ownership rewrite — reverse order alone makes Traffic release first. |
| `5141c08` | dep hardening | `Props` now declares `lighting`: its `init()` already calls `lighting.registerLight`, which needs `Lighting.manager`. Init and teardown order stayed **byte-identical**. |
| `af5a3b4` | D3 physics | F2 debug draw replaced both `BufferAttribute`s every frame; three **0.171.0** (verified in `node_modules`) never reclaims a displaced attribute's GL buffer. 300 frames → **300** attribute pairs, now **1**. Growth replaces and disposes the whole geometry explicitly; 400 growing frames → 10 generations, each retired one disposed once. Teardown now also unparents the debug mesh. |
| `8e3a825` | D6 diagnostics | `errors`/`glFaults` were genuinely unbounded `Array<string>`, and a GL fault has historically fired **every frame** for a session. Now 64 slots: first 32, a suppression marker, latest 31. 10,000 appends → 64. |

**Disposition of the original findings** — D1 confirmed; D2 confirmed but mechanism and
scope corrected; D3 confirmed; D4 real, resources overstated; D5 real but narrower and
different in places; **D6a intentional, no change made**; D6b real but far lower
retention severity than implied (strings only — no Error, GL, DOM or system object
graphs were ever held).

**`Engine.dispose()` still has no caller** — no unload, HMR, restart or test path. It
was repaired because its contract is unambiguous, not because it is reachable.

**D6a, explicitly:** the `console.warn`/`error` interception is deliberate
page-lifetime instrumentation. It installs once, keeps the originals in closures and
forwards correctly. **Do not add naive restore-on-teardown logic** — `console.error =
origErr` would silently destroy a wrapper installed later by other code, and there is
no ownership check available to prevent it.

**Residual caveat, carried forward from `5141c08`.** Traffic tears down before Lighting
and Vehicles today only because of **registration order**, not a declared edge. Both
relationships are acquired lazily in `_lazyBuild` *after* system init — deliberately,
per its docstring — so **do not add `Traffic → Lighting` or `Traffic → Vehicles` as
init deps** without real architecture work. The order is safe as it stands; just do not
casually reorder the `OPTIONAL` list in `main.js` without re-checking it.

### Completed
- **B2: dusk hue — DONE, `1beada1`, pushed.** See §5 for the lesson.

#### Daylight-hue candidate — the static trace that preceded the closure

Read-only trace at `2f60c59`, kept as reference. **The candidate is now CLOSED as no
defect** — see the runtime result above. Nothing below is a defect; it is retained so
nobody repeats the trace, and because its predictions were borne out.

**Current static state.** `st_southend` is tod **11.2**, weather **clear**, and grades
between keys **8.2** and **11.6** with `smooth(t)` = **0.9616** — i.e. 96% the midday
key. Effective interpolated look:

| param | effective at 11.2 |
|---|---|
| `shadowTint` | **[0.926, 0.968, 1.103]** — B over G by ~0.135 |
| `midTint` | [0.9985, 0.9996, 1.0027] — effectively neutral |
| `highTint` | [1.029, 1.010, 0.973] — warm, R > G > B |
| saturation | ~0.955 |
| contrast | ~1.131 |
| white balance | temperature ~-0.071, tint ~**-0.021** |

**Attribution result — do NOT "fix daylight tint".** `whiteBalanceGains`
(`ColorGrade.js:339`) is the codebase's magenta axis: positive `tint` raises R
(+0.045), **lowers G (-0.11)** and raises B (+0.055). That is exactly why B2 worked at
dusk, where `tint` ran 0.22. **At daylight the effective tint is NEGATIVE (~-0.021),
so it is slightly green-POSITIVE and structurally opposes the observed deficit.**
Changing it without new evidence would make things worse.

The strongest remaining grade-side hypothesis is **`shadowTint`**, B/G ratio ~**1.139**
applied across whatever shadow area the mask actually covers. **It is a hypothesis, not
a finding.**

**WHOLE-FRAME RGB DOES NOT ESTABLISH A DEFECT.** The observation R 111.5 / G 105.3 /
B 111.2 is *not* evidence of magenta on its own. Warm sun (R>G>B) plus cool skylight
fill (B>G>R) plus blue sky plus red-brown brick plus almost no green material composes
naturally to R > B > G, with green simply being the channel nothing boosts.

**Better metric — on KNOWN-NEUTRAL surfaces only:**

> **M = G - (R + B) / 2**

Near zero means no green deficiency; materially negative means a genuine magenta bias.
Warm light and cool light both leave M near zero, which is precisely why it separates
grading bias from a legitimate warm/cool split. **Do not use whole-frame M** — sky and
material composition confound it. Measure separately on **sunlit neutral pavement**,
**shadowed neutral pavement**, and **sky**. Two isolation mechanisms already exist: the
road material's `setAtlas(0, 1)`, which substitutes each tile's measured mean linear
colour and so gives a known reference, and the sky-dome visibility raycast mask already
used in the dusk work.

**Minimum future experiment — one page load, and step 3 renders nothing:**
1. `capture({ shot: 'st_southend', holdActors: true })` — baseline regional M.
2. `__boston.gradeIntensity(0)` (exists, `RenderPipeline.js:398`) — does the grade
   create the neutral-surface deficit at all?
3. Drive **`gradeCPU`** with the effective 11.2 look on a known-neutral input and ablate
   `shadowTint`, `highTint` and white-balance `tint` **separately, on a copy of the
   look**. CPU only — no shader edit, no extra pass.
4. Confirm only the winning hypothesis with one targeted GPU capture.

**Limitation:** `gradeCPU` omits vibrance and shadowSat and hardcodes the shoulder knee,
so validate its prediction against at least one GPU result before treating it as
authoritative.

**Plausibility ranking:** (1) scene composition / legitimate warm-cool split, possibly
benign; (2) `shadowTint` B/G applied over too much shadow area; (3) blue-sky coverage
contaminating whole-frame statistics; (4) sun colour, which can raise R but does not
obviously explain a G deficit.

**Structurally unlikely or incapable:** AutoExposure (achromatic); daylight white-balance
tint (sign opposes magenta); `midTint` (neutral); `highTint` (warm, not magenta); the B1
shoulder (per-channel, compresses the *highest* channel — B in a sky frame — so it
reduces B>G rather than causing it).

**HOW IT RESOLVED (2026-09-01).** The rule this section set — measure neutral surfaces
before touching any daylight colour parameter — was followed, and the candidate closed as
scene composition. The refinement worth carrying forward is that **the road surfaces are
not neutral**, so the metric had to be run against each tile's known baked albedo via
`setAtlas(0, 1)` rather than assumed. The static prediction above was right: the grade was
not injecting magenta, and daylight `tint` was correctly left alone. Standing traps still
apply: stay within one page load; use block/region statistics (grain never converges
per-pixel); do not assume B2's dusk attribution transfers to daylight; and do not read
whole-frame R > B > G as magenta.

### B1/B2 four-risk sweep — CLOSED 2026-09-01, none require a source change
All four were measured on current pixels at `9fa7a68`, one WebGL context, block/region
statistics. **No source change was made.** Do not re-run these without new evidence.

| # | risk | verdict | evidence |
|---|---|---|---|
| 1 | final grain reintroduces top clipping | **NOT REPRODUCED** | `night_neon`, grain 0.015 vs 0: **0.0000% of pixels at 255 either way**. The ≥250 fraction is identical within noise (0.1432% vs 0.1449%). |
| 2 | no-toe black point zeroes a channel and warms deep shadows | **NOT REPRODUCED, mechanism inverted** | `overcast_wide` has **no pixel below luma 10** at all (min luma 22.6) and **zero pixels with B=0**. The darkest 0.5% is R 14.6 / G 34.9 / B 47.6 — **B−R +33**, i.e. blue, not warm. A uniform black point makes it *bluer* (B−R +40), so staggering reduces the cast rather than causing one. |
| 3 | scene-referred B2 tint interacts with the fixed B1 shoulder | **NOT REPRODUCED** | `downtown_dusk`, `highlightKnee` 0.86 → 1.0: sky **ΔG +0.08/255** against the 2/255 criterion this list set. ΔR +1.78, ΔB −0.04 — the shoulder compresses the top channel (R) as designed and does not touch the newly-raised green. Restores exactly. |
| 4 | rain undoes the dusk correction | **REAL BUT IMMATERIAL** | `downtown_dusk` clear R132.4 / G88.2 / B76.6 (B−G −11.56) vs rain R117.7 / G93.6 / B87.9 (B−G **−5.75**). Rain halves the amber margin but the channel order stays **R > G > B**; the pre-B2 failure was R > B > G. Correction holds. |

The one thing worth carrying forward is #4: rain roughly halves dusk's amber margin. It
is not a defect, but if dusk-in-rain is ever tuned, that is the interaction to watch.

### Known current defects
- **Rain may now read below the grain floor.** The rebuild closed an automatic fail and
  may have overshot; animating, it adds ~1.65/255 of vertical HF against a ~3.3 grain
  floor.
- ~~**`overcast_wide` flatness is a SCENE defect**~~ — **CLOSED 2026-09-01, does not
  reproduce.** Re-measured on the real HDR buffer (`composer.inputBuffer`, HalfFloat,
  decoded per pixel over the whole 1920×1080 frame): **6.33 stops p01→p99**, 6.85
  p0.1→p99.9, 7.08 min→max, with the sky band at median 0.781 against a ground band
  median of 0.0401 — **4.28 stops of sky-to-ground separation**. Display side uses 74%
  of the range with no clipping and no crushed black. The old 4.8-stop figure is either
  superseded by intervening lighting work or was itself measured on a partial frame.
  **Measure the whole buffer**: a `readRenderTargetPixels(0, 0, 480, 270)` corner read
  on this same shot returns 3.15 stops, because it misses the sky entirely.
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
- **The whole static lifecycle audit (D1–D6)** — closed; see §9 for the corrected
  findings. The original audit report is superseded by that table.
- **Daylight magenta at `st_southend`** — closed 2026-09-01 as legitimate scene
  composition, measured on current pixels. The surfaces are not neutral; the pipeline
  compresses chroma toward neutral rather than adding a green deficiency.
- **Physics ground truth** — closed 2026-09-01 by `af773bd`…`c7954f6`: the terrain
  heightfield was transposed about x=z, the road collider had a hole at every junction,
  and Player stood on the terrain raster instead of the drawn surface. See
  `docs/CURRENT_STATE.md` §Physics ground truth for the measurements and the two
  measurement traps. Heightfield *resolution* is not a problem and needs no work.

## 10. Your first commit
Make a local commit as soon as you have a verified-bootable state, before changing
anything substantial. **Do not push** — the repository owner pushes manually.
