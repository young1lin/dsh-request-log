# dsh-request-log — Deduplicating Compressed Persistence Layer (v2 Format Design)

Target: src/host/store.ts, src/host/capture.ts, plugin entry src/host/index.ts, wire vocab src/shared/types.ts.
Status: proposal, buildable as specified. All line numbers refer to the current checkout of this repository.

---

## 0. Problem statement, quantified

Each settled provider attempt is persisted as ONE JSONL line holding the FULL CallRecord
(src/shared/types.ts L89–112: request.system, request.messages[], request.tools[],
response.blocks[]). Because every turn resends the whole prior conversation
(RecordedRequest.messages grows monotonically; capture.ts L154–169 projects exactly
system + messages + tools + scalars), the per-file cost of a session grows ~quadratically:
call N carries ≈ N−1 previously-persisted messages again. A few dozen calls therefore reach
the configured ceiling — DEFAULTS.maxFileBytes = 128 * 1024 * 1024 (index.ts L797) — and
users observe 100–190 MB files. Every existing read cost is linear in those raw bytes:
get() reads and splits the WHOLE file (store.ts L373–389), readAll() parses every byte
(L250–267).

Goal: same append-only, crash-tolerant, fail-soft, one-file-per-session model — but bytes on
disk proportional to UNIQUE content, reads independent of history length, v1 and v2 lines
interoperable in one file during transition.

Design decisions are prefixed DECISION.

---

## 1. Exact current behavior (quoted anchors)

### 1.1 Config and caps

- StoreConfig (store.ts L33–42): directory, retentionDays, maxCallsPerSession, maxFileBytes.
- Defaults (index.ts L794–798): retentionDays: 14, maxCallsPerSession: 2000,
  maxFileBytes: 128 * 1024 * 1024. Zod bounds (index.ts L802–811): retentionDays 1..3650,
  maxCallsPerSession >= 1, maxFileBytes >= 1 MiB.
- Path sanitization: fileNameOf (store.ts L50–56) whitelists [a-zA-Z0-9._-], strips trailing
  dots, prefixes Win32 reserved device names (RESERVED_DEVICE_NAME L47).
  File name: <sanitized>.jsonl under dshHomePath('request-log') (index.ts L64).

### 1.2 Write path (store.ts append, L227–248)

1. JSON.stringify(record) + '\n'; byte length via lineBytes (L158–161).
2. Serialized through the per-file promise chain: enqueue (L151–156) tails
   state.queue.then(job); the stored tail swallows errors (next.catch(() => {})) so one
   failure never wedges later appends.
3. Inside the job:
   - ensureDirectory() memoized mkdir (L127–139).
   - If state.poisoned -> repairTail first (L236).
   - stat current size (missing file => 0) (L237).
   - If size + bytes > maxFileBytes -> trimForBytes(sessionId, path, bytes) (L238).
   - writeLine(path, line) -> plain appendFile (L218–220). NO fsync/fdatasync anywhere
     (import list L28). A power loss may drop the tail — tolerated, see §6.2.
   - On ANY error: state.poisoned = true, rethrow (L241–245). Capture logs and continues
     (capture.ts L282–284 fire-and-forget store.append(record).catch(warn)), so the model
     call never breaks.
4. Trimming (trimForBytes, L186–212): reads the whole file UTF-8, splits on newline, pops
   trailing empties, budget = maxFileBytes - incoming (L195), keeps NEWEST whole lines whose
   bytes fit (always keeps >=1 line, L202), tmp+rename path.tmp -> path (L207–209; atomic
   replace, libuv MOVEFILE_REPLACE_EXISTING on Win32), invalidates index cache (L210).
5. Poison flag set ONLY when the job threw — in practice a torn/failed writeLine.

### 1.3 Partial-line repair (repairTail, L168–179)

Reads the file; if it does not end with a newline, truncates to lastIndexOf('\n')+1 bytes and
deletes the cache entry. A half-written record (ENOSPC sim tests/store.spec.ts L319–344 via
the protected writeLine seam / FlakyStore) is discarded; only the torn record itself is lost.

### 1.4 Read path

- Index/poll (entriesOf, L317–353): stat -> cached (mtimeMs,size) match serves entries
  (L325–328). Grew past parsedBytes -> readTail incremental (L331–340). Else readAll full
  (L341–345). Cache bounded to 16 sessions, insertion-order eviction (L347–350).
- Incremental tail (readTail, L276–309): reads only [fromByte,size); null-forces full re-read
  when the file SHRANK below fromByte (trim happened, L282) or short-read; trailing chunk
  without newline stops at last newline, stays unparsed until completed (L290–299).
- Full read (readAll, L250–267): slices to last complete line, splits, parseLine each
  (L98–107): JSON.parse, refuse schema !== RECORD_SCHEMA (L102), silently skip corrupt /
  foreign lines (tests/store.spec.ts L182–195 pin this).
- Detail (get, L373–389): whole-file read; substring prefilter
  needle = '"id":' + JSON.stringify(callId) (L382); verifies record.id === callId (L386).
- Projection: toIndexEntry(record) (src/shared/types.ts L244–284) derives the row (usage,
  finishKind, ttfb/duration, messageCount, toolCalls/calledTools via countToolCalls L214–241
  with TOOL_DISPATCH_SITE regex L189, toolNames, requestChars, responseBlockKinds). Consumed
  by entriesOf; api.ts serves it at GET /dsh-request-log/sessions/:sessionId/calls
  (installApi L145–206; listIndex called L178; page ceiling from store.maxCallsPerSession
  L142) and full records at /calls/:callId (store.get, L192). assignSteps (store.ts L87–95)
  stamps steps after merge.

