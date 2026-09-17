# Dama Game — API Documentation

**Base URL (Production):** `https://dama-game-backend.onrender.com`  
**Base URL (Local):** `http://localhost:5000`  
**All API routes are prefixed with `/api`**

---

## Authentication

| Type | How to send | Used by |
|------|-------------|---------|
| API Token | `X-API-Token: dama_xxx` header, `Authorization: Bearer dama_xxx`, or `?token=dama_xxx` query param | Frontend game client |
| Admin JWT | `Authorization: Bearer <jwt>` | Admin panel |

---

## 1. Health

### `GET /api/health`
Public. Check if server is running.

**Response:**
```json
{
  "ok": true,
  "uptime": 123.45,
  "timestamp": "2026-07-08T10:00:00.000Z",
  "db": "ok"
}
```

---

## 2. Player Balance (Owner Backend Bridge)

### `POST /api/player-balance`
Public. Called by the frontend on load to fetch the real balance from the token owner's backend.

**Security Model:**
The frontend never sends raw phone/username. Instead:
1. System-backend mints a short-lived signed JWT (launch token) containing `{ phone, username, balance, gameId }`
2. Frontend forwards this opaque token to dama-backend along with the API token
3. Dama-backend verifies the launch token with system-backend (which decrypts it)
4. Dama-backend extracts phone/username only from the verified JWT (never exposes to client)

**Request:**
```json
{
  "token":  "dama_a52ea8f0ac191e6a23a39347...",
  "launch": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (success):**
```json
{
  "ok": true,
  "data": {
    "balance": 1250,
    "username": "Kaleab"
  }
}
```

**Response (owner backend unreachable, token invalid, or not configured):**
```json
{
  "ok": true,
  "data": {
    "balance": null,
    "username": null
  }
}
```
> When `balance` is `null`, the frontend falls back to the `?balance=` URL param.

---

## 3. Players

### `GET /api/players`
Requires: API Token or Admin JWT.  
List all players.

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "ph_0909095880",
      "name": "Kaleab",
      "photo": null,
      "phone": "0909095880",
      "balance": 500,
      "bet": 100,
      "wins": 5,
      "losses": 3,
      "draws": 1,
      "online": 1,
      "is_ready": 0,
      "ready_bet": 0,
      "piece_theme": "classic",
      "last_seen": 1720000000
    }
  ]
}
```

---

### `GET /api/players/:id`
Requires: API Token or Admin JWT.

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `POST /api/players`
Public. Register or update a player (upsert). Called by frontend on load.

**Request:**
```json
{
  "id":          "ph_0909095880",
  "name":        "Kaleab",
  "photo":       null,
  "phone":       "0909095880",
  "bet":         100,
  "pieceThemeId": "classic",
  "isDemo":      false
}
```

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `GET /api/players/ready`
Requires: API Token or Admin JWT.  
List online ready players, optionally filtered by bet amount.

**Query params:** `?bet=100&excludeId=ph_xxx`

**Response:**
```json
{
  "ok": true,
  "data": [ ...players ]
}
```

---

### `PATCH /api/players/:id/ready`
Requires: API Token or Admin JWT.  
Mark player as ready with a bet amount.

**Request:**
```json
{ "bet": 100 }
```

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `PATCH /api/players/:id/unready`
Requires: API Token or Admin JWT.  
Clear player ready state.

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `PATCH /api/players/:id/balance`
Requires: API Token or Admin JWT.  
Adjust player balance by an amount (positive = add, negative = deduct).

**Request:**
```json
{ "amount": -100 }
```

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `PATCH /api/players/:id`
Requires: Admin JWT only.  
Update player fields.

**Request:**
```json
{
  "name": "New Name",
  "wins": 10,
  "losses": 2,
  "draws": 0,
  "balance": 1000,
  "bet": 50
}
```

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `DELETE /api/players/:id`
Requires: Admin JWT only.

**Response:**
```json
{
  "ok": true,
  "data": { "deleted": true }
}
```

---

### `POST /api/players/:id/result`
Requires: API Token or Admin JWT.  
Record a win/loss/draw result.

**Request:**
```json
{ "result": "win" }
```

**Response:**
```json
{
  "ok": true,
  "data": { ...player }
}
```

