import { describe, it, expect } from 'vitest';
import { MICROSOFT_OAUTH_ENDPOINTS, ONEDRIVE_SCOPES, MICROSOFT_USERINFO_MAPPER } from '@/providers/microsoft/microsoft-oauth';
import { GOOGLE_OAUTH_ENDPOINTS, GOOGLE_DRIVE_SCOPES, GOOGLE_USERINFO_MAPPER } from '@/providers/google/google-oauth';

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

describe('GOOGLE_USERINFO_MAPPER', () => {
  it('maps the OIDC userinfo payload', () => {
    expect(
      GOOGLE_USERINFO_MAPPER({ sub: 'g-1', email: 'a@b.com', name: 'Ada', picture: 'http://pic' }),
    ).toEqual({ userId: 'g-1', email: 'a@b.com', name: 'Ada', picture: 'http://pic' });
  });

  it('defaults missing optional fields to empty strings', () => {
    expect(GOOGLE_USERINFO_MAPPER({ sub: 'g-1' })).toEqual({
      userId: 'g-1',
      email: '',
      name: '',
      picture: '',
    });
  });

  it('returns null without a stable id or for non-objects', () => {
    expect(GOOGLE_USERINFO_MAPPER({ email: 'a@b.com' })).toBeNull();
    expect(GOOGLE_USERINFO_MAPPER(null)).toBeNull();
    expect(GOOGLE_USERINFO_MAPPER('nope')).toBeNull();
  });
});

describe('MICROSOFT_USERINFO_MAPPER', () => {
  it('maps the Graph /me payload, preferring mail over userPrincipalName', () => {
    expect(
      MICROSOFT_USERINFO_MAPPER({ id: 'm-1', mail: 'a@b.com', userPrincipalName: 'a@upn', displayName: 'Ada' }),
    ).toEqual({ userId: 'm-1', email: 'a@b.com', name: 'Ada', picture: '' });
  });

  it('falls back to userPrincipalName when mail is absent', () => {
    expect(MICROSOFT_USERINFO_MAPPER({ id: 'm-1', userPrincipalName: 'a@upn' })).toEqual({
      userId: 'm-1',
      email: 'a@upn',
      name: '',
      picture: '',
    });
  });

  it('leaves the email empty when neither mail nor userPrincipalName is present', () => {
    expect(MICROSOFT_USERINFO_MAPPER({ id: 'm-1' })).toEqual({
      userId: 'm-1',
      email: '',
      name: '',
      picture: '',
    });
  });

  it('returns null without a stable id or for non-objects', () => {
    expect(MICROSOFT_USERINFO_MAPPER({ mail: 'a@b.com' })).toBeNull();
    expect(MICROSOFT_USERINFO_MAPPER(null)).toBeNull();
  });
});
