import type { ServerAuthAdapter, ServerAuthTokenResult, OAuthEndpoints } from './types';
import { StorageError, FyreDbPluginConfigError } from '@/errors/fyredb-error';
import { log } from '@/log';

export type BffServerAdapterConfig = {
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUrl: string;
  readonly endpoints: OAuthEndpoints;
  readonly scopes: Readonly<Record<string, readonly string[]>>;
};

/**
 * BFF (server-mediated) adapter. Pure OAuth 2.0 protocol shell — builds
 * auth URLs, exchanges codes, refreshes and revokes tokens. Does **not**
 * handle HTTP routing, cookies, or CSRF — `ServerAuthService` owns that.
 *
 * Per PLUGGABLES_V2 §4.
 */
export class BffServerAdapter implements ServerAuthAdapter {
  readonly name: string;
  readonly scopes: Readonly<Record<string, readonly string[]>>;

  constructor(private readonly config: BffServerAdapterConfig) {
    this.name = config.name;
    this.scopes = config.scopes;
  }

  login(state: string, feature: string): string {
    const scopes = this.scopes[feature] as string[] | undefined;
    if (!scopes) throw new FyreDbPluginConfigError(`Unknown feature: ${feature}`);
    const url = new URL(this.config.endpoints.authUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  async exchangeCode(code: string): Promise<ServerAuthTokenResult> {
    const r = await this.tokenRequest({
      code,
      redirect_uri: this.config.callbackUrl,
      grant_type: 'authorization_code',
    });
    log.auth('code exchanged for %s', this.name);
    return { accessToken: r.access_token, expiresIn: r.expires_in, refreshToken: r.refresh_token };
  }

  async refresh(refreshToken: string): Promise<ServerAuthTokenResult> {
    log.auth('refreshing token for %s (token=%s...)', this.name, refreshToken.slice(0, 8));
    const r = await this.tokenRequest({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    log.auth('token refreshed for %s (expires_in=%d)', this.name, r.expires_in);
    return { accessToken: r.access_token, expiresIn: r.expires_in, refreshToken: r.refresh_token };
  }

  async logout(refreshToken: string): Promise<void> {
    if (!this.config.endpoints.revokeUrl) return;
    await fetch(this.config.endpoints.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
  }

  private async tokenRequest(params: Record<string, string>): Promise<{
    readonly access_token: string;
    readonly refresh_token?: string;
    readonly expires_in: number;
  }> {
    const response = await fetch(this.config.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...params,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      log.auth.error(
        'token request failed: status=%d url=%s body=%s',
        response.status,
        this.config.endpoints.tokenUrl,
        body || '(empty)',
      );
      throw new StorageError(`Token request failed: ${response.status} ${body}`, { kind: 'auth-expired' });
    }
    return (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  }
}
