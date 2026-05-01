// =============================================================================
// types.ts — Core data shapes for @elizaos/plugin-neynar-search
// =============================================================================

/** Raw author object returned by Neynar cast endpoints */
export interface NeynarAuthor {
  fid: number;
  username: string;
  display_name?: string;
  follower_count: number;
  following_count?: number;
  power_badge?: boolean;
  profile?: {
    bio?: { text?: string };
  };
}

/** Reaction counts on a cast */
export interface NeynarReactions {
  likes_count: number;
  recasts_count: number;
}

/** Reply count on a cast */
export interface NeynarReplies {
  count: number;
}

/** Raw Neynar cast object (minimal fields we need) */
export interface NeynarCast {
  hash: string;
  text: string;
  timestamp: string;          // ISO 8601
  author: NeynarAuthor;
  reactions: NeynarReactions;
  replies: NeynarReplies;
  parent_url?: string;
  channel?: { id?: string; name?: string } | null;
}

/** Response envelope from GET /v2/farcaster/cast/search */
export interface NeynarSearchResponse {
  result: {
    casts: NeynarCast[];
    next?: { cursor?: string };
  };
}

/** Response envelope from GET /v2/farcaster/user/casts */
export interface NeynarUserCastsResponse {
  casts: NeynarCast[];
  next?: { cursor?: string };
}

/** A cast enriched with a score and suggested reply angle */
export interface ScoredOpportunity extends NeynarCast {
  score: number;            // 1.0–10.0, one decimal place
  suggestedAngle: string;   // one sentence, data-first
  castUrl: string;          // https://warpcast.com/USERNAME/HASH
  matchedKeywords: string[];
}

/** Runtime configuration built inside the action handler */
export interface PluginConfig {
  apiKey: string;
  archonUrl: string;          // e.g. http://archon_euro_container:3000
  archonAgentId: string;
  keywords: string[];
  maxResults: number;         // cap, default 10
  minScore: number;           // discard below this, default 6
}