### 1.5 Retention (sweep, L397–440)

Boot + every 24 h (index.ts L71 SWEEP_INTERVAL_MS, L95–101, timer unref'd L851). Per .jsonl:
stat; mtimeMs < now − retentionDays·DAY_MS -> rm + drop cache (L413–416). Else full readFile
to COUNT lines without parsing (L421–423); lines > maxCallsPerSession -> rewriteLineCapped
(keep newest N, L443–457, tmp+rename); else size > maxFileBytes -> trimForBytes(path, 0)
(L430–433). Trims ride the same per-file enqueue so they cannot race an append into losing
records (comment L427–430). Fail-soft per file (catch, L435–437).

### 1.6 Capture feed

installCapture registers a GLOBAL llm/stream waterfall listener (capture.ts L121–128);
recordAttempt (L171–286) snapshots the request (toRecordedRequest L154–169), fingerprints
{provider,model,request} with requestHashOf sha1-slice12 (L131–133), assembles
response.blocks from block-end chunks (L217–222), settles usage/finish/status (L227–244,
fallbacks L259–276), persists fire-and-forget (L282–284).

---

## 2. V2 record format (mixed-v1-friendly, same append model)

### 2.1 Shape of the redundancy

From types.ts: RecordedRequest = system?: string, messages: RecordedMessage[]
({ id?, role, content: RecordedBlock[], sourceKind? } L31–37), tools?: RecordedToolSchema[]
({name,description,parameters} L13–17), plus scalars. RecordedResponse = blocks, usage,
finish, chunkCount (L77–83). RecordedBlock open ({type}+keys, L25–28); run_code arguments
embed whole programs (tests/store.spec.ts L225–249).

Between consecutive ordinary calls in a session:
- messages prefix [0..k) is BYTE-IDENTICAL (re-serialized session memory) => ~100% redundancy;
- tools and system are stable for most of a session => highly repeated;
- response is unique per attempt (fresh tokens; self-compresses well);
- timing/id/status/usage are small scalars.

So N messages resend per call => quadratic duplication. The dedup unit must be smaller than
"request", coarser than "block".

### 2.2 Chunking unit candidates and the pick

| Candidate | Pros | Cons |
|---|---|---|
| A. per-message hash | Exactly matches resend pattern; blob size 0.1–50 KB; retries share all blobs | ~80 B ref line per message |
| B. response-block-group hash | One hash/call | Responses unique => saves nothing over compression alone |
| C. tools-array hash | Huge win (KB-scale schemas, stable) | Not sufficient alone |
| D. system-prompt hash | Stable, medium size | Not sufficient alone |
| E. whole-request hash | simplest | Never repeats (grows each turn) => zero dedup |

DECISION — chunk by structural piece, hashed over EXACT recorded JSON:
1. m — one per-message blob (A), the workhorse: turn-over-turn history identical by
   construction => each new call persists only genuinely NEW messages.
2. t — one blob for the whole tools array (C): ~one physical copy per session, often shared
   cross-session within a project.
3. s — one blob for the system prompt string (D).
4. r — one blob for the ENTIRE response body (blocks+usage+finish+chunkCount). Blocks NOT
   hashed individually (rejects B at block grain): nearly all unique => finer grain only adds
   refs; retries then share ALL m/s/t objects and differ only in r.

Hash input = exact JSON of the recorded piece (post-safeSnapshot); for m the FULL
RecordedMessage INCLUDING id/sourceKind. Deliberate conservatism: an adapter regenerating
message ids per request degrades dedup silently (duplicate objects persist — correctness and
losslessness intact); hashing only {role, content} could return the WRONG object (an earlier
twin with a different id) — rejected. Algorithm sha256, full lowercase hex identity;
measured ~10 µs per KB-class message vs the JSON.stringify we already pay in append.

### 2.3 Envelope line (self-describing, same JSONL)

V2 continues one-line-one-record JSONL, distinguishable per line by leading key: current
records start {"schema":1,...} (capture.ts L185, recordOf in tests); v2 starts {"v":2,...}.
Readers branch on a single peek — no out-of-band version marker; both schemas stay
first-class forever.

    {
      "v": 2,
      "id": "<uuid>",                 // same semantics as CallRecord.id
      "sessionId": "...",
      "purpose": "compaction",        // optional
      "provider": "...", "model": "...",
      "reasoningEffort": "...",       // optional
      "requestHash": "...", "attempt": 1,
      "timing": {"startedAt": ..., "firstChunkAt": ..., "endedAt": ...},
      "status": "ok",
      "opts": {"temperature": .., "maxTokens": .., "stop": [..]},   // inline scalars
      "refs": [
        {"k":"s","h":"<sha256hex>","z":310},          // system, if present
        {"k":"t","h":"<sha256hex>","z":9021},         // tools, if present
        {"k":"m","h":"<sha256hex>","z":480},          // messages, IN ORDER, duplicates allowed
        ...,
        {"k":"r","h":"<sha256hex>","z":1500}          // response, if settled
      ],
      "sum": {                                        // precomputed projection: almost-CallIndexEntry
        "messageCount": 31, "requestChars": 80213,
        "blockKinds": ["text","tool-call"],           // -> responseBlockKinds
        "toolCalls": 3, "calledTools": [{"name":"run_code","count":1}],
        "toolNames": ["run_code", "..."]
      }
    }

Field-order discipline: id emitted immediately after v so get()'s substring prefilter
(store.ts L382) works unchanged on v2 lines. sum removes ALL traversal of blob payloads from
the list path — toIndexEntry-grade rows materialize from the envelope alone. Missing/unreadable
blob => detail degradation ONLY (metadata + {"unavailable":true}), mirroring capture's
fail-soft fidelity rule for unserializable blocks (capture.ts L217–222); index rows unaffected.

### 2.4 Where hashes live — decided

- Per-file footer: hostile to append-only + torn-tail repair (L168–179) and parsedBytes
  machinery (L276–309). REJECTED.
- Sidecar .idx: doubles crash surface across trim renames; duplicates state indexCache
  already caches. REJECTED.
- Inline refs array in each envelope line: appended atomically WITH the record riding the
  existing chain; self-describing; scan-able.

DECISION — inline refs in each envelope line. Write path stays ONE appendFile of one line;
index projection needs no blob IO; footer/sidecar buys seek speed we do not need because
envelopes are ~0.3–2 KB and bounded by maxCallsPerSession.

---

## 3. Blob storage — DECISION: global content-addressed store (option b)

    $DSH_HOME/request-log/<session>.jsonl            # envelopes (mixed v1+v2)
    $DSH_HOME/request-log/objects/aa/<sha256hex>.drl # 256 fan-out buckets
    $DSH_HOME/request-log/objects/tmp-*              # staging (same volume => atomic rename)

Object bytes: 'DRL1' magic + 1 codec byte (0=identity, 1=deflateRaw no-dict, 2=deflateRaw
seed-dict) + payload.

Why (b) beats (a) single-pack-per-session:

- Atomic writes: CAS objects immutable + uniquely named; concurrent writers of one hash
  produce identical bytes ("last rename wins" = no-op). EBUSY/EPERM on Win32 rename
  (target handle open) recoverable by any later writer. A pack needs offset-table mutation
  synchronized under the per-session chain plus torn-pack recovery of its own.
- Windows fs semantics: temp lives in SAME bucket dir => same-volume rename (cross-volume
  rename copies and is NOT atomic). Content-derived names eliminate contention. Fan-out
  2 hex chars keeps dirs small. Existing code already trusts tmp+rename on Windows
  (trimForBytes L207–209, rewriteLineCapped L453–455).
- GC/retention interplay: objects referenced only by expired sessions must die. Mark-sweep
  attaches to the ALREADY-existing sweep (L397) which readFile's every live file anyway
  (L421): extract "h":"[0-9a-f]{64}" matches into reachable-set; unlink unreachable objects
  older than a grace floor (mtime >= GC-start exempt — defeats append-during-GC race).
  Refcounting rejected: atomic bump paired with non-atomic envelope append is unfixable
  across crashes; mark-sweep derives truth from files alone, restartable for free. Lag
  between envelope-trim and reclaim <= SWEEP_INTERVAL_MS + grace; extra objects inert.
- Code complexity: (b) REMOVES code overall — no offsets, no pack compaction, no torn-pack
  repair; readers just open/read/inflate. Cross-session dedup free (same project => shared
  tools/system/user messages).

Fallback (documented, not implemented): per-session pack can layer later behind the same
BlobStore interface without envelope-syntax change.

---

## 4. Compression

### 4.1 Codec selection for 1–50 KB blobs

Sync one-shots only (write-once-read-rarely; sizes too small to amortize async streams):

- gzip: −18 B container + CRC/ISIZE we do not need (no HTTP transport; blobs are files).
  Excluded.
- brotli: best raw ratio but slower cold decode and custom dictionary would need
  training/bundling. Runner-up.
- node:zlib deflateRaw (CHOSEN): level configurable, default 6; compute rides the decoupled
  persistence leg anyway (capture.ts L278–284 keeps persistence OFF the stream tail).

Empirical (Node 22.18, synthetic record shaped like CallRecord — padded prose + 14-tool
array + run_code program; synthetic padding OVERSTATES absolute ratios; real code/log JSON
should be assumed roughly 1/3–1/2 of these):

  3 records sum 70,026 B raw
   - independent deflateRaw L6 -> 3,409 (~20x)
   - independent gzip6         -> 3,463
   - independent brotli q4     -> 2,892 (~24x)
   - whole-stream gzip6        -> 1,695 (~41x)
  single 24,628 B record deflateRaw L6 -> 1,203 B in 0.28 ms; br q4 1,022 B/0.38 ms; br q6 999 B/1.17 ms

Reading: structural dedup replaces the cross-line context that whole-stream deflate
exploits, so per-record compression + dedup ~= effective 15–50x reduction vs v1 bytes on
history-dominated sessions.

### 4.2 Shared dictionary

Verified empirically on Node 22.18.0: zlib.deflateRawSync(buf, {dictionary}) /
inflateRawSync(x, {dictionary}) round-trip correctly; wrapped deflateSync ALSO accepts the
option without throwing, but raw framing is where dictionary semantics are contractual =>
standardize on deflateRaw/inflateRaw exclusively.

Dictionary bootstrap: repetition that matters at 1–10 KB is JSON scaffolding + tool-schema
boilerplate. Ship DICTIONARY_SEED constant (~8–16 KB common keys/types/tool-description
fragments), codec byte selects dict (1=none, 2=seed). Adaptive/lazy extension optional later.
Measured indicative: small 589 B message with unrelated 8 KB dict -> 137 vs 142 B (no-dict);
benefit concentrates exactly in the 1–10 KB band v2 targets.

Escape hatch: pieces > maxChunkBytes (config, default 32 MiB) store codec 0 (identity).

---

## 5. Read path

### 5.1 List/index (hot, zero blob IO)

entriesOf unchanged mechanically: same (mtime,size) stat gate, same readTail incremental
append, same parsedBytes bookkeeping, same bounded-16 cache. Only parseLine branches:
schema===1 -> legacy path (toIndexEntry); v===2 -> assemble CallIndexEntry DIRECTLY from the
envelope (sum + scalars + assignSteps participation) touching NO blobs. Cold-start today =
readAll JSON.parses up to 128 MB (multi-second poll on first open); v2 cold-start parses
envelopes only = maxCallsPerSession x ~1 KB worst-case, typically well under 1 MB =>
milliseconds, independent of accumulated history.

### 5.2 Detail reads (get)

Locate envelope (needle prefilter intact) -> collect distinct hashes -> parallel
blobStore.get(h) -> inflate -> JSON.parse -> splice request/response -> return plain
CallRecord-compatible object (schema:1 shimmed so API payloads stay stable). Missing blob =>
placeholder {"$unavailable":"<hash>"} at that slot (fail-soft, mirrors unserializable-block
policy).

### 5.3 In-memory caches

- Envelope index: EXISTING indexCache (bound 16, insertion-order evict) — semantics unchanged.
- NEW bodyCache: byte-budgeted LRU over reassembled records (default 64 MiB / 64 entries)
  + separate raw-blob LRU (default 16 MiB) keyed by hash. Blob cache needs NO invalidation
  (content-addressed = immutable); body caches ride the existing stat-gate.

---

## 6. Migration, crash safety, GC scheduling

### 6.1 Modes (Config.format, default 'auto')

- 'v1' — frozen legacy behavior byte-for-byte (kill switch).
- 'auto' — NEW appends are v2; old files convert LAZILY and gradually:
  (i) inherently — every trimForBytes/rewriteLineCapped rewrite emits survivors as v2
  envelopes (those rewrites already re-materialize every kept line); (ii) bounded background
  migrator piggybacked on the sweep cycle + boot pass, oldest-mtime-first, budgeted
  (e.g. <=64 MiB raw/day), one file in flight, riding the file's enqueue chain like
  sweep-trims (L430–433).
- No forced explicit config beyond format:'v1'.

Mixed files first-class forever: parseLine accepts both; rollback to an older binary simply
IGNORES v2 lines via the foreign-schema skip at L102 — degraded view, zero corruption.

### 6.2 Crash-safety ledger (every step restartable)

| Step | Mechanism | After crash/power cut |
|---|---|---|
| Object write | writeFile(bucket/tmp-uniq) then rename (same dir) | orphan tmp (GC sweeps), OR complete immutable object; never partial visible target |
| Blob-vs-envelope order | blobs written INSIDE the enqueued job BEFORE writeLine | persisted envelope references only already-renamed objects; mid-phase failure => record never landed => equals today's loss semantics |
| Envelope append | unchanged appendFile + newline rule | torn tail repaired by repairTail exactly as today (spec L319–344 keeps passing) |
| Lazy migration rewrite | read -> CAS blobs -> build v2 text -> tmp+rename | mid-way crash leaves original INTACT (rename = commit point); restart redoes deterministically |
| Sweep / GC | mark from LIVE files only; grace floor on mtime | missed objects reclaimed next cycle; never deletes referenced data |
| fsync stance | NONE added (matches import surface L28) | post-crash missing recent blobs => placeholders (fail-soft, logged); wrong data impossible — content addressing prevents torn-partial masquerade (magic+frame validation) |

### 6.3 Semantics shifts codified

- maxFileBytes re-pointed at LOGICAL stored bytes attributed to the session = sum(envelope
  line bytes) + sum(refs[].z) over KEPT envelopes (tracked incrementally per cached entry;
  recount on cold load by summation of envelopes only). File-by-stat survives as cheap
  precondition: file bytes <= attributed bytes => crossing it implies breach (early-exit).
- Trim accounting counts an OBJECT once per referencing envelope (shared-blob double-count
  makes per-session budgets an UPPER bound of marginal bytes; disk relief lands when ALL
  referencers trim and GC collects). Documented approximation; trim stays O(envelopes),
  no global coordination.
- maxCallsPerSession UNCHANGED (raw line count — v2 envelopes are lines like v1).

---

## 7. Risks and mitigations

1. Many-small-files pressure (256 dirs x sessions x objects): fan-out + GC; acceptable for
   a dev-machine diagnostics plugin; expose object count via health later.
2. fsync-less durability: unchanged exposure for envelopes; NEW exposure for blobs. Chosen
   deliberately (fail-soft contract, debug-data stakes); escape hatch Config.durability =>
   fh.datasync() after each object rename if losses reported.
3. maxFileBytes semantics drift (external scripts measuring raw size): release note +
   health endpoint exposing both measures; zod min stays 1 MiB.
4. Memory caps: envelope index bound 16 sessions ~= <=32 MB worst; LRUs byte-budgeted;
   decompress inputs gated by declared z sanity ceiling (reject z > maxChunkBytes) against
   zip-bomb inflation from corrupt/tampered files.
5. Multi-process staleness: second DSH instance appending while cached — IDENTICAL exposure
   exists today via the stat-gate; nothing new introduced.
6. Windows rename-vs-open-reader races: benign (unique targets; reader retry; terminal
   failure <=> ENOSPC-class outcome equal to today).
7. Testability seams (mirroring protected writeLine):
   - KEEP writeLine (FlakyStore depends on it).
   - NEW protected putObject/getObject on BlobStore for ENOSPC sims.
   - Injectable Compressor {deflate/inflate} => golden-vector tests with pinned dictionary.
   - now-injection for sweep/GC timing (pattern preserved from sweep(now), L397).
   - Every §1 observable in tests/store.spec.ts must keep passing unchanged: torn-fuse
     semantics (L128–153), trim-then-full-reread (L155–166), sweep delete/trim (L168–195),
     foreign-schema skip (L182–195 — unknown schema/v treated identically), byte-cap bound
     (L346–361 asserts stat.size <= cap => trivially true in v2), sanitization,
     mkdir-on-append, lossless get(). New specs: mixed-line sessions, migration idempotence
     between simulated crash points, GC grace race, LRU bounds, budget accounting.

---

## 8. Pseudocode

### 8.1 Write (append v2)

    async append(record /* CallRecord */): Promise<void>
      const line = buildEnvelope(record)          // split pieces, sha256 each, refs[] planned
      return this.enqueue(record.sessionId, async () => {
        await this.ensureDirectories()
        // 1. materialize blobs (skip puts whose object already present — verified cache/path)
        for (const ref of line.refsPendingBlob()) {
          const out = compressor.deflate(pieceBytes(ref), dictFor(ref))   // deflateRaw L6
          await this.blobStore.put(ref.h, wrapFrame(codec, out))          // tmp+rename, CAS-named
          ref.z = out.length
        }
        // 2. budget trim — same shape as today, logical measure
        const projected = envelopeBytes(line)                            // refs[].z known now
        if (attributedBytes(id) + projected > config.maxFileBytes || rawStatOverCap(path))
          await this.trimForBytesLogical(id, projected)                  // drop oldest ENVELOPES
        // 3. single guarded append (unchanged mechanics)
        try {
          if (state.poisoned) await this.repairTail(path, sessionId)
          await this.writeLine(path, JSON.stringify(line) + '\n')
          state.poisoned = false            // blobs done BEFORE this => no torn-ref case possible
        } catch (e) { state.poisoned = true; throw e }   // blob-phase failures NEVER set poisoned
      })

### 8.2 Read (list + detail)

    parseEntryLine(raw):
      obj = JSON.parse(raw)                       // caller guaranteed complete line
      if (obj.schema === 1) return toIndexEntry(obj)
      if (obj.v === 2)       return entryFromSum(obj)   // pure projection, ZERO blob IO
      return undefined                                   // fail-soft skip (spec-pinned)

    async get(sessionId, callId): Promise<CallRecord | undefined>
      env = scanEnvelopesOnce(sessionId).find(e => e.id === callId)   // needle prefilter intact
      if (!env) return undefined
      const cached = bodyLru.get(cacheKey); if (cached) return cached
      const pieces = await Promise.all(env.refs.map(async r =>
        ({ k: r.k, val: await orPlaceholder(r.h, () => decompressParse(blobStore.get(r.h))) })))
      const out = shimCallRecord(env,
        take(pieces,'s'), take(pieces,'t'),
        pieces.filter(p => p.k === 'm').map(p => p.val), take(pieces,'r'))
      bodyLru.put(cacheKey, out, weightBytes(out))
      return out

### 8.3 Migration (lazy, rides enqueue)

    async migrateFile(sessionId):
      return this.enqueue(sessionId, async () => {
        const text = await readFileOrEmpty(path); if (!text.includes('"schema":1')) return
        const converted = []
        for (const rec of completeLines(text)) {              // torn-tail rule intact
          if (isV1(rec)) {
            for (const piece of splitPieces(rec))
              await this.blobStore.put(hashOf(piece), wrap(compress(piece))).catch(failSoft) // idempotent
            converted.push(buildEnvelopeLine(rec))
          } else converted.push(rec.raw)
        }
        await atomicRewrite(tmpToPath)                        // commit point
        this.indexCache.delete(sessionId)
      })

### 8.4 GC (attached to sweep, after deletion phase)

    async gcObjects(graceMs = 3600000):
      reachable = new Set()
      for each live *.jsonl:                                  // sweep already reads each (L421)
        for m of text.matchAll(/"h":"([0-9a-f]{64})"/g)) reachable.add(m[1])
      for each objects/<xx>/<h>.drl:
        if (!reachable.has(h) && now - stat.mtimeMs > graceMs) rm.catch(() => {})
      for each objects/tmp-*: rm                              // crash debris

