import { OAUTH_SCOPES } from '../../config/schema.js';

export interface MetadataOptions {
  /** Public origin the server is reachable on, without a trailing slash. */
  issuer: string;
  /** Path the MCP endpoint is served on. */
  endpoint: string;
}

/**
 * RFC 9728 protected resource metadata.
 *
 * This is what a client fetches after the 401 tells it where to look, and it is the only thing
 * that connects the MCP endpoint to the authorization server in front of it.
 */
export function protectedResourceMetadata(options: MetadataOptions): Record<string, unknown> {
  return {
    resource: `${options.issuer}${options.endpoint}`,
    authorization_servers: [options.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/HalloSouf/moneybird-mcp',
  };
}

/**
 * RFC 8414 authorization server metadata.
 *
 * `token_endpoint_auth_methods_supported: ["none"]` says every client here is public: the secret
 * that matters belongs to the Moneybird application this server holds, and no client ever sees it.
 * PKCE is therefore not optional, which `code_challenge_methods_supported` advertises.
 */
export function authorizationServerMetadata(options: MetadataOptions): Record<string, unknown> {
  const { issuer } = options;
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    // Claude only picks this over registration when the flag and the `none` auth method are both
    // present, so the two belong together.
    client_id_metadata_document_supported: true,
    service_documentation: 'https://github.com/HalloSouf/moneybird-mcp',
  };
}
