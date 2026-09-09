# Requests tab at scale — handoff and status

Written 2026-09-09 on branch `requests-tab-scale`. This is the entry point
for whoever writes the remaining code; another model implements from here,
and the author of this document reviews.

**Required reading, in order:**

1. `docs/superpowers/specs/2026-09-09-requests-tab-scale-design.md` — what is
   being built and *why*, with the measurements that justify it.
2. `docs/superpowers/plans/2026-09-09-requests-tab-scale.md` — seven tasks,
   each with the actual test code, the actual implementation, the exact
   commands, and the commit message. Follow it step by step. It is the
   contract; this document only says where the work stopped.

`AGENTS.md` outranks both. Read its "design bar" section before proposing
anything the plan does not already specify.

## Where the work stopped

Branch `requests-tab-scale`, cut from `main` at `0237907`.

| Task | State |
| --- | --- |
| 1. Host — model filter + rollup | Steps 1–5 **done and verified**; steps 6–10 (API param, commit) **not started** |
| 2. Client — page by offset | not started |
| 3. Client — derive column floor once | not started |
| 4. Client — model chip row | not started |
| 5. Pure — token buckets | not started |
| 6. Client — bucket x-mode wiring | not started |
| 7. Docs + live re-measurement | not started |

### What is done, precisely

