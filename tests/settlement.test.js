// tests/settlement.test.js
//
// Unit tests for services/settlement.js
//
// Settlement math rules (from the top of settlement.js):
//
//  PvP WIN:
//    pot          = bet × 2
//    fee          = round(pot × 10%)     = round(bet × 0.2)
//    winnerPayout = pot − fee
//    owner earns  fee
//
//  PvP DRAW:
//    feeEach  = round(bet × 5%)
//    refund   = bet − feeEach
//    totalFee = feeEach × 2
//    owner earns totalFee
//
//  AI WIN — human player wins:
//    pot          = bet × 2
//    fee          = round(pot × 10%)
//    winnerPayout = pot − fee
//    ownerDelta   = fee − bet            (negative — house pays net)
//
//  AI WIN — AI wins:
//    owner earns bet  (player's lost bet)
//    owner also earns fee (the house commission)
//    winnerPayout = 0
//    ownerDelta = bet  (positive, tracked in 'ai_profit' row)
//
//  AI DRAW:
//    feeEach  = round(bet × 5%)
//    refund   = bet − feeEach
//    totalFee = feeEach × 2
//    owner earns totalFee

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Mock all external modules that settlement.js depends on so tests run without
// a real SQLite database or network.
// ─────────────────────────────────────────────────────────────────────────────

// Shared state for tracking mock calls across tests
const mockState = {
  ownerBalance:  {},   // token_id → { balance, total_earned }
  transactions:  [],
  playerBalance: {},   // playerId → balance delta accumulated
  playerResults: [],   // { id, result }
};

function resetMockState() {
  mockState.ownerBalance  = {};
  mockState.transactions  = [];
  mockState.playerBalance = {};
  mockState.playerResults = [];
}

// ── Mock: db ─────────────────────────────────────────────────────────────────
vi.mock('../src/db/database.js', () => {
  const rows = {}; // generic key-value store for prepared query mocks

  const makePrepared = (sql) => ({
    run:  (...args) => {
      // Track INSERT INTO token_owner_balances upserts and token_owner_transactions
      if (sql.includes('token_owner_balances')) {
        const tokenId = args[0];
        const delta   = args[1];
        if (!mockState.ownerBalance[tokenId]) {
          mockState.ownerBalance[tokenId] = { balance: 0, total_earned: 0 };
        }
        mockState.ownerBalance[tokenId].balance      += delta;
        mockState.ownerBalance[tokenId].total_earned += (delta > 0 ? delta : 0);
      }
      if (sql.includes('token_owner_transactions')) {
        mockState.transactions.push({ sql, args });
      }
      return { changes: 1, lastInsertRowid: 1 };
    },
    get:  (...args) => {
      // Return balance row when queried
      if (sql.includes('SELECT balance FROM token_owner_balances')) {
        const tokenId = args[0];
        return { balance: mockState.ownerBalance[tokenId]?.balance ?? 0 };
      }
      // is_ai checks — return non-AI by default (tests override per-case via playerTable)
      if (sql.includes('SELECT is_ai FROM players')) {
        const playerId = args[0];
        return { is_ai: playerTable[playerId]?.is_ai ?? 0 };
      }
      // token_id from players
      if (sql.includes('SELECT token_id FROM players')) {
        const playerId = args[0];
        return { token_id: playerTable[playerId]?.token_id ?? 1 };
      }
      return null;
    },
    all:  () => [],
  });

  return {
    default: {
      prepare: (sql) => makePrepared(sql),
      exec:    () => {},
    },
  };
});

// ── playerTable — controls what db.prepare('SELECT is_ai…').get() returns ────
// Tests mutate this object directly to set up AI vs human scenarios.
const playerTable = {};

// ── Mock: services/players.js ─────────────────────────────────────────────────
vi.mock('../src/services/players.js', () => ({
  adjustBalance: vi.fn((id, amount) => {
    mockState.playerBalance[id] = (mockState.playerBalance[id] ?? 0) + amount;
  }),
  recordResult: vi.fn((id, result) => {
    mockState.playerResults.push({ id, result });
  }),
}));

