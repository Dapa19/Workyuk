import { describe, expect, it, vi, afterEach } from 'vitest';
import { api, formatBytes, formatDate } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('client API helpers', () => {
  it('sends JSON requests with browser credentials and unwraps data', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { ok: true } }) });
    vi.stubGlobal('fetch', fetch);
    await expect(api('/auth/me')).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/me');
    expect(fetch.mock.calls[0][1].credentials).toBe('include');
  });
  it('preserves safe field errors from the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { code: 'VALIDATION_ERROR', message: 'Periksa data.', fields: { username: ['Wajib diisi'] } } }) }));
    await expect(api('/agency/clients')).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR', fields: { username: ['Wajib diisi'] } });
  });
  it('formats Indonesian dates and file sizes', () => {
    expect(formatDate('2026-10-20')).toContain('20');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });
});