---

## 9. Effort map

- src/host/store.ts: parseLine dual-arm; CallStore gains BlobStore + LRUs +
  buildEnvelope/entryFromSum; trimForBytes -> logical variant; sweep gains GC leg + migrate
  hook; append reordered (blobs-inside-chain before writeLine).
- src/host/blob.ts (NEW): CAS put/get, frame codecs, dictionary registry, tmp+rename helpers.
- src/shared/types.ts: RECORD_SCHEMA_V2 = 2, envelope + sum interfaces; toIndexEntry untouched.
- src/host/capture.ts: NO changes (speaks CallRecord; conversion at the store boundary —
  CaptureStore.append signature intact).
- src/host/api.ts: NO changes (endpoints identical; degradation rides record shape).

---

## 10. v3: tree objects

Shipped from docs/superpowers/plans/2026-08-27-v3-tree-persistence.md. This section
supersedes the envelope layout of §2.3; everything else — the object store (§3), compression
(§4), crash ledger (§6.2) — carries over unchanged.

### 10.1 What broke in v2

Measured on a real 830-call store: 17.8 MB of v2 envelope lines indexed 5.14 MB (3,444
objects) of unique blob content — a **3.5× index overhead** overall, 6.8× on the longest
sessions. `refs[]` was **97.6 %** of envelope bytes (57 % on 6-call sessions, 99 % on
135-call ones); the mean line was 26,271 B (max 53,701 B); `Σz` — what `maxFileBytes`
counted — reached 262 MB against those 5.14 MB of real content. The v2 dedup removed
redundancy from message *bodies* and reintroduced it in message *hashes*: every append
re-listed every piece hash of the whole conversation, so envelope bytes grew as
`calls × messages × ~85 B` — quadratic in session length.

