import { describe, it, expect } from 'vitest';
import { MICROSOFT_OAUTH_ENDPOINTS, ONEDRIVE_SCOPES } from '@/providers/microsoft/microsoft-oauth';
import { GOOGLE_OAUTH_ENDPOINTS, GOOGLE_DRIVE_SCOPES } from '@/providers/google/google-oauth';

describe('MICROSOFT_OAUTH_ENDPOINTS', () => {
  it('exposes Microsoft OAuth endpoints', () => {
    expect(MICROSOFT_OAUTH_ENDPOINTS.authUrl).toContain('login.microsoftonline.com');
    expect(MICROSOFT_OAUTH_ENDPOINTS.tokenUrl).toContain('login.microsoftonline.com');
    expect(MICROSOFT_OAUTH_ENDPOINTS.userinfoUrl).toContain('graph.microsoft.com');
  });

  it('exposes OneDrive scopes including offline access and file permissions', () => {
    expect(ONEDRIVE_SCOPES).toContain('offline_access');
    expect(ONEDRIVE_SCOPES).toContain('Files.ReadWrite');
    expect(ONEDRIVE_SCOPES).toContain('Files.ReadWrite.AppFolder');
  });
});

describe('GOOGLE_OAUTH_ENDPOINTS', () => {
  it('exposes Google OAuth endpoints', () => {
    expect(GOOGLE_OAUTH_ENDPOINTS.authUrl).toContain('accounts.google.com');
    expect(GOOGLE_OAUTH_ENDPOINTS.tokenUrl).toContain('oauth2.googleapis.com');
    expect(GOOGLE_OAUTH_ENDPOINTS.revokeUrl).toContain('oauth2.googleapis.com');
    expect(GOOGLE_OAUTH_ENDPOINTS.userinfoUrl).toContain('googleapis.com');
  });

  it('exposes Google Drive scopes', () => {
    expect(GOOGLE_DRIVE_SCOPES).toContain('https://www.googleapis.com/auth/drive');
    expect(GOOGLE_DRIVE_SCOPES).toContain('https://www.googleapis.com/auth/drive.appdata');
  });
});
