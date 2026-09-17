# Dama — Token Backend Integration Guide

Your server must expose **one endpoint**:

```
POST {your_backend_url}/dama
Content-Type: application/json
```

Dama calls this endpoint for every game event. Every request body includes:
- `action` — what happened
- `token` — your Dama API token string (authenticates the call)

You respond with `{ "ok": true }` (or action-specific data shown below).

---

## Actions Reference

### 1. `get_balance` — Fetch player balance on login

**Request:**
```json
{
  "action":   "get_balance",
  "token":    "dama_2449f295e76f...",
  "phone":    "0911234567",
  "username": "Abebe"
}
```

**Response (required):**
```json
{
  "balance":  1500,
  "username": "Abebe"
}
```

---

### 2. `deduct` — Bet placed, deduct from player balance

Called when a game starts and the bet is locked in.

**Request:**
```json
{
  "action":   "deduct",
  "token":    "dama_2449f295e76f...",
  "phone":    "0911234567",
  "username": "Abebe",
  "playerId": "ph_0911234567",
  "amount":   100,
  "gameId":   "AI-ABC123"
}
```

**Response:**
```json
{ "ok": true }
```

---

### 3. `credit` — Winner payout, add to player balance

Called when the game ends and this player won. **Add `amount` to their balance.**

**Request:**
```json
{
  "action":   "credit",
  "token":    "dama_2449f295e76f...",
  "phone":    "0911234567",
  "username": "Abebe",
  "playerId": "ph_0911234567",
  "amount":   180,
  "fee":      20,
  "gameId":   "AI-ABC123"
}
```
- `amount` — what the winner receives (pot minus 10% fee). **Add this to player balance.**
- `fee` — the 10% commission Dama kept (for your records)

**Response:**
```json
{ "ok": true }
```

---

### 4. `loss` — Loser notification

Called when this player lost. No money movement (already deducted at start). Informational only.

**Request:**
```json
{
  "action":   "loss",
  "token":    "dama_2449f295e76f...",
  "phone":    "0922345678",
  "username": "Bekele",
  "playerId": "ph_0922345678",
  "amount":   0,
  "fee":      20,
  "gameId":   "AI-ABC123"
}
```

**Response:**
```json
{ "ok": true }
```

---

### 5. `refund` — Draw refund, return amount to player

Called when the game ends in a draw. **Add `amount` back to this player's balance.**

**Request:**
```json
{
  "action":   "refund",
  "token":    "dama_2449f295e76f...",
  "phone":    "0911234567",
  "username": "Abebe",
  "playerId": "ph_0911234567",
  "amount":   95,
  "fee":      10,
  "gameId":   "AI-ABC123"
}
```

**Response:**
```json
{ "ok": true }
```

---

### 6. `owner_fee` — Your commission / profit / loss

Called after every game settlement. Tells you how much you earned or paid out as the house.

**`amount` is positive when you earn, negative when you pay out.**

| `type` | When | `amount` |
|---|---|---|
| `pvp_win_fee` | PvP win | + (10% of pot) |
| `pvp_draw_fee` | PvP draw | + (5%×2 of bets) |
| `ai_profit` | AI wins — player lost | + (player's bet) |
| `ai_win_fee` | AI win commission | + |
| `ai_loss` | Player beats AI — you pay out | − |
| `ai_draw_fee` | AI draw fee | + |

**Request (PvP win, bet=100 each):**
```json
{
  "action":  "owner_fee",
  "token":   "dama_2449f295e76f...",
  "amount":  20,
  "type":    "pvp_win_fee",
  "gameId":  "AI-ABC123"
}
```

**Request (player beats AI — you pay out):**
```json
{
  "action":        "owner_fee",
  "token":         "dama_2449f295e76f...",
  "amount":        -80,
  "type":          "ai_loss",
  "gameId":        "AI-ABC123",
  "humanPlayerId": "ph_0911234567"
}
```

**Response:**
```json
{ "ok": true }
```

---

### 7. `ping` — Connectivity check

**Request:**
```json
{ "action": "ping", "token": "dama_2449f295e76f..." }
```

**Response:**
```json
{ "ok": true }
```

---

## Complete Game Flow Examples

### PvP — Player A wins (bet = 100 each)

```
pot=200  fee=20 (10%)  payout=180

→ deduct  { token, phone:A, amount:100, gameId }
→ deduct  { token, phone:B, amount:100, gameId }

→ credit  { token, phone:A, amount:180, fee:20, gameId }  ← ADD 180 to A
→ loss    { token, phone:B, amount:0,   fee:20, gameId }  ← informational
→ owner_fee { token, amount:20, type:"pvp_win_fee", gameId }
```

### PvP — Draw (bet = 100 each)

```
feeEach=5  refund=95  totalFee=10

→ deduct  { token, phone:A, amount:100, gameId }
→ deduct  { token, phone:B, amount:100, gameId }

→ refund  { token, phone:A, amount:95, fee:10, gameId }  ← ADD 95 to A
→ refund  { token, phone:B, amount:95, fee:10, gameId }  ← ADD 95 to B
→ owner_fee { token, amount:10, type:"pvp_draw_fee", gameId }
```

### AI game — Player wins (bet = 100)

```
pot=200  fee=20  payout=180  ownerNet = 20-100 = -80

→ deduct   { token, phone:player, amount:100, gameId }   ← called by start-bet
→ credit   { token, phone:player, amount:180, fee:20, gameId }  ← ADD 180 to player
→ owner_fee { token, amount:-80, type:"ai_loss", gameId, humanPlayerId }
```

### AI game — AI wins (bet = 100)

```
→ deduct   { token, phone:player, amount:100, gameId }
→ loss     { token, phone:player, amount:0, fee:20, gameId }
→ owner_fee { token, amount:100, type:"ai_profit",  gameId, humanPlayerId }
→ owner_fee { token, amount:20,  type:"ai_win_fee", gameId, humanPlayerId }
```

### AI game — Draw (bet = 100)

```
feeEach=5  refund=95  totalFee=10

→ deduct   { token, phone:player, amount:100, gameId }
→ refund   { token, phone:player, amount:95, fee:10, gameId }  ← ADD 95 to player
→ owner_fee { token, amount:10, type:"ai_draw_fee", gameId }
```

---

## Key Rules for Your Implementation

1. `credit` action → **add `amount` to player balance**
2. `deduct` action → **subtract `amount` from player balance**
3. `refund` action → **add `amount` to player balance**
4. `loss` action → **no balance change** (informational only)
5. `owner_fee` action → **update your house/owner balance** (positive = you earn, negative = you pay out)
6. Always validate the `token` field matches your registered Dama API token
7. Respond with any `2xx` status to confirm success
8. All `phone` values are sent normalized (e.g. `0911234567` — match however you store them)