A second, independent flaw: `logicalBytesOfLine` summed `refs[].z` per envelope, counting
a shared blob once per referencing record. On the largest real session that attributed
62.82 MB to 5.44 MB of actual disk — **12.4×** — so `maxFileBytes: 128 MiB` began
discarding history at roughly 10 MB of real occupancy.

### 10.2 The v3 envelope

    {"v":3,"id":"...","sessionId":"...","provider":"...","model":"...",
     "requestHash":"...","attempt":1,"timing":{},"status":"ok","opts":{},
     "tree":"<sha256>","resp":"<sha256>","zn":1234,"sum":{}}

- `tree` — hash of a **tree object** naming this call's ordered request pieces (system, the
  whole tools array, each message; canonical order `s`, `t`, `m…`). The response is NOT
  a tree entry — it changes every call, so it rides `resp` and retries share one tree.
- `resp` — the response body's blob hash; absent when the call never settled.
- `zn` — compressed bytes of the objects THIS append created (new pieces, the tree node
  when one was written, the response blob when new). A retry that materializes nothing bills
  0. Exact by construction; this retires the 12.4× over-count above. `logicalBytesOfLine`
  for a v3 line is simply `lineBytes + zn`.

### 10.3 Tree objects

A tree is an ordinary object in the store whose content is JSON in exactly this shape:

    {"t":3,"p":"<parent tree sha256>","e":[{"k":"m","h":"<piece sha256>"}]}

