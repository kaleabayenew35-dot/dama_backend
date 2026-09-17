import { nanoid } from 'nanoid';
import db from '../db/database.js';
import * as playersService from '../services/players.js';
import { getAllOwnerBalances } from '../services/settlement.js';
import { ok, fail } from '../utils/response.js';

const ETHIOPIAN_NAMES = [
  'Abebe Bikila',
  'Tirunesh Dibaba',
  'Haile Gebrselassie',
  'Almaz Ayana',
  'Kenenisa Bekele',
];

export const getStats = async (req, res, next) => {
  try {
    const totalPlayers  = db.prepare('SELECT COUNT(*) as cnt FROM players').get().cnt;
    const onlinePlayers = db.prepare('SELECT COUNT(*) as cnt FROM players WHERE online = 1').get().cnt;
    const totalGames    = db.prepare('SELECT COUNT(*) as cnt FROM games').get().cnt;
    const activeGames   = db.prepare("SELECT COUNT(*) as cnt FROM games WHERE status = 'active'").get().cnt;
    const totalETB      = db.prepare('SELECT COALESCE(SUM(balance), 0) as total FROM players').get().total;

    ok(res, { totalPlayers, onlinePlayers, totalGames, activeGames, totalETB });
  } catch (err) {
    next(err);
  }
};

export const listAllPlayers = async (req, res, next) => {
  try {
    const players = db.prepare('SELECT * FROM players ORDER BY created_at DESC').all();
    ok(res, players);
  } catch (err) {
    next(err);
  }
};

export const deleteDemoPlayers = async (req, res, next) => {
  try {
    const info = db.prepare("DELETE FROM players WHERE id LIKE 'demo_%'").run();
    ok(res, { deleted: info.changes });
  } catch (err) {
    next(err);
  }
};

export const seedDemoPlayers = async (req, res, next) => {
  try {
    const seeded = [];
    for (const name of ETHIOPIAN_NAMES) {
      const id = `demo_${nanoid()}`;
      playersService.upsert({ id, name, isDemo: true });
      seeded.push(id);
    }
    ok(res, { seeded: seeded.length, ids: seeded }, 201);
  } catch (err) {
    next(err);
  }
};

export const getOwnerBalances = async (req, res, next) => {
  try {
    const balances = getAllOwnerBalances();
    ok(res, balances);
  } catch (err) { next(err); }
};

export const getConnectionsStatus = async (req, res, next) => {
  try {
    const gameBackend = { status: 'online', url: `${req.protocol}://${req.get('host')}` };
    const tokens = db.prepare('SELECT id, owner, backend_url, is_active FROM api_tokens').all();
    const tokenBackends = [];

    for (const t of tokens) {
      if (!t.backend_url) {
        tokenBackends.push({ id: t.id, owner: t.owner, url: null, status: 'not_configured' });
        continue;
      }
      try {
        const checkUrl = t.backend_url.replace(/\/$/, '') + '/dama';
        const pingRes = await fetch(checkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_balance', phone: '0000000000', token: t.token }),
          signal: AbortSignal.timeout(2000),
        });
        tokenBackends.push({
          id: t.id,
          owner: t.owner,
          url: t.backend_url,
          status: pingRes.ok ? 'online' : 'error',
          statusCode: pingRes.status
        });
      } catch (err) {
        tokenBackends.push({
          id: t.id,
          owner: t.owner,
          url: t.backend_url,
          status: 'offline',
          error: err.message
        });
      }
    }

    ok(res, { gameBackend, tokenBackends });
  } catch (err) {
    next(err);
  }
};

export const getItemStats = async (req, res, next) => {
  try {
    // Count purchases per item_id from owned_items table
    const rows = db.prepare(`
      SELECT
        item_id,
        COUNT(*) AS purchase_count,
        GROUP_CONCAT(p.name, ', ') AS buyers
      FROM owned_items oi
      JOIN players p ON p.id = oi.player_id
      GROUP BY oi.item_id
      ORDER BY purchase_count DESC
    `).all();

    // Build a map: item_id → { purchase_count, buyers[] }
    const statsMap = {};
    for (const row of rows) {
      statsMap[row.item_id] = {
        purchase_count: row.purchase_count,
        buyers: row.buyers ? row.buyers.split(', ') : [],
      };
    }

    ok(res, statsMap);
  } catch (err) { next(err); }
};

