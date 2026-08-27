---
'moneybird-mcp': minor
---

First release. An MCP server for the Moneybird API with 200 tools across nine toolsets, read-only
until write access is enabled explicitly.

- Connect from inside the conversation with `connect_moneybird`, which opens Moneybird's token page
  and stores the token you create. Falls back to `moneybird-mcp login` where the client cannot
  prompt.
- Personal API tokens and OAuth applications, including loopback and out-of-band authorization and
  automatic token refresh.
- stdio and Streamable HTTP transports, the latter with no-auth, shared-token and passthrough
  authentication.
- Request pacing that respects Moneybird's published rate limits, typed errors for both of its
  error shapes, and `Link` header pagination.