A **delta** (`p` present) adds its `e` entries on top of its parent; a **keyframe**
(`p` absent) carries the complete ordered list. The writer emits a delta only when the new
list STRICTLY EXTENDS the previous one for the same session and the chain depth is under
`TREE_KEYFRAME_INTERVAL` (32); anything else — compaction rewriting history wholesale, a
changed system prompt, a cold or evicted tree cache, a full chain — cuts a keyframe.
Resolution walks parent pointers to the root and concatenates the nodes' entries root-first;
the walk is bounded at `TREE_MAX_WALK` (64) and refuses repeated hashes, so corruption
throws instead of looping or serving a partial list. A failed resolution degrades the whole
request slot at the caller (`[request unavailable: tree <hash> could not be resolved]`),
never a silently truncated conversation.

Why `refs[]` had to go: an inline list cannot stay flat without moving state out of the
line, and per-line independence — a trim that keeps the newest N lines must leave each of
them resolvable alone — forbids putting the chain in the line. The immutable,
content-addressed object store is exactly where shared structure belongs; concurrent writers
converge instead of conflicting.

### 10.4 GC

The mark phase broadened from `"h":"<64hex>"` to any 64-hex string appearing in a line
(over-marking only spares an object from GC; under-marking deletes live data), plus a
transitive walk of every `"tree":"<hash>"` chain: each visited node contributes its own
hash, its parent, and its entries to the reachable set. Failures in the tree-mark stage
surface on `/health` via the sweep status. This shipped BEFORE the first v3 write — a
sweep that cannot see through a tree would delete live pieces.