---

### `GET /api/players/:id/owned`
Requires: API Token or Admin JWT.  
Get list of owned item IDs for a player.

**Response:**
```json
{
  "ok": true,
  "data": ["fire", "dome", "metal"]
}
```

---

### `POST /api/players/:id/purchase`
Requires: API Token or Admin JWT.  
Purchase a cosmetic item.

**Request:**
```json
{ "itemId": "fire" }
```

**Response:**
```json
{
  "ok": true,
  "data": { "owned": ["fire", "dome"] }
}
```

---

## 4. Games

All game routes require: **API Token or Admin JWT**.

### `GET /api/games`
List games with optional filters.

**Query params:** `?playerId=ph_xxx&status=finished&limit=20&offset=0`

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "abc123",
      "mode": "pvp",
      "player1_id": "ph_111",
      "player2_id": "ph_222",
      "player1_name": "Kaleab",
      "player2_name": "Abebe",
      "winner_id": "ph_111",
      "winner_name": "Kaleab",
      "status": "finished",
      "bet_amount": 100,
      "move_count": 34,
      "duration_sec": 180,
      "created_at": 1720000000,
      "finished_at": 1720000180
    }
  ]
}
```

---

### `GET /api/games/:id`
Get a single game with its move history.

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "abc123",
    "moves": [
      { "id": 1, "game_id": "abc123", "player_id": "ph_111", "move_num": 1, "move_data": "{...}", "ts": 1720000010 }
    ]
  }
}
```

---

### `POST /api/games`
Create a new game record.

**Request:**
```json
{
  "mode":       "pvp",
  "player1Id":  "ph_111",
  "player2Id":  "ph_222",
  "betAmount":  100
}
```

**Response:**
```json
{
  "ok": true,
  "data": { ...game }
}
```

---

### `PATCH /api/games/:id/finish`
Finish a game — set winner and stats.

**Request:**
```json
{
  "winnerId":    "ph_111",
  "durationSec": 180,
  "moveCount":   34
}
```

**Response:**
```json
{
  "ok": true,
  "data": { ...game }
}
```

---

### `POST /api/games/:id/moves`
Append a move to a game.

**Request:**
```json
{
  "playerId": "ph_111",
  "moveData": {
    "from": { "row": 2, "col": 3 },
    "to":   { "row": 3, "col": 4 }
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": { "id": 5, "game_id": "abc123", "move_num": 5 }
}
```

---

### `POST /api/games/finish-local`
Save a completed AI or local (offline) game.

**Request:**
```json
{
  "player1Id":   "ph_111",
  "player2Id":   "bot_easy",
  "mode":        "ai",
  "winnerId":    "ph_111",
  "result":      "win",
  "durationSec": 120,
  "moveCount":   28
}
```

**Response:**
```json
{
  "ok": true,
  "data": { ...game }
}
```

---

## 5. AI

### `GET /api/ai`
Public. Get current AI configuration.

**Response:**
```json
{
  "ok": true,
  "data": {
    "difficulty": "medium",
    "depth": 10,
    "think_delay": 600,
    "ai_name": "Computer 🤖",
    "allow_undo": 1
  }
}
```

---

### `PUT /api/ai`
Requires: Admin JWT.  
Update AI configuration.

**Request:**
```json
{
  "difficulty": "hard",
  "depth": 15,
  "thinkDelay": 400,
  "aiName": "Master Bot",
  "allowUndo": false
}
```

**Response:**
```json
{
  "ok": true,
  "data": { ...config }
}
```

---

### `GET /api/ai/bots/public`
Public. List AI bots for the game client bot selector.

**Response:**
```json
{
  "ok": true,
  "data": [
    { "id": "bot_1", "name": "Beginner", "depth": 2, "pct": 10, "wins": 5, "losses": 12, "draws": 1 }
  ]
}
```

---

### `GET /api/ai/bots`
Requires: Admin JWT.  
List all AI bots with full details.

---

### `PATCH /api/ai/bots/:id`
Requires: Admin JWT.  
Update a bot's name or difficulty.

**Request:**
```json
{ "name": "Hard Bot", "depth": 18 }
```

---

### `POST /api/ai/move`
Public. Ask Gemini AI for the best move.

