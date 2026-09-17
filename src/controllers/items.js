// backend/src/controllers/items.js
import { query, withTransaction } from '../db/database.js';
import * as playersService from '../services/players.js';
import { ok, fail } from '../utils/response.js';

const ITEM_CATALOGUE = {
  lava:    { type: 'theme', price: 50  },
  mint:    { type: 'theme', price: 50  },
  dusk:    { type: 'theme', price: 50  },
  ruby:    { type: 'theme', price: 100 },
  cosmic:  { type: 'theme', price: 100 },
  copper:  { type: 'theme', price: 150 },
  venom:   { type: 'theme', price: 200 },
  metal:   { type: 'style', price: 80  },
  wood:    { type: 'style', price: 80  },
  crystal: { type: 'style', price: 120 },
  shadow:  { type: 'style', price: 120 },
  marble:  { type: 'style', price: 150 },
  pawn:    { type: 'style', price: 200 },
  hex:     { type: 'style', price: 200 },
  star:    { type: 'style', price: 250 },
  diamond: { type: 'style', price: 250 },
};

export const getOwnedItems = async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT item_id FROM owned_items WHERE player_id = $1`, [req.params.id]
    );
    ok(res, rows.map(r => r.item_id));
  } catch (err) { next(err); }
};

export const purchaseItem = async (req, res, next) => {
  try {
    const { id: playerId } = req.params;
    const { itemId } = req.body;

    if (!itemId) return fail(res, 'itemId is required', 400);

    const catalogueItem = ITEM_CATALOGUE[itemId];
    if (!catalogueItem) return fail(res, `Unknown item: ${itemId}`, 400);

    const player = await playersService.getById(playerId);
    if (!player) return fail(res, 'Player not found', 404);

    const { rows: alreadyOwned } = await query(
      `SELECT 1 FROM owned_items WHERE player_id = $1 AND item_id = $2`, [playerId, itemId]
    );
    if (alreadyOwned.length) return fail(res, 'Item already owned', 409);

    if (player.balance < catalogueItem.price) {
      return fail(res, `Insufficient balance. Need ${catalogueItem.price} ETB, have ${player.balance} ETB`, 402);
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE players SET balance = balance - $1 WHERE id = $2`, [catalogueItem.price, playerId]
      );
      await client.query(
        `INSERT INTO owned_items (player_id, item_id) VALUES ($1, $2)`, [playerId, itemId]
      );
    });

    const updated = await playersService.getById(playerId);
    ok(res, { player: updated, itemId, price: catalogueItem.price });
  } catch (err) { next(err); }
};

export const grantItem = async (req, res, next) => {
  try {
    const { playerId, itemId } = req.body;
    if (!playerId || !itemId) return fail(res, 'playerId and itemId required', 400);

    const player = await playersService.getById(playerId);
    if (!player) return fail(res, 'Player not found', 404);

    if (!ITEM_CATALOGUE[itemId]) return fail(res, `Unknown item: ${itemId}`, 400);

    await query(
      `INSERT INTO owned_items (player_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [playerId, itemId]
    );

    ok(res, { granted: true, playerId, itemId });
  } catch (err) { next(err); }
};

export const revokeItem = async (req, res, next) => {
  try {
    const { playerId, itemId } = req.params;

    const { rowCount } = await query(
      `DELETE FROM owned_items WHERE player_id = $1 AND item_id = $2`, [playerId, itemId]
    );

    if (!rowCount) return fail(res, 'Item not owned by this player', 404);
    ok(res, { revoked: true, playerId, itemId });
  } catch (err) { next(err); }
};
