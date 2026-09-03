# dsh-request-log

**A [DeepSeek Harness](https://www.deepseek.com/harness/) plugin that records every Provider request and response — exactly what was sent, and exactly what came back.**

Each time dsh calls a Provider, the plugin captures the full neutral request payload (system prompt, messages, tool schemas, sampling options) and the assembled response (content blocks, usage, finish reason, timings), persists it per session, and serves a **Requests / 请求** tab in the web UI where you can browse every call and inspect it in four views:

- **Neutral** — the exact provider-neutral capture (what crossed the `llm/stream` boundary).
- **OpenAI ChatCompletion** — `POST /v1/chat/completions` shape (`reasoning_content` for thinking, `role: 'tool'` rows for tool results, `cached_tokens` details).
- **Anthropic Messages** — `POST /v1/messages` shape (`system` blocks, `tool_use`/`tool_result`, `cache_read_input_tokens`).
- **OpenAI Responses** — `POST /v1/responses` in the exact form the harness adapter sends (`store: false`, full `input`, native `reasoning: { effort, summary }`); when the prior call of the conversation is known, an annotation (and the banner) reconstruct what a stateful client *could* have sent through `previous_response_id` — clearly marked as a reconstruction, never as the real request.

A call opens in the view its provider and model imply — **Anthropic Messages** for Claude routes, **OpenAI Responses** for Codex-style ones, **OpenAI ChatCompletion** otherwise — so the first thing you see is the shape that call really took on the wire. **Neutral** is one click away, and whichever view you pick is remembered per session.

The JSON bodies render as a **collapsible tree**: containers fold past depth 2 by default, long strings (a 40KB system prompt) clamp behind a `… +N chars` toggle, and Expand / Collapse buttons control the whole view.

The wire views are reconstructed from the exact capture, mirroring the mapping dsh's pi-ai adapters perform — differences between the views are exactly the differences between the protocols. Adapters resolve some things the neutral boundary never sees (the exact Anthropic thinking mode, thinking signatures, adapter default `max_tokens`); where a detail is unknowable the rendering keeps a **legal** wire shape and marks the gap with a namespaced `_note` — the views show what a real client could have sent, never an invented value.

## Features

- **Every attempt recorded** — including each retry of a failed call (retries are correlated by a request hash and numbered `attempt: N`).
- **Step numbers** — each ordinary call wears a `#N` badge numbering its place in the session's conversation loop (what was called at step 1, step 2, …); retries share their step, auxiliary calls take none. The detail view shows the same step in its call card.
- **Auxiliary calls too** — session-title and compaction calls are tagged with their `purpose`.
- **Usage statistics — 折线图** — a switchable chart panel above the ledger plots every loaded call: cache-hit rate per step (fixed 0–100 % axis), token volumes (in / cache-hit / cache-write / out; a cumulative mode on by default renders as stacked bars of running totals — one column per step, Cursor-dashboard style — and a per-step stacking toggle covers the line view), latency phases (total vs TTFT), output speed; hover for exact values, error/aborted calls draw gaps instead of fake zeros, auxiliary calls stay off the axis (badge counts them). The open state and active metric ride the same per-session memory.
- **Timing** — start time, TTFB (first chunk), and total duration per call.
- **Usage** — input/output/cache-read/cache-write tokens exactly as the provider reported them.
- **Durable** — one JSONL file per session under `$DSH_HOME/request-log/`, with retention (default 14 days, or `never` to keep everything the way dsh keeps its own session logs), a per-session call cap (default 2000), and a per-session byte cap (default 128 MiB, counting each line plus the object bytes that append added; oldest records trimmed first).
- **Fail-soft** — capture and storage failures never break a model call; a partially-written line is repaired on the next append; the read API is optional (a headless composition simply skips it).
- **Fenced** — the read API serves the loopback host (plus any `trustedHosts` you configure) only; DNS-rebinding and cross-site requests are refused before any read, and a loopback-named `Host` is honored only when the connection itself is loopback (a LAN peer cannot spoof it).

## Privacy

**This plugin persists the complete plaintext of every model call** — your full prompts, conversation history, tool schemas, model outputs, reasoning traces, and the provider's own failure text (common credential shapes in it are redacted on capture, but treat it as sensitive anyway) — under `$DSH_HOME/request-log/`, kept for `retentionDays` (default 14; `never` keeps files indefinitely). The content lives in two places: the `<sessionId>.jsonl` envelopes and the deflate-compressed objects in `objects/` — compression, not encryption. **Deleting a session's `.jsonl` does not erase its content**: the objects stay until a sweep's GC reclaims them, and once the plugin is uninstalled no sweep ever runs again — to erase everything, delete the whole `request-log` directory.

Anyone with access to that directory can read it all; files are created owner-only where the platform honors modes, but assume no more than the directory itself grants. The read API serves the loopback host plus any `trustedHosts` you configure — **every trustedHosts entry is an unauthenticated grant of the full transcripts to every device that can reach that authority**. When the harness web server is bound to a non-loopback interface, remote peers are refused unless they arrive under a configured trusted host: a spoofed loopback `Host` header does not pass, because loopback trust rests on the connection, not the header. Images are recorded as attachment references only, never bytes. Control everything with the `directory` / `retentionDays` / `maxFileBytes` / `maxCallsPerSession` settings below.

## Install / Update

```sh
dsh plugin --profile web add dsh-request-log
```

Or to update:

```sh
dsh plugin --profile web update dsh-request-log@latest
```

Then start the web UI with `dsh web` (restart it if it was already running) and open any session's **Requests** tab.

## Use it

Open any session and click the **Requests / 请求** tab:

- The list is a chronological ledger — the newest call sits at the bottom (like the Trajectory tab), with status dot, model, step badge (`#N`), finish reason, TTFB / total latency, token counts, and a messages/tool-cells column where the tool number counts **invocations** — the tool-call blocks the response made, with a `run_code` program's inner `tools.x(...)` dispatch sites standing in for the transport call (hover for the per-tool breakdown). It loads the newest 100 calls first and a **Load older** button pages in the rest (your scroll position is anchored while older rows prepend); retries show a `×N` badge; auxiliary calls show their purpose.
- **Disk added** — the summary strip's last tile is what this session added to the store (envelope lines + the compressed objects its appends created), with the split and its share of the per-session cap on hover. Marginal, not the transcript's weight — a retry adds 0, and pieces two sessions share bill to whichever wrote them first.
- **Auto** refreshes the list every 3s while the session is running (paused while the tab is hidden). A transient refresh failure keeps the loaded data and shows a stale-data banner instead of clearing the ledger.
- **统计 / Charts** — a toggleable panel above the ledger switches between four per-call line charts: **Hit rate** (each step's cache-read ÷ billed input, on a fixed 0–100 % axis — cold starts, post-compaction drops and error gaps are all visible at a glance), **Tokens** (in / cache-hit / cache-write / out — a **累计 / Cumulative** toggle, on by default, switches to stacked bars of running totals: one column per step whose height is the cumulative usage so far and whose color segments break it down by token kind, like the Cursor usage dashboard; error steps that reported nothing carry the total forward instead of punching a gap, hovering a column shows each series' cumulative total plus what that step added, and legend chips drop a series from the columns entirely. With cumulative off, per-step lines return and the **Stacked** toggle piles them per step), **Latency** (total vs TTFT), and **Speed** (output tokens/s of the stream phase). Hover anywhere for exact values (crosshair + tooltip); calls that never reported usage draw gaps, never fake zeros.

  A **按时间 / 按步骤 (By time / By step)** toggle picks the x axis, and the choice rides the same per-session memory. **By time** is the default: every call sits at its real wall clock, so a burst of calls clusters tight and an idle hour is a visible stretch of empty axis — the shape of *when you asked for what*. Ticks land on local wall-clock boundaries (and carry the date once the span leaves one day); each retry attempt plots separately, because in time a retry is another request; and compaction / session-title calls join the chart, since a compaction is usually what explains a hit-rate cliff. Cumulative totals render as a stacked **area** here — columns would take their width from neighbour spacing and draw 1px slivers inside a burst. **By step** is the numbered axis: every conversation turn gets equal width and a `#N`, retries collapse into the step they retry, and auxiliary calls drop off the axis (an ⓘ badge counts them).
- Click a row to open the detail view: a summary card (provider, model, effort, timing, usage, finish) plus the full request/response JSON — switch between the four views (it opens on the protocol detected for that call, not on Neutral), toggle line wrapping, or copy the JSON.
- **Your place is kept** — the tab only renders while active, but per-session view memory (in-page + `sessionStorage`) reopens the call you were viewing, its request/response side and format, the paged-in window, and the Auto toggle when you switch tabs — or even refresh the page. Each session remembers its own view.

## How it works

- **Capture** — a transparent `llm/stream` waterfall listener. Every real attempt (retry attempts re-enter the waterfall) is recorded and passed through unchanged.
- **Storage** — one JSONL line per settled attempt, appended to `$DSH_HOME/request-log/<sessionId>.jsonl`. Each line is a **v3 envelope** carrying one **tree** hash that names the whole ordered request piece list, the response body's hash, and `zn` — the compressed bytes that append actually materialized in the object store. Bodies and trees both live in the git-style content-addressed object store (`objects/<xx>/<sha256>.drl`, deflate-compressed); a tree is a *keyframe* holding the full piece list, after which each turn writes a small *delta* naming only the pieces it added (chained by parent pointer, re-keyframed every 32 nodes), so the envelope line stays **flat** however long the session runs — over a real store's 2,570 lines: 774 B median, 656 B min, 1,147 B max, and the longest session's 164th line (722 B) is no bigger than its first (778 B). What remains is the fixed part, not history: in a 702 B line, 200 B of usage counts, 146 B of hashes, 89 B of timings, the rest ids and model. v2 instead re-listed every message hash per line and grew linearly with history (97.6 % of envelope bytes on a real store). `zn` also makes the byte cap track materialized content exactly: a piece already on disk bills nothing, a retry bills 0 — which also means pieces two sessions share bill to whichever wrote them first. Reads stay cheap: list pages project from the envelope alone; only the detail view resolves the tree (a bounded parent walk) and reassembles blobs. **On-disk occupancy runs higher than the content figure — until the sweep packs it:** 97 % of objects are ≤ 4 KiB and so occupy a full filesystem cluster whatever their compressed size, so budget roughly 2× the compressed size while objects are loose — on one real store (2,570 calls), 11,279 objects storing 15.34 MB occupied 30.86 MB loose. The sweep's pack pass then moves cold objects — reachable, and older than the GC grace floor, so a pending append can never lose its body — into immutable solid-block pack files under `objects/packs/` (1 MiB blocks; a pack file grows to 64 MiB), ordered by the call that first introduced each object — the pieces come out of the tree nodes, since an envelope line names only its tree and its response body — because neighbouring calls re-send nearly the same conversation and order alone swings the packed size by 36 %, and unlinks the loose copies only after the pack and its index are both durable. The same store swept: 7.51 MB of pack bytes plus a 0.52 MB index across 37 solid blocks — ~1.0× occupancy, no cluster slack — and a detail read touches p50 4 / p90 6 blocks (max 9: many sessions interleave, so a conversation's pieces scatter) in the ~8 ms class. A pack at least 8 MiB in size whose live share falls under half is rewritten without its dead weight, and `pack: 'off'` is the way back out — it stops packing and gradually unpacks existing packs to loose objects, so the format is never a one-way door. Packs (like the JSONL layer) assume **one writer process per store directory**: two `dsh` processes sweeping the same `$DSH_HOME` could interleave pack writes into a torn block. v1 and v2 files stay readable forever and migrate lazily to v3 within a per-cycle byte budget (newest sessions first, 64 MiB of legacy source per sweep — enough to clear a large backlog well inside the retention window); a daily sweep garbage-collects unreachable objects, marking transitively through tree chains, and skips every reclaiming phase whenever it could not build the complete reachable set — missing a cycle costs a day of disk, deleting on partial knowledge costs the record forever; and `format: 'v1'` freezes legacy behavior if you ever need the old format byte-for-byte.
- **Read API** — same-origin GET routes under `/dsh-request-log/` (`/health`, `/sessions/:id/calls`, `/sessions/:id/calls/:callId`), served by the harness web server behind a Host/Origin trust fence (loopback + `trustedHosts`). The list route also reports the session's `storage` footprint — envelope bytes, materialized object bytes, their sum, and the `maxFileBytes` in force — the same accounting the cap bills, so what the UI shows is what a trim would act on. It is **marginal**: a piece already stored bills nothing, so per-session figures never sum to the store directory's size.

### Configuration

The loader row's `config:` block (cordis.patch.yml) accepts:

| field | default | meaning |
| --- | --- | --- |
| `directory` | `$DSH_HOME/request-log` | where the JSONL files live — pointing this at a synced folder (OneDrive/Dropbox) or a network share puts the plaintext in the cloud / on the wire |
| `retentionDays` | `14` | delete session files untouched this long, in days (1–3650). `never` keeps every file forever — dsh's own session logs are never deleted, so this is what following the host looks like. `0` is refused: keeping nothing and keeping everything must not be one keystroke apart |
| `maxCallsPerSession` | `2000` | per-session cap (newest kept) |
| `maxFileBytes` | `134217728` | per-session cap on envelope-line bytes plus the compressed object bytes each append *materialized* — a piece already on disk bills nothing, so a retry bills 0 and shared pieces bill to whichever session wrote them first. Budget it as marginal **content**, not as disk: real occupancy runs ~2× the compressed size while objects are loose and ~1× once the sweep has packed them (see Storage above). Oldest records are trimmed first, and the raw `.jsonl` is held under the same number by a separate file-size guard |
| `format` | `auto` | record format for new writes: `auto` = v3 deduplicating tree envelopes (+ lazy migration of old files), `v1` = legacy full-body JSONL |
| `pack` | `auto` | whether the daily sweep packs cold reachable objects into solid-block pack files under `objects/packs/` (packing waits out the GC grace floor, so fresh writes stay loose): `auto` packs and repacks, `off` stops packing and gradually unpacks existing packs back to loose objects — the rollback door for downgrading to a build that cannot read packs; either way, one writer process per store directory |
| `trustedHosts` | `[]` | non-loopback authorities the read API may serve (`host` or `host:port`); every entry grants unauthenticated full-transcript reads to every device that can reach it |

## Development

```sh
pnpm install
pnpm run test     # typecheck + vitest
pnpm run build    # lib/index.js (host) + lib/client.js (browser)
pnpm run watch    # rebuild on change; run alongside `pnpm run dev:web` from a dsh checkout for client HMR
```

Register the local checkout into your web profile:

```sh
dsh plugin --profile web add .
```

## Compatibility

Built against `@deepseek-ai/dsh` 0.1.1-rc.2 (`@deepseek-ai/dsh-llm` 0.1.1-rc.2 wire types).

## License

Apache-2.0
