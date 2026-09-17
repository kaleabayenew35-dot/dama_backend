import * as playersService from '../services/players.js';
import { ok, fail } from '../utils/response.js';
import { normalizePhone } from '../utils/phone.js';

export const listPlayers = async (req, res, next) => {
  try {
    const { online, search, limit, offset } = req.query;
    const players = await playersService.getAll({ online, search, limit, offset });
    ok(res, players);
  } catch (err) {
    next(err);
  }
};

export const getPlayer = async (req, res, next) => {
  try {
    const player = await playersService.getById(req.params.id);
    if (!player) {
      if (req.params.id.startsWith('ph_') && req.apiToken?.id) {
        const phone = req.params.id.replace('ph_', '');
        const created = await playersService.upsert({
          id:      req.params.id,
          name:    'Player',
          phone,
          tokenId: req.apiToken.id,
        });
        return ok(res, created);
      }
      return fail(res, 'Player not found', 404);
    }
    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const upsertPlayer = async (req, res, next) => {
  try {
    const { id, name, photo, bet, pieceThemeId, isDemo, phone } = req.body;
    const lastIp  = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const rawUa   = req.headers['user-agent'] || 'Unknown Device';

    let lastDevice = 'Desktop / Browser';
    if (/mobile/i.test(rawUa)) {
      if (/iphone/i.test(rawUa))       lastDevice = 'iPhone';
      else if (/ipad/i.test(rawUa))    lastDevice = 'iPad';
      else if (/android/i.test(rawUa)) lastDevice = 'Android Mobile';
      else                             lastDevice = 'Mobile Browser';
    } else {
      if (/windows/i.test(rawUa))      lastDevice = 'Windows PC';
      else if (/macintosh/i.test(rawUa)) lastDevice = 'Macbook / iMac';
      else if (/linux/i.test(rawUa))   lastDevice = 'Linux PC';
    }

    const player = await playersService.upsert({
      id, name, photo,
      phone: normalizePhone(phone),
      bet, pieceThemeId, isDemo,
      lastIp, lastDevice,
      tokenId: req.apiToken?.id || null,
    });
    ok(res, player, 200);
  } catch (err) {
    next(err);
  }
};

export const updatePlayer = async (req, res, next) => {
  try {
    const existing = await playersService.getById(req.params.id);
    if (!existing) return fail(res, 'Player not found', 404);
    const player = await playersService.update(req.params.id, req.body);
    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const adjustBalance = async (req, res, next) => {
  try {
    const existing = await playersService.getById(req.params.id);
    if (!existing) return fail(res, 'Player not found', 404);
    const { amount } = req.body;
    const player = await playersService.adjustBalance(req.params.id, amount);
    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const deletePlayer = async (req, res, next) => {
  try {
    const deleted = await playersService.deletePlayer(req.params.id);
    if (!deleted) return fail(res, 'Player not found', 404);
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
};

export const recordResult = async (req, res, next) => {
  try {
    const existing = await playersService.getById(req.params.id);
    if (!existing) return fail(res, 'Player not found', 404);
    const { result } = req.body;
    const player = await playersService.recordResult(req.params.id, result);
    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const setReady = async (req, res, next) => {
  try {
    const { id } = req.params;
    let existing = await playersService.getById(id);

    if (!existing && id.startsWith('ph_') && req.apiToken?.id) {
      const phone = id.replace('ph_', '');
      existing = await playersService.upsert({
        id,
        name:    'Player',
        phone,
        tokenId: req.apiToken.id,
      });
    }

    if (!existing) return fail(res, 'Player not found', 404);

    const { bet } = req.body;
    if (!bet || isNaN(Number(bet)) || Number(bet) <= 0) {
      return fail(res, 'Valid bet amount required', 400);
    }

    const player = await playersService.setReady(id, Number(bet));

    const { broadcastPlayerUpdated } = await import('../ws/wsServer.js');
    broadcastPlayerUpdated(player);

    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const clearReady = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await playersService.getById(id);
    if (!existing) return fail(res, 'Player not found', 404);

    const player = await playersService.clearReady(id);

    const { broadcastPlayerUpdated } = await import('../ws/wsServer.js');
    broadcastPlayerUpdated(player);

    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const listReadyPlayers = async (req, res, next) => {
  try {
    const { bet, excludeId } = req.query;
    const players = await playersService.getReadyPlayers({
      bet:       bet       ? Number(bet)  : undefined,
      excludeId: excludeId || undefined,
    });
    ok(res, players);
  } catch (err) {
    next(err);
  }
};
