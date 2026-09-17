// backend/src/services/settlement.js
//
// Handles ALL game financial settlement:
//
//  ── PvP (player vs player) ──────────────────────────────────────────────────
//  WIN:
//    pot = bet × 2
//    fee = round(pot × 10%)          → token owner balance  (house commission)
//    winnerPayout = pot − fee         → credited to winner's local balance
//    Callbacks: credit(winner), loss(loser), owner_fee(tokenOwner)
//
//  DRAW:
//    feeEach = round(bet × 5%)
//    refund  = bet − feeEach          → each player gets back
//    totalFee = feeEach × 2           → token owner balance
//    Callbacks: refund(p1), refund(p2), owner_fee(tokenOwner)
//
//  ── AI (player vs AI bot) ───────────────────────────────────────────────────
//  The AI is the "house" — backed by the token owner's balance.
//
//  PLAYER WINS vs AI:
//    pot = bet × 2
//    fee = round(pot × 10%)          → token owner balance  (commission still applies)
//    winnerPayout = pot − fee
//    net owner change = fee − bet    (owner pays the bet back plus the other bet minus fee)
//    i.e. owner_balance -= (bet − fee)  → deduct the AI's bet contribution
//    Callbacks: credit(player), owner_fee(tokenOwner, net)
//
//  AI WINS:
//    pot = bet × 2
//    fee = round(pot × 10%)
//    aiProfit = bet − fee            → the player's lost bet goes to the owner (minus commission)
//    owner_balance += pot            → owner keeps the whole pot (player bet already deducted)
//    Callbacks: loss(player), owner_profit(tokenOwner, pot)
//
//  DRAW vs AI:
//    feeEach = round(bet × 5%)
//    refund  = bet − feeEach         → player gets back
//    totalFee = feeEach × 2          → token owner
//    Callbacks: refund(player), owner_fee(tokenOwner, totalFee)
//
//  ── Transaction types saved to token_owner_transactions ─────────────────────
//    'pvp_win_fee'   — 10% commission from a PvP win
//    'pvp_draw_fee'  — 5%×2 commission from a PvP draw
//    'ai_win_fee'    — 10% commission portion from an AI win game
//    'ai_profit'     — owner profit when AI wins (player's lost bet)
//    'ai_loss'       — owner pays out when player beats the AI (negative, deducted)
//    'ai_draw_fee'   — 5%×2 commission when AI game draws

import db from '../db/database.js';
import * as playersService from './players.js';
import { notifyWinPayout, notifyDrawRefund, notifyOwnerFee } from './ownerCallback.js';

const WIN_FEE_PCT  = 0.10;  // 10% of total pot on win
const DRAW_FEE_PCT = 0.05;  // 5% of each player's bet on draw

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the token_owner_balances table exists.
 * Called once at startup via migrations.
 */
export function ensureOwnerBalanceTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_owner_balances (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id     INTEGER NOT NULL UNIQUE,
      balance      INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (token_id) REFERENCES api_tokens(id)
    );

    CREATE TABLE IF NOT EXISTS token_owner_transactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id   INTEGER NOT NULL,
      game_id    TEXT,
      type       TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (token_id) REFERENCES api_tokens(id)
    );
  `);
}

/**
 * Adjust owner balance by `delta` (positive = credit, negative = deduct).
 * Always saves a transaction row.
 * Balance CAN go negative (e.g. when the house backs AI and player wins).
 *
 * @param {number} tokenId
 * @param {string} gameId
 * @param {number} delta        positive = owner earns, negative = owner pays out
 * @param {string} type         transaction type string
 * @param {string} note
 */
function adjustOwnerBalance(tokenId, gameId, delta, type, note) {
  if (!tokenId) return;

  // Upsert balance row — balance allowed to go negative (house can be in debt)
  // total_earned tracks cumulative positive income only
  db.prepare(`
    INSERT INTO token_owner_balances (token_id, balance, total_earned)
    VALUES (?, ?, CASE WHEN ? > 0 THEN ? ELSE 0 END)
    ON CONFLICT(token_id) DO UPDATE SET
      balance      = balance + excluded.balance,
      total_earned = total_earned + CASE WHEN excluded.total_earned > 0 THEN excluded.total_earned ELSE 0 END,
      updated_at   = unixepoch()
  `).run(tokenId, delta, delta, delta);

  // Read the new running balance after the update
  const row = db.prepare('SELECT balance FROM token_owner_balances WHERE token_id = ?').get(tokenId);
  const runningBalance = row?.balance ?? 0;

  // Log transaction with running_balance so the UI can show balance-per-step
  db.prepare(`
    INSERT INTO token_owner_transactions (token_id, game_id, type, amount, running_balance, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenId, gameId || null, type, delta, runningBalance, note || null);
}

