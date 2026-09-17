// tests/launchToken.test.js
//
// Unit tests for src/utils/launchToken.js
// Covers the new system-backend verification flow.

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const VALID_CLAIMS = {
  phone: '251911223344',
  username: 'Abebe',
  balance: 500,
  gameId: 'game_abc',
};

const { verifyLaunchToken } = await import('../src/utils/launchToken.js');
const appModule = await import('../src/app.js');
const app = appModule.default;

describe('verifyLaunchToken', () => {
  const SYSTEM_BACKEND_URL = 'https://system-backend.example';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the claims from the system-backend verification response', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: true, ...VALID_CLAIMS }),
    });

    const result = await verifyLaunchToken('token', SYSTEM_BACKEND_URL);

    expect(fetch).toHaveBeenCalledWith(
      'https://system-backend.example/api/verify-launch-token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launch: 'token' }),
      })
    );
    expect(result).toEqual({
      phone: '251911223344',
      username: 'Abebe',
      balance: 500,
      gameId: 'game_abc',
    });
  });

  it('returns null when the system backend reports an invalid launch token', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: false }),
    });

    await expect(verifyLaunchToken('token', SYSTEM_BACKEND_URL)).resolves.toBeNull();
  });

  it('throws when the system backend URL is missing', async () => {
    await expect(verifyLaunchToken('token', '')).rejects.toThrow('system backend URL is required');
  });

  it('returns null for empty tokens before contacting the system backend', async () => {
    await expect(verifyLaunchToken('   ', SYSTEM_BACKEND_URL)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('/api/player-balance fallback behavior', () => {
  it('returns 200 with null values when launch verification fails', async () => {
    const response = await request(app)
      .post('/api/player-balance')
      .send({ token: 'dama_test', launch: 'bad-launch-token' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: { balance: null, username: null },
    });
  });
});
