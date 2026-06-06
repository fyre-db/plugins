import type { ServerAuthAdapter } from './types';
import { StrataPluginConfigError } from '@/errors/strata-error';
import { log } from '@/log';
import {
  generateState,
  parseState,
  jsonResponse,
  errorResponse,
  setCookieHeader,
  clearCookieHeader,
  getCookie,
  encodeRefreshCookie,
  decodeRefreshCookie,
} from './oauth-utils';

export type ServerAuthServiceOptions = {
  /** URL prefix shared by all auth routes (e.g. `'/api/auth'`). */
  readonly basePath: string;
  /** Cookie name for the base64-encoded refresh token payload. */
  readonly refreshCookieName: string;
  /** Cookie name for the CSRF token used during the OAuth round-trip. */
  readonly csrfCookieName: string;
  /** Path to redirect to after a successful login callback. */
  readonly loginRedirectPath: string;
  /** Path to redirect to after a successful feature callback. */
  readonly featureRedirectPath: string;
  /** Path to redirect to when the OAuth callback fails. */
  readonly errorRedirectPath: string;
};

const CSRF_MAX_AGE = 600;
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Owns all HTTP handling for server-side auth: routing, cookies, CSRF,
 * scope lookup, and response construction. Delegates protocol-specific
 * operations (auth URL, code exchange, refresh, logout) to the registered
 * `ServerAuthAdapter`s.
 *
 * The refresh cookie stores a base64-encoded JSON payload `{ name, token }`
 * so the provider can be resolved from the cookie on refresh/logout without
 * requiring a `?provider=` query parameter.
 *
 * Per PLUGGABLES_V2 §6.
 */
export class ServerAuthService {
  private readonly basePath: string;
  private readonly refreshCookieName: string;
  private readonly csrfCookieName: string;
  private readonly loginRedirectPath: string;
  private readonly featureRedirectPath: string;
  private readonly errorRedirectPath: string;
  private readonly byName: ReadonlyMap<string, ServerAuthAdapter>;

  constructor(adapters: readonly ServerAuthAdapter[], options: ServerAuthServiceOptions) {
    const byName = new Map<string, ServerAuthAdapter>();
    for (const a of adapters) {
      if (byName.has(a.name)) {
        throw new StrataPluginConfigError(`ServerAuthService: duplicate adapter name "${a.name}"`);
      }
      byName.set(a.name, a);
    }
    this.byName = byName;
    this.basePath = options.basePath.replace(/\/+$/, '');
    this.refreshCookieName = options.refreshCookieName;
    this.csrfCookieName = options.csrfCookieName;
    this.loginRedirectPath = options.loginRedirectPath;
    this.featureRedirectPath = options.featureRedirectPath;
    this.errorRedirectPath = options.errorRedirectPath;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = this.stripBase(url.pathname);
    if (path === null) return new Response('Not found', { status: 404 });

    const method = request.method;

    log.auth('%s %s', method, path);

    if (method === 'GET' && path === '/callback') return this.handleCallback(request, url);

    if (method === 'GET' && path === '/login') {
      const adapter = this.resolveByProvider(url);
      if (!adapter) return new Response('Not found', { status: 404 });
      return this.handleLogin(url, adapter);
    }

    if (method === 'POST' && path === '/refresh') return this.handleRefresh(request, url);
    if (method === 'POST' && path === '/logout') return this.handleLogout(request);

    return new Response('Not found', { status: 404 });
  }

  // ─── handlers ────────────────────────────────────────────

