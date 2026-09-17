// Client → Server
export const CLIENT_JOIN   = 'join';
export const CLIENT_LEAVE  = 'leave';
export const CLIENT_PING   = 'ping';
export const CHALLENGE_SEND   = 'challenge_send';
export const CHALLENGE_ACCEPT = 'challenge_accept';
export const CHALLENGE_DECLINE = 'challenge_decline';
export const MAKE_MOVE        = 'make_move';
export const GAME_OVER        = 'game_over';
export const GAME_RESIGN      = 'resign';
export const RECONNECT_GAME   = 'reconnect_game';

// Server → Client
export const SERVER_PONG           = 'pong';
export const SERVER_PRESENCE       = 'presence';
export const SERVER_PLAYER_UPDATED = 'player_updated';
export const SERVER_AI_CONFIG_UPDATED = 'ai_config_updated';
export const CHALLENGE_RECEIVE     = 'challenge_receive';
export const CHALLENGE_DECLINED    = 'challenge_declined';
export const GAME_START            = 'game_start';
export const MOVE_MADE             = 'move_made';
export const OPPONENT_LEFT         = 'opponent_left';
export const OPPONENT_REJOINED     = 'opponent_rejoined';
export const KICKED                = 'kicked';