/**
 * Resolve the token_id that owns a given player.
 */
function getTokenIdForPlayer(playerId) {
  const row = db.prepare('SELECT token_id FROM players WHERE id = ?').get(playerId);
  return row?.token_id || null;
}

/**
 * Get the token_id for a game (from player1).
 */
function getGameTokenId(game) {
  return getTokenIdForPlayer(game.player1_id);
}

/**
 * Check whether a player is an AI bot.
 */
function isAiPlayer(playerId) {
  if (!playerId) return false;
  const row = db.prepare('SELECT is_ai FROM players WHERE id = ?').get(playerId);
  return row?.is_ai === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// PvP settlement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settle a PvP WIN game.
 *
 * Flow:
 *   pot          = bet × 2
 *   fee          = round(pot × 10%)   → owner earns this
 *   winnerPayout = pot − fee           → winner's balance increased
 *
 * Callbacks to token backend:
 *   credit(winner, winnerPayout, fee)
 *   loss(loser, 0, fee)
 *   owner_fee(fee)
 *
 * @param {string} winnerId
 * @param {string} loserId
 * @param {object} game  — DB game row
 */
export function settleWin(winnerId, loserId, game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    playersService.recordResult(winnerId, 'win');
    playersService.recordResult(loserId,  'loss');
    return { winnerPayout: 0, fee: 0 };
  }

  const pot          = bet * 2;
  const fee          = Math.round(pot * WIN_FEE_PCT);
  const winnerPayout = pot - fee;

  // Credit winner's local balance
  playersService.adjustBalance(winnerId, winnerPayout);
  // Stats
  playersService.recordResult(winnerId, 'win');
  playersService.recordResult(loserId,  'loss');

  // Owner earns the 10% fee
  const tokenId = getGameTokenId(game);
  adjustOwnerBalance(
    tokenId, game.id, fee,
    'pvp_win_fee',
    `PvP win fee 10% | bet=${bet} pot=${pot} fee=${fee} | game ${game.id}`
  );

  // Fire-and-forget callbacks to token owner's external backend
  notifyWinPayout(tokenId, { winnerId, loserId, winnerPayout, fee, gameId: game.id }).catch(() => {});
  notifyOwnerFee(tokenId, { amount: fee, type: 'pvp_win_fee', gameId: game.id }).catch(() => {});

  return { winnerPayout, fee, tokenId };
}

/**
 * Settle a PvP DRAW game.
 *
 * Flow:
 *   feeEach  = round(bet × 5%)
 *   refund   = bet − feeEach         → each player gets back
 *   totalFee = feeEach × 2           → owner earns this
 *
 * Callbacks:
 *   refund(p1, refund, feeEach)
 *   refund(p2, refund, feeEach)
 *   owner_fee(totalFee)
 *
 * @param {object} game  — DB game row
 */