### 10.5 Migration

Readers accept v1, v2 and v3 lines forever. The lazy migrator converts within its per-cycle
byte budget (newest files first): a v2 line already names its pieces, so conversion needs no
blob reads — `refs` become tree entries and the `r` ref becomes `resp`; v1 lines bake
their pieces first. Both run through one shared tree state per file, so a migrated file gets
the same delta chain a freshly written one would rather than a keyframe per line.
`format: 'v2'` is deliberately absent — v2 was never a release the config needed to pin;
`format: 'v1'` remains the kill switch.

### 10.6 Post-review hardening

An independent review of the v3 landing found seven defects, all fixed together. Grouped by
what they threaten:

**Silent data loss.** A deduplicating `put` writes nothing, so an object keeps its CREATION
mtime however often it is re-referenced — while the GC's reachable set is fixed BEFORE the
append's envelope line lands. An object that only the pending line will reference, and whose
last previous referrer expired in this same sweep, was deleted out from under it. A hit past
half the grace floor now touches the mtime back over the line; the stat the put already
performs is what decides, so the hot path stays at one syscall (measured: ~0.8 ms per append
worst case, every piece stale). Predates v3 — the pre-dedup `put` short-circuited on `has()`
just as early. Staging files were likewise reaped with zero grace, which could delete a
`tmp-*` belonging to a put in flight and fail that bake; they now share the object floor.

**Permanent slot degradation.** `encodeTree` concatenates strings for its canonical key
order, so a malformed entry stringified to the literal text `undefined` — unparsable bytes,
content-addressed, immutable, taking their whole record with them. The encoder now validates
at the only door in, and the v2→v3 migration validates `refs` before building entries and
passes a damaged line through as v2 rather than converting it. Separately, `put`
short-circuits on the stat alone, so an object corrupted in place at the same byte length was
never re-baked: a failed read now DELETES the object, and the next put restores it from the
caller's own copy. A ceiling rejection is explicitly not that proof — lowering
`maxChunkBytes` must never delete objects baked under a higher one.

