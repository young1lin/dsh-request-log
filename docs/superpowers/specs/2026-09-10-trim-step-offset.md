# Trim-aware step numbering (defect C) — decided, sequenced after `requests-tab-scale`

Owner decision recorded 2026-09-09 (session handoff review). This is a
specification note, not implemented work: it lands on a branch AFTER
`requests-tab-scale` merges, so the perf work ships without entanglement.

## The defect

`assignSteps` (`src/host/store.ts`) numbers logical turns from 1 over
whichever lines survive in the file. After a trim (`rewriteLineCapped` or
`trimForBytes`), `#1` is no longer the session's first turn — and the reader
has no way to know the numbering restarted. The step badge silently changes
meaning mid-session.

## What `#N` is — and is not

`#N` never claimed to be dsh's step N. There is no dsh step id to persist:
`step` is documented as derived (`src/shared/types.ts`), and the capture
listener only ever sees `GenerateOptions`. `#N` means "the Nth turn I
recorded." The defect is that a trim silently resets that claim.

## The fix (decided)

- Record how many MAIN turns each trim dropped (auxiliary calls consume no
  step, so they contribute nothing to the count).
- Add that count as an offset when `assignSteps` numbers the surviving
  lines: `step = droppedMainTurns + countedSoFar`.
- BOTH trim paths bump it: `rewriteLineCapped` (line-count cap) and
  `trimForBytes` (byte cap).
- Storage: a sidecar next to the JSONL (e.g. `<sessionId>.step-offset` or
  equivalent). A missing sidecar means 0 — exactly today's behavior — so the
  on-disk JSONL format is untouched and needs no migration. Lazy-migration
  rules elsewhere in this repo do not apply because nothing old changes
  shape.
- The offset is per-session and monotonic; it never decreases.

## Known limit

Turns already lost from an existing session are unknowable. `#N` on those
sessions stays wrong whatever this fix does; it only stops NEW drift. This
is the argument for the companion decision that shipped first: raising
`maxCallsPerSession` to 20,000 (measured: 2,034 calls = 5.6 MB objects vs a
128 MB byte cap — the line cap was deleting history ~23× earlier than the
bound meant to bound it).
