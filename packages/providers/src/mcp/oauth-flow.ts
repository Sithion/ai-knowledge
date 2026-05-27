import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { CogniStoreOAuthProvider } from './oauth-provider.js';
import { guardRemoteMcpUrl } from './url-guard.js';
import type { ITokenStore } from '../secrets/token-store.js';

export interface InteractiveOAuthOptions {
  providerId: string;
  url: string;
  /** Loopback redirect URI reserved by the desktop shell for this attempt. */
  redirectUrl: string;
  scopes?: string[];
  clientId?: string;
  allowInsecure?: boolean;
  tokenStore: ITokenStore;
}

/**
 * Drives the interactive half of the OAuth 2.1 flow for a remote MCP server, held
 * across two HTTP requests by the dashboard server: `begin()` discovers + builds the
 * authorization URL (the SDK saves the PKCE verifier + any DCR client info via the
 * token store); `finish(code)` exchanges the code for tokens (also persisted).
 */
export class InteractiveOAuthFlow {
  private readonly transport: StreamableHTTPClientTransport;
  private authUrl: URL | null = null;

  constructor(opts: InteractiveOAuthOptions) {
    const url = guardRemoteMcpUrl(opts.url, opts.allowInsecure);
    const provider = new CogniStoreOAuthProvider(opts.tokenStore, {
      providerId: opts.providerId,
      redirectUrl: opts.redirectUrl,
      scopes: opts.scopes,
      clientId: opts.clientId,
      onRedirect: (u) => { this.authUrl = u; },
    });
    this.transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  }

  /**
   * Attempt to connect. If the server needs authorization, the SDK calls
   * `redirectToAuthorization` (captured here) and throws `UnauthorizedError`; we
   * return the authorization URL the user must visit. If tokens already exist the
   * connect succeeds and we return `null` (already authorized).
   */
  async begin(): Promise<string | null> {
    const client = new Client({ name: 'cognistore', version: '1.0.0' });
    try {
      await client.connect(this.transport);
      await client.close();
      return null; // already authorized
    } catch (e) {
      if (e instanceof UnauthorizedError && this.authUrl) return this.authUrl.toString();
      throw e;
    }
  }

  /** Exchange the authorization code for tokens (saved via the token store). */
  async finish(authorizationCode: string): Promise<void> {
    await this.transport.finishAuth(authorizationCode);
    await this.dispose();
  }

  async dispose(): Promise<void> {
    try { await this.transport.close(); } catch { /* ignore */ }
  }
}
