import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ITokenStore } from '../secrets/token-store.js';

export interface CogniStoreOAuthOptions {
  /** Provider id — the key under which this session's state is persisted. */
  providerId: string;
  /** Loopback redirect URI for this attempt (e.g. http://127.0.0.1:<port>/callback). */
  redirectUrl: string;
  clientName?: string;
  scopes?: string[];
  /** Static client_id for servers that don't support Dynamic Client Registration. */
  clientId?: string;
  /** Host hook: open the system browser at the authorization URL. */
  onRedirect: (authorizationUrl: URL) => void | Promise<void>;
}

/**
 * CogniStore's `OAuthClientProvider` implementation. The MCP SDK drives the OAuth
 * 2.1 protocol (discovery, PKCE, DCR, token exchange, refresh); this class only
 * persists session state via the injected token store and hands the authorization
 * URL to the host (which opens the browser and captures the loopback redirect).
 */
export class CogniStoreOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly store: ITokenStore,
    private readonly opts: CogniStoreOAuthOptions,
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'CogniStore',
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(' ') } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const s = await this.store.get(this.opts.providerId);
    if (s.clientInformation) return s.clientInformation;
    if (this.opts.clientId) return { client_id: this.opts.clientId };
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.patch(this.opts.providerId, { clientInformation: info as OAuthClientInformationFull });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.get(this.opts.providerId)).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.patch(this.opts.providerId, { tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.opts.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.patch(this.opts.providerId, { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const s = await this.store.get(this.opts.providerId);
    if (!s.codeVerifier) throw new Error('no PKCE code_verifier saved for this OAuth session');
    return s.codeVerifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') {
      await this.store.delete(this.opts.providerId);
      return;
    }
    const patch: Partial<{ tokens: undefined; clientInformation: undefined; codeVerifier: undefined }> = {};
    if (scope === 'tokens') patch.tokens = undefined;
    if (scope === 'client') patch.clientInformation = undefined;
    if (scope === 'verifier') patch.codeVerifier = undefined;
    await this.store.patch(this.opts.providerId, patch);
  }
}
