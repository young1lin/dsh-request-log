# AGENTS.md

This file provides guidance to coding agents working in this repository.

## What this is

`dsh-request-log` — a DeepSeek Harness (dsh) plugin that records every Provider request and response: a transparent `llm/stream` listener on the host captures each real attempt (retries included) unchanged, persists one JSONL line per settled attempt under `$DSH_HOME/request-log/`, and serves a **Requests / 请求** tab in the web UI where every call can be inspected in four views — Neutral (the exact provider-neutral capture), OpenAI ChatCompletion, Anthropic Messages, and OpenAI Responses (the latter three are faithful reconstructions from the capture; unknowable details are marked with namespaced `_note`, never invented).

`README.md` is the handoff document — read it before non-trivial work. `DESIGN-persistence.md` and `docs/superpowers/plans/` record the storage design decisions; `.superpowers/sdd/` (git-ignored) holds the task-by-task build history of the object-pack store.

## Commands

```sh
pnpm install
pnpm run test          # typecheck (tsc --noEmit) + vitest run
npx vitest run tests/store.spec.ts   # single file
pnpm run lint          # oxlint   (lint:fix to auto-fix)
pnpm run typecheck     # tsc --noEmit only
pnpm run build         # tsdown (both halves) + scripts/emit-client-dts.mjs
pnpm run watch         # tsdown --watch
pnpm pack --dry-run    # tarball manifest check
```

Local dev loop: register the checkout into your web profile once (`dsh plugin --profile web add .`), then run `pnpm run watch` alongside `pnpm run dev:web` from a dsh checkout for client HMR. Client-half changes reload with a browser refresh (the server reads `lib/client.js` from disk per request); **host-half changes require restarting `dsh web`**.

## Layout

- `src/host/` — the host half (a plain Cordis plugin): `index.ts` (entry/service), `capture.ts` (waterfall listener), `store.ts` (JSONL + v3 envelopes), `blob.ts` / `tree.ts` / `pack.ts` / `pack-format.ts` (git-style content-addressed object store: deflate-compressed objects, delta-chained trees, solid-block packs), `api.ts` (read routes + trust fence), `errtext.ts`.
- `src/client/` — the browser half: `view.tsx` (ledger), `detail.tsx` (call detail), `chart.tsx` / `chart-stats.ts` (usage charts), `persist.ts` (per-session view memory), `react.ts`, `json.ts` (collapsible tree), `dict.ts` (bilingual UI dictionary).
- `src/wire/` — wire-format reconstruction: `openai-chat.ts`, `anthropic.ts`, `openai-responses.ts`, `common.ts`.
- `src/shared/types.ts` — types crossing the wire.
- `tests/` — vitest specs, mirroring the src layout.
- `cordis.patch.yml` — the dsh loader row that declares the client bundle.
- `scripts/emit-client-dts.mjs` — writes the hand-maintained `lib/client.d.ts`.

## Two halves, two build outputs

`tsdown.config.ts` builds two entries: the host as **ESM** `lib/index.js` (+ `.d.ts` via rolldown-plugin-dts, target es2023) and the client as a **CJS closure bundle** `lib/client.js` for dsh's ClientModuleSystem. `lib/` is build output and **git-ignored — never commit it**. `package.json` `files` is an explicit allowlist; when a build starts emitting a new file that should ship, add it there, and check with `pnpm pack --dry-run`.

`engines.node` is `>=20` as a **syntax claim** (es2023 output parses on Node 20); the dev toolchain itself needs Node >= 22.13 because pnpm 11 requires it. CI verifies both claims (`ci.yml`: ubuntu+windows × node 22/24 matrix, plus an `engines-floor` job that `node --check`s the bundles on Node 20).

## Storage invariants that bite

