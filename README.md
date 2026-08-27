# moneybird-mcp

A Model Context Protocol server for the [Moneybird](https://moneybird.com) accounting API.

It exposes Moneybird as a set of MCP tools, so an assistant such as Claude can look up contacts,
read invoices, check bank mutations, log time and pull reports from your administration. Access is
read-only until you turn writing on, tools are grouped into toolsets you can enable individually,
and the client paces its own requests to stay inside Moneybird's rate limit. It speaks stdio for
local clients and Streamable HTTP for remote ones.

## Quick start

Register the server with your client. For Claude Code:

```bash
claude mcp add moneybird -- npx -y moneybird-mcp serve
```

Then ask your assistant to connect. The server starts without credentials and exposes a
`connect_moneybird` tool: it opens Moneybird's token page in your browser, asks for the token you
create there, verifies it, picks your administration and stores it — without leaving the
conversation.

That needs a client that supports MCP elicitation. Where it is unavailable the same setup runs in a
terminal:

```bash
npx moneybird-mcp login
```

which walks you through the same steps and stores the result in
`~/.config/moneybird-mcp/credentials.json`.

Check that everything resolves before you rely on it:

```bash
npx moneybird-mcp status
```

`status` prints the enabled toolsets, the write and delete settings, where the credentials came
from, and the administrations the token can reach. It exits non-zero when it cannot reach
Moneybird.

## Authentication

Moneybird offers two ways to get a token, and this server supports both. Neither is fully
hands-off: Moneybird implements neither Dynamic Client Registration nor PKCE, so no flow exists
that skips creating a token or registering an application. That is a limitation of the Moneybird
API, not of this server. What the `connect_moneybird` tool does is remove every step around that
one — it opens the right page and captures the result for you.

**Personal API token.** You create it yourself at
<https://moneybird.com/user/applications/new>, tick the scopes you want, and paste it into
`moneybird-mcp login`. Simplest route. The scopes are fixed at creation, and Moneybird does not
currently expire these tokens — which also means one cannot be rotated automatically. Treat it like
a password.

**OAuth application.** You register an application in the same place, then:

```bash
export MONEYBIRD_CLIENT_ID=...
export MONEYBIRD_CLIENT_SECRET=...
npx moneybird-mcp login --oauth
```

The server opens Moneybird's authorization page, catches the redirect on
`http://127.0.0.1:51739/callback`, and exchanges the code. Moneybird matches redirect URIs exactly,
so that URI has to be registered with your application verbatim. Use `--port` to pick a different
one, or `--oob` to have Moneybird show the code in the browser instead of redirecting — useful
where no loopback listener can be opened. OAuth tokens can be revoked from Moneybird and refreshed
automatically when they carry an expiry.

To store a token without any prompting, for example in a provisioning script:

```bash
npx moneybird-mcp login --token "$MONEYBIRD_TOKEN"
```

`moneybird-mcp logout` removes the stored file. For an OAuth credential it does not revoke the
authorization itself — do that in Moneybird.

See [docs/authentication.md](docs/authentication.md) for scopes, refresh behaviour and the exact
flows.

## Configuration

Configuration comes from the environment; CLI flags override it.

### Environment variables

| Variable                       | Default                                                          | Purpose                                                                               |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `MONEYBIRD_API_TOKEN`          | —                                                                | Token to use, bypassing the stored credentials entirely.                              |
| `MONEYBIRD_ADMINISTRATION_ID`  | from stored credentials                                          | Administration used when a tool does not name one.                                    |
| `MONEYBIRD_TOOLSETS`           | `core,invoicing,purchases,banking,time`                          | Toolsets to enable. Accepts `all`, `none`, or `-name` to drop one from the defaults.  |
| `MONEYBIRD_ALLOW_WRITE`        | `false`                                                          | `true` enables tools that create or modify data.                                      |
| `MONEYBIRD_ALLOW_DELETE`       | `false`                                                          | `true` enables tools that delete data. Has no effect without `MONEYBIRD_ALLOW_WRITE`. |
| `MONEYBIRD_TRANSPORT`          | `stdio`                                                          | `stdio` or `http`.                                                                    |
| `MONEYBIRD_HOST`               | `127.0.0.1`                                                      | Bind address for the HTTP transport.                                                  |
| `PORT` / `MONEYBIRD_PORT`      | `3000`                                                           | Port for the HTTP transport. `PORT` wins if both are set.                             |
| `MONEYBIRD_HTTP_AUTH`          | `shared-token` if `MONEYBIRD_MCP_AUTH_TOKEN` is set, else `none` | `none`, `shared-token` or `passthrough`.                                              |
| `MONEYBIRD_MCP_AUTH_TOKEN`     | —                                                                | Shared secret callers must present in `shared-token` mode.                            |
| `MONEYBIRD_CLIENT_ID`          | —                                                                | OAuth application client id. Must be set together with the secret.                    |
| `MONEYBIRD_CLIENT_SECRET`      | —                                                                | OAuth application client secret.                                                      |
| `MONEYBIRD_OAUTH_SCOPES`       | all six scopes                                                   | Comma-separated scopes to request during `login --oauth`.                             |
| `MONEYBIRD_REDIRECT_URI`       | `http://127.0.0.1:51739/callback`                                | Redirect URI for the OAuth flow. Must match the one registered with your application. |
| `MONEYBIRD_TIME_ZONE`          | —                                                                | IANA time zone sent with date-sensitive requests, e.g. `Europe/Amsterdam`.            |
| `MONEYBIRD_BASE_URL`           | `https://moneybird.com/api/v2`                                   | API base URL. For testing against a stub.                                             |
| `MONEYBIRD_REQUEST_TIMEOUT_MS` | `30000`                                                          | Per-request timeout.                                                                  |
| `MONEYBIRD_MAX_RETRIES`        | `3`                                                              | Retries after the first attempt, for 429 and 5xx responses.                           |
| `MONEYBIRD_MCP_CONFIG_DIR`     | `$XDG_CONFIG_HOME/moneybird-mcp`, else `~/.config/moneybird-mcp` | Directory holding `credentials.json`.                                                 |

### Commands

| Command                | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `moneybird-mcp serve`  | Start the MCP server. This is the default when no command is given. |
| `moneybird-mcp login`  | Authenticate and store credentials.                                 |
| `moneybird-mcp logout` | Remove the stored credentials.                                      |
| `moneybird-mcp status` | Print the configuration and verify the connection.                  |
| `moneybird-mcp tools`  | List the tools the current settings expose.                         |

### Flags

| Flag                    | Command | Meaning                                                                    |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--http`                | `serve` | Serve over Streamable HTTP instead of stdio.                               |
| `--host <host>`         | `serve` | Bind address for `--http`. Default `127.0.0.1`.                            |
| `--port <port>`         | `serve` | Port for `--http`. Default `3000`.                                         |
| `--endpoint <path>`     | `serve` | Path the MCP endpoint is served on. Default `/mcp`.                        |
| `--toolsets <list>`     | `serve` | Comma-separated toolsets; `all`, or `-name` to drop one from the defaults. |
| `--allow-write`         | `serve` | Enable tools that create or modify data.                                   |
| `--allow-delete`        | `serve` | Enable tools that delete data. Implies `--allow-write`.                    |
| `--administration <id>` | `serve` | Default administration id.                                                 |
| `--oauth`               | `login` | Use the OAuth application flow.                                            |
| `--oob`                 | `login` | Show the authorization code in the browser instead of redirecting.         |
| `--port <port>`         | `login` | Loopback port for the OAuth redirect. Default `51739`.                     |
| `--token <token>`       | `login` | Store a token without prompting.                                           |
| `--json`                | `tools` | Emit the tool list as JSON.                                                |
| `--help`, `-h`          | any     | Print usage.                                                               |
| `--version`, `-v`       | any     | Print the version.                                                         |

## Toolsets

Tools are grouped by Moneybird's own domains. Five are enabled by default; the other four are
opt-in.

| Toolset     | Default | Covers                                                                            |
| ----------- | ------- | --------------------------------------------------------------------------------- |
| `core`      | on      | Administrations, contacts, products, projects, ledger accounts, tax rates, users. |
| `invoicing` | on      | Sales invoices, recurring invoices, estimates, workflows.                         |
| `purchases` | on      | Purchase invoices, receipts, documents, general journal documents.                |
| `banking`   | on      | Financial accounts, financial mutations, payment linking.                         |
| `time`      | on      | Time entries.                                                                     |
| `reports`   | off     | Profit and loss, balance sheet and other `/reports` endpoints.                    |
| `assets`    | off     | Fixed assets and depreciation.                                                    |
| `tasks`     | off     | Notes, tasks, events, custom fields.                                              |
| `webhooks`  | off     | Webhook subscriptions.                                                            |

Set them explicitly, add to the defaults, or subtract from them:

```bash
moneybird-mcp serve --toolsets core,invoicing     # exactly these two
moneybird-mcp serve --toolsets all                # everything
moneybird-mcp serve --toolsets reports            # exactly reports
moneybird-mcp serve --toolsets -banking,-time     # the defaults minus two
```

A `-name` entry anywhere in the list means the list starts from the defaults rather than from
nothing. `all` wins over everything else. An unknown name is an error, not a silent no-op.

The full per-tool listing is in [docs/tools.md](docs/tools.md), or run `moneybird-mcp tools`.

## Safety model

Every tool declares one of three access tiers, and the server only registers the ones the current
settings permit. A tool that is not registered is invisible to the model — it cannot be called by
mistake or talked into existence.

- **read** — always registered.
- **write** — creates or modifies data. Needs `--allow-write` or `MONEYBIRD_ALLOW_WRITE=true`.
- **destroy** — needs `--allow-delete` _and_ `--allow-write`. `--allow-delete` on its own does
  nothing.

Deleting is gated separately from writing because the two failure modes are not comparable. A
wrong write leaves a record you can correct; a delete, or an invoice sent to a customer, is not
something the API can take back. Enabling writes so an assistant can draft an invoice should not
also let it remove your bookkeeping. The `destroy` tier therefore covers both deletions and calls
that are irreversible in practice, such as sending a document to a contact.

Read-only is the default. Turn on the least you need:

```bash
claude mcp add moneybird --env MONEYBIRD_ALLOW_WRITE=true -- npx -y moneybird-mcp serve
```

## Client setup

### Claude Code

```bash
claude mcp add moneybird -- npx -y moneybird-mcp serve
```

With write access and a wider tool selection:

```bash
claude mcp add moneybird \
  --env MONEYBIRD_ALLOW_WRITE=true \
  --env MONEYBIRD_TOOLSETS=all \
  -- npx -y moneybird-mcp serve
```

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "moneybird": {
      "command": "npx",
      "args": ["-y", "moneybird-mcp", "serve"],
      "env": {
        "MONEYBIRD_ALLOW_WRITE": "true"
      }
    }
  }
}
```

The file lives at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Restart the app after editing it.

### Any stdio client

The server is a plain stdio MCP server. Run `moneybird-mcp serve` and speak JSON-RPC over stdin and
stdout. Diagnostics go to stderr, never stdout.

```json
{
  "command": "npx",
  "args": ["-y", "moneybird-mcp", "serve"],
  "env": {
    "MONEYBIRD_API_TOKEN": "..."
  }
}
```

If you would rather not store credentials on disk, set `MONEYBIRD_API_TOKEN` in the client's `env`
block. It takes precedence over anything in `credentials.json`.

## Docker and self-hosting

```bash
docker build -t moneybird-mcp .
docker run --rm -p 3000:3000 -e MONEYBIRD_API_TOKEN=... moneybird-mcp
```

The image defaults to the HTTP transport on `0.0.0.0:3000` and exposes `/mcp`, plus an unauthenticated
`/healthz`. Do not put it on a public address without authentication.

[docs/hosting.md](docs/hosting.md) covers the three HTTP authentication modes, multi-tenant
`passthrough` deployments, reverse-proxy notes and connecting a remote client.

## Rate limits

Moneybird allows **150 requests per 5 minutes per IP**, and **50 per 5 minutes** for `/reports`
endpoints. The client keeps its own sliding-window counters for both budgets and delays a request
that would exceed one, so ordinary use does not produce 429s. When Moneybird returns a 429 anyway,
the client honours `Retry-After` and otherwise backs off exponentially with full jitter, up to
`MONEYBIRD_MAX_RETRIES` attempts.

The budget is per IP, not per token. Several instances behind one egress address share it, and the
local counters cannot see each other. Size deployments accordingly.

## Development

```bash
npm install
npm run build      # before typecheck: the docs generator imports the built output
npm run typecheck
npm test
npm run format
```

`docs/tools.md` is generated from the tool definitions. Regenerate it after adding or changing a
tool:

```bash
npm run docs:tools
```

`spec/endpoints.json` pins Moneybird's published operation list, and a test checks every path a
tool calls against it. Refresh it when Moneybird ships API changes:

```bash
npm run spec:refresh
npm test
```

A failing endpoint test after a refresh means a route a tool depends on moved or was withdrawn.

## Contributing

Issues and pull requests are welcome at
<https://github.com/HalloSouf/moneybird-mcp>. Please run `npm run typecheck`, `npm test` and
`npm run format:check` before opening a pull request; CI runs the same checks on Node 20 and 22.

Changes that affect users ship with a changeset, which becomes the changelog entry:

```bash
npm run changeset
```

Pick `patch` for fixes, `minor` for new tools or options, `major` for anything that breaks an
existing setup. Refactors, tests and CI changes need none. Merging to `main` opens a pull request
that collects the pending changesets into a version bump and a `CHANGELOG.md` entry. See
[.changeset/README.md](.changeset/README.md).

## Licence

MIT. See [LICENSE](LICENSE).
