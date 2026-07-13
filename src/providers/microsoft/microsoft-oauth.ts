import type { OAuthEndpoints, UserInfoMapper } from '@/auth/types';

export const MICROSOFT_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
} as const;

/**
 * Maps Microsoft Graph's `/me` payload (`id`/`mail`→`userPrincipalName`/
 * `displayName`). Graph exposes no photo URL on `/me`, so `picture` is empty.
 */
export const MICROSOFT_USERINFO_MAPPER: UserInfoMapper = (raw) => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const userId = typeof r.id === 'string' ? r.id : '';
  if (!userId) return null;
  const email =
    typeof r.mail === 'string' && r.mail
      ? r.mail
      : typeof r.userPrincipalName === 'string'
        ? r.userPrincipalName
        : '';
  return {
    userId,
    email,
    name: typeof r.displayName === 'string' ? r.displayName : '',
    picture: '',
  };
};

export const ONEDRIVE_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'Files.ReadWrite',
  'Files.ReadWrite.AppFolder',
] as const;
