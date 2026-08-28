# Hosting

Running `moneybird-mcp` as a long-lived HTTP service instead of a local stdio process.

## The HTTP transport

```bash
moneybird-mcp serve --http --host 0.0.0.0 --port 3000
```

Two paths are served:

| Path       | Purpose                                                        |
| ---------- | -------------------------------------------------------------- |
| `/mcp`     | The Streamable HTTP MCP endpoint. Change it with `--endpoint`. |
| `/healthz` | Returns `{"status":"ok"}` with HTTP 200. Never authenticated.  |

Anything else gets a 404.

A fresh MCP server instance is built for each request, so the deployment holds no per-connection
state and can be scaled horizontally or restarted without draining sessions.

## Authentication modes

`MONEYBIRD_HTTP_AUTH` picks how incoming requests are authenticated. If it is unset, the mode is
`shared-token` when `MONEYBIRD_MCP_AUTH_TOKEN` is set and `none` otherwise.

### `none`

No check at all. Only safe when the port is not reachable from anywhere you do not control — a
loopback bind, a private network, or a proxy that authenticates on the server's behalf. Binding a
non-loopback address in this mode prints a warning at startup.

```bash
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -e MONEYBIRD_API_TOKEN=your-moneybird-token \
  -e MONEYBIRD_ADMINISTRATION_ID=123456789 \
  moneybird-mcp
```

### `shared-token`

A fixed secret guards the endpoint. Callers send `Authorization: Bearer <secret>`; the comparison
is constant-time. The server authenticates to Moneybird with its own token, so every caller acts as
the same Moneybird identity on the same administration.

```bash
docker run --rm \
  -p 3000:3000 \
  -e MONEYBIRD_HTTP_AUTH=shared-token \
  -e MONEYBIRD_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e MONEYBIRD_API_TOKEN=your-moneybird-token \
  -e MONEYBIRD_ADMINISTRATION_ID=123456789 \
  -e MONEYBIRD_ALLOW_WRITE=true \
  moneybird-mcp
```

Starting in this mode without `MONEYBIRD_MCP_AUTH_TOKEN` is a configuration error and the server
refuses to start.

### `passthrough`

The caller's bearer token _is_ the Moneybird token. The server extracts it from the
`Authorization` header and builds that request's Moneybird client with it.

```bash
docker run --rm \
  -p 3000:3000 \
  -e MONEYBIRD_HTTP_AUTH=passthrough \
  -e MONEYBIRD_ALLOW_WRITE=true \
  moneybird-mcp
```

This is the multi-tenant mode. One deployment serves many users and many administrations, and the
host stores no Moneybird credential of its own — there is nothing on the box to steal, and
revoking a user's access is something the user does in Moneybird without touching the deployment.

Two consequences to plan for:

- Every request is authenticated by Moneybird, not by the server. An invalid token surfaces as a
  Moneybird 401 in the tool result, not as an HTTP 401 from this server.
- No `MONEYBIRD_ADMINISTRATION_ID` will be right for everyone. Leave it unset; the tools then
  require an explicit `administration_id`, and callers can discover theirs with
  `list_administrations`.

Only run `passthrough` over TLS. The token is a bearer credential in a header.

### `oauth`

The server runs an OAuth 2.1 authorization server in front of Moneybird. A client discovers it,
registers itself, and sends the user to Moneybird to authorize; what the client ends up holding is
a token this server minted, which maps to a Moneybird credential only this server can read.

```bash
docker run --rm \
  -p 3000:3000 \
  -e MONEYBIRD_HTTP_AUTH=oauth \
  -e MONEYBIRD_PUBLIC_URL=https://mcp.example.com \
  -e MONEYBIRD_DATABASE_URL=postgres://user:pass@db:5432/mb_prod \
  -e MONEYBIRD_TOKEN_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -e MONEYBIRD_CLIENT_ID=your-application-id \
  -e MONEYBIRD_CLIENT_SECRET=your-application-secret \
  -e MONEYBIRD_ALLOW_WRITE=true \
  moneybird-mcp
```

Nobody pastes a token: connecting is a redirect to Moneybird and back. That is worth something on
its own, but the reason it exists is that Moneybird supports neither Dynamic Client Registration
nor PKCE, so a client cannot run this flow against Moneybird itself. This server can, because it
is two things at once — the authorization server the client talks to, and a confidential client
towards Moneybird holding the application secret.

Paths this mode adds, all outside the MCP endpoint:

| Path                                      | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `/.well-known/oauth-protected-resource`   | RFC 9728 metadata, named by the 401 on the endpoint   |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata                                     |
| `/register`                               | RFC 7591 Dynamic Client Registration                  |
| `/authorize`                              | Starts the flow, redirects to Moneybird               |
| `/oauth/callback`                         | Where Moneybird returns; must match your application  |
| `/oauth/select`                           | Records which administration the authorization is for |
| `/token`, `/revoke`                       | Token issuance, rotation and revocation               |

Consequences to plan for:

- **The redirect uri must match exactly.** Register `MONEYBIRD_PUBLIC_URL` + `/oauth/callback`
  with your Moneybird application. Moneybird compares it literally.
- **Serve on an origin, not a subpath.** A proxy that rewrites every path onto `/mcp` — a common
  way to host several MCP servers on one hostname — makes `/.well-known` and `/oauth/*`
  unreachable, and discovery fails before it starts.
- **Credentials now live on your host.** Unlike `passthrough`, this deployment stores Moneybird
  tokens. They are encrypted with `MONEYBIRD_TOKEN_ENCRYPTION_KEY`, and the tokens this server
  issues are stored only as SHA-256 hashes; losing the database without the key does not expose an
  administration. Back up the key separately from the database, because losing it means every
  authorization has to be repeated.
- **Registration is open.** Any client that can reach `/register` can register. Authorizing still
  requires a Moneybird account and consent, so an unknown client gets no further, but put the
  endpoint behind a rate limit if the deployment is public.
- **One administration per authorization.** After the Moneybird consent screen the server asks
  which administration the connection is for, and binds it to that credential. Authorizing again
  is how you change it. Tools can still address another administration explicitly with
  `administration_id`.

### Choosing between the modes

|                                    | `shared-token`                  | `passthrough`                  | `oauth`                              |
| ---------------------------------- | ------------------------------- | ------------------------------ | ------------------------------------ |
| Who holds the Moneybird credential | the server, one for all callers | each caller                    | the server, one per user             |
| What a caller supplies             | a shared secret                 | their Moneybird token          | nothing; they authorize in a browser |
| State to operate                   | none                            | none                           | Postgres and an encryption key       |
| Serves many administrations        | no                              | yes                            | yes                                  |
| Revoking one user                  | rotate the secret for everyone  | that user's token in Moneybird | `/revoke`, or in Moneybird           |

## Reverse proxy

Terminate TLS at the proxy and forward to the container over the private network:

```nginx
location /mcp {
    proxy_pass         http://127.0.0.1:3000/mcp;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   Authorization     $http_authorization;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;

    # Streamable HTTP responses arrive incrementally.
    proxy_buffering    off;
    proxy_read_timeout 300s;
}
```

Forward the `Authorization` header verbatim — both `shared-token` and `passthrough` depend on it.
Disable response buffering, or streamed responses arrive in one lump at the end.

The server does not read `X-Forwarded-For` and does not rate-limit callers itself. If your endpoint
is reachable from the internet, rate-limit it at the proxy.

### The rate limit is per IP

Moneybird's budget of 150 requests per 5 minutes (50 for `/reports`) is counted per source IP
address, not per token. The client's own pacing is per process, so it cannot see other processes.

That has a direct effect on how you scale. Several replicas behind one NAT gateway share a single
150-request budget while each believes it has the whole thing, and they will collectively trip the
limit before any of them throttles. In `passthrough` mode this is sharper still: all tenants share
the deployment's egress IP, so one busy tenant can exhaust the budget for everyone.

If you need more headroom, give instances separate egress addresses rather than adding replicas
behind one.

## Health checks and lifecycle

`/healthz` answers before any credential is validated, so it reports that the process is up and
listening, not that Moneybird is reachable. Use `moneybird-mcp status` for the latter — it verifies
the token against the API and exits non-zero on failure.

Because a server instance is built per request, credentials are resolved per request too. The
listener therefore starts even when no usable credential exists, and the failure shows up on the
first MCP call rather than at boot. Run `moneybird-mcp status` with the same environment as part of
the deployment to catch that early. `SIGINT` and `SIGTERM` close the listener and exit cleanly.

The image ships a `HEALTHCHECK` that polls `/healthz`.

## Connecting a client

For a client that supports remote MCP servers over HTTP, point it at the `/mcp` URL and give it the
bearer token the deployment expects.

```bash
claude mcp add --transport http moneybird https://mcp.example.com/mcp \
  --header "Authorization: Bearer $TOKEN"
```

In `shared-token` mode `$TOKEN` is `MONEYBIRD_MCP_AUTH_TOKEN`. In `passthrough` mode it is the
user's own Moneybird API token. In `none` mode omit the header entirely.

## Docker Compose

```yaml
services:
  moneybird-mcp:
    image: moneybird-mcp
    build: .
    restart: unless-stopped
    ports:
      - '127.0.0.1:3000:3000'
    environment:
      MONEYBIRD_HTTP_AUTH: shared-token
      MONEYBIRD_MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:?set MCP_AUTH_TOKEN}
      MONEYBIRD_API_TOKEN: ${MONEYBIRD_API_TOKEN:?set MONEYBIRD_API_TOKEN}
      MONEYBIRD_ADMINISTRATION_ID: ${MONEYBIRD_ADMINISTRATION_ID}
      MONEYBIRD_TOOLSETS: all
      MONEYBIRD_ALLOW_WRITE: 'true'
```

Deleting stays off here. Add `MONEYBIRD_ALLOW_DELETE: 'true'` only if you mean it; see the safety
model in the [README](../README.md#safety-model).