**Unbounded work.** `inflateRaw` ran without `maxOutputLength`, and compressed length bounds
nothing: 256 MB of zeros frames into 260 KB, well under the ceiling, and expanded fully
before the hash check could reject it (measured RSS +521 MB → +33.6 MB after). Every
deflate-coded object is raw-smaller than `maxChunkBytes` by construction, so that is the
ceiling handed to the inflater.

**Observability.** The store directory is created by the first append, so a fresh install's
BOOT sweep hit ENOENT and published a false error on `/health` for 24 hours; an empty store
now reports a clean cycle. The migration scan swallowed its own read failures, making the
sweep's error branch dead code and hiding a file that can never convert.

**Fairness.** A file that fails to convert is still charged its full size against the
per-cycle budget — correctly, since it was read, and not charging it would let a directory of
failures re-read unboundedly every cycle. But newest-first ordering then handed a stubborn
file at the head of the queue the entire budget, forever. Candidates now sort by consecutive
failure count first, so a failing file keeps retrying at the back of the line instead of
starving every other one.

One reported finding was not a defect: `migrationBudgetBytes` lives on the internal
`StoreConfig`, not on the plugin's `Config` schema, and is not exported from the package
entry — no user-reachable path sets it.

## 11. v4: the object pack store

Shipped from docs/superpowers/plans/2026-08-28-object-pack-store.md. This section adds a
second home for §3's objects — solid-block pack files beside the loose store — without
changing the write path or any crash guarantee: `put` still writes loose objects, and a
pack only ever receives objects the sweep has already verified are reachable and cold.

Two invariants govern everything below, and outrank every optimization:

1. **Incomplete knowledge ⇒ no deletion.** The reachable set is built by reading every
   session file; if ANY error occurred while building it, the cycle skips the object GC,
   the pack phase, and the repack phase (`markComplete: false` on `/health`). Partial
   knowledge marks live data as garbage.
2. **Durability before deletion.** A loose object is unlinked only after both its pack
   block and an index naming it are durable. An old pack is retired only after the
   replacement pack and its index are durable. Duplicated data is free to fix on the next
   cycle; deleted data is not.

Why packs exist, measured on a real 3-day store (2,570 calls, 11,279 objects, 36.64 MB of
raw content): NTFS allocation is a step function — a file ≤ ~700 B lives resident in the
MFT, a file ≥ ~900 B costs a full 4 KiB cluster plus its ~520 B record, and 4,074 objects
in the 700 B–4 KiB band held 6.14 MB but occupied 17.94 MB. 97 % of objects fit in one
cluster whatever their size, so compressing harder cannot fix it; only fewer files can.
Loose, that store's 15.34 MB of deflated content occupied 30.86 MB. And object order
decides 36 % of the compression ratio: the same objects in 1 MiB blocks pack to 6.20 MB
in chronological order versus 9.72 MB in hash order, because consecutive calls re-send
nearly the same conversation — so packing and repacking MUST preserve chronological order.

### 11.1 Layout

    <store>/objects/
      <xx>/<sha256>.drl          loose objects — unchanged, still the only write path
      packs/
        pack-<epochMs>-<rand>.pack    immutable; append-only while active
        pack-<epochMs>-<rand>.idx     sorted index, rebuildable from the .pack
        pack-<epochMs>-<rand>.retired marker: readers skip it, the sweep deletes it

`objects/packs/` is invisible to the loose GC and census: both filter root entries with
`/^[0-9a-f]{2}$/`, which `packs` fails. That isolation means nothing else reaps in here,
so `reapRetired` also clears `tmp-` staging debris past the same one-hour grace floor —
otherwise a crash between an index's write and its rename would leave a file that
accumulates for the life of the store.

**One writer.** The loose store is multi-process safe by construction: content-addressed
writes are idempotent and commit by rename. Packs are not — appending is `open(path,'a')`
plus a write, and two processes doing it at once would interleave into a torn block that
`scanPack` then silently stops at. The plugin runs inside one `dsh web` process per store
directory, which is the assumption this rests on. Reads are safe from any number of
processes; only the sweep writes.

### 11.2 Pack file format

    header (16 bytes)
      0..3    "DRP1"
      4       version = 1
      5..15   reserved, zero

    then a sequence of blocks, each:
      u32be   payloadLength
      u8      codec            1 = deflateRaw (level 9), 2 = zstd (level 12)
      u16be   entryCount       (1..4096)
      entryCount × 40 bytes:
        32    hash, raw bytes (the sha256, not hex)
        u32be rawOffset        offset of this object inside the DECOMPRESSED block
        u32be rawLength
      payloadLength bytes      the compressed concatenation of the objects, in table order

Blocks are self-describing: the entry table sits uncompressed in the block header, which
is exactly what makes an index rebuildable from the pack alone. The block codec is chosen
per build — zstd 12 when the Node runtime exposes `zstdCompressSync`, deflateRaw 9
otherwise — and is independent of the loose store's per-object deflate.

### 11.3 Index file format

    header (16 bytes)
      0..3    "DRI1"
      4       version = 1
      5..7    reserved, zero
      8..11   u32be recordCount
      12..15  u32be packBytes    size of the .pack when this index was written

    then recordCount × 48 bytes, sorted ascending by hash:
      32      hash, raw bytes
      u32be   blockOffset        offset of the block header in the .pack
      u32be   blockLength        total block length including its header
      u32be   rawOffset
      u32be   rawLength

The index is never deserialized into objects: it is held as a `Buffer` and searched with a
binary search over 48-byte records — a 128k-object pack costs 6 MB of RAM, not 128k JS
objects. `packBytes` detects an index that predates a crash-interrupted append: if the
`.pack` is longer than `packBytes`, the tail blocks are missing from the index and the
index is rebuilt from the pack.