Uncommitted in the working tree (deliberately — the next implementer should
finish Task 1 and commit it as one unit, per the plan's Step 10):

- `src/shared/types.ts` — added `SessionModelTally`; `CallIndexResponse`
  gained `models?`, and its `total` is now documented as the *filtered* count.
- `src/host/store.ts` — added the exported pure `tallyModels(entries)`;
  `listIndex` gained a fourth `model?` parameter, filters before paging, and
  returns `models`.
- `tests/store.spec.ts` — three new specs: model filtering plus rollup, step
  numbering preserved under a filter, and offset paging within a filtered set.

**Verification actually run:** `npx vitest run tests/store.spec.ts` — 81
passed, 0 failed. `pnpm run test` (full typecheck + suite) has **not** been
run since these edits; run it before committing.

### What is next

Task 1 Steps 6–10 in the plan: the `?model=` param in `src/host/api.ts`, its
spec in `tests/api.spec.ts`, then the commit. Note the plan's Step 6 offers to
write a `fakeStore` helper — **do not**. `tests/api.spec.ts` already drives a
real `CallStore` through `seededStore()` / `makeHandler()`; extend that pattern
with a second record under a different model and assert on the response body.
Then Tasks 2–7 in order.

## Traps in this repository and this machine

These are not hypothetical. Each one has already cost time.

1. **A raw NUL byte got written into `src/host/store.ts` by an editing tool.**
   It produced `entry.provider + '<NUL>' + entry.model` — source that compiles
   and passes tests while `file` reports the module as `data` rather than as
   text, and while every `grep` over it answers "Binary file matches". It is
   now an explicit `'\u0000'` escape, which is the intended separator (a NUL
   cannot occur in a provider or model name, so the key cannot collide).
   **After every edit to a source file, verify:**

   ```sh
   file src/host/store.ts     # must say "UTF-8 text", never "data"
   ```

   Do not diagnose this with `grep -c $'\x00'` — bash collapses that to an
   empty pattern and it reports every line as a match. Use `file`, or
   `node -e 'process.exit(require("fs").readFileSync(P).includes(0)?1:0)'`.

2. **Line endings are LF.** On Windows, confirm no tool rewrote a file as
   CRLF before committing.

3. **Host-half changes require restarting `dsh web`.** Client-half changes
   (`src/client/**`) need only a browser refresh, because the server reads
   `lib/client.js` from disk per request. Tasks 1 and 2's host edits will not
   appear on :3080 until the restart.

4. **This checkout is junction-loaded into `~/.dsh/profiles/web`.** Do not move
   the work into a git worktree: it detaches the live `dsh web` on :3080 that
   Task 3 and Task 7 must measure against.

5. `lib/`, `.tmp/`, `.superpowers/`, `coverage/` are build output or scratch —
   never commit them.

## Reproducing the performance measurement

Task 3 Step 9 and Task 7 Step 3 require before/after numbers, because the
repo's commit convention is that a perf claim carries measured ones. The
recipe, against the live `dsh web` on :3080:

- Drive Chromium through the Playwright already installed in the sibling
  project — no new install:
  `file:///C:/PythonProject/learnfolk/apps/web/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs`
  (a bare Windows path fails ESM resolution; the `file:///` URL is required).
- Seed the ledger window before the app boots, via
  `context.addInitScript`, writing
  `sessionStorage['dsh-request-log:view:<sessionId>']` with
  `{ limit: 5000, auto: false, ... }` — `auto: false` keeps the 3 s poll from
  perturbing the measurement.
- Navigate, open the learnfolk session, click the **Requests** tab, then
  `waitForFunction(() => document.querySelectorAll('.rl-row').length > 1500)`.
- Read layout cost from CDP, not from wall clock:
  `Performance.enable` then `Performance.getMetrics`, differencing
  `LayoutDuration`, `RecalcStyleDuration`, `ScriptDuration`, `LayoutCount`.
- The poll's shape is: write one cell's `textContent`, then read
  `.rl-table` `offsetWidth` to force the reflow, twelve times, and take the
  median.

Baseline on `session-deb9aa02` at 2000 rows, for comparison: mount layout
3860 ms, mount script 798 ms, poll reflow 482 ms median / 549 ms max,
resolved tracks `90/134/35/35/51/36/28/46/38/58/26/61`. The target after
Task 3: mount layout ~291 ms, poll reflow ~17.5 ms, **identical** resolved
tracks and no clipped cell — a width that moved means the candidate picker
missed the widest value, which is a bug, not a tradeoff.

## Open decisions the implementer must not settle alone

1. **Stack order.** The bucket bars stack `cacheRead, in, cacheWrite,
   reasoning, out` (cache hits on the floor), as specified by the owner. The
   existing by-time / by-step token modes stack
   `in, cacheRead, cacheWrite, reasoning, out`. Two orders inside one metric
   group is an inconsistency. The plan's conservative default is to leave the
   shipped modes alone. Aligning them is one line in `TOKENS_GROUP.stackOrder`
   — **owner's call.**

2. **`maxCallsPerSession`.** Still unanswered, and time-sensitive.
   `~/.dsh/profiles/web/cordis.patch.yml` sets `retentionDays: 'never'` but no
   call cap, so the default of 2000 applies and the daily sweep deletes the
   oldest records past it (`store.ts` `rewriteLineCapped`). The owner's
   session already lost roughly its first 13 hours, and stood at 2121 records
   — so the next sweep deletes 121 more. Raising the cap prevents recurrence;
   nothing restores what is gone. **No code change here — a config decision.**

3. **Defect C, step renumbering.** `assignSteps` numbers from 1 over whatever
   survives in the file, so after a trim `#N` no longer names dsh's step N —
   this is why the badges stop at `#2071` while dsh reports 3209 steps. Out of
   scope for these seven tasks. Fixing it means persisting the step in the v3
   envelope head at append time rather than deriving it per read. **Owner's
   call whether it becomes an eighth task.**

## What the review will check

Beyond "the tests pass":

- **Every new user-visible string exists in BOTH `zh` and `en`** in
  `src/client/dict.ts`. A string hardcoded in a component is a rejection.
- **Pure helper first, component after.** New logic belongs in a React-free
  module with its own spec mirroring the src path; components stay thin.
  Logic that can only be tested by rendering is a rejection.
- **The column floor stays derived.** Task 3 must not land a hardcoded pixel
  track list. The `var(--rl-tracks, …)` fallback must reproduce today's
  behavior exactly when no measurement has happened.
- **Fail-soft holds.** Nothing added may throw into the capture or write path,
  and a client-side failure degrades to today's behavior, never to a crash.
- **Perf claims carry measured numbers** in the commit body, produced by the
  recipe above — not estimates, and not numbers copied from this document.
- **No raw NUL bytes, no CRLF, no `lib/` in a commit.**
- Tasks stay separately committed, in plan order, with the plan's commit
  messages (edit them if the work diverged — but then say how it diverged).
