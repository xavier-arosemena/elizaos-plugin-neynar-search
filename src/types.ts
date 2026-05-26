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
  /** Neynar API key (required) */
  apiKey: string;
  /** Base URL of the target agent's DirectClient, e.g. http://archon_euro_container:3000 */
  archonUrl: string;
  /** Agent ID of the target agent receiving the scout queue */
  archonAgentId: string;
  /** Farcaster ID (FID) of the target agent for inbound engagement detection (Tier 3) */
  archonFarcasterFid: number;
  /** Path to the generated target list JSON (Tier 2 profile monitoring) */
  targetListJsonPath: string;
  /** Default keyword corpus for Tier 1 topic discovery when RAG knowledge is unavailable */
  defaultKeywords: string[];
  /** Maximum number of results in the ranked queue (default: 5) */
  maxResults: number;
  /** Minimum score threshold; casts below this are discarded unless fallback triggers (default: 6) */
  minScore: number;
}

/**
 * Runtime state for the three-tier discovery coordinator.
 * Persisted to a JSON file between cycles.
 */
export interface ScoutCycleState {
  /** Monotonically increasing cycle counter */
  cycleNumber: number;
  /** ISO timestamp of last cycle */
  lastCycleAt: string;
  /** Keywords used in the last Tier 1 search */
  lastKeywords: string[];
  /** Whether Tier 1 was executed from cache */
  tier1Cached: boolean;
  /** Whether Tier 2 was executed this cycle */
  tier2Executed: boolean;
  /** Whether Tier 3 was executed this cycle */
  tier3Executed: boolean;
}

/** Resolved profile with FID for Tier 2 profile monitoring */
export interface MonitoredProfile {
  /** Farcaster handle without @, e.g. "tldr" */
  handle: string;
  /** Resolved Farcaster ID (FID) from target_list.json */
  fid: number;
  /** Follower count at resolution time */
  followerCount: number;
  /** Strategic vector: "Industrial & Energy" | "Strategic Autonomy" | "Rationalism & Finance" */
  vector?: string;
}

/** A single notification from Neynar's notifications endpoint */
export interface NeynarNotification {
  type: "reply" | "recast" | "like" | "follow" | "mention";
  cast: NeynarCast;
  parent_cast?: NeynarCast; // only for replies
}

/** Response envelope from GET /v2/farcaster/notifications */
export interface NeynarNotificationsResponse {
  notifications: {
    type: string;
    cast: any;
    parent_cast?: any;
  }[];
}