export function settleDraw(game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    playersService.recordResult(game.player1_id, 'draw');
    playersService.recordResult(game.player2_id, 'draw');
    return { refund: 0, fee: 0 };
  }

  const feeEach  = Math.round(bet * DRAW_FEE_PCT);
  const refund   = bet - feeEach;
  const totalFee = feeEach * 2;

  // Refund both players
  playersService.adjustBalance(game.player1_id, refund);
  playersService.adjustBalance(game.player2_id, refund);
  // Stats
  playersService.recordResult(game.player1_id, 'draw');
  playersService.recordResult(game.player2_id, 'draw');

  // Owner earns both fee halves
  const tokenId = getGameTokenId(game);
  adjustOwnerBalance(
    tokenId, game.id, totalFee,
    'pvp_draw_fee',
    `PvP draw fee 5%×2 | bet=${bet} refund=${refund} totalFee=${totalFee} | game ${game.id}`
  );

  // Fire-and-forget callbacks
  notifyDrawRefund(tokenId, {
    player1Id: game.player1_id,
    player2Id: game.player2_id,
    refund,
    fee: totalFee,
    gameId: game.id,
  }).catch(() => {});
  notifyOwnerFee(tokenId, { amount: totalFee, type: 'pvp_draw_fee', gameId: game.id }).catch(() => {});

  return { refund, fee: totalFee, tokenId };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI game settlement  (player vs AI bot — house-backed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settle an AI WIN game — called when either the human player or the AI wins.
 *
 * Case A — HUMAN PLAYER wins:
 *   pot          = bet × 2
 *   fee          = round(pot × 10%)     → owner commission
 *   winnerPayout = pot − fee             → player's balance increased
 *   ownerDelta   = fee − bet             → NEGATIVE: owner backed the AI bet, pays it out minus commission
 *   Callbacks: credit(player), owner_fee(ownerDelta)
 *
 * Case B — AI wins (player loses):
 *   pot        = bet × 2
 *   fee        = round(pot × 10%)        → owner commission (from the "game")
 *   aiProfit   = bet                      → the player's lost bet goes to owner
 *   ownerDelta = bet                      → POSITIVE: owner keeps the player's bet
 *   (the AI's own bet was never really spent — it's house money)
 *   Callbacks: loss(player), owner_profit(bet)
 *
 * @param {string} winnerId   player ID of winner (may be AI)
 * @param {string} loserId    player ID of loser  (may be AI)
 * @param {object} game       DB game row
 */
export function settleAiWin(winnerId, loserId, game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    playersService.recordResult(winnerId, 'win');
    playersService.recordResult(loserId,  'loss');
    return { winnerPayout: 0, fee: 0, ownerDelta: 0 };
  }

  const pot          = bet * 2;
  const fee          = Math.round(pot * WIN_FEE_PCT);
  const winnerPayout = pot - fee;

  const winnerIsAi = isAiPlayer(winnerId);
  const humanId    = winnerIsAi ? loserId  : winnerId;
  const aiId       = winnerIsAi ? winnerId : loserId;

  // Stats — only record for real players, not AI bots in the players table
  // (AI bots have their own win/loss in ai_bots table, updated separately)
  if (!isAiPlayer(winnerId)) {
    playersService.recordResult(winnerId, 'win');
  }
  if (!isAiPlayer(loserId)) {
    playersService.recordResult(loserId, 'loss');
  }

  // Resolve token from the human player
  const tokenId = getTokenIdForPlayer(humanId);

  if (winnerIsAi) {
    // ── AI wins: player loses their bet — owner (house) keeps it ─────────
    // The player's bet was already deducted from their balance at game start.
    // Bets for AI games are deducted via start-bet API, stored in game_bet_log.
    // Owner gains: the player's bet amount (pot - AI's own "virtual" bet)
    // We credit the full player bet to the owner since the AI bet is house money.
    adjustOwnerBalance(
      tokenId, game.id, bet,
      'ai_profit',
      `AI wins — player bet collected | bet=${bet} game ${game.id}`
    );

    // Also credit the commission portion (tracked separately for reporting)
    adjustOwnerBalance(
      tokenId, game.id, fee,
      'ai_win_fee',
      `AI win fee 10% | pot=${pot} fee=${fee} game ${game.id}`
    );

    // Callback: player lost, no payout
    notifyOwnerFee(tokenId, {
      amount: bet + fee,
      type: 'ai_profit',
      gameId: game.id,
      humanPlayerId: humanId,
    }).catch(() => {});

    return { winnerPayout: 0, fee, ownerDelta: bet, tokenId };

  } else {
    // ── Human wins: credit human player, deduct from owner (house) ───────
    playersService.adjustBalance(winnerId, winnerPayout);

    // Owner backed the AI. They collected bet from the player at game start
    // but now must pay out winnerPayout. Net owner change:
    //   collected(bet) - paid(winnerPayout) = bet - (pot - fee) = fee - bet
    //   Since fee=0.1*pot=0.1*(2*bet)=0.2*bet and bet=bet:
    //   ownerDelta = 0.2*bet - bet = -0.8*bet  (owner pays net)
    const ownerDelta = fee - bet; // will be negative

    adjustOwnerBalance(
      tokenId, game.id, ownerDelta,
      'ai_loss',
      `AI loses — owner pays player win | bet=${bet} payout=${winnerPayout} ownerNet=${ownerDelta} game ${game.id}`
    );

    // Callback: notify owner backend about the payout
    notifyOwnerFee(tokenId, {
      amount: ownerDelta,   // negative — so owner backend knows it's a deduction
      type: 'ai_loss',
      gameId: game.id,
      humanPlayerId: humanId,
    }).catch(() => {});

    return { winnerPayout, fee, ownerDelta, tokenId };
  }
}

