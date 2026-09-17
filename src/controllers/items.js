// backend/src/controllers/items.js
import db from '../db/database.js';
import * as playersService from '../services/players.js';
import { ok, fail } from '../utils/response.js';

// All valid item IDs (mirrors frontend PIECE_THEMES + BALL_STYLES)
const ITEM_CATALOGUE = {
  // themes — premium only (free ones can't be purchased)
  lava:    { type:'theme', price:50  },
  mint:    { type:'theme', price:50  },
  dusk:    { type:'theme', price:50  },
  ruby:    { type:'theme', price:100 },
  cosmic:  { type:'theme', price:100 },
  copper:  { type:'theme', price:150 },
  venom:   { type:'theme', price:200 },
  // styles
  metal:   { type:'style', price:80  },
  wood:    { type:'style', price:80  },
  crystal: { type:'style', price:120 },
  shadow:  { type:'style', price:120 },
  marble:  { type:'style', price:150 },
  pawn:    { type:'style', price:200 },
  hex:     { type:'style', price:200 },
  star:    { type:'style', price:250 },
  diamond: { type:'style', price:250 },
};

/**
 * GET /api/players/:id/owned
 * Returns array of item IDs owned by the player.
 */
export const getOwnedItems = (req, res, next) => {
  try {
    const rows = db.prepare(
      'SELECT item_id FROM owned_items WHERE player_id = ?'
    ).all(req.params.id);
    ok(res, rows.map(r => r.item_id));
  } catch (err) { next(err); }
};

/**
 * POST /api/players/:id/purchase
 * Body: { itemId }
 * Validates balance, deducts, inserts into owned_items.
 */
export const purchaseItem = (req, res, next) => {
  try {
    const { id: playerId } = req.params;
    const { itemId } = req.body;

    if (!itemId) return fail(res, 'itemId is required', 400);

    const catalogueItem = ITEM_CATALOGUE[itemId];
    if (!catalogueItem) return fail(res, `Unknown item: ${itemId}`, 400);

    const player = playersService.getById(playerId);
    if (!player) return fail(res, 'Player not found', 404);

    // Already owned?
    const already = db.prepare(
      'SELECT 1 FROM owned_items WHERE player_id = ? AND item_id = ?'
    ).get(playerId, itemId);
    if (already) return fail(res, 'Item already owned', 409);

    // Sufficient balance?
    if (player.balance < catalogueItem.price) {
      return fail(res, `Insufficient balance. Need ${catalogueItem.price} ETB, have ${player.balance} ETB`, 402);
    }

    // Deduct balance and record ownership in a transaction
    db.prepare('BEGIN').run();
    try {
      db.prepare(
        'UPDATE players SET balance = balance - ? WHERE id = ?'
      ).run(catalogueItem.price, playerId);

      db.prepare(
        'INSERT INTO owned_items (player_id, item_id) VALUES (?, ?)'
      ).run(playerId, itemId);

      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }

    const updated = playersService.getById(playerId);
    ok(res, { player: updated, itemId, price: catalogueItem.price });
  } catch (err) { next(err); }
};

/**
 * POST /api/admin/items/grant   (admin only)
 * Body: { playerId, itemId }
 * Grants an item to a player for free (no balance deduction).
 */
export const grantItem = (req, res, next) => {
  try {
    const { playerId, itemId } = req.body;
    if (!playerId || !itemId) return fail(res, 'playerId and itemId required', 400);

    const player = playersService.getById(playerId);
    if (!player) return fail(res, 'Player not found', 404);

    if (!ITEM_CATALOGUE[itemId]) return fail(res, `Unknown item: ${itemId}`, 400);

    // INSERT OR IGNORE — no error if already owned
    db.prepare(
      'INSERT OR IGNORE INTO owned_items (player_id, item_id) VALUES (?, ?)'
    ).run(playerId, itemId);

    ok(res, { granted: true, playerId, itemId });
  } catch (err) { next(err); }
};

/**
 * DELETE /api/admin/items/:playerId/:itemId   (admin only)
 * Revokes an item from a player (refund is optional — not included by default).
 */
export const revokeItem = (req, res, next) => {
  try {
    const { playerId, itemId } = req.params;

    const info = db.prepare(
      'DELETE FROM owned_items WHERE player_id = ? AND item_id = ?'
    ).run(playerId, itemId);

    if (!info.changes) return fail(res, 'Item not owned by this player', 404);
    ok(res, { revoked: true, playerId, itemId });
  } catch (err) { next(err); }
};
