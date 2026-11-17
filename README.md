# @local/dsh-cursor

Cursor models in DeepSeek Harness.

- **Settings → Cursor**: browser sign-in, account status, subscription quota windows, and a model editor.
- **Composer picker**: selected Cursor models stream through the official `@cursor/sdk` agent runtime.
- **DSH-owned tools**: Cursor's built-in file/shell tools are disabled; every model tool call returns to DSH for approval, execution, and logging.
- **Composer usage pill**: Cursor Models and Other Models usage for the current Cursor model when a local Cursor CLI session is available.

The full user-facing description and limitations are in [docs/DETAIL.md](docs/DETAIL.md).

## Install

From this workspace:

```sh
cd /Users/bondiano/Documents/deepseek-harness/default-workspace/dsh-cursor
pnpm install --config.auto-install-peers=false
```

Then install the bundle into the running profile (for example through the DSH Plugins page, **Add plugin**, pointing at this directory, or with `plugin_manager install_bundle`). The package declares `dsh.bundle.patch` and `dsh.client`, so one install mounts the Host row and the browser half. Refresh the Web page after installation.

`@cursor/sdk` is a normal dependency. A local linked install needs the `pnpm install` above because the profile does not install a linked package's transitive dependencies; a packed or published install brings them automatically.

## Sign in

Open **Settings → Cursor** and use **Sign in with Cursor**. The SDK mints a named, expiring user API key; DSH stores it as the credential record `dsh-cursor/default`. The key is write-only: the page shows the account email and expiry, never the value.

An existing Cursor API key can be saved manually in the same card. `CURSOR_API_KEY` is the headless fallback.

## Quotas

Quota telemetry is read from a local Cursor CLI session (`CURSOR_AUTH_TOKEN`, the CLI auth file, or — only on explicit request — the macOS Keychain) through two Cursor Connect endpoints: `GetCurrentPeriodUsage` for the quota buckets and `GetPlanInfo` for the plan name and price. It is independent of model calls: without a CLI login, models still work and the card explains how to connect quota data.

The card mirrors Cursor's own **Plan & usage** page: current plan, reset date, the **Cursor Models** bucket (`autoPercentUsed`, Cursor Grok and Composer), the **Other Models** bucket (`apiPercentUsed`), and the monthly **On-Demand** limit from `spendLimitUsage`. Included usage overall (`totalPercentUsed`) drives the composer pill.

## Development

```sh
pnpm check          # syntax + 79 unit tests (fake SDK, no network)
pnpm test
```

Tests cover settings validation and atomic writes, catalog normalization and selection, the tool bridge, prompt projection, transport streaming/reuse/cancellation/timeout, auth state and redaction, quota parsing/caching, and the authenticated RPC envelope. Live Cursor calls require the user's account and are verified manually.

## Security

- API keys and CLI access tokens never appear in RPC responses, logs, replay state, or cache keys (only SHA-256 hashes).
- The browser half talks only through the authenticated `/api` connection RPC.
- Cursor SDK runs with `tools: []`/`['mcp']`, `settingSources: []`, no MCP servers, retries disabled, and a temporary working directory.
- Tool execution and approval remain on the DSH side.

## Attribution

See [NOTICE](NOTICE). `@cursor/sdk` remains subject to Cursor's Terms of Service and is not redistributed by this package.
