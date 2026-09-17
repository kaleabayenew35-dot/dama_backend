/**
 * Send a successful response: { ok: true, data }
 * @param {import('express').Response} res
 * @param {*} data
 * @param {number} [status=200]
 */
export const ok = (res, data, status = 200) => {
  res.status(status).json({ ok: true, data });
};

/**
 * Send a failure response: { ok: false, error }
 * @param {import('express').Response} res
 * @param {string} message
 * @param {number} [status=400]
 */
export const fail = (res, message, status = 400) => {
  res.status(status).json({ ok: false, error: message });
};
