import * as aiService from '../services/ai.js';
import { ok, fail } from '../utils/response.js';

export const getConfig = async (req, res, next) => {
  try {
    const config = aiService.getConfig();
    ok(res, config);
  } catch (err) { next(err); }
};

export const updateConfig = async (req, res, next) => {
  try {
    const { difficulty, depth, thinkDelay, aiName, allowUndo } = req.body;
    const fields = {};
    if (difficulty  !== undefined) fields.difficulty  = difficulty;
    if (depth       !== undefined) fields.depth       = depth;
    if (thinkDelay  !== undefined) fields.thinkDelay  = thinkDelay;
    if (aiName      !== undefined) fields.aiName      = aiName;
    if (allowUndo   !== undefined) fields.allowUndo   = allowUndo;
    const config = aiService.updateConfig(fields);
    ok(res, config);
  } catch (err) { next(err); }
};

export const getBots = async (req, res, next) => {
  try {
    const bots = aiService.getBots();
    ok(res, bots);
  } catch (err) { next(err); }
};

// Public version — no admin required, used by the game frontend
export const getBotsPublic = async (req, res, next) => {
  try {
    const bots = aiService.getBots();
    ok(res, bots);
  } catch (err) { next(err); }
};

export const updateBot = async (req, res, next) => {
  try {
    const { id }          = req.params;
    const { name, depth } = req.body;

    if (depth !== undefined) {
      const d = parseInt(depth, 10);
      if (isNaN(d) || d < 1 || d > 20) {
        return fail(res, 'depth must be an integer between 1 and 20', 400);
      }
    }

    const bot = aiService.updateBot(id, {
      name,
      depth: depth !== undefined ? parseInt(depth, 10) : undefined,
    });

    if (!bot) return fail(res, 'AI bot not found', 404);
    ok(res, bot);
  } catch (err) { next(err); }
};

/* ═══════════════════════════════════════════════════════════════
   getLLMMove — ask Google Gemini to pick the best move
   POST /api/ai/move
   Body: { board: number[][], moves: MoveObj[], aiPlayer: number }
   Returns: { move: MoveObj } or { fallback: true } when unavailable
═══════════════════════════════════════════════════════════════ */

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/** Render the 8×8 board as a readable text grid for the prompt */
function renderBoard(board, aiPlayer) {
  const SYMBOLS = { 0: '.', 1: 'b', 2: 'w', 3: 'B', 4: 'W' };
  const rows = board.map((row, r) =>
    `${8 - r} | ` + row.map(c => SYMBOLS[c] || '.').join(' ')
  );
  return [
    '  Legend: b=black-man  B=black-king  w=white-man  W=white-king  .=empty',
    `  You are playing as: ${aiPlayer === 2 ? 'white (w/W)' : 'black (b/B)'}`,
    '    a b c d e f g h',
    '    ───────────────',
    ...rows,
  ].join('\n');
}

/** Convert a move object to a human-readable string like "(2,1) → (3,0)" */
function moveLabel(m) {
  const fr = m.from || { r: m.r, c: m.c };
  const cols = 'abcdefgh';
  return `(row${fr.r},${cols[fr.c]}) → (row${m.r},${cols[m.c]})${
    m.capturedSquare ? ' [capture]' : ''
  }`;
}

export const getLLMMove = async (req, res, next) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
      // Key not configured — tell frontend to use local Minimax
      return res.json({ ok: true, data: { fallback: true, reason: 'no_api_key' } });
    }

    const { board, moves, aiPlayer, difficulty } = req.body;

    if (!board || !Array.isArray(moves) || moves.length === 0) {
      return fail(res, 'board and moves are required', 400);
    }

    // Build numbered move list for the prompt
    const moveList = moves
      .map((m, i) => `${i + 1}. ${moveLabel(m)}`)
      .join('\n');

    const boardText = renderBoard(board, aiPlayer);

    const prompt = `You are an unbeatable grandmaster at Dama (Ethiopian Checkers). \
You always choose the single best strategic move to WIN the game as quickly as possible.

Rules reminder:
- Men move diagonally forward only. Kings (uppercase) move any number of squares diagonally.
- Captures are MANDATORY. If a capture is available you MUST take it.
- After a capture, if another capture is possible from the landing square, you must continue capturing.
- The goal is to capture all opponent pieces or leave them with no legal moves.

Current board:
${boardText}

Difficulty level: ${difficulty ?? 90}%

Legal moves available to you (numbered list):
${moveList}

Respond with ONLY a single integer — the number of the move you choose (e.g. "3"). \
Do not include any other text, explanation, or punctuation.`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,   // near-deterministic for strategy
        maxOutputTokens: 8, // we only need a single digit
        topP: 0.95,
      },
    };

    const apiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000), // 8-second hard timeout
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('[AI/LLM] Gemini API error:', apiRes.status, errText);
      return res.json({ ok: true, data: { fallback: true, reason: 'api_error' } });
    }

    const json = await apiRes.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    const idx = parseInt(rawText, 10) - 1; // convert 1-based to 0-based

    if (isNaN(idx) || idx < 0 || idx >= moves.length) {
      console.warn('[AI/LLM] Gemini returned invalid move index:', rawText, '— falling back');
      return res.json({ ok: true, data: { fallback: true, reason: 'invalid_response' } });
    }

    console.log(`[AI/LLM] Gemini picked move ${idx + 1}: ${moveLabel(moves[idx])}`);
    return res.json({ ok: true, data: { move: moves[idx] } });

  } catch (err) {
    // Network timeout, AbortError, parse error — all fall back gracefully
    console.error('[AI/LLM] Unexpected error, falling back to Minimax:', err.message);
    return res.json({ ok: true, data: { fallback: true, reason: 'exception' } });
  }
};
