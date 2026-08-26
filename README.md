# dsh-request-log

**A [DeepSeek Harness](https://www.deepseek.com/harness/) plugin that records every Provider request and response — exactly what was sent, and exactly what came back.**

Each time dsh calls a Provider, the plugin captures the full neutral request payload (system prompt, messages, tool schemas, sampling options) and the assembled response (content blocks, usage, finish reason, timings), persists it per session, and serves a **Requests / 请求** tab in the web UI where you can browse every call and inspect it in four views:

- **Neutral** — the exact provider-neutral capture (what crossed the `llm/stream` boundary).
- **OpenAI ChatCompletion** — `POST /v1/chat/completions` shape (`reasoning_content` for thinking, `role: 'tool'` rows for tool results, `cached_tokens` details).
- **Anthropic Messages** — `POST /v1/messages` shape (`system` blocks, `tool_use`/`tool_result`, `cache_read_input_tokens`).
- **OpenAI Responses** — `POST /v1/responses` shape, reconstructed as a real client chains it: `store: true` + `previous_response_id` with only the NEW input items (a badge shows how many items stayed server-side); degrades to full input when the history was compacted or edited.

The JSON bodies render as a **collapsible tree**: containers fold past depth 2 by default, long strings (a 40KB system prompt) clamp behind a `… +N chars` toggle, and Expand / Collapse buttons control the whole view.

The wire views are reconstructed from the exact capture, mirroring the mapping dsh's pi-ai adapters perform — differences between the views are exactly the differences between the protocols.

## Features

- **Every attempt recorded** — including each retry of a failed call (retries are correlated by a request hash and numbered `attempt: N`).
- **Step numbers** — each ordinary call wears a `#N` badge numbering its place in the session's conversation loop (what was called at step 1, step 2, …); retries share their step, auxiliary calls take none. The detail view shows the same step in its call card.
- **Auxiliary calls too** — session-title and compaction calls are tagged with their `purpose`.
- **Timing** — start time, TTFB (first chunk), and total duration per call.
- **Usage** — input/output/cache-read/cache-write tokens exactly as the provider reported them.
- **Durable** — one JSONL file per session under `$DSH_HOME/request-log/`, with retention (default 14 days) and a per-session cap (default 2000 calls).
- **Fail-soft** — capture and storage failures never break a model call; the read API is optional (a headless composition simply skips it).

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

- The list is a chronological ledger — the newest call sits at the bottom (like the Trajectory tab), with status dot, model, step badge (`#N`), finish reason, TTFB / total latency, token counts, and message/tool counts. It loads the newest 100 calls first and a **Load older** button pages in the rest (your scroll position is anchored while older rows prepend); retries show a `×N` badge; auxiliary calls show their purpose.
- **Auto** refreshes the list every 3s while the session is running (paused while the tab is hidden). A transient refresh failure keeps the loaded data and shows a stale-data banner instead of clearing the ledger.
- Click a row to open the detail view: a summary card (provider, model, effort, timing, usage, finish) plus the full request/response JSON — switch between the four views, toggle line wrapping, or copy the JSON.
- **Your place is kept** — the tab only renders while active, but per-session view memory (in-page + `sessionStorage`) reopens the call you were viewing, its request/response side and format, the paged-in window, and the Auto toggle when you switch tabs — or even refresh the page. Each session remembers its own view.

## How it works

- **Capture** — a transparent `llm/stream` waterfall listener. Every real attempt (retry attempts re-enter the waterfall) is recorded and passed through unchanged.
- **Storage** — one JSONL line per settled attempt, appended to `$DSH_HOME/request-log/<sessionId>.jsonl`.
- **Read API** — same-origin GET routes under `/dsh-request-log/` (`/health`, `/sessions/:id/calls`, `/sessions/:id/calls/:callId`), served by the harness web server.

### Configuration

The loader row's `config:` block (cordis.patch.yml) accepts:

| field | default | meaning |
| --- | --- | --- |
| `directory` | `$DSH_HOME/request-log` | where the JSONL files live |
| `retentionDays` | `14` | delete session files untouched this long |
| `maxCallsPerSession` | `2000` | per-session cap (newest kept) |

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
