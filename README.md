# dsh-request-log

**A [DeepSeek Harness](https://www.deepseek.com/harness/) plugin that records every Provider request and response — exactly what was sent, and exactly what came back.**

Each time dsh calls a Provider, the plugin captures the full neutral request payload (system prompt, messages, tool schemas, sampling options) and the assembled response (content blocks, usage, finish reason, timings), persists it per session, and serves a **Requests / 请求** tab in the web UI where you can browse every call and inspect it in four views:

- **Neutral** — the exact provider-neutral capture (what crossed the `llm/stream` boundary).
- **OpenAI ChatCompletion** — `POST /v1/chat/completions` shape (`reasoning_content` for thinking, `role: 'tool'` rows for tool results, `cached_tokens` details).
- **Anthropic Messages** — `POST /v1/messages` shape (`system` blocks, `tool_use`/`tool_result`, `cache_read_input_tokens`).
- **OpenAI Responses** — `POST /v1/responses` in the exact form the harness adapter sends (`store: false`, full `input`, native `reasoning: { effort, summary }`); when the prior call of the conversation is known, an annotation (and the banner) reconstruct what a stateful client *could* have sent through `previous_response_id` — clearly marked as a reconstruction, never as the real request.

The JSON bodies render as a **collapsible tree**: containers fold past depth 2 by default, long strings (a 40KB system prompt) clamp behind a `… +N chars` toggle, and Expand / Collapse buttons control the whole view.

The wire views are reconstructed from the exact capture, mirroring the mapping dsh's pi-ai adapters perform — differences between the views are exactly the differences between the protocols. Adapters resolve some things the neutral boundary never sees (the exact Anthropic thinking mode, thinking signatures, adapter default `max_tokens`); where a detail is unknowable the rendering keeps a **legal** wire shape and marks the gap with a namespaced `_note` — the views show what a real client could have sent, never an invented value.

## Features

- **Every attempt recorded** — including each retry of a failed call (retries are correlated by a request hash and numbered `attempt: N`).
- **Step numbers** — each ordinary call wears a `#N` badge numbering its place in the session's conversation loop (what was called at step 1, step 2, …); retries share their step, auxiliary calls take none. The detail view shows the same step in its call card.
- **Auxiliary calls too** — session-title and compaction calls are tagged with their `purpose`.
- **Usage statistics — 折线图** — a switchable chart panel above the ledger plots every loaded call: cache-hit rate per step (fixed 0–100 % axis), token volumes (in / cache-hit / cache-write / out, stacked toggle), latency phases (total vs TTFT), output speed; hover for exact values, error/aborted calls draw gaps instead of fake zeros, auxiliary calls stay off the axis (badge counts them). The open state and active metric ride the same per-session memory.
- **Timing** — start time, TTFB (first chunk), and total duration per call.
- **Usage** — input/output/cache-read/cache-write tokens exactly as the provider reported them.
- **Durable** — one JSONL file per session under `$DSH_HOME/request-log/`, with retention (default 14 days), a per-session call cap (default 2000), and a per-file byte cap (default 128 MiB; oldest records trimmed first).
- **Fail-soft** — capture and storage failures never break a model call; a partially-written line is repaired on the next append; the read API is optional (a headless composition simply skips it).
- **Fenced** — the read API serves the loopback host (plus any `trustedHosts` you configure) only; DNS-rebinding and cross-site requests are refused before any read.

## Privacy

**This plugin persists the complete plaintext of every model call** — your full prompts, conversation history, tool schemas, and model outputs — to `$DSH_HOME/request-log/<sessionId>.jsonl`, one file per session, kept for `retentionDays` (default 14) days. Anyone with access to that directory (or to a machine where the web UI is reachable) can read them. Control it with the `directory` / `retentionDays` / `maxFileBytes` / `maxCallsPerSession` settings below, delete the files to erase a session's log, or uninstall the plugin to stop recording entirely. No credentials are ever recorded — API keys do not cross the `llm/stream` boundary — but the *content* of your sessions is on disk in cleartext.

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
- **Auto** refreshes the list every 3s while the session is running (paused while the tab is hidden). A transient refresh failure keeps the loaded data and shows a stale-data banner instead of clearing the ledger.
- **统计 / Charts** — a toggleable panel above the ledger switches between four per-call line charts: **Hit rate** (each step's cache-read ÷ billed input, on a fixed 0–100 % axis — cold starts, post-compaction drops and error gaps are all visible at a glance), **Tokens** (in / cache-hit / cache-write / out, with an optional cumulative stacked view), **Latency** (total vs TTFT), and **Speed** (output tokens/s of the stream phase). Hover anywhere for exact values (crosshair + tooltip); calls that never reported usage draw gaps, never fake zeros; retries collapse into their step; auxiliary compaction/title calls stay off the numbered axis (an ⓘ badge counts them).
- Click a row to open the detail view: a summary card (provider, model, effort, timing, usage, finish) plus the full request/response JSON — switch between the four views, toggle line wrapping, or copy the JSON.
- **Your place is kept** — the tab only renders while active, but per-session view memory (in-page + `sessionStorage`) reopens the call you were viewing, its request/response side and format, the paged-in window, and the Auto toggle when you switch tabs — or even refresh the page. Each session remembers its own view.

## How it works

- **Capture** — a transparent `llm/stream` waterfall listener. Every real attempt (retry attempts re-enter the waterfall) is recorded and passed through unchanged.
- **Storage** — one JSONL line per settled attempt, appended to `$DSH_HOME/request-log/<sessionId>.jsonl`. New records are written as **v2 envelopes**: request/response bodies land once each in a git-style content-addressed object store (`objects/<xx>/<sha256>.drl`, deflate-compressed), while the line itself carries only small hash references plus a precomputed summary. Consecutive requests resend almost the whole conversation history, so per-message hashing removes exactly that redundancy — on real long sessions this measures a ~50–100× reduction in stored bytes (a 179 MB log replays to ≈ 2.4 MB of compressed content), with every append still crash-tolerant and fail-soft. **On-disk occupancy runs higher than that content figure:** the median object is well under a filesystem cluster — in one real store, 2,066 objects holding 2.1 MB of content occupied 8 MB of disk, 97 % of them ≤ 4 KiB — so budget roughly 3–4× the compressed size and treat the headline ratio as an order of magnitude, not an exact multiple. Reads stay cheap: list pages project from the envelope alone; only the detail view reassembles blobs. Old v1 files keep working forever, are converted lazily as trims/sweeps rewrite them plus a per-cycle migration budget (newest sessions first, 64 MiB of legacy source per sweep — enough to clear a large backlog well inside the retention window), a daily sweep garbage-collects unreachable objects, and `format: 'v1'` freezes legacy behavior if you ever need the old format byte-for-byte.
- **Read API** — same-origin GET routes under `/dsh-request-log/` (`/health`, `/sessions/:id/calls`, `/sessions/:id/calls/:callId`), served by the harness web server behind a Host/Origin trust fence (loopback + `trustedHosts`).

### Configuration

The loader row's `config:` block (cordis.patch.yml) accepts:

| field | default | meaning |
| --- | --- | --- |
| `directory` | `$DSH_HOME/request-log` | where the JSONL files live |
| `retentionDays` | `14` | delete session files untouched this long |
| `maxCallsPerSession` | `2000` | per-session cap (newest kept) |
| `maxFileBytes` | `134217728` | per-session cap on *attributed* bytes — the envelope line plus its referenced compressed blobs, counted once per referencing record. Shared blobs are counted per reference, so this tracks what the session would have cost unshared (≈ the v1 size), not its share of physical disk; oldest records are trimmed first |
| `format` | `auto` | record format for new writes: `auto` = v2 deduplicating envelopes (+ lazy migration of old files), `v1` = legacy full-body JSONL |
| `trustedHosts` | `[]` | non-loopback authorities the read API may serve (`host` or `host:port`) |

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
