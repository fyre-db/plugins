import type { OAuthEndpoints } from '@/auth/types';

export const GOOGLE_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
} as const;

export const GOOGLE_DRIVE_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.appdata',
] as const;
