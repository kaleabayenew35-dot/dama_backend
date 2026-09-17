// backend/src/utils/launchToken.js
//
// Server-side verification of the short-lived launch token that system-backend
// mints and passes to the frontend as a URL parameter.
//
// The browser never sees the raw phone number; it only carries an opaque token
// string that it forwards to this backend. This backend asks system-backend to
// verify the token and return the claims.
//
// Usage:
//   import { verifyLaunchToken } from '../utils/launchToken.js';
//   const claims = await verifyLaunchToken(launchParam);
//   // claims === null  →  missing / malformed token
//   // throws Error     →  expired / invalid / verification failure (treat as 401)
//   // returns { phone, username, balance, gameId }  →  valid

/**
 * Verify a launch token by delegating to system-backend.
 *
 * @param {string|undefined|null} launchToken  — raw token string from the request
 * @param {string} systemBackendUrl  — the backend URL to query for verification
 * @returns {Promise<{ phone: string, username: string, balance: number, gameId?: string } | null>}
 *
 * @throws {Error} when verification fails
 */
export async function verifyLaunchToken(launchToken, systemBackendUrl) {
  if (!launchToken || typeof launchToken !== 'string' || !launchToken.trim()) {
    return null;
  }

  if (!systemBackendUrl || typeof systemBackendUrl !== 'string' || !systemBackendUrl.trim()) {
    throw new Error('system backend URL is required');
  }

  const verifyUrl = `${systemBackendUrl.trim().replace(/\/$/, '')}/api/verify-launch-token`;
  console.log('[launch-token] verifying', { verifyUrl, launchLength: launchToken.trim().length });

  try {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ launch: launchToken.trim() }),
    });

    let rawBody = '';
    let payload = null;

    try {
      if (typeof response.json === 'function') {
        payload = await response.json();
      }
    } catch {
      payload = null;
    }

    if (!payload && typeof response.text === 'function') {
      try {
        rawBody = await response.text();
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        payload = null;
      }
    }

    if (typeof rawBody !== 'string') {
      rawBody = payload ? JSON.stringify(payload) : '';
    }

    console.log('[launch-token] response', {
      verifyUrl,
      status: response.status,
      rawBody,
    });

    if (!response.ok) {
      throw new Error(`Launch token verification failed with status ${response.status}`);
    }

    if (!payload || payload.valid !== true) {
      console.warn('[launch-token] invalid response payload', { verifyUrl, payload });
      return null;
    }

    if (!payload.phone || !payload.username) {
      return null;
    }

    return {
      phone: payload.phone,
      username: payload.username,
      balance: typeof payload.balance === 'number' ? payload.balance : null,
      gameId: payload.gameId || null,
    };
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }

    throw new Error('Launch token verification failed');
  }
}