- **Fail-soft above all.** Capture and storage failures must never break a model call — everything in the write path is best-effort with repair on next append (a torn JSONL line is repaired, not fatal).
- One JSONL line per settled attempt, a **v3 envelope**: tree hash (the ordered request piece list), response body hash, and `zn` (compressed bytes that append actually materialized). The envelope stays flat however long the session runs — trees are keyframes, turns write deltas, re-keyframed every 32 nodes.
- The byte cap (`maxFileBytes`) bills **materialized content**, not disk: a piece already on disk bills nothing, a retry bills 0, shared pieces bill to whoever wrote them first.
- The sweep's pack pass only moves objects older than the GC grace floor — a pending append can never lose its body. `pack: off` must remain a working rollback door (it unpacks).
- Any change to on-disk format: update `format`/`pack` config docs in README and keep lazy migration of old files working.

## Security & privacy stance

This plugin persists the **complete plaintext** of every model call; treat everything under `request-log/` as sensitive. The read API is fenced to the loopback host plus configured `trustedHosts` — loopback trust rests on the **connection**, never on a spoofable `Host` header. Common credential shapes are redacted on capture. Any new read route must go through the same fence in `src/host/api.ts`, and every `trustedHosts` entry is an unauthenticated full-transcript grant — document it as such.

## Testing pattern

Pure rules live in React-free modules so vitest can load them directly (`wire/*`, `chart-stats.ts`, `persist.ts`, `host/store.ts`, `host/pack*.ts`, `host/tree.ts`, …); React components stay thin orchestrators over those helpers. New behavior = pure helper + unit tests first, component wiring after. Tests mirror the src layout — a new module gets a same-named spec.

## Conventions

- **UI copy is bilingual** — zh and en both, via the dictionary in `src/client/dict.ts` (`{placeholder}` interpolation); code comments and commit messages are English.
- **Commits:** imperative subject, body explains *why*; a perf claim carries measured before/after numbers (see history: "Document what the fixes changed, with measured numbers").
- **Line endings are LF.** On Windows, don't let an editor or script rewrite files as CRLF.
- `lib/`, `.tmp/`, `.superpowers/`, `coverage/` are scratch or build output — never commit them, and don't rely on anything in `.tmp/` surviving.

## Release

Every release gets a user-facing entry in `CHANGELOG.md` (Keep a Changelog format, Chinese; it ships in the tarball via `files`). Version lives in `package.json`.

Publishing is tag-driven via **npm Trusted Publishing** (`.github/workflows/publish.yml`, same as `@young1lin/dsh-ui-gitworkbench`): the workflow runs lint / test / build / pack checks, verifies the tag matches `package.json`, and publishes through GitHub Actions OIDC — no NPM_TOKEN secret, no OTP. Trusted Publishing requires npm >= 11.5.1, hence Node 24 in the workflow. **Precondition:** the trusted publisher must be configured on npmjs.com — package Settings → Trusted publishing → user `young1lin`, repo `dsh-request-log`, workflow `publish.yml` — check it once before relying on the tag flow.

Cutting a release:

1. Write the user-facing entry in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, and commit it.
2. From a clean tree run `npm version patch` (or `minor` / `major`) — bumps `package.json` and creates the `vX.Y.Z` tag in one commit.
3. `git push && git push --tags` — the tag triggers `publish.yml`.
4. Watch the Actions run; when it is green verify with `npm view dsh-request-log version`. A red run publishes nothing: fix, delete the tag (local `git tag -d`, remote `git push origin :refs/tags/vX.Y.Z`), and re-push it. A version already on npm can never be republished (E403) — bump to a new version instead.

History: 0.1.0 (2026-08-31) was published by hand — a trusted publisher can only be configured on a package that already exists, so a brand-new name's first publish is manual exactly once (`npm login` + `npm publish`; `prepublishOnly` builds and dry-run checks itself). The npm account `young1lin` has 2FA: an interactive terminal confirms via a browser popup, a non-TTY shell (e.g. an agent's) fails with EOTP unless given `--otp=<code>`. No tag was pushed for 0.1.0; the first useful tag is the next one.

Built against `@deepseek-ai/dsh` 0.1.1-rc.2 wire types — keep the Compatibility section of the README current when that changes.