**Request:**
```json
{
  "board":       [[...]],
  "moves":       [{ "from": {...}, "to": {...} }],
  "aiPlayer":    2,
  "difficulty":  "hard"
}
```

**Response:**
```json
{
  "ok": true,
  "data": { "move": { "from": {...}, "to": {...} } }
}
```
> If Gemini is unavailable: `{ "ok": true, "data": { "fallback": true } }`

---

## 6. Admin

### `POST /api/admin/login`
Public. Admin login.

**Request:**
```json
{ "username": "admin", "password": "admin123" }
```

**Response:**
```json
{
  "ok": true,
  "data": { "token": "<jwt>", "username": "admin" }
}
```

---

### `POST /api/admin/change-password`
Requires: Admin JWT.

**Request:**
```json
{ "currentPassword": "old", "newPassword": "newpass123" }
```

---

### `GET /api/admin/stats`
Requires: Admin JWT.  
Dashboard summary stats.

**Response:**
```json
{
  "ok": true,
  "data": {
    "totalPlayers": 120,
    "onlinePlayers": 14,
    "totalGames": 340,
    "activeGames": 3,
    "totalBetVolume": 45000
  }
}
```

---

### `GET /api/admin/owner-balances`
Requires: Admin JWT.  
Service fee earnings per token owner.

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "token_id": 1,
      "key_name": "mobile-app",
      "owner": "Kaleab",
      "balance": 2500,
      "total_earned": 8000,
      "updated_at": 1720000000
    }
  ]
}
```

---

### `GET /api/admin/token-users`
Requires: Admin JWT.

---

### `GET /api/admin/item-stats`
Requires: Admin JWT.

---

### `POST /api/admin/items/grant`
Requires: Admin JWT.  
Grant a cosmetic item to a player for free.

**Request:**
```json
{ "playerId": "ph_111", "itemId": "fire" }
```

---

### `DELETE /api/admin/items/:playerId/:itemId`
Requires: Admin JWT.

---

### `GET /api/admin/players`
Requires: Admin JWT. Full player list with all fields.

---

### `POST /api/admin/players/seed`
Requires: Admin JWT. Seed demo players.

---

### `DELETE /api/admin/players/demo`
Requires: Admin JWT. Delete all demo players.

---

### `PATCH /api/admin/players/:id/balance`
Requires: Admin JWT.

**Request:**
```json
{ "balance": 1000 }
```

---

## 7. Admin Tokens

All token routes require: **Admin JWT**.

### `GET /api/admin/tokens`
List all API tokens.

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": 1,
      "token": "dama_a52ea8f0...",
      "key_name": "mobile-app",
      "owner": "Kaleab",
      "backend_url": "https://your-server.com/api",
      "created_at": 1720000000,
      "expires_at": null,
      "last_used": 1720000500,
      "is_active": 1
    }
  ]
}
```

---

### `POST /api/admin/tokens`
Create a new API token.

**Request:**
```json
{
  "key_name":        "mobile-app-v2",
  "owner":           "Kaleab",
  "backend_url":     "https://your-server.com/api",
  "expires_in_days": 30
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": 2,
    "token": "dama_newtoken...",
    "key_name": "mobile-app-v2",
    "owner": "Kaleab",
    "backend_url": "https://your-server.com/api",
    "is_active": 1
  }
}
```
> ⚠️ Copy the `token` value now — it is only shown once in full.

---

### `PATCH /api/admin/tokens/:id/toggle`
Enable or revoke a token.

**Response:**
```json
{
  "ok": true,
  "data": { ...token, "is_active": 0 }
}
```

---

### `PATCH /api/admin/tokens/:id/backend-url`
Update the owner backend URL for a token.

**Request:**
```json
{ "backend_url": "https://new-server.com/api" }
```

---

### `DELETE /api/admin/tokens/:id`

**Response:**
```json
{
  "ok": true,
  "data": { "deleted": true }
}
```

---

## 8. WebSocket Events

