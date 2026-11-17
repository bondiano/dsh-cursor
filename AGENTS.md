# dsh-cursor Contributor Guide

Cursor LLM provider plugin (`@local/dsh-cursor`) for DeepSeek Harness, streaming Cursor models via `@cursor/sdk` with DSH-owned tool execution and quota telemetry. Separate from `@local/dsh-runtime-cursor`. See [README.md](README.md), [docs/DETAIL.md](docs/DETAIL.md), and [../AGENTS.md](../AGENTS.md).

## Layout

- `index.ts`: Cordis plugin `apply`, settings/provider/RPC/tool registration.
- `client.ts`: classic-script browser settings card (`Settings -> Cursor`) and composer usage pill.
- `lib/`: `adapter.ts`, `auth.ts`, `bridge.ts`, `catalog.ts`, `errors.ts`, `prompt.ts`, `rpc.ts`, `run.machine.ts` (`cursorRun` XState v5 machine), `settings.ts`, `transport.ts`, `usage.ts`.
- `locale/`: `en.json`, `ru.json`, `zh.json`.
- `test/`: `node:test` suites with fake SDK fixtures (no network).

## Security & Architecture Invariants

- **DSH-owned tools:** Cursor SDK must run with built-in file/shell tools disabled (`tools: []`/`['mcp']`, `settingSources: []`, no MCP servers, retries disabled). All tool approvals and executions happen on the DSH side via `lib/bridge.ts`.
- **Secret redaction:** Cursor API keys (`dsh-cursor/default`) and CLI auth tokens must never appear in RPC responses, logs, replay state, or cache keys (SHA-256 hashes only).
- **Authenticated RPC:** Browser client communicates strictly through authenticated `/api` connection RPC.
- **Licensing:** `@cursor/sdk` remains subject to Cursor's Terms of Service ([NOTICE](NOTICE)); do not vendor or redistribute its SDK code.

## Verification

```sh
npm ci
npm run check     # tsc --noEmit && tsc && node --test dist/test/*.test.js
```

Sync `../machines` if `lib/run.machine.ts` changes, and update `../repositories.json` snapshot metadata when files here change.
