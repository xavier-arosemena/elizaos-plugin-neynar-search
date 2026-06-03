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
  /** If true, skip Tier 2 (profile monitoring) entirely — reduces ~38 credits/cycle/profile */
  disableTier2?: boolean;
  /** If true, skip Tier 3 (inbound engagement detection) — reduces ~148 credits/cycle */
  disableTier3?: boolean;
  /** Maximum number of keywords to use in Tier 1 search (default: no limit). Saves ~149 credits per excluded keyword */
  keywordLimit?: number;
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
  type: "reply" | "recast" | "like" | "follow" | "mention" | "direct_cast";
  cast: NeynarCast;
  parent_cast?: NeynarCast; // only for replies / direct_casts
}

/** Response envelope from GET /v2/farcaster/notifications */
export interface NeynarNotificationsResponse {
  notifications: {
    type: string;
    cast: any;
    parent_cast?: any;
  }[];
}

// =============================================================================
// Direct Cast types
// =============================================================================

/** Represents a Direct Cast (DM) notification from Neynar's notifications API */
export interface DirectCastNotification {
  type: "direct_cast";
  cast: NeynarCast;           // The DM message cast object
  sender?: NeynarAuthor;       // Sender profile (nested in cast.author)
  received_at: string;         // ISO timestamp
}

/** Configuration for the REPLY_DIRECT_CAST action */
export interface DmConfig {
  /** Neynar API key (required) */
  apiKey: string;
  /** Neynar signer UUID (required for sending replies) */
  signerUuid: string;
  /** Farcaster ID of this agent (Archon) */
  archonFid: number;
  /** Minimum follower count for a sender to not be considered spam (default: 50) */
  spamMinFollowers: number;
  /** Minimum follower count for senders without power badge (default: 200) */
  spamMinFollowersPower: number;
  /** Max DMs per sender in 24h before rate-limiting (default: 3) */
  maxDmsPerSender: number;
  /** Maximum DMs to process per cycle (default: 3) */
  maxDmsPerCycle: number;
  /** Minimum priority score for a DM to get a reply (default: 30) */
  minScoreForReply: number;
  /** Maximum DM replies per 24h rolling window (default: 10) */
  dailyReplyLimit: number;
}

/** Persisted state tracking DM priority across cycles */
export interface DmPriorityState {
  /** ISO timestamp of last DM fetch */
  lastFetchTimestamp: string;
  /** Set of processed DM cast hashes (dedup, max 200) */
  processedDmHashes: string[];
  /** Set of replied DM cast hashes (max 200) */
  sentReplyHashes: string[];
  /** Rolling daily reply counter */
  dailyReplyCount: number;
  /** Date string (YYYY-MM-DD) for daily counter reset */
  dailyReplyDate: string;
  /** DMs still awaiting reply, sorted by score descending */
  pendingReplies: Array<{
    dmHash: string;
    senderFid: number;
    senderHandle: string;
    dmText: string;
    score: number;
  }>;
}

// =============================================================================
// Like action types
// =============================================================================

/** Configuration for the LIKE_FARCASTER action */
export interface LikeConfig {
  /** Neynar API key (required) */
  apiKey: string;
  /** Neynar signer UUID (required for write operations) */
  signerUuid: string;
  /** Maximum likes per 24h rolling window (default: 270) */
  maxDailyLikes: number;
  /** Min delay between like API calls in ms (default: 3000) */
  minDelayMs: number;
  /** Max delay between like API calls in ms (default: 5000) */
  maxDelayMs: number;
  /** Path to the liked-casts state file */
  likedStatePath: string;
  /** How many recent casts to fetch per author for extra likes (default: 5) */
  extraCastsPerAuthor: number;

  // ==========================================================================
  // Wider Discovery Layers (Issue #8)
  // ==========================================================================

  /** Enable commenter discovery: like casts from users who replied to scout-identified casts (default: true) */
  commenterDiscoveryEnabled: boolean;
  /** Maximum number of commenters to check per scout cast (default: 5) */
  maxCommentersPerCast: number;
  /** Maximum casts to fetch per discovered commenter (default: 3) */
  maxCastsPerCommenter: number;

  /** Enable keyword discovery: search for relevant casts using keywords during the like cycle (default: true) */
  keywordDiscoveryEnabled: boolean;
  /** Maximum number of keywords to use in discovery search (default: 3, saves ~149 credits per keyword) */
  keywordDiscoveryMaxKeywords: number;

  /** Enable channel feed discovery: like casts from the same channel as scout-identified casts (default: false) */
  channelDiscoveryEnabled: boolean;
  /** Maximum number of casts to fetch per channel (default: 5) */
  maxCastsPerChannel: number;
}

/** Persisted state tracking likes across cycles */
export interface LikeState {
  /** Set of cast hashes that have been liked, hash → timestamp */
  likedHashes: Record<string, number>;
  /** Rolling counter for the current 24h window */
  dailyCount: number;
  /** Timestamp of the first like in the current window (epoch ms) */
  windowStart: number;
  /** ISO timestamp of last LIKE cycle */
  lastCycleAt: string;
  /** Current batch number in this 24h window */
  batchNumber: number;
}

/** Result of a single LIKE cycle batch */
export interface LikeCycleResult {
  totalAttempted: number;
  totalLiked: number;
  totalFailed: number;
  scoutCastsLiked: number;
  extraCastsLiked: number;
  dailyBudgetRemaining: number;
  batchBudgetUsed: number;
}

// =============================================================================
// Follow/Unfollow action types
// =============================================================================

/** Configuration for the FOLLOW_FARCASTER action */
export interface FollowConfig {
  /** Neynar API key (required) */
  apiKey: string;
  /** Neynar signer UUID (required for write operations) */
  signerUuid: string;
  /** Maximum follows per cycle (default: 5) */
  maxFollowsPerCycle: number;
  /** Minimum follower count to not be considered spam (default: 10) */
  spamMinFollowers: number;
}

/** Persisted state shared between FOLLOW_FARCASTER and UNFOLLOW_FARCASTER */
export interface FollowState {
  /** FIDs Archon is currently following */
  followedFids: number[];
  /** FID → ISO timestamp when followed */
  followedAt: Record<number, string>;
  /** Cursor for staggered pagination (null = start from page 1) */
  followerCursor: string | null;
  /** Count of FIDs checked in current staggered pass (for logging) */
  followerPageChecked: number;
  /** ISO timestamp of last follow cycle */
  lastFollowCycle: string | null;
  /** ISO timestamp of last unfollow cycle */
  lastUnfollowCycle: string | null;
  /** Total FOLLOW_FARCASTER cycles run */
  followCycleCount: number;
  /** Total UNFOLLOW_FARCASTER cycles run */
  unfollowCycleCount: number;
  /** Total follow API calls that succeeded */
  totalFollowsExecuted: number;
  /** Total unfollow API calls that succeeded */
  totalUnfollowsExecuted: number;
}

/** Result of a single FOLLOW_FARCASTER cycle */
export interface FollowCycleResult {
  followed: number;
  attempted: number;
  skipped: number;
  alreadyFollowed: number;
  spamFiltered: number;
  errors: string[];
}

/** Result of a single UNFOLLOW_FARCASTER cycle */
export interface UnfollowCycleResult {
  unfollowed: number;
  pageSize: number;
  pageRemaining: boolean;
  checkedFids: number;
  errors: string[];
}
