/**
 * Tagged access-token. Carries the issuing adapter's name so a downstream
 * cloud adapter can sanity-check it received the right kind of token.
 *
 * Per PLUGGABLES_V2 §2.
 */
export type AccessToken = {
  /** Issuing adapter name: 'google', 'dropbox', 'corp-sso', ... */
  readonly name: string;
  /** Raw bearer token string. */
  readonly token: string;
  /** Optional expiry (epoch ms). `undefined` = unknown. */
  readonly expiresAt?: number;
  /** Signed-in account's normalized profile, when the server resolved it. */
  readonly profile?: UserProfile;
};

/**
 * Normalized identity of a signed-in / connected account, resolved by the
 * server side from the provider's userinfo endpoint. Provider-agnostic shape.
 */
export type UserProfile = {
  /** Issuing adapter name: 'google', 'microsoft', ... */
  readonly provider: string;
  /** Provider-stable account id (`sub` / `id`). */
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string;
};

/**
 * Maps a provider's raw userinfo JSON to the provider-agnostic profile
 * fields. `provider` is stamped by the adapter. Return `null` when the
 * payload is missing a stable account id.
 */
export type UserInfoMapper = (raw: unknown) => Omit<UserProfile, 'provider'> | null;

/**
 * Aggregate browser-side auth state derived by `ClientAuthService` from its
 * adapters. Per PLUGGABLES_V2 §5.
 */
export type AuthStateStatus = 'loading' | 'signed-in' | 'signed-out';

export type AuthState = {
  readonly status: AuthStateStatus;
  /** Active adapter's name when `status === 'signed-in'`. */
  readonly name?: string;
  /** Signed-in account's normalized profile, when resolved by the server. */
  readonly profile?: UserProfile;
};

/**
 * One auth mechanism on the browser side. The adapter is a stateless
 * protocol shell — it knows how to start a login flow, refresh against the
 * server-held credential, and tear down. It does **not** cache tokens, mark
 * itself active, or expose state. `ClientAuthService` owns all of that.
 *
 * Per PLUGGABLES_V2 §3.
 */
export type ClientAuthAdapter = {
  readonly name: string;

  /**
   * Begin the login flow.
   * - Redirect/BFF: navigates the page; the returned promise never resolves
   *   (the caller's JS context is unloaded).
   * - Popup/PKCE: resolves once the popup completes; the service then calls
   *   `refresh()` to materialise the access token.
   *
   * @param feature — scope group to request. Defaults to `'login'`.
   */
  login(feature?: string): Promise<void>;

  /**
   * Try to obtain a fresh access token from the server-held credential
   * (BFF: HttpOnly refresh cookie; PKCE: secret store). Returns `null`
   * when no session exists or the refresh failed.
   *
   * The returned token's `name` must equal this adapter's `name`.
   *
   * @param feature — when set, refreshes a feature-scoped token using
   *   the provided `refreshToken` instead of the login cookie.
   * @param refreshToken — required when `feature` is set.
   */
  refresh(feature?: string, refreshToken?: string): Promise<AccessToken | null>;

  /** Best-effort revoke + clear server-side state. Never throws. */
  logout(): Promise<void>;

  /**
   * Process the OAuth callback on the current page. Each adapter knows
   * its own callback protocol (BFF: hash fragment, PKCE: query params).
   * Returns parsed creds or `null` if no callback data is present.
   * Clears callback data from the URL to prevent leaking tokens.
   */
  handleCallback?(): FeatureCreds | null;
};

export type FeatureCreds = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly feature: string;
  readonly provider: string;
  readonly receivedAt: number;
  /** Connected account's normalized profile, resolved by the server. */
  readonly profile?: UserProfile;
};

/**
 * Result of a token exchange or refresh. Clean contract type — adapters
 * map provider-specific responses to this shape.
 */
export type ServerAuthTokenResult = {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken?: string;
};

/**
 * Server-side counterpart for an auth mechanism that needs an HTTP boundary.
 * Pure protocol shell — knows how to build auth URLs, exchange codes, refresh
 * and revoke tokens. Does **not** handle HTTP routing, cookies, or CSRF —
 * `ServerAuthService` owns all of that.
 *
 * Per PLUGGABLES_V2 §4.
 */
export type ServerAuthAdapter = {
  readonly name: string;
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  login(state: string, feature: string): string;
  exchangeCode(code: string): Promise<ServerAuthTokenResult>;
  refresh(refreshToken: string): Promise<ServerAuthTokenResult>;
  logout(refreshToken: string): Promise<void>;
  /**
   * Resolve the account's normalized profile from an access token via the
   * provider's userinfo endpoint. Best-effort — returns `null` when the
   * provider has no userinfo endpoint configured or the fetch/mapping fails.
   */
  fetchUserInfo(accessToken: string): Promise<UserProfile | null>;
};

/**
 * OAuth 2.0 endpoint URLs for a provider.
 */
export type OAuthEndpoints = {
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string;
  readonly userinfoUrl?: string;
};
