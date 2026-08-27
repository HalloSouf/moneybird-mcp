/**
 * Public API of moneybird-mcp.
 *
 * Importing this package embeds the Moneybird MCP server in another process; the `moneybird-mcp`
 * executable is a thin wrapper over the same functions.
 */
export { createMoneybirdServer, SERVER_NAME } from './server/create.js';
export type { CreateServerOptions, CreatedServer } from './server/create.js';
export { serveStdio } from './server/stdio.js';
export type { StdioHandle } from './server/stdio.js';
export { serveHttp, authenticate } from './server/http.js';
export type { HttpAuthMode, HttpHandle, HttpServerOptions } from './server/http.js';

export { MoneybirdClient, DEFAULT_BASE_URL } from './moneybird/client.js';
export type {
  MoneybirdClientOptions,
  MoneybirdResponse,
  RequestOptions,
  TokenProvider,
} from './moneybird/client.js';
export {
  MoneybirdError,
  MoneybirdAuthError,
  MoneybirdNetworkError,
  MoneybirdNotFoundError,
  MoneybirdRateLimitError,
  MoneybirdValidationError,
} from './moneybird/errors.js';

export {
  configFromEnv,
  permissionsFor,
  resolveToolsets,
  ConfigError,
  DEFAULT_TOOLSETS,
  OAUTH_SCOPES,
  TOOLSETS,
} from './config/schema.js';
export type { OAuthScope, ServerConfig, Toolset } from './config/schema.js';

export { FileCredentialStore, MemoryCredentialStore } from './config/store.js';
export type { CredentialStore, StoredCredentials } from './config/store.js';

export { resolveAuth, MissingCredentialsError } from './auth/provider.js';
export {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  APPLICATIONS_URL,
  AUTHORIZE_URL,
  OOB_REDIRECT_URI,
  REVOKE_URL,
  TOKEN_URL,
} from './auth/oauth.js';

export { allTools } from './tools/index.js';
export { connectTools } from './tools/connect.js';
export type { ElicitationSupport } from './tools/connect.js';
export { AuthSession } from './auth/session.js';
export type { ToolAccess, ToolDefinition, ToolContext, ToolResult } from './tools/common.js';
