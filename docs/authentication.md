# Authentication

Moneybird has two ways to obtain an API credential, and `moneybird-mcp` supports both.

## Connecting from inside the conversation

The server starts even with no credential at all. In that state it still registers three setup
tools — `connect_moneybird`, `moneybird_connection_status` and `select_administration` — outside
the usual toolset and permission gating, because they are the only way back from a server that
cannot authenticate.

`connect_moneybird` uses MCP elicitation, which the client advertises per mode:

| Client advertises           | What happens                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| `elicitation.url` + `.form` | Moneybird's token page opens, then the client asks you to paste the token |
| `elicitation.form` only     | The client asks for the token with the page link in the prompt            |
| Neither                     | The tool explains the manual route and points at `moneybird-mcp login`    |

The token is verified against `GET /administrations` before it is stored, so a typo fails
immediately rather than at the first real call. When the token reaches exactly one administration
that one becomes the default; otherwise use `select_administration`.

You can also hand a token straight to the tool — `connect_moneybird` with a `token` argument — which
skips the prompting entirely.

Neither is zero configuration. Moneybird's OAuth implementation supports neither
[Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591) nor
[PKCE](https://datatracker.ietf.org/doc/html/rfc7636), so a client cannot register itself on the
fly and a public client cannot complete the code flow safely without a client secret. You therefore
either create a personal API token by hand, or register your own OAuth application and hold its
secret. This is a property of the Moneybird API; no MCP server can work around it.

|          | Personal API token            | OAuth application                                       |
| -------- | ----------------------------- | ------------------------------------------------------- |
| Setup    | Create a token in the browser | Register an application, then authorize it              |
| Scopes   | Fixed when you create it      | Requested per authorization                             |
| Expiry   | Currently none                | Whatever Moneybird issues; refreshed automatically      |
| Revoke   | Delete it in Moneybird        | Revoke the authorization in Moneybird                   |
| Rotate   | By hand                       | Automatic, via the refresh token                        |
| Good for | One person, one machine       | Shared deployments, anything you need to revoke cleanly |

## Personal API token

1. Open <https://moneybird.com/user/applications/new>.
2. Choose the personal API token option.
3. Tick the scopes you need — see [Scopes](#scopes) below.
4. Create the token and copy it. Moneybird shows it once.

Then:

```bash
npx moneybird-mcp login
```

The command opens the same page for you, prompts for the token, calls
`GET /administrations` to verify it, and asks which administration to use by default.

To skip the prompts entirely:

```bash
npx moneybird-mcp login --token "$MONEYBIRD_TOKEN"
```

The scopes of a personal token are fixed at creation. To change them, create a new token and log in
again. Moneybird does not currently expire these tokens, which is convenient and also means a leaked
one stays valid until you delete it.

## OAuth application

### Register the application

1. Open <https://moneybird.com/user/applications/new>.
2. Choose the OAuth application option.
3. Set the redirect URI to `http://127.0.0.1:51739/callback`, or the port you intend to use.
4. Note the client id and client secret.

### Redirect URI matching

Moneybird matches the redirect URI **exactly**. Not a prefix, not a host match — the whole string,
including scheme, host, port and path. `http://127.0.0.1:51739/callback` and
`http://localhost:51739/callback` are different URIs, and so are the same URI on two different
ports.

This matters because the loopback flow builds its redirect URI from `--port`. If you register
`http://127.0.0.1:51739/callback` and then run `login --oauth --port 8080`, Moneybird rejects the
authorization. Register every port you plan to use, or always use the default.

`MONEYBIRD_REDIRECT_URI` overrides the constructed URI when you need something else — but the
loopback listener still binds `--port`, so the two must agree.

### Loopback flow (default)

```bash
export MONEYBIRD_CLIENT_ID=...
export MONEYBIRD_CLIENT_SECRET=...
npx moneybird-mcp login --oauth
```

What happens:

1. A random `state` value is generated and a one-shot HTTP listener starts on `127.0.0.1:51739`.
2. Your browser opens Moneybird's authorization page. The URL is also printed, in case no browser
   can be launched.
3. You approve, and Moneybird redirects to `http://127.0.0.1:51739/callback?code=...&state=...`.
4. The listener checks that `state` matches, then shuts down. A mismatch, an `error` parameter, or
   a missing code all abort the login.
5. The code is exchanged at `https://moneybird.com/oauth/token` for an access token and, if
   Moneybird issues one, a refresh token.

The listener gives up after five minutes.

### Out-of-band flow

Where no loopback listener can be opened — a container, a remote shell, a machine with no browser:

```bash
npx moneybird-mcp login --oauth --oob
```

This uses the redirect URI `urn:ietf:wg:oauth:2.0:oob`. Moneybird displays the authorization code
in the browser instead of redirecting; you paste it into the prompt. The URI must be registered
with your application like any other.

The out-of-band flow puts the code on screen, where it can be shoulder-surfed or pasted into the
wrong window. Prefer the loopback flow when it is available.

## Scopes

Moneybird defines six scopes. `moneybird-mcp login --oauth` requests all six unless
`MONEYBIRD_OAUTH_SCOPES` narrows the list; a personal token gets whatever you tick in the browser.

| Scope            | Grants access to                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `sales_invoices` | Sales invoices, recurring invoices, invoice workflows and the contacts they bill.              |
| `documents`      | Purchase invoices, receipts, general journal documents and general documents.                  |
| `estimates`      | Estimates and estimate workflows.                                                              |
| `bank`           | Financial accounts, financial mutations and payment linking.                                   |
| `time_entries`   | Time entries and the projects they book against.                                               |
| `settings`       | Administration settings: ledger accounts, tax rates, products, custom fields, users, webhooks. |

Two things are easy to get wrong:

- **Contacts have no scope of their own.** They are reachable through any scope that implies
  billing a customer — `sales_invoices`, `documents` or `estimates`. `time_entries` alone does not
  grant contact access, so a token scoped only for time tracking cannot resolve who the work was
  for.
- **There is no scope for reports, assets, tasks or webhooks.** Those endpoints sit under one of
  the six above — `settings` covers webhooks and custom fields, the rest follow the data they
  concern.

Narrow the request when you want a token that can do less:

```bash
MONEYBIRD_OAUTH_SCOPES=sales_invoices,settings npx moneybird-mcp login --oauth
```

An unknown scope name is a configuration error, not a silently dropped entry.

Scopes limit what the token can reach at Moneybird. They are independent of this server's
`--allow-write` and `--allow-delete` flags, which limit what the model is allowed to attempt. Use
both: a read-only server holding a full-access token still exposes only read tools, and a
write-enabled server holding a `settings`-only token still cannot touch invoices.

## Token refresh

Only OAuth credentials can be refreshed, and only when Moneybird issued a refresh token.

The server checks the recorded expiry before every request and refreshes **300 seconds ahead** of
it, so a long-running call never races the deadline. Concurrent tool calls share a single in-flight
refresh — a refresh token is single-use, and letting several calls each spend it would invalidate
the credential. The refreshed token is written back to `credentials.json` immediately.

When the stored token has expired and cannot be refreshed — no refresh token, or a missing client
id or secret — the server says so and asks you to run `moneybird-mcp login` again rather than
failing with an opaque 401.

Personal API tokens carry no expiry, so this machinery never engages for them.

## Where credentials are stored

`credentials.json`, in the first of these that applies:

| Condition                         | Directory                        |
| --------------------------------- | -------------------------------- |
| `MONEYBIRD_MCP_CONFIG_DIR` is set | that directory, used as-is       |
| `XDG_CONFIG_HOME` is set          | `$XDG_CONFIG_HOME/moneybird-mcp` |
| Windows, `APPDATA` is set         | `%APPDATA%\moneybird-mcp`        |
| Otherwise                         | `~/.config/moneybird-mcp`        |

The file holds a long-lived token with full access to an administration, so it is written with mode
`0600` and its parent directory with `0700`. On Windows those modes do nothing and the protection
comes from the user profile directory instead.

It records the token, the refresh token and expiry when there is one, the granted scopes, the
default administration and its name, the OAuth client id and secret when the credential is an OAuth
one, and the creation timestamp. Anyone who can read the file can act as you in Moneybird. Do not
commit it, do not bake it into a container image, and do not sync it.

`moneybird-mcp status` prints the path, the credential kind, the scopes and the expiry without
revealing the token.

## Precedence

`MONEYBIRD_API_TOKEN` always wins. When it is set, the stored credential is not read at all — so a
container, a CI run or a `passthrough` HTTP request never picks up a developer's local login by
accident. It also means the token cannot be refreshed, since nothing knows how it was obtained.

Everything else falls back to `credentials.json`. If neither exists you get an error pointing at
`moneybird-mcp login` — at startup on stdio, and on the first tool call over HTTP, where each
request resolves its own credential.

## Removing access

```bash
npx moneybird-mcp logout
```

This deletes the local file after confirming. It does **not** revoke anything at Moneybird — for an
OAuth credential the authorization remains valid, and for a personal token the token still works.
To actually withdraw access, delete the token or revoke the authorization in your Moneybird account
settings.

The package exports a `revokeToken` helper against `https://moneybird.com/oauth/revoke` for
programmatic use. Note that Moneybird answers `200` even for a token it does not recognise, so a
successful call is not evidence that the token existed.

## Troubleshooting

**`Moneybird refused the credentials (401)`** — the token is revoked, mistyped, or belongs to a
different account. Run `moneybird-mcp status` to confirm, then log in again.

**`Moneybird refused the credentials (403)`** — the token is valid but lacks the scope the endpoint
needs. Check the scope table above; for a personal token you will need to create a new one.

**`The token works but reaches no administrations`** — the token authenticated but
`GET /administrations` came back empty. Usually too narrow a scope selection.

**Authorization fails immediately after approving** — almost always the redirect URI. Compare what
is registered with your application against what `login` printed, character for character.

**`OAuth state mismatch`** — the redirect did not belong to the login you started. Close stale
authorization tabs and try again.

**`OAuth needs both MONEYBIRD_CLIENT_ID and MONEYBIRD_CLIENT_SECRET`** — only one is set. The
server refuses to guess.