### 11.4 Read path

`BlobStore.get`, in order: LRU hit → loose file (today's path unchanged) → `PackStore.read`
(binary-search each loaded index, read the block, decompress — the block LRU is bounded at
16 MB — slice `[rawOffset, rawOffset+rawLength)`, verify the content hash, cache) → a miss
forgets the pack LISTING once (a repack may have landed a new pack since it was cached)
and retries before throwing. A stale cached index is safe: it points into a pack that
still exists until retirement completes, and immutable packs return correct bytes forever.

A miss must forget the listing and NOT the loaded indexes, and loading an index must not
read the pack it describes — only `stat` it, since only the length decides whether the
index is current. Both matter because the miss path is the APPEND path: every object `put`
has not seen before asks the packs first, and the answer is normally no. Conflating the
two made a miss cost 6.30 ms against a 0.17 ms hit on the real store's 10.5 MB pack, and
that figure grows with the store forever.

### 11.5 Write path

Unchanged. `put` still writes loose objects, so every atomicity guarantee of the append
chain survives. `put` gains one lookup: a hash already in a pack returns `{ z: 0, created:
false }` without writing and without `utimes` — a packed object has no mtime to refresh
and is not GC'd by mtime. `putLoose` is the one door around that check, used only by
unpacking: it verifies the content hash before writing (its bytes come straight out of a
pack) and short-circuits when a loose copy already exists, so a budget-interrupted unpack
resumes without recounting.

### 11.6 Packing (sweep phase, after GC)

Candidates are loose objects that are reachable and older than the GC grace floor — the
same window that protects an object whose envelope line has not landed yet. They are
ordered by first appearance in the chronological envelope scan the sweep already performs
(`packingOrder`); anything unreferenced goes last, by hash.

An envelope line names only its tree root and its response body. A call's message pieces
are named INSIDE its tree node, so ranking the line's own hashes ranks a third of the
bytes and leaves the rest tied for last — sorted by hash, the ordering this section says
costs 36 %. `markTreeChains` therefore reports each node's own entry hashes as it walks,
and the sweep expands every line's tree hash into the pieces THAT node introduced. First
occurrence wins in `packingOrder`, and a node's own entries are exactly its call's new
pieces, so this reproduces call order without a second walk. Measured on the real store:
10.55 MB of pack bytes when only the line's hashes were ranked, 7.51 MB with the
expansion. Blocks fill to 1 MiB raw or
4096 entries; the active pack is appended to until it would exceed 64 MiB; at most 64 MiB
of raw content moves per cycle (`packBudgetBytes`, always at least one object so a cycle
makes progress however tight the budget). Then, in this exact order: fsync the pack →
rewrite the index → unlink the loose copies (invariant 2). Creating a pack fsyncs the
DIRECTORY too: syncing a file promises its content survives a crash, not its name, and
the loose copies of everything in it are about to be deleted. The index is rebuilt from
the prior index plus a scan of the buffer just written — an append knows where its own
blocks landed, and reading a 64 MiB pack back to reindex one block would size the phase
by the pack. The pack itself is still the authority whenever the file did not end up the
length the append implies, or the prior index would not load. The whole phase — like the
GC and the repack — runs only when the mark completed (invariant 1).

### 11.7 Repack (sweep phase, after packing)

Packs are immutable, so space inside one is reclaimed by rewriting: a pack whose
reachable entries fall below half (`repackLiveRatio`) and which holds at least 8 MiB
(`repackMinBytes`) is read back in STORED order — order is what the compression ratio
rests on, and a repack that reordered would inflate the store it was called to shrink —
and its live objects are appended into a fresh pack (an all-dead pack needs no
replacement, only retirement). Survivors stream through an 8 MiB chunk
(`repackChunkBytes`) rather than being held at once: a 64 MiB pack decompresses to
several hundred MB, and this runs inside the web server. Their presence is established
first — an index lookup each, no bytes held — so a pack whose survivors cannot all be
accounted for is left exactly as it is; a read that fails after that check leaves
duplicates in the new pack and the old pack still serving, which is the right half to be
wrong about. The old pack is sealed as an append target first (otherwise the
survivors could land in the very pack about to be retired), then marked `.retired`;
readers skip retired packs, and deleting their files is best-effort, retried on later
sweeps — on Windows a reader may still hold the handle.

Reachability lags a trim by one cycle — the mark reads each file BEFORE that cycle's
trims — so the objects of a call the cap has just trimmed stay reachable until the next
sweep, and a pack emptied by a trim is rewritten by a LATER sweep, never the one that
did the trimming.

### 11.8 Unpacking — the rollback door

`pack: 'off'` must not merely stop packing; it must undo it, or the format is a one-way
door for anyone downgrading to a build that cannot read packs. With packing off, each
sweep moves up to `packBudgetBytes` of packed objects back to loose (via `putLoose`) and
retires a pack only once every object it holds is loose again. The unpack phase runs
ungated by `markComplete` — it consults no reachability set and only ever adds copies, so
partial knowledge cannot lose data — and a pack whose objects could not all be read (or
whose budget ran out mid-way) stays exactly as it is, since retiring it would delete
bytes with no loose copy (invariant 2, from the other side).

### 11.9 Configuration

Public (`Config`, zod, README): `pack: 'auto' | 'off'`, default `'auto'`; `'off'` stops
creating packs and gradually unpacks existing ones (§11.8). The knobs `packBlockBytes`,
`packBudgetBytes`, `repackLiveRatio` and `repackMinBytes` live on the internal
`StoreConfig` and are not user-reachable.

