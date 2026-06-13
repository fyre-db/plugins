import type { OAuthEndpoints } from '@/auth/types';

export const MICROSOFT_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
} as const;

export const ONEDRIVE_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'Files.ReadWrite',
  'Files.ReadWrite.AppFolder',
] as const;
