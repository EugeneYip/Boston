# PAUSE_HANDOFF — Boston, paused 2026-09-13

**This file is written for a successor who has no chat history.** It assumes you are a
coding AI — a different Claude account, ChatGPT, Codex, or anything else — opening this
repository cold. Everything you need to resume safely is in the repository. Nothing here
depends on a conversation, an account, a memory store, or a previous agent.

**Repository + canonical handoff documents are project truth. Chat history is
supplementary evidence only, and you should assume you do not have it.**

---

## A. Current canonical checkpoint

| | |
|---|---|
| Canonical repository | **`/Volumes/Projects/boston`** (external SSD) |
| Checkpoint at pause | **`e9430a52854d5ba190bd4bc78d7d08391dd36f17`** |
| State at pause | `HEAD == origin/main`, working tree clean, 0 ahead / 0 behind |
| Pushes | **manual, by the repository owner** — never push |

**If `/Volumes/Projects` is not mounted, STOP.** Do not fall back to another checkout and
do not recreate Boston elsewhere. `~/Desktop/boston` was renamed `boston-OLD-DO-NOT-USE`
and is stale.

**Do not trust the SHA above — verify it.** Hand-written checkpoints go stale. The
commands in §G are the checkpoint.

---

## B. Why the project is paused

The owner has **intentionally paused active Boston development**. There is no immediate
plan to ship another version, and **no active authorized implementation programme**.

The pause is a decision, not a blockage. The last programme (the Stage 2A factual-road
family) closed cleanly at PASS with known prototype limitations; nothing was abandoned
mid-flight.

---

## C. What is closed, frozen, or negative

### CLOSED — finished, do not reopen without new owner authorization

- **Stage 2A factual-road Back Bay prototype family** — **PASS WITH KNOWN PROTOTYPE
  LIMITATIONS**. Canonical report:
  `research/GIS_HYBRID_WORLD_STAGE2A4_CAUSAL_INFLUENCE_CLOSEOUT_2026-09-13.md`.

### CLOSED NEGATIVE — proven not to work, do not retry from scratch

- **PDDL "Buildings with Roof Breaks" as complete ground-footprint replacement
  geometry.** Roof-break polygons are roof planes, not footprints, and carry only about
  half the procedural building mass. See the Stage 1A / 1A.1 / 1A.2 reports.
- **Repairing the hand-authored Back Bay road frame with a simple global transform or a
  width fit.** The registration error is per-street, not a rotation, scale or datum
  fault. See `research/GIS_HYBRID_WORLD_STAGE1D_ROAD_REGISTRATION_DIAGNOSIS_2026-09-13.md`.

### FROZEN — correct as they stand, do not modify

- The **Northeastern technical programme** (technically closed 2026-09-09).
- The **Stage 2A factual core** — SAM geometry inside the Back Bay core bbox.
- The **default-off candidate** as currently generated.

### BLOCKED — do NOT autonomously resume

- **NPC pedestrian hair raster truth test.** It needs one raster capture on a quiet host
  and was stopped twice by the resource gate. It requires explicit owner authorization
  *and* resource headroom. Details in `AI_HANDOFF.md` §0.

### NOT AUTHORIZED

Stage 2B · citywide factual-road rollout · production default-on · factual road widths ·
factual sidewalks · factual parcels · factual building migration.

---

## D. What remains DEFAULT OFF

The factual-road candidate ships in the repository but **nothing loads it unless a URL
flag is present**:

| flag | effect |
|---|---|
| *(none)* | baseline Boston — hand-authored roads. This is what a player sees. |
| `?gisRoads=1` | factual SAM road backbone in the Back Bay core (prototype) |
| `?gisBackBay=1` | factual Back Bay buildings (separate, earlier prototype) |
| both together | **both disabled**, fail-safe, with a console error |

Default-off parity is proven by fingerprint, not by inspection: the flag-absent city
fingerprint is **`5fa6c6be79473213`**, unchanged across every stage of the programme.
`node research/gis-stage2a/validate.mjs` re-checks it along with 25 other invariants.

**Making the candidate default-on requires a separate owner decision.** Do not do it.

---

## E. Known prototype limitations

These are accepted, documented, and **not defects to go and fix**. Evidence is in the
Stage 2A.4 report (§I, §G, §F) — read there rather than re-deriving.

1. **4 `LEGACY_BOUNDARY_INCOMPATIBLE` ports** — 3 Commonwealth, 1 Fairfield. The factual
   network and the hand-authored geography outside it cannot honestly connect there.
   **Commonwealth's legacy carriageways are drawn on the wrong sides of the mall**
   (inbound is eastbound and belongs south; `boston-geo.js` has it north). Do not "fix"
   the matcher to force a join — the matcher is right and the legacy geometry is wrong.