export const getTokenUsers = async (req, res, next) => {
  try {
    const tokens = db.prepare(`
      SELECT
        t.id,
        t.key_name,
        t.owner,
        t.token,
        t.is_active,
        t.created_at,
        t.last_used,
        COUNT(p.id)                 AS player_count,
        COALESCE(SUM(p.balance), 0) AS total_balance,
        SUM(CASE WHEN p.online = 1 THEN 1 ELSE 0 END) AS online_count,
        SUM(p.wins)                 AS total_wins,
        SUM(p.losses)               AS total_losses,
        COALESCE(ob.balance, 0)     AS owner_balance,
        COALESCE(ob.total_earned, 0) AS owner_total_earned
      FROM api_tokens t
      LEFT JOIN players p  ON p.token_id = t.id AND p.is_ai = 0 AND p.is_demo = 0
      LEFT JOIN token_owner_balances ob ON ob.token_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `).all();

    const result = tokens.map(tok => {
      const players = db.prepare(`
        SELECT id, name, phone, balance, wins, losses, draws, online, last_seen, bet, piece_theme
        FROM players
        WHERE token_id = ? AND is_ai = 0 AND is_demo = 0
        ORDER BY balance DESC
      `).all(tok.id);
      return { ...tok, players };
    });

    ok(res, result);
  } catch (err) { next(err); }
};

export const adminAdjustBalance = async (req, res, next) => {
  try {
    const existing = playersService.getById(req.params.id);
    if (!existing) return fail(res, 'Player not found', 404);

    const { amount, balance } = req.body;

    let player;
    if (typeof balance === 'number') {
      // Set exact balance
      player = playersService.update(req.params.id, { balance: Math.max(0, balance) });
    } else if (typeof amount === 'number') {
      // Adjust relative
      player = playersService.adjustBalance(req.params.id, amount);
    } else {
      return fail(res, 'Provide either amount or balance', 400);
    }

    ok(res, player);
  } catch (err) {
    next(err);
  }
};

export const getOwnerTransactions = async (req, res, next) => {
  try {
    const { from, to, token_id } = req.query;
    const conditions = [];
    const params = [];

    if (token_id) { conditions.push('tot.token_id = ?'); params.push(Number(token_id)); }
    if (from)     { conditions.push('tot.created_at >= ?'); params.push(Math.floor(new Date(from).getTime() / 1000)); }
    if (to)       { conditions.push('tot.created_at <= ?'); params.push(Math.floor(new Date(to).getTime() / 1000) + 86399); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT tot.id, tot.token_id, tot.game_id, tot.type, tot.amount,
             tot.running_balance, tot.note, tot.created_at,
             t.owner, t.key_name
      FROM token_owner_transactions tot
      JOIN api_tokens t ON t.id = tot.token_id
      ${where}
      ORDER BY tot.created_at DESC, tot.id DESC
      LIMIT 500
    `).all(...params);

    ok(res, rows);
  } catch (err) { next(err); }
};

/**
 * GET /api/admin/pending-callbacks
 * Query params (all optional):
 *   status   — 'pending' | 'failed' | 'delivered'  (default: pending + failed)
 *   token_id — filter by token
 *   game_id  — filter by game
 *   limit    — default 200
 *
 * Returns outbox rows so an operator can see what never delivered.
 */
export const getPendingCallbacks = async (req, res, next) => {
  try {
    const { status, token_id, game_id, limit = 200 } = req.query;
    const conditions = [];
    const params     = [];

    if (status) {
      conditions.push('poc.status = ?');
      params.push(status);
    } else {
      // Default: show everything that isn't cleanly delivered
      conditions.push("poc.status IN ('pending','failed')");
    }

    if (token_id) {
      conditions.push('poc.token_id = ?');
      params.push(Number(token_id));
    }

    if (game_id) {
      conditions.push('poc.game_id = ?');
      params.push(game_id);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(Math.min(Number(limit), 500));

    const rows = db.prepare(`
      SELECT
        poc.id, poc.token_id, poc.game_id, poc.action,
        poc.payload_json, poc.attempts, poc.last_error,
        poc.status, poc.created_at, poc.updated_at,
        t.owner, t.key_name, t.backend_url
      FROM pending_owner_callbacks poc
      LEFT JOIN api_tokens t ON t.id = poc.token_id
      ${where}
      ORDER BY poc.created_at DESC, poc.id DESC
      LIMIT ?
    `).all(...params);

    // Parse payload_json for readability — keep raw string as fallback
    const data = rows.map(row => {
      let payload = row.payload_json;
      try { payload = JSON.parse(row.payload_json); } catch { /* keep raw */ }
      return { ...row, payload_json: undefined, payload };
    });

    ok(res, data);
  } catch (err) { next(err); }
};