/**
 * Settle an AI DRAW game.
 *
 * Flow:
 *   feeEach  = round(bet × 5%)
 *   refund   = bet − feeEach         → player gets back
 *   totalFee = feeEach × 2           → owner earns this (AI's half + commission)
 *
 * The player's bet was already deducted at game start.
 * Owner collected player's bet, now returns `refund`, keeps `feeEach` from player.
 * The AI's matching bet was house money — owner keeps that feeEach too.
 *
 * @param {string} humanPlayerId
 * @param {object} game  — DB game row
 */
export function settleAiDraw(humanPlayerId, game) {
  const bet = game.bet_amount || 0;
  if (bet <= 0) {
    if (humanPlayerId) playersService.recordResult(humanPlayerId, 'draw');
    return { refund: 0, fee: 0 };
  }

  const feeEach  = Math.round(bet * DRAW_FEE_PCT);
  const refund   = bet - feeEach;
  const totalFee = feeEach * 2;

  // Refund player
  playersService.adjustBalance(humanPlayerId, refund);
  playersService.recordResult(humanPlayerId, 'draw');

  // Owner keeps both fee halves
  const tokenId = getTokenIdForPlayer(humanPlayerId);
  adjustOwnerBalance(
    tokenId, game.id, totalFee,
    'ai_draw_fee',
    `AI draw fee 5%×2 | bet=${bet} refund=${refund} totalFee=${totalFee} game ${game.id}`
  );

  // Callback
  notifyOwnerFee(tokenId, { amount: totalFee, type: 'ai_draw_fee', gameId: game.id }).catch(() => {});

  return { refund, fee: totalFee, tokenId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get owner balance for a token.
 */
export function getOwnerBalance(tokenId) {
  return db.prepare('SELECT * FROM token_owner_balances WHERE token_id = ?').get(tokenId);
}

/**
 * Get all owner balances with token info.
 */
export function getAllOwnerBalances() {
  return db.prepare(`
    SELECT t.id as token_id, t.key_name, t.owner, t.token,
           COALESCE(ob.balance, 0)       as balance,
           COALESCE(ob.total_earned, 0)  as total_earned,
           ob.updated_at
    FROM api_tokens t
    LEFT JOIN token_owner_balances ob ON ob.token_id = t.id
    ORDER BY COALESCE(ob.total_earned, 0) DESC
  `).all();
}