  private handleLogin(url: URL, adapter: ServerAuthAdapter): Response {
    const feature = url.searchParams.get('feature') ?? 'login';
    const scopes = adapter.scopes[feature] as string[] | undefined;
    if (!scopes) return errorResponse(`Unknown feature: ${feature}`, 400);

    const { state, csrf } = generateState(adapter.name, feature);
    const authUrl = adapter.login(state, feature);

    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': setCookieHeader(this.csrfCookieName, csrf, CSRF_MAX_AGE),
      },
    });
  }

  private async handleCallback(request: Request, url: URL): Promise<Response> {
    const stateParam = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code || !stateParam) {
      return new Response('Not found', { status: 404 });
    }

    let state;
    try {
      state = parseState(stateParam);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const adapter = this.byName.get(state.provider);
    if (!adapter) return new Response('Not found', { status: 404 });

    const csrfCookie = getCookie(request, this.csrfCookieName);
    if (!csrfCookie || csrfCookie !== state.csrf) return this.redirectError();

    let result;
    try {
      result = await adapter.exchangeCode(code);
    } catch {
      return this.redirectError();
    }

    if (!result.refreshToken) return this.redirectError();

    const isFeature = state.feature !== 'login';

    if (isFeature) {
      // Feature callback: redirect to featureRedirectPath with token data
      // as URL-encoded hash params. The client page reads them.
      const params = new URLSearchParams({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_in: String(result.expiresIn),
        feature: state.feature,
        provider: state.provider,
      });
      const headers = new Headers();
      headers.set('Location', `${this.featureRedirectPath}#${params.toString()}`);
      headers.append('Set-Cookie', setCookieHeader(this.csrfCookieName, '', 0));
      return new Response(null, { status: 302, headers });
    }

    // Login callback: set refresh cookie and redirect
    log.auth('callback succeeded for %s (feature=%s)', state.provider, state.feature);
    const cookieValue = encodeRefreshCookie(adapter.name, result.refreshToken);
    const headers = new Headers();
    headers.append('Location', this.loginRedirectPath);
    headers.append('Set-Cookie', setCookieHeader(this.refreshCookieName, cookieValue, REFRESH_MAX_AGE));
    headers.append('Set-Cookie', setCookieHeader(this.csrfCookieName, '', 0));
    return new Response(null, { status: 302, headers });
  }

  private async handleRefresh(request: Request, url: URL): Promise<Response> {
    const feature = url.searchParams.get('feature') ?? 'login';

    // Verify the login cookie exists (authenticates the caller)
    const resolved = this.resolveFromCookie(request);
    if (!resolved) return errorResponse('No refresh token found', 401);

    if (feature !== 'login') {
      // Feature refresh: use the refresh token from the request body
      const providerName = url.searchParams.get('provider');
      const adapter = providerName ? this.byName.get(providerName) : undefined;
      if (!adapter) return errorResponse('Unknown provider', 400);
      log.auth('feature refresh requested: provider=%s feature=%s', providerName, feature);

      let body;
      try {
        body = (await request.json()) as { refresh_token?: unknown };
      } catch {
        return errorResponse('Invalid request body', 400);
      }
      if (typeof body.refresh_token !== 'string') return errorResponse('Missing refresh_token', 400);

      let result;
      try {
        result = await adapter.refresh(body.refresh_token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.auth.error('feature refresh failed: provider=%s feature=%s error=%s', adapter.name, feature, msg);
        return errorResponse('Feature refresh failed', 401);
      }

      return jsonResponse({
        access_token: result.accessToken,
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken ?? body.refresh_token,
        name: adapter.name,
        feature,
      });
    }

    // Login refresh: use the cookie token
    const { adapter, token } = resolved;
    log.auth('login refresh requested: provider=%s', adapter.name);
    let result;
    try {
      result = await adapter.refresh(token);
    } catch {
      return errorResponse('Refresh failed', 401);
    }

    const responseHeaders: Record<string, string> = {};
    if (result.refreshToken && result.refreshToken !== token) {
      const cookieValue = encodeRefreshCookie(adapter.name, result.refreshToken);
      responseHeaders['Set-Cookie'] = setCookieHeader(this.refreshCookieName, cookieValue, REFRESH_MAX_AGE);
    }

    log.auth('login refresh succeeded for %s', adapter.name);
    return jsonResponse(
      { access_token: result.accessToken, expires_in: result.expiresIn, name: adapter.name },
      200,
      responseHeaders,
    );
  }

  private async handleLogout(request: Request): Promise<Response> {
    const resolved = this.resolveFromCookie(request);
    if (resolved) {
      try {
        await resolved.adapter.logout(resolved.token);
      } catch {
        // best-effort
      }
    }
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader(this.refreshCookieName) });
  }

  // ─── internals ───────────────────────────────────────────

  private stripBase(pathname: string): string | null {
    if (!this.basePath) return pathname;
    if (pathname === this.basePath) return '';
    if (pathname.startsWith(`${this.basePath}/`)) return pathname.slice(this.basePath.length);
    return null;
  }

  private resolveByProvider(url: URL): ServerAuthAdapter | undefined {
    const name = url.searchParams.get('provider');
    return name ? this.byName.get(name) : undefined;
  }

  private resolveFromCookie(request: Request): { adapter: ServerAuthAdapter; token: string } | null {
    const raw = getCookie(request, this.refreshCookieName);
    if (!raw) return null;
    try {
      const { name, token } = decodeRefreshCookie(raw);
      const adapter = this.byName.get(name);
      if (!adapter) return null;
      return { adapter, token };
    } catch {
      return null;
    }
  }

  private redirectError(): Response {
    return new Response(null, { status: 302, headers: { Location: this.errorRedirectPath } });
  }
}
