# Requests tab at scale: per-model stats, load performance, token buckets

Status: approved 2026-09-09. Extends the ledger and the stats panel
described in README; supersedes nothing.

## Why

Three complaints from the project owner, against a real 2000+ call session
(`session-deb9aa02`, learnfolk workspace):

1. A session whose model changed mid-run reports one merged set of totals.
   There is no way to read one model's usage, and no way to ask for all
   models as a deliberate choice rather than as the only option.
2. The tab is unusable at that size — visibly janky on load and every 3s.
3. The token chart answers "how much had accumulated by step N", never
   "how much did I burn between 14:00 and 14:05".

Investigating (2) surfaced three defects that had not been reported, two of
which destroy or hide data. They are recorded under "Defects found"; only
the reachability bug is in scope here.

## Measurements

Playwright + CDP `Performance.getMetrics` against the live `dsh web` on
:3080, 1600x1000 viewport, the real 2000-row ledger.

| | baseline | frozen tracks |
| --- | --- | --- |
| Mount, tab click to rows settled (LayoutDuration) | 3860 ms | 291 ms |
| Mount (ScriptDuration) | 798 ms | 150 ms |
| One cell edit + forced reflow — the 3s poll shape | 482 ms median / 549 ms max | 17.5 ms / 22.8 ms |
| Scroll, 30 rAF frames (LayoutDuration) | 0 ms | 0 ms |
| Resolved column widths | 90/134/35/35/51/36/28/46/38/58/26/61 | identical |
| Clipped header or body cell | none | none |

Layout, not script, is 5x the cost: `styles.css` sizes twelve `max-content`
tracks across *every* row, so one changed cell re-measures 2000 rows by 12
tracks. The index payload is not implicated — 0.99 MB of JSON for 2109
entries parses in 6 ms, and the host already caches by (mtime, size) and
tail-parses the append.

`content-visibility: auto` was measured and REJECTED: it cuts the poll
further (17.5 to 2.7 ms), but grid item placement is not incremental, so
revealing rows re-runs the whole grid — scroll layout went 0 to 1799 ms over
30 frames. Virtualization is rejected for the reason it was never asked
for: it removes rows from the DOM, and the owner's constraint is explicit
(information must not be hidden). Under the chosen design find-in-page,
screen readers and the chart's `scrollIntoView` all keep working.

## 1. Per-model split

The filter lives on the server, because the client cannot do it correctly:
chips derived from the loaded window would miss a model that has not paged
in, and `total` / "Load older" would count the unfiltered set.

- `store.listIndex(sessionId, limit, offset, model?)` filters entries
  before paging, so `total` is the filtered count and paging walks the
  filtered set. It also returns `models: [{ provider, model, calls }]`
  computed over ALL entries — the chip row is complete however little is
  paged in.
- `api.ts` accepts one new `?model=` param, behind the same trust fence.
- `CallIndexResponse.models?` is optional, so an older host degrades to
  "no chips" rather than to a broken tab.
- The client renders a chip row (all, plus one chip per model) ONLY when
  the session holds two or more models; a single-model session gains no
  control it would never use. The selection persists per session in
  `ViewMemory.model`, coerced like every other stored field.
- Ledger, summary strip and charts all follow the one selection. Splitting
  them would put two different data apertures on one screen.
- Step badges keep their session numbering when filtered (`assignSteps`
  runs before the filter), so `#412` still means turn 412 of the session,
  not "the 12th call of this model".
- `Disk added` stays session-wide — it is a storage fact, not a per-model
  one — and its tooltip says so.

## 2. Performance: derive the column floor once, not per row

The invariant in `styles.css` holds: every column still sits at the width of
the widest thing in it, derived and never declared. It is derived from four
rows instead of two thousand.

- A hidden measuring grid (`repeat(12, max-content)`) holds the header row
  plus three candidate rows built from the widest formatted value per
  column — top-3 per column, because in a proportional font string length
  is only an approximation of width.
