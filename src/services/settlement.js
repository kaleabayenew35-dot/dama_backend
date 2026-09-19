// backend/src/services/settlement.js
import { query } from '../db/database.js';
import * as playersService from './players.js';
import { notifyWinPayout, notifyDrawRefund, notifyOwnerFee } from './ownerCallback.js';

const WIN_FEE_PCT  = 0.10;
const DRAW_FEE_PCT = 0.05;

const now = () => Math.floor(Date.now() / 1000);

// ── kept for backwards-compat call in migrations.js ──────────────────────────
export async function ensureOwnerBalanceTable() {
  // Tables are created in schema.js — nothing to do here
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function adjustOwnerBalance(tokenId, gameId, delta, type, note) {
  if (!tokenId) return; // owner balance tracking is token-based — skip if no token

  // Upsert balance row
  await query(`
    INSERT INTO token_owner_balances (token_id, balance, total_earned, updated_at)
    VALUES ($1, $2, CASE WHEN $2 > 0 THEN $2 ELSE 0 END, $3)
    ON CONFLICT (token_id) DO UPDATE SET
      balance      = token_owner_balances.balance + EXCLUDED.balance,
      total_earned = token_owner_balances.total_earned + CASE WHEN EXCLUDED.total_earned > 0 THEN EXCLUDED.total_earned ELSE 0 END,
      updated_at   = EXCLUDED.updated_at
  `, [tokenId, delta, now()]);

  const { rows } = await query(
    `SELECT balance FROM token_owner_balances WHERE token_id = $1`, [tokenId]
  );
  const runningBalance = rows[0]?.balance ?? 0;

  await query(`
    INSERT INTO token_owner_transactions (token_id, game_id, type, amount, running_balance, note, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [tokenId, gameId || null, type, delta, runningBalance, note || null, now()]);
}

async function getTokenIdForPlayer(playerId) {
  const { rows } = await query(`SELECT token_id FROM players WHERE id = $1`, [playerId]);
  // Returns null when no token linked — getBackendInfo handles the system_backend fallback
  return rows[0]?.token_id || null;
}

async function getGameTokenId(game) {
  return getTokenIdForPlayer(game.player1_id);
}

async function isAiPlayer(playerId) {
  if (!playerId) return false;
  const { rows } = await query(`SELECT is_ai FROM players WHERE id = $1`, [playerId]);
  return rows[0]?.is_ai === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// PvP settlement
// ─────────────────────────────────────────────────────────────────────────────

export async function settleWin(winnerId, loserId, game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    await playersService.recordResult(winnerId, 'win');
    await playersService.recordResult(loserId,  'loss');
    return { winnerPayout: 0, fee: 0 };
  }

  const pot          = bet * 2;
  const fee          = Math.round(pot * WIN_FEE_PCT);
  const winnerPayout = pot - fee;

  await playersService.adjustBalance(winnerId, winnerPayout);
  await playersService.recordResult(winnerId, 'win');
  await playersService.recordResult(loserId,  'loss');

  const tokenId = await getGameTokenId(game);
  await adjustOwnerBalance(
    tokenId, game.id, fee,
    'pvp_win_fee',
    `PvP win fee 10% | bet=${bet} pot=${pot} fee=${fee} | game ${game.id}`
  );

  notifyWinPayout(tokenId, { winnerId, loserId, winnerPayout, fee, gameId: game.id }).catch(() => {});
  notifyOwnerFee(tokenId, { amount: fee, type: 'pvp_win_fee', gameId: game.id }).catch(() => {});

  return { winnerPayout, fee, tokenId };
}

export async function settleDraw(game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    await playersService.recordResult(game.player1_id, 'draw');
    await playersService.recordResult(game.player2_id, 'draw');
    return { refund: 0, fee: 0 };
  }

  const feeEach  = Math.round(bet * DRAW_FEE_PCT);
  const refund   = bet - feeEach;
  const totalFee = feeEach * 2;

  await playersService.adjustBalance(game.player1_id, refund);
  await playersService.adjustBalance(game.player2_id, refund);
  await playersService.recordResult(game.player1_id, 'draw');
  await playersService.recordResult(game.player2_id, 'draw');

  const tokenId = await getGameTokenId(game);
  await adjustOwnerBalance(
    tokenId, game.id, totalFee,
    'pvp_draw_fee',
    `PvP draw fee 5%×2 | bet=${bet} refund=${refund} totalFee=${totalFee} | game ${game.id}`
  );

  notifyDrawRefund(tokenId, {
    player1Id: game.player1_id,
    player2Id: game.player2_id,
    refund, fee: totalFee, gameId: game.id,
  }).catch(() => {});
  notifyOwnerFee(tokenId, { amount: totalFee, type: 'pvp_draw_fee', gameId: game.id }).catch(() => {});

  return { refund, fee: totalFee, tokenId };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI game settlement
// ─────────────────────────────────────────────────────────────────────────────

export async function settleAiWin(winnerId, loserId, game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    await playersService.recordResult(winnerId, 'win');
    await playersService.recordResult(loserId,  'loss');
    return { winnerPayout: 0, fee: 0, ownerDelta: 0 };
  }

  const pot          = bet * 2;
  const fee          = Math.round(pot * WIN_FEE_PCT);
  const winnerPayout = pot - fee;

  const winnerIsAi = await isAiPlayer(winnerId);
  const humanId    = winnerIsAi ? loserId  : winnerId;

  if (!(await isAiPlayer(winnerId))) await playersService.recordResult(winnerId, 'win');
  if (!(await isAiPlayer(loserId)))  await playersService.recordResult(loserId,  'loss');

  const tokenId = await getTokenIdForPlayer(humanId);

  if (winnerIsAi) {
    await adjustOwnerBalance(
      tokenId, game.id, bet,
      'ai_profit',
      `AI wins — player bet collected | bet=${bet} game ${game.id}`
    );
    await adjustOwnerBalance(
      tokenId, game.id, fee,
      'ai_win_fee',
      `AI win fee 10% | pot=${pot} fee=${fee} game ${game.id}`
    );
    notifyOwnerFee(tokenId, {
      amount: bet + fee, type: 'ai_profit', gameId: game.id, humanPlayerId: humanId,
    }).catch(() => {});
    return { winnerPayout: 0, fee, ownerDelta: bet, tokenId };
  } else {
    await playersService.adjustBalance(winnerId, winnerPayout);
    const ownerDelta = fee - bet;
    await adjustOwnerBalance(
      tokenId, game.id, ownerDelta,
      'ai_loss',
      `AI loses — owner pays player win | bet=${bet} payout=${winnerPayout} ownerNet=${ownerDelta} game ${game.id}`
    );
    notifyOwnerFee(tokenId, {
      amount: ownerDelta, type: 'ai_loss', gameId: game.id, humanPlayerId: humanId,
    }).catch(() => {});
    return { winnerPayout, fee, ownerDelta, tokenId };
  }
}

export async function settleAiDraw(humanPlayerId, game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    if (humanPlayerId) await playersService.recordResult(humanPlayerId, 'draw');
    return { refund: 0, fee: 0 };
  }

  const feeEach  = Math.round(bet * DRAW_FEE_PCT);
  const refund   = bet - feeEach;
  const totalFee = feeEach * 2;

  await playersService.adjustBalance(humanPlayerId, refund);
  await playersService.recordResult(humanPlayerId, 'draw');

  const tokenId = await getTokenIdForPlayer(humanPlayerId);
  await adjustOwnerBalance(
    tokenId, game.id, totalFee,
    'ai_draw_fee',
    `AI draw fee 5%×2 | bet=${bet} refund=${refund} totalFee=${totalFee} game ${game.id}`
  );
  notifyOwnerFee(tokenId, { amount: totalFee, type: 'ai_draw_fee', gameId: game.id }).catch(() => {});

  return { refund, fee: totalFee, tokenId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function getOwnerBalance(tokenId) {
  const { rows } = await query(
    `SELECT * FROM token_owner_balances WHERE token_id = $1`, [tokenId]
  );
  return rows[0] || null;
}

export async function getAllOwnerBalances() {
  const { rows } = await query(`
    SELECT t.id as token_id, t.key_name, t.owner, t.token,
           COALESCE(ob.balance, 0)      as balance,
           COALESCE(ob.total_earned, 0) as total_earned,
           ob.updated_at
    FROM api_tokens t
    LEFT JOIN token_owner_balances ob ON ob.token_id = t.id
    ORDER BY COALESCE(ob.total_earned, 0) DESC
  `);
  return rows;
}