2. **8 `INTENTIONALLY_TERMINAL` ports** — no legacy counterpart crosses that boundary
   face at all; the factual street simply runs past the edge of the prototype.
3. **11 synthetic transition connectors** (max 65.15 m) — prototype infrastructure,
   labelled `transitionConnector`, explicitly **not** SAM geometry.
4. **A ~0.49 m Huntington lot-phase residual** — mathematically irreducible on a bent
   edge whose two frontages round to 60 and 61 lots. The two lot grids share exactly one
   zero, at arc 0, so no cut preserves both sides.
5. **Derived procedural effects inside the documented influence envelope** — `rayToRoad`
   reaches `cfg.depth * 2 + 12` (80 m in Back Bay), so changing a road legitimately
   moves parcels up to ~60 m away. This is `buildPlots` working correctly, not leakage.

---

## F. Read order for a future AI

Stop as soon as you know whether you are allowed to act. **You do not need to read every
research report before that point.**

1. **`AI_HANDOFF.md`** — cold-start orientation, §0 first.
2. **`docs/PAUSE_HANDOFF_2026-09-13.md`** — this file.
3. **`docs/CURRENT_STATE.md`** — living state, header block first.
4. **`research/GIS_HYBRID_WORLD_STAGE2A4_CAUSAL_INFLUENCE_CLOSEOUT_2026-09-13.md`** —
   the canonical closeout of the last programme.
5. **`AGENTS.md`** — operating rules, resource policy, exact validation commands.
6. **Only then** the detailed documents relevant to whatever the owner has newly
   authorized: `ARCHITECTURE.md`, `CONTRACTS.md`, `research/README.md` for the GIS
   programme index, `docs/CRITIC_REPORT.md` for visual work.

---

## G. Cold-start commands

```bash
mount | grep /Volumes/Projects          # must print a mount; if not, STOP
cd /Volumes/Projects/boston
git rev-parse --show-toplevel           # /Volumes/Projects/boston
git status -sb                          # expect clean
git rev-parse HEAD                      # compare with §A
git rev-parse origin/main
git log --oneline origin/main..HEAD     # unpushed work, if any
git worktree list                       # auxiliary worktrees — do not modify
```

Lightweight validation (static, no rendering, safe on a loaded machine):

```bash
npm run check
```

Regenerate the factual-road candidate deterministically (still default off):

```bash
node research/gis-stage2a3/build-candidate.mjs
node research/gis-stage2a/validate.mjs
```

---

## H. Safe resume procedure

1. Verify `/Volumes/Projects` is mounted. If not — **STOP**.
2. Verify the canonical repository path.
3. Verify `HEAD`, `origin/main`, and the working tree.
4. Read the cold-start documents in §F order.
5. Determine whether the **owner has issued a new authorization**.
6. **If there is no new authorization: STOP.** Report the state and wait. Do not invent
   a programme, do not start "obvious" improvements, and do not resume anything from
   §C just because it is listed there.
7. If the authorized work requires rendering: apply the standing resource gate in
   `AGENTS.md`, and use **one WebGL context at a time**.
8. Preserve the manual-push policy. Never push; never amend, rebase, squash, reset, or
   rewrite history; never modify auxiliary worktrees.

---

## I. Possible future directions — explicitly NOT authorized

Listed so a successor does not have to rediscover them. **None of these is permission.**

- A **transferability study on a second district**. **North End** is the strongest
  candidate: prior factual-building transfer evidence already exists there, and its
  morphology differs sharply from Back Bay, so it would test whether the Stage 2A result
  generalises or is Back Bay-specific.
- Correcting **Commonwealth Avenue's carriageway sides** in `src/data/boston-geo.js`.
  This would make 3 of the 4 incompatible ports joinable, but it edits the hand-authored
  default-off baseline, which no stage has been authorized to touch.
- Deciding whether the **0.49 m Huntington residual** is accepted permanently or is worth
  a different cut policy for bent edges.
- Stage 2B in any form.

---

## J. Do-not-reopen / do-not-assume list

**Do not reopen:**

- Stage 2A seam micro-optimization. The seam is 6.96 m, the residual is fully attributed,
  and `UNRESOLVED` is 0 for both the parcel ledger and the port ledger.
- The closed-negative results in §C. They cost multiple stages each and are documented.
- Northeastern, NPC hair, or NPC pedestrians without explicit authorization.

**Do not assume:**

- That a copied SHA anywhere in the docs is current. Verify with git.
- That `origin/main` has the newest commit. Pushes are manual.
- That runtime figures quoted in older documents are current — many predate the GIS
  programme and are labelled historical.
- That a candidate flag is safe to enable by default. It is not authorized.
- That the previous agent's context is available. It is not. This repository is the
  handoff.
