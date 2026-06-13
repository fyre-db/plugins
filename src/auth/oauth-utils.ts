export function generateState(provider: string, feature: string): { state: string; csrf: string } {
  const csrf = crypto.randomUUID();
  const payload = { provider, feature, csrf };
  return { state: btoa(JSON.stringify(payload)), csrf };
}

export type OAuthState = {
  readonly provider: string;
  readonly feature: string;
  readonly csrf: string;
};

export function parseState(state: string): OAuthState {
  return JSON.parse(atob(state)) as OAuthState;
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function setCookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookieHeader(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function getCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return undefined;
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
  return match?.substring(name.length + 1);
}



export function isSafeReturnUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') && !url.toLowerCase().startsWith('javascript:');
}

export type RefreshCookiePayload = {
  readonly name: string;
  readonly token: string;
};

export function encodeRefreshCookie(name: string, token: string): string {
  return btoa(JSON.stringify({ name, token }));
}

export function decodeRefreshCookie(value: string): RefreshCookiePayload {
  return JSON.parse(atob(value)) as RefreshCookiePayload;
}