- Its resolved `gridTemplateColumns` is published as a `--rl-tracks` custom
  property. `.rl-table` and `.rl-row` both read
  `grid-template-columns: var(--rl-tracks, repeat(12, max-content))`, and
  `subgrid` is dropped — identical explicit track lists align rows by
  construction.
- The `var()` fallback IS the degradation path: before the first measurement,
  and if the measuring effect never runs, the table behaves as it does today.
- A `ResizeObserver` on the measuring grid re-derives on font load, zoom and
  locale switch, so no other code has to know when widths could change.
- `summarize()` is memoized on the calls array; today it re-sums 2000 rows on
  every render, including every scroll threshold flip.

### Reachability (defect A, in scope)

`api.ts` clamps `limit` to `MAX_LIMIT = max(maxCallsPerSession, 50)` = 2000,
while the client pages by growing `limit` at `offset: 0`. A session holding
2121 records therefore serves 2000 forever: "Load older" reports 121
remaining, does nothing when clicked, and never stops offering.

Fix: the client pages by `offset` — it already renders oldest-first and
already anchors scroll on prepend, so it prepends an older page instead of
re-fetching a wider window. `limit` stays at `PAGE_SIZE`, which also removes
the 1 MB refetch from every "Load older". The server clamp stays as its own
guard.

## 3. Token buckets: by time window

A third x-mode on the Tokens group, beside by-time and by-step.

- Bucket sizes 1m / 5m / 10m / 30m as chips, plus a custom minutes field.
  Buckets align to wall-clock boundaries, the rule the axis ticks already
  follow. Empty stretches render as empty buckets: an idle hour must look
  idle.
- Each bar is the tokens consumed WITHIN that window, segmented bottom to
  top: cache-hit, input, cache-write, reasoning, answer. Reasoning and answer
  always sum to the reported output, so the stack top stays billed + output —
  the rule the existing token group already keeps.
- Offered only on the Tokens group (`bucketable`, mirroring the existing
  `cumulable`); switching to Latency or Speed falls back to time mode.
- The cumulative toggle is hidden in bucket mode. A per-bucket sum and a
  running total answer different questions, and time + cumulative already
  answers the second.
- New pure module `src/client/chart-buckets.ts` with
  `tests/chart-buckets.spec.ts`. Legend, tooltip, hover snapping and
  click-to-locate are reused unchanged.

## Defects found while measuring

**A — Reachability. In scope, fixed above.** 121 of 2121 records are
unreachable through the UI and "Load older" is a permanent no-op. Proven:
`?limit=3000` and `?limit=5000` both return exactly 2000 against
`total: 2121`.

**B — Silent data loss. Out of scope; a configuration decision.**
`maxCallsPerSession` defaults to 2000 and the sweep keeps the newest 2000
(`store.ts:886`). In the owner's session dsh reports 3209 steps while the
log's first surviving record is 2026-09-08T04:37Z — about 13 hours after the
session directory was created (Sep 7 23:39). The sweep that ran
2026-09-09T11:54Z reports `trimmedFiles: 1`, and 121 records have been
appended since. The session's first ~13 hours of calls are gone, and the
next sweep deletes 121 more. Raising the cap in the profile's `config:`
block prevents recurrence; it cannot restore what was deleted.

**C — Step badges renumber after a trim. Out of scope; recommended next.**
`assignSteps` numbers from 1 over whatever survives in the file, so after a
trim `#N` no longer names dsh's step N. This is the direct cause of "3209
steps but the badges stop at 2071". Fixing it means persisting the step in
the envelope head at append time (a v3 field, lazily absent on old records)
rather than deriving it per read.

## Testing

Pure helpers first, vitest, mirroring the src layout — the pattern
`AGENTS.md` mandates: `chart-buckets.ts` bucketing and stacking, the
track-candidate picker, the store's model filter and `models` rollup, the
client's offset paging. Components are wired after their helpers pass. The
Playwright measurement above is re-run on the live session and its
before/after numbers go in the commit message, per the repo's convention
that a perf claim carries measured numbers.