// ── Mock: services/ownerCallback.js ──────────────────────────────────────────
vi.mock('../src/services/ownerCallback.js', () => ({
  notifyWinPayout:  vi.fn(() => Promise.resolve()),
  notifyDrawRefund: vi.fn(() => Promise.resolve()),
  notifyOwnerFee:   vi.fn(() => Promise.resolve()),
  notifyBetPlaced:  vi.fn(() => Promise.resolve()),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import the module AFTER mocks are registered
// ─────────────────────────────────────────────────────────────────────────────
const { settleWin, settleDraw, settleAiWin, settleAiDraw } =
  await import('../src/services/settlement.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a minimal game row
// ─────────────────────────────────────────────────────────────────────────────
function makeGame({ bet = 100, player1Id = 'p1', player2Id = 'p2', id = 'game1' } = {}) {
  return { id, bet_amount: bet, player1_id: player1Id, player2_id: player2Id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('settlement.js — PvP win', () => {
  beforeEach(() => {
    resetMockState();
    // Both players are real humans
    playerTable['p1'] = { is_ai: 0, token_id: 1 };
    playerTable['p2'] = { is_ai: 0, token_id: 1 };
  });

  it('calculates fee and winnerPayout correctly', () => {
    const bet  = 100;
    const game = makeGame({ bet });

    const result = settleWin('p1', 'p2', game);

    const pot          = bet * 2;                         // 200
    const fee          = Math.round(pot * 0.10);          // 20
    const winnerPayout = pot - fee;                       // 180

    expect(result.fee).toBe(fee);
    expect(result.winnerPayout).toBe(winnerPayout);
  });

  it('credits the winner with winnerPayout', () => {
    const bet  = 200;
    const game = makeGame({ bet });
    settleWin('p1', 'p2', game);

    const pot          = bet * 2;
    const fee          = Math.round(pot * 0.10);
    const winnerPayout = pot - fee;

    expect(mockState.playerBalance['p1']).toBe(winnerPayout);
  });

  it('does NOT credit the loser', () => {
    settleWin('p1', 'p2', makeGame({ bet: 100 }));
    expect(mockState.playerBalance['p2']).toBeUndefined();
  });

  it('records win for winner and loss for loser', () => {
    settleWin('p1', 'p2', makeGame({ bet: 100 }));
    expect(mockState.playerResults).toContainEqual({ id: 'p1', result: 'win' });
    expect(mockState.playerResults).toContainEqual({ id: 'p2', result: 'loss' });
  });

  it('credits the owner with the 10% fee', () => {
    const bet  = 500;
    const game = makeGame({ bet });
    settleWin('p1', 'p2', game);

    const fee = Math.round(bet * 2 * 0.10);   // 100
    expect(mockState.ownerBalance[1]?.balance).toBe(fee);
  });

  it('returns zero payout when bet is 0 (no-bet game)', () => {
    const result = settleWin('p1', 'p2', makeGame({ bet: 0 }));
    expect(result.winnerPayout).toBe(0);
    expect(result.fee).toBe(0);
  });
});

describe('settlement.js — PvP draw', () => {
  beforeEach(() => {
    resetMockState();
    playerTable['p1'] = { is_ai: 0, token_id: 1 };
    playerTable['p2'] = { is_ai: 0, token_id: 1 };
  });

  it('calculates refund and totalFee correctly', () => {
    const bet  = 100;
    const game = makeGame({ bet });

    const result = settleDraw(game);

    const feeEach  = Math.round(bet * 0.05);   // 5
    const refund   = bet - feeEach;            // 95
    const totalFee = feeEach * 2;              // 10

    expect(result.refund).toBe(refund);
    expect(result.fee).toBe(totalFee);
  });

  it('refunds both players', () => {
    const bet  = 200;
    const game = makeGame({ bet });
    settleDraw(game);

    const feeEach = Math.round(bet * 0.05);
    const refund  = bet - feeEach;

    expect(mockState.playerBalance['p1']).toBe(refund);
    expect(mockState.playerBalance['p2']).toBe(refund);
  });

  it('credits owner with both fee halves', () => {
    const bet  = 200;
    const game = makeGame({ bet });
    settleDraw(game);

    const totalFee = Math.round(bet * 0.05) * 2;
    expect(mockState.ownerBalance[1]?.balance).toBe(totalFee);
  });

  it('records draw for both players', () => {
    settleDraw(makeGame({ bet: 100 }));
    expect(mockState.playerResults).toContainEqual({ id: 'p1', result: 'draw' });
    expect(mockState.playerResults).toContainEqual({ id: 'p2', result: 'draw' });
  });

  it('returns zero refund/fee when bet is 0', () => {
    const result = settleDraw(makeGame({ bet: 0 }));
    expect(result.refund).toBe(0);
    expect(result.fee).toBe(0);
  });
});

describe('settlement.js — AI win (human player wins)', () => {
  beforeEach(() => {
    resetMockState();
    playerTable['human'] = { is_ai: 0, token_id: 1 };
    playerTable['ai']    = { is_ai: 1, token_id: null };
  });

  it('calculates payout and ownerDelta correctly', () => {
    const bet  = 100;
    const game = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });

    const result = settleAiWin('human', 'ai', game);

    const pot          = bet * 2;                  // 200
    const fee          = Math.round(pot * 0.10);   // 20
    const winnerPayout = pot - fee;                // 180
    const ownerDelta   = fee - bet;                // 20 - 100 = -80

    expect(result.winnerPayout).toBe(winnerPayout);
    expect(result.fee).toBe(fee);
    expect(result.ownerDelta).toBe(ownerDelta);
    expect(ownerDelta).toBeLessThan(0);  // owner pays out net
  });

  it('credits the human player with winnerPayout', () => {
    const bet  = 100;
    const game = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    settleAiWin('human', 'ai', game);

    const winnerPayout = 100 * 2 - Math.round(100 * 2 * 0.10);  // 180
    expect(mockState.playerBalance['human']).toBe(winnerPayout);
  });

  it('deducts net ownerDelta from owner balance', () => {
    const bet  = 100;
    const game = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    settleAiWin('human', 'ai', game);

    const ownerDelta = Math.round(bet * 2 * 0.10) - bet;  // -80
    expect(mockState.ownerBalance[1]?.balance).toBe(ownerDelta);
  });

  it('records human win, does not record result for AI in players table', () => {
    const game = makeGame({ bet: 100, player1Id: 'human', player2Id: 'ai' });
    settleAiWin('human', 'ai', game);

    expect(mockState.playerResults).toContainEqual({ id: 'human', result: 'win' });
    // AI bot never gets a recordResult call for itself in the players table
    expect(mockState.playerResults.find(r => r.id === 'ai')).toBeUndefined();
  });

  it('owner delta equals fee - bet (negative, ~-80% of bet)', () => {
    // Invariant: fee = 0.2*bet, ownerDelta = 0.2*bet - bet = -0.8*bet
    const bet  = 500;
    const fee  = Math.round(bet * 2 * 0.10);   // 100
    const expectedDelta = fee - bet;            // -400

    const game = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    const result = settleAiWin('human', 'ai', game);

    expect(result.ownerDelta).toBe(expectedDelta);
  });
});

describe('settlement.js — AI win (AI beats human)', () => {
  beforeEach(() => {
    resetMockState();
    playerTable['human'] = { is_ai: 0, token_id: 1 };
    playerTable['ai']    = { is_ai: 1, token_id: null };
  });

  it('human gets zero payout', () => {
    const game   = makeGame({ bet: 100, player1Id: 'human', player2Id: 'ai' });
    const result = settleAiWin('ai', 'human', game);
    expect(result.winnerPayout).toBe(0);
  });

  it('owner earns the player bet (ai_profit) plus fee (ai_win_fee)', () => {
    const bet    = 100;
    const game   = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    settleAiWin('ai', 'human', game);

    const fee = Math.round(bet * 2 * 0.10);  // 20
    // Two separate adjustOwnerBalance calls: bet (ai_profit) + fee (ai_win_fee)
    const expectedOwnerTotal = bet + fee;    // 120
    expect(mockState.ownerBalance[1]?.balance).toBe(expectedOwnerTotal);
  });

  it('does not credit the human player', () => {
    const game = makeGame({ bet: 100, player1Id: 'human', player2Id: 'ai' });
    settleAiWin('ai', 'human', game);
    expect(mockState.playerBalance['human']).toBeUndefined();
  });

  it('records loss for human', () => {
    const game = makeGame({ bet: 100, player1Id: 'human', player2Id: 'ai' });
    settleAiWin('ai', 'human', game);
    expect(mockState.playerResults).toContainEqual({ id: 'human', result: 'loss' });
  });

  it('ownerDelta positive and equals bet', () => {
    const bet    = 300;
    const game   = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    const result = settleAiWin('ai', 'human', game);
    // ownerDelta returned by the function is the 'ai_profit' portion only
    expect(result.ownerDelta).toBe(bet);
    expect(result.ownerDelta).toBeGreaterThan(0);
  });
});

describe('settlement.js — AI draw', () => {
  beforeEach(() => {
    resetMockState();
    playerTable['human'] = { is_ai: 0, token_id: 1 };
    playerTable['ai']    = { is_ai: 1, token_id: null };
  });

  it('calculates refund and totalFee correctly', () => {
    const bet    = 100;
    const game   = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    const result = settleAiDraw('human', game);

    const feeEach  = Math.round(bet * 0.05);  // 5
    const refund   = bet - feeEach;           // 95
    const totalFee = feeEach * 2;             // 10

    expect(result.refund).toBe(refund);
    expect(result.fee).toBe(totalFee);
  });

  it('refunds only the human player', () => {
    const bet    = 100;
    const game   = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    settleAiDraw('human', game);

    const refund = bet - Math.round(bet * 0.05);
    expect(mockState.playerBalance['human']).toBe(refund);
  });

  it('credits owner with totalFee', () => {
    const bet    = 100;
    const game   = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
    settleAiDraw('human', game);

    const totalFee = Math.round(bet * 0.05) * 2;
    expect(mockState.ownerBalance[1]?.balance).toBe(totalFee);
  });

  it('records draw for human', () => {
    settleAiDraw('human', makeGame({ bet: 100, player1Id: 'human', player2Id: 'ai' }));
    expect(mockState.playerResults).toContainEqual({ id: 'human', result: 'draw' });
  });

  it('returns zero refund/fee when bet is 0', () => {
    const result = settleAiDraw('human', makeGame({ bet: 0 }));
    expect(result.refund).toBe(0);
    expect(result.fee).toBe(0);
  });
});

describe('settlement.js — rounding invariants', () => {
  beforeEach(() => {
    resetMockState();
    playerTable['p1'] = { is_ai: 0, token_id: 1 };
    playerTable['p2'] = { is_ai: 0, token_id: 1 };
  });

  it('winnerPayout + fee === pot for PvP win', () => {
    for (const bet of [1, 7, 33, 100, 500, 999]) {
      resetMockState();
      const game   = makeGame({ bet });
      const result = settleWin('p1', 'p2', game);
      const pot    = bet * 2;
      expect(result.winnerPayout + result.fee).toBe(pot);
    }
  });

  it('refund + feeEach === bet for PvP draw (per player)', () => {
    for (const bet of [1, 7, 33, 100, 500, 999]) {
      resetMockState();
      const game   = makeGame({ bet });
      const result = settleDraw(game);
      // totalFee is feeEach*2, so feeEach = totalFee/2 only when even —
      // use the formula directly
      const feeEach = Math.round(bet * 0.05);
      expect(result.refund + feeEach).toBe(bet);
    }
  });

  it('winnerPayout + fee === pot for AI win (human wins)', () => {
    playerTable['human'] = { is_ai: 0, token_id: 1 };
    playerTable['ai']    = { is_ai: 1, token_id: null };
    for (const bet of [1, 7, 33, 100, 500]) {
      resetMockState();
      const game   = makeGame({ bet, player1Id: 'human', player2Id: 'ai' });
      const result = settleAiWin('human', 'ai', game);
      const pot    = bet * 2;
      expect(result.winnerPayout + result.fee).toBe(pot);
    }
  });
});
