import type { OAuthEndpoints, UserInfoMapper } from '@/auth/types';

export const GOOGLE_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
} as const;

/** Maps Google's OIDC userinfo payload (`sub`/`email`/`name`/`picture`). */
export const GOOGLE_USERINFO_MAPPER: UserInfoMapper = (raw) => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const userId = typeof r.sub === 'string' ? r.sub : '';
  if (!userId) return null;
  return {
    userId,
    email: typeof r.email === 'string' ? r.email : '',
    name: typeof r.name === 'string' ? r.name : '',
    picture: typeof r.picture === 'string' ? r.picture : '',
  };
};

export const GOOGLE_DRIVE_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.appdata',
] as const;