**URL:** `wss://dama-game-backend.onrender.com?token=dama_xxx`

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `{ playerId, sessionToken, apiToken }` | Connect and authenticate |
| `leave` | `{ playerId }` | Disconnect gracefully |
| `ping` | — | Keep-alive |
| `challenge_send` | `{ challengerId, opponentId, betAmount }` | Send a match challenge |
| `challenge_accept` | `{ challengerId, opponentId, betAmount }` | Accept a challenge — bets deducted here |
| `challenge_decline` | `{ challengerId, opponentId }` | Decline a challenge |
| `make_move` | `{ gameId, playerId, from, move }` | Submit a move |
| `game_over` | `{ gameId, winnerId, reason, durationSec, moveCount }` | Report game result |
| `resign` | `{ gameId, playerId }` | Resign from game |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `pong` | — | Reply to ping |
| `presence` | `{ online: [playerId, ...] }` | List of online player IDs |
| `player_updated` | `{ player }` | Player data changed (balance, wins, etc.) |
| `challenge_receive` | `{ challenger, betAmount }` | Incoming challenge |
| `challenge_declined` | `{ opponentId }` | Opponent declined |
| `game_start` | `{ gameId, opponent, myColor, turn, betAmount, history }` | Match started |
| `move_made` | `{ from, move }` | Opponent made a move |
| `opponent_left` | `{ playerId }` | Opponent disconnected |
| `opponent_rejoined` | `{ playerId }` | Opponent reconnected |
| `game_over` | `{ winnerId, reason }` | Game ended |
| `kicked` | `{ reason }` | Session replaced on another device |
| `error` | `{ message }` | Error message |

---

## 9. Owner Backend Callbacks

Your backend must implement **one endpoint**:

### `POST /dama`
Called by Dama backend for all game events. Read the `action` field to handle each case.

---

#### `action: "get_balance"` — fetch player balance on login

**Request from Dama:**
```json
{
  "action":   "get_balance",
  "phone":    "0909095880",
  "username": "Kaleab"
}
```

**Your response (required):**
```json
{ "balance": 1250 }
```

---

#### `action: "deduct"` — bet placed, game starting

**Request from Dama:**
```json
{
  "action":   "deduct",
  "phone":    "0909095880",
  "username": "Kaleab",
  "playerId": "ph_0909095880",
  "amount":   100,
  "gameId":   "abc123"
}
```

**Your response:**
```json
{ "ok": true }
```

---

#### `action: "credit"` — player won

**Request from Dama:**
```json
{
  "action":   "credit",
  "phone":    "0909095880",
  "username": "Kaleab",
  "playerId": "ph_0909095880",
  "amount":   180,
  "fee":      20,
  "gameId":   "abc123"
}
```
> `amount` = what the winner receives. `fee` = Dama's 10% service cut.

---

#### `action: "loss"` — player lost

```json
{
  "action":   "loss",
  "phone":    "0909095880",
  "username": "Kaleab",
  "playerId": "ph_0909095880",
  "amount":   0,
  "fee":      20,
  "gameId":   "abc123"
}
```

---

#### `action: "refund"` — draw, each player refunded

```json
{
  "action":   "refund",
  "phone":    "0909095880",
  "username": "Kaleab",
  "playerId": "ph_0909095880",
  "amount":   95,
  "fee":      5,
  "gameId":   "abc123"
}
```
> `amount` = refund per player. `fee` = Dama's 5% draw cut per player.

---

## 10. Frontend URL Format

The frontend game is opened with URL params that identify the player:

```
https://dama-game-6d2b.onrender.com/
  ?token=dama_a52ea8f0ac191e6a23a39347a3b2b4e61b0a176b0bc0403f
  &phone=0909095880
  &username=Kaleab
  &balance=500
```

| Param | Required | Description |
|-------|----------|-------------|
| `token` | ✅ | API token created in admin panel |
| `phone` | ✅ | Player's phone number (used as unique ID) |
| `username` | ✅ | Player's display name |
| `balance` | ✅ | Initial balance shown while real balance loads |

> The `balance` param is just a placeholder. The real balance is fetched from the owner backend via `POST /dama` with `action: "get_balance"`.

---

## 11. Error Responses

All errors follow this format:

```json
{
  "ok": false,
  "error": "Description of what went wrong"
}
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request / validation error |
| `401` | Missing or invalid token/JWT |
| `403` | CORS blocked |
| `404` | Resource not found |
| `500` | Internal server error |
