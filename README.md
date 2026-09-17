# Dama Backend

REST + WebSocket API server for the Dama (Ethiopian checkers) game platform.

## Stack

- **Node.js 18+** with ESM (`"type": "module"`)
- **Express 4** — HTTP framework
- **better-sqlite3** — synchronous SQLite driver
- **ws** — WebSocket server
- **express-validator** — request validation
- **helmet / cors** — security & CORS
- **dotenv** — environment config
- **morgan** — HTTP request logging
- **nanoid** — unique ID generation

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and adjust values
cp .env.example .env

# 3. Start in development mode (auto-restarts on file changes)
npm run dev

# 4. Start in production
npm start
```

The server starts on `http://localhost:3001` by default.  
The SQLite database is created automatically at `./data/dama.db`.

---

## Environment Variables

| Variable       | Default                                  | Description                          |
|----------------|------------------------------------------|--------------------------------------|
| `PORT`         | `3001`                                   | HTTP port                            |
| `NODE_ENV`     | `development`                            | `development` or `production`        |
| `DB_PATH`      | `./data/dama.db`                         | Path to SQLite database file         |
| `ADMIN_TOKEN`  | `dama-admin-secret-change-me`            | Bearer token for admin endpoints     |
| `CORS_ORIGINS` | `http://localhost:5173,...`              | Comma-separated allowed CORS origins |

---

## API Endpoints

### Health

| Method | Path         | Description           |
|--------|--------------|-----------------------|
| GET    | /api/health  | Server + DB liveness  |

**Response:**
```json
{ "ok": true, "uptime": 42.1, "timestamp": "...", "db": "ok" }
```

---

### Players — `/api/players`

| Method | Path                    | Auth    | Description                        |
|--------|-------------------------|---------|------------------------------------|
| GET    | /api/players            | —       | List players (`?online`, `?search`, `?limit`, `?offset`) |
| GET    | /api/players/:id        | —       | Get one player                     |
| POST   | /api/players            | —       | Upsert player (register / update)  |
| PATCH  | /api/players/:id        | Admin   | Partial update player fields       |
| PATCH  | /api/players/:id/balance| —       | Add or deduct balance              |
| DELETE | /api/players/:id        | Admin   | Delete player                      |
| POST   | /api/players/:id/result | —       | Record win / loss / draw           |

**POST /api/players body:**
```json
{ "id": "string", "name": "string", "photo": "url?", "bet": 100, "pieceThemeId": "classic", "isDemo": false }
```

**PATCH /api/players/:id/balance body:**
```json
{ "amount": 50 }   // positive = add, negative = deduct, floors at 0
```

**POST /api/players/:id/result body:**
```json
{ "result": "win" | "loss" | "draw" }
```

---

### Games — `/api/games`

| Method | Path                    | Auth | Description                          |
|--------|-------------------------|------|--------------------------------------|
| GET    | /api/games              | —    | List games (`?status`, `?playerId`, `?limit`, `?offset`) |
| GET    | /api/games/:id          | —    | Get game + moves                     |
| POST   | /api/games              | —    | Create game                          |
| PATCH  | /api/games/:id/finish   | —    | Finish game                          |
| POST   | /api/games/:id/moves    | —    | Append a move                        |

**POST /api/games body:**
```json
{ "mode": "ai" | "pvp", "player1Id": "string", "player2Id": "string?", "betAmount": 0 }
```

**PATCH /api/games/:id/finish body:**
```json
{ "winnerId": "string?", "durationSec": 120, "moveCount": 24 }
```

**POST /api/games/:id/moves body:**
```json
{ "playerId": "string", "moveData": { "from": { "r": 0, "c": 1 }, "to": { "r": 1, "c": 2 }, "captured": { "r": 0, "c": 1 } } }
```

---

### AI Config — `/api/ai`

| Method | Path    | Auth  | Description        |
|--------|---------|-------|--------------------|
| GET    | /api/ai | —     | Get AI config      |
| PUT    | /api/ai | Admin | Update AI config   |

**PUT /api/ai body:**
```json
{ "difficulty": "easy" | "medium" | "hard", "thinkDelay": 600, "aiName": "Computer 🤖", "allowUndo": true }
```

---

### Admin — `/api/admin`

All admin routes require:  
`Authorization: Bearer <ADMIN_TOKEN>`

| Method | Path                             | Description                       |
|--------|----------------------------------|-----------------------------------|
| GET    | /api/admin/stats                 | Aggregate stats                   |
| GET    | /api/admin/players               | Full player list                  |
| DELETE | /api/admin/players/demo          | Delete all demo players           |
| POST   | /api/admin/players/seed          | Seed 5 Ethiopian demo players     |
| PATCH  | /api/admin/players/:id/balance   | Set exact or adjust balance       |

**PATCH /api/admin/players/:id/balance body:**
```json
{ "balance": 1000 }   // set exact balance
// OR
{ "amount": -200 }    // relative adjustment
```

---

## WebSocket

Connect to `ws://localhost:3001`.

### Client → Server

```json
{ "type": "join",  "playerId": "xxx" }
{ "type": "leave", "playerId": "xxx" }
{ "type": "ping" }
```

### Server → Client

```json
{ "type": "pong" }
{ "type": "presence", "online": ["id1", "id2"] }
{ "type": "player_updated", "player": { ... } }
{ "type": "ai_config_updated", "config": { ... } }
```

**Behavior:**
- `join` — marks player online in DB, broadcasts updated presence list to all clients.
- `leave` / disconnect — marks player offline, broadcasts updated presence list.
- Every 30 seconds — server broadcasts the full presence list to all connected clients.

---

## Response Format

All REST responses follow a consistent envelope:

```json
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": "message" }

// Validation error
{ "ok": false, "errors": [ { "field": "name", "msg": "name is required" } ] }
```

---

## Project Structure

```
src/
  server.js          HTTP + WS server bootstrap
  app.js             Express app factory
  config/env.js      Env var validation & exports
  db/
    database.js      SQLite connection (WAL mode, FK on)
    schema.js        CREATE TABLE statements + seed
    migrations.js    Runs schema on startup
  routes/            Express routers (one per domain)
  controllers/       Thin handlers — call service, return response
  services/          Business logic + all DB queries
  middleware/
    errorHandler.js  Global error → { ok: false, error }
    validate.js      express-validator result checker
    auth.js          Bearer token admin guard
  ws/
    wsServer.js      WebSocket server + presence logic
    wsEvents.js      Event name constants
  utils/
    logger.js        Leveled console logger
    response.js      ok() / fail() response helpers
```
