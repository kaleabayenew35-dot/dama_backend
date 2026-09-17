### FOLDER: dama-backend

Responsibility: identify the token, relay to the right system-backend,

return balance/username — never touch the raw phone itself beyond

passing it through.

- `/api/player-balance` receives `{ token, launch }`.
- Look up `token` in `api_tokens` → get that token's `backend_url`

(which system-backend instance owns this game/partner).
- Forward `launch` to that system-backend's verify endpoint.
- System-backend decrypts it and hands back `{ phone, username, balance }`

(or dama-backend calls a separate "get balance by phone" endpoint

after verification — either way, dama-backend never decrypts the

payload itself, only system-backend holds DAMA_LAUNCH_SECRET).
- Return `{ balance, username }` to the frontend.
