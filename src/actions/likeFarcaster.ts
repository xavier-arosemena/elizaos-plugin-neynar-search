// =============================================================================
// likeFarcaster.ts — LIKE_FARCASTER ElizaOS Action
//
// Flow:
//   1. Build LikeConfig from runtime settings (FARCASTER_NEYNAR_API_KEY,
//      FARCASTER_NEYNAR_SIGNER_UUID, LIKER_MAX_DAILY, etc.)
//   2. Load LikeState from disk, check rolling 24h window
//   3. Check daily budget; if exhausted, return early
//   4. Read Scout deliveries from Archon's message memories (ingest endpoint)
//   5. Parse cast URLs from Scout delivery texts, extract short hashes
//   6. Resolve short hashes → full hashes + author FIDs via lookupCast
//   7. Filter already-liked hashes (perma-set dedup)
//   8. LIKE Scout-identified casts first (prioritized)
//   9. If batch budget remains, get extra casts from followers of cast authors
//  10. Filter already-liked, LIKE extra casts
//  11. Update and persist LikeState
//  12. Return formatted cycle results via callback
//
// Logging: All like-related logs use [LIKE] prefix for grep filtering.
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { batchLikeCasts, getUserCasts, lookupCast, getFollowersPage, getCastConversation, searchAllKeywords } from "../lib/neynarClient.js";
import {
  loadLikeState,
  saveLikeState,
  checkAndResetWindow,
  isWithinBudget,
  getRemainingBudget,
  isHashLiked,
  recordLikedHash,
  getWindowAgeHours,
} from "../lib/likeState.js";
import type { LikeConfig, LikeState, LikeCycleResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY_LIKES = 270;
const DEFAULT_MIN_DELAY_MS = 3000;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_BATCHES_PER_DAY = 12;
const DEFAULT_FOLLOWERS_PER_AUTHOR = 20;
const DEFAULT_CASTS_PER_FOLLOWER = 3;
const BATCH_RANDOMIZE_FRACTION = 0.2; // ±20% jitter on batch size
const MAX_MEMORIES_TO_SCAN = 200;

// Wider Discovery (Issue #8) defaults
const DEFAULT_COMMENTER_DISCOVERY_ENABLED = true;
const DEFAULT_MAX_COMMENTERS_PER_CAST = 5;
const DEFAULT_MAX_CASTS_PER_COMMENTER = 3;
const DEFAULT_KEYWORD_DISCOVERY_ENABLED = true;
const DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS = 3;
const DEFAULT_CHANNEL_DISCOVERY_ENABLED = false;
const DEFAULT_MAX_CASTS_PER_CHANNEL = 5;

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

/**
 * Build a LikeConfig from the agent runtime settings.
 * Every value can be overridden via character.json secrets / env vars.
 */
function createLikeConfig(runtime: IAgentRuntime): LikeConfig {
  return {
    apiKey: runtime.getSetting("FARCASTER_NEYNAR_API_KEY") || "",
    signerUuid: runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID") || "",
    maxDailyLikes:
      Number(runtime.getSetting("LIKER_MAX_DAILY")) || DEFAULT_MAX_DAILY_LIKES,
    minDelayMs:
      Number(runtime.getSetting("LIKER_MIN_DELAY_MS")) || DEFAULT_MIN_DELAY_MS,
    maxDelayMs:
      Number(runtime.getSetting("LIKER_MAX_DELAY_MS")) || DEFAULT_MAX_DELAY_MS,
    likedStatePath: runtime.getSetting("LIKER_STATE_PATH") || "",
    extraCastsPerAuthor:
      Number(runtime.getSetting("LIKER_EXTRA_PER_AUTHOR")) || DEFAULT_FOLLOWERS_PER_AUTHOR,

    // Wider Discovery (Issue #8)
    commenterDiscoveryEnabled:
      runtime.getSetting("LIKER_COMMENTER_DISCOVERY_ENABLED") !== "false"
        ? true
        : DEFAULT_COMMENTER_DISCOVERY_ENABLED,
    maxCommentersPerCast:
      Number(runtime.getSetting("LIKER_MAX_COMMENTERS_PER_CAST")) || DEFAULT_MAX_COMMENTERS_PER_CAST,
    maxCastsPerCommenter:
      Number(runtime.getSetting("LIKER_MAX_CASTS_PER_COMMENTER")) || DEFAULT_MAX_CASTS_PER_COMMENTER,
    keywordDiscoveryEnabled:
      runtime.getSetting("LIKER_KEYWORD_DISCOVERY_ENABLED") !== "false"
        ? true
        : DEFAULT_KEYWORD_DISCOVERY_ENABLED,
    keywordDiscoveryMaxKeywords:
      Number(runtime.getSetting("LIKER_KEYWORD_DISCOVERY_MAX_KEYWORDS")) || DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS,
    channelDiscoveryEnabled:
      runtime.getSetting("LIKER_CHANNEL_DISCOVERY_ENABLED") === "true"
        ? true
        : DEFAULT_CHANNEL_DISCOVERY_ENABLED,
    maxCastsPerChannel:
      Number(runtime.getSetting("LIKER_MAX_CASTS_PER_CHANNEL")) || DEFAULT_MAX_CASTS_PER_CHANNEL,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read Scout delivery texts from Archon's message memory.
 * Scout stores deliveries via POST /{agentId}/ingest using
 * runtime.messageManager.addEmbeddingToMemory() with roomId = runtime.agentId.
 * Each delivery text starts with "[SCOUT DELIVERY]".
 */
async function getScoutDeliveries(runtime: IAgentRuntime): Promise<string[]> {
  const deliveries: string[] = [];

  try {
    // Query memories from Archon's own room (roomId = agentId for ingest)
    const memories = await runtime.messageManager.getMemories({
      roomId: runtime.agentId,
      count: MAX_MEMORIES_TO_SCAN,
      unique: false,
    });

    if (memories && memories.length > 0) {
      for (const mem of memories) {
        const text = mem.content?.text ?? "";
        if (text.includes("[SCOUT DELIVERY]")) {
          deliveries.push(text);
        }
      }
      elizaLogger.info(
        `[LIKE] Scout deliveries found — ${deliveries.length} delivery memories ` +
        `from ${memories.length} total in room ${runtime.agentId}`
      );
    } else {
      elizaLogger.info(
        "[LIKE] No memories returned from getMemories — trying getMemoriesWithoutEmbedding fallback"
      );
      // Fallback for runtimes where getMemories requires embeddings
      const flat = await (runtime.messageManager as any).getMemoriesWithoutEmbedding?.({
        roomId: runtime.agentId,
        count: MAX_MEMORIES_TO_SCAN,
      });

      if (flat && flat.length > 0) {
        for (const mem of flat) {
          const text = mem.content?.text ?? "";
          if (text.includes("[SCOUT DELIVERY]")) {
            deliveries.push(text);
          }
        }
        elizaLogger.info(
          `[LIKE] Scout deliveries found via fallback — ${deliveries.length} of ${flat.length} memories`
        );
      } else {
        elizaLogger.warn("[LIKE] No memories found in any query path");
      }
    }
  } catch (err) {
    elizaLogger.warn(`[LIKE] Error reading Scout deliveries: ${String(err)}`);
  }

  return deliveries;
}

/**
 * Extract Warpcast cast URLs from a list of Scout delivery texts.
 *
 * Scout queue format per line:
 *   1. SCORE 8/10 [PRIORITY] — @username
 *      URL: https://warpcast.com/username/0x1234abcd
 */
function extractCastUrls(deliveries: string[]): string[] {
  const urls: string[] = [];
  const urlRegex = /https:\/\/warpcast\.com\/[\w.-]+\/\w+/g;

  for (const text of deliveries) {
    const found = text.match(urlRegex);
    if (found) {
      urls.push(...found);
    }
  }

  return urls;
}

/**
 * Extract the short hash from a Warpcast cast URL.
 * URL format: https://warpcast.com/{username}/{shortHash}
 * The short hash is the last URL segment (e.g., "0x1234abcd").
 */
function extractShortHash(url: string): string | null {
  try {
    const segments = url.split("/");
    const last = segments[segments.length - 1];
    return last && last.length > 0 ? last : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an array of short hashes to full cast info (full hash + author FID)
 * via the Neynar lookupCast API.
 *
 * Deduplicates lookups by short hash to avoid redundant API calls.
 * Each lookup costs ~5 credits.
 */
async function resolveShortHashes(
  apiKey: string,
  castUrls: string[]
): Promise<Map<string, { fullHash: string; fid: number; handle: string }>> {
  const result = new Map<string, { fullHash: string; fid: number; handle: string }>();
  const unique = [...new Set(castUrls)];

  elizaLogger.info(
    `[LIKE] Resolving ${unique.length} unique cast URLs via lookupCast (type=url)`
  );

  for (const castUrl of unique) {
    try {
      const cast = await lookupCast(apiKey, castUrl);
      if (cast && cast.hash) {
        result.set(castUrl, {
          fullHash: cast.hash,
          fid: cast.author.fid,
          handle: cast.author.username ?? `fid_${cast.author.fid}`,
        });
        elizaLogger.debug(
          `[LIKE] Resolved ${castUrl.slice(-10)} → ${cast.hash.slice(0, 14)}... (by @${cast.author.username ?? "unknown"}, fid=${cast.author.fid})`
        );
      } else {
        elizaLogger.warn(`[LIKE] Could not resolve cast URL: ${castUrl} — cast not found`);
      }
    } catch (err) {
      elizaLogger.warn(`[LIKE] Error resolving URL ${castUrl}: ${String(err)}`);
    }
  }

  elizaLogger.info(
    `[LIKE] Hash resolution complete — ${result.size}/${unique.length} resolved`
  );

  return result;
}

/**
 * Get extra unliked cast hashes from **followers** of the cast authors.
 * Instead of fetching more casts from the same author (which duplicates
 * content), this discovers new authors by fetching followers of each
 * cast author and collecting their recent casts.
 *
 * This builds network presence by engaging with the author's audience
 * rather than spamming the same author's content.
 *
 * Fetches up to `maxFollowersPerAuthor` followers per author, then
 * up to `maxCastsPerFollower` recent casts per follower.
 */
async function getExtraCastHashes(
  apiKey: string,
  authorFids: number[],
  maxFollowersPerAuthor: number,
  state: LikeState,
  budget: number
): Promise<string[]> {
  if (budget <= 0 || authorFids.length === 0) return [];

  const uniqueFids = [...new Set(authorFids)];
  const candidates: string[] = [];
  const seenHashes = new Set<string>();
  const MAX_CASTS_PER_FOLLOWER = DEFAULT_CASTS_PER_FOLLOWER;

  elizaLogger.info(
    `[LIKE] Extra discovery (followers) — ${uniqueFids.length} unique authors, ` +
    `fetching up to ${maxFollowersPerAuthor} followers each, ` +
    `up to ${MAX_CASTS_PER_FOLLOWER} casts per follower, budget=${budget}`
  );

  for (const fid of uniqueFids) {
    try {
      // Fetch followers of the cast author (1 page)
      const { fids: followerFids } = await getFollowersPage(
        apiKey,
        fid,
        maxFollowersPerAuthor
      );

      if (followerFids.length === 0) {
        elizaLogger.debug(`[LIKE] Extra discovery fid=${fid}: no followers returned`);
        continue;
      }

      elizaLogger.debug(
        `[LIKE] Extra discovery fid=${fid}: ${followerFids.length} followers fetched`
      );

      // Fetch recent casts from each follower
      for (const followerFid of followerFids) {
        try {
          const casts = await getUserCasts(apiKey, followerFid, MAX_CASTS_PER_FOLLOWER);

          let newForFollower = 0;
          for (const cast of casts) {
            if (!seenHashes.has(cast.hash) && !isHashLiked(state, cast.hash)) {
              seenHashes.add(cast.hash);
              candidates.push(cast.hash);
              newForFollower++;
            }
          }

          if (newForFollower > 0) {
            elizaLogger.debug(
              `[LIKE] Extra discovery follower fid=${followerFid}: ` +
              `${casts.length} fetched, ${newForFollower} new unliked`
            );
          }
        } catch (err) {
          elizaLogger.debug(
            `[LIKE] Error fetching casts for follower fid=${followerFid}: ${String(err)}`
          );
        }

        // Early exit if we have enough buffer (2x budget)
        if (candidates.length >= budget * 2) break;
      }
    } catch (err) {
      elizaLogger.warn(`[LIKE] Error fetching followers for fid=${fid}: ${String(err)}`);
    }

    // Early exit if we have enough buffer (2x budget)
    if (candidates.length >= budget * 2) {
      elizaLogger.debug("[LIKE] Extra discovery (followers) — early exit: enough candidates collected");
      break;
    }
  }

  const result = candidates.slice(0, budget);

  elizaLogger.info(
    `[LIKE] Extra discovery (followers) — ${candidates.length} unliked found, taking ${result.length} for batch`
  );

  return result;
}

// =============================================================================
// Wider Discovery Layer 2 — Commenter Discovery (Issue #8)
// =============================================================================

/**
 * Extract unique commenter FIDs from the conversation (replies) of a set of
 * scout-identified casts. Used by the commenter discovery layer to find new
 * authors to engage with.
 */
async function getCommenterFidsFromScoutCasts(
  apiKey: string,
  castUrls: string[],
  hashMap: Map<string, { fullHash: string; fid: number; handle: string }>,
  maxCommentersPerCast: number
): Promise<number[]> {
  const commenterFids = new Set<number>();

  elizaLogger.info(
    `[LIKE] Commenter discovery — scanning up to ${castUrls.length} scout cast conversations, ` +
    `max ${maxCommentersPerCast} commenters per cast`
  );

  for (const castUrl of castUrls) {
    const castInfo = hashMap.get(castUrl);
    if (!castInfo) continue;

    try {
      const { replies } = await getCastConversation(apiKey, castInfo.fullHash, 1, 25);

      if (replies.length === 0) {
        elizaLogger.debug(`[LIKE] Commenter discovery: no replies for ${castInfo.fullHash.slice(0, 14)}...`);
        continue;
      }

      let commentersAdded = 0;
      for (const reply of replies) {
        if (commentersAdded >= maxCommentersPerCast) break;
        const replyFid = reply.author?.fid;
        if (replyFid && replyFid !== castInfo.fid && !commenterFids.has(replyFid)) {
          commenterFids.add(replyFid);
          commentersAdded++;
        }
      }

      elizaLogger.debug(
        `[LIKE] Commenter discovery: ${replies.length} replies for ` +
        `${castInfo.handle}:${castInfo.fullHash.slice(0, 8)}... → ` +
        `${commentersAdded} new commenter FIDs added`
      );
    } catch (err) {
      elizaLogger.debug(
        `[LIKE] Commenter discovery: error fetching conversation for ${castInfo.fullHash.slice(0, 14)}...: ${String(err)}`
      );
    }
  }

  elizaLogger.info(
    `[LIKE] Commenter discovery complete — ${commenterFids.size} unique commenter FIDs found`
  );

  return [...commenterFids];
}

/**
 * Get extra unliked cast hashes from **commenters** of the scout-identified casts.
 * Fetches the conversation (replies) for each scout cast, extracts unique
 * commenter FIDs, then fetches their recent casts and filters out already-liked ones.
 *
 * This builds network presence by engaging with people who are actively
 * discussing the same topics as the scout-identified content.
 */
async function getExtraCastHashesFromCommenters(
  apiKey: string,
  commenterFids: number[],
  maxCastsPerCommenter: number,
  state: LikeState,
  budget: number
): Promise<string[]> {
  if (budget <= 0 || commenterFids.length === 0) return [];

  const uniqueFids = [...new Set(commenterFids)];
  const candidates: string[] = [];
  const seenHashes = new Set<string>();

  elizaLogger.info(
    `[LIKE] Extra discovery (commenters) — ${uniqueFids.length} unique commenters, ` +
    `up to ${maxCastsPerCommenter} casts each, budget=${budget}`
  );

  for (const commenterFid of uniqueFids) {
    try {
      const casts = await getUserCasts(apiKey, commenterFid, maxCastsPerCommenter);

      let newForCommenter = 0;
      for (const cast of casts) {
        if (!seenHashes.has(cast.hash) && !isHashLiked(state, cast.hash)) {
          seenHashes.add(cast.hash);
          candidates.push(cast.hash);
          newForCommenter++;
        }
      }

      if (newForCommenter > 0) {
        elizaLogger.debug(
          `[LIKE] Extra discovery commenter fid=${commenterFid}: ` +
          `${casts.length} fetched, ${newForCommenter} new unliked`
        );
      }
    } catch (err) {
      elizaLogger.debug(
        `[LIKE] Error fetching casts for commenter fid=${commenterFid}: ${String(err)}`
      );
    }

    // Early exit if we have enough buffer (2x budget)
    if (candidates.length >= budget * 2) break;
  }

  const result = candidates.slice(0, budget);

  elizaLogger.info(
    `[LIKE] Extra discovery (commenters) — ${candidates.length} unliked found, taking ${result.length} for batch`
  );

  return result;
}

// =============================================================================
// Wider Discovery Layer 3 — Keyword Discovery (Issue #8)
// =============================================================================

/**
 * Search for relevant casts using a subset of the agent's keyword corpus
 * during the like cycle. This finds content that may have been missed by the
 * Scout or published between scout cycles.
 *
 * Uses `searchAllKeywords` with a small keyword limit to control credit costs
 * (~149 credits per keyword). Only runs if keywordDiscoveryEnabled is true
 * and the config has max keywords > 0.
 */
async function getRelevantCastsByKeywords(
  apiKey: string,
  keywords: string[],
  maxKeywords: number,
  state: LikeState,
  budget: number
): Promise<string[]> {
  if (budget <= 0 || keywords.length === 0 || maxKeywords <= 0) return [];

  // Use only the configured number of keywords to control costs
  const activeKeywords = keywords.slice(0, maxKeywords);

  elizaLogger.info(
    `[LIKE] Keyword discovery — ${activeKeywords.length}/${keywords.length} keywords, ` +
    `budget=${budget}, ~${activeKeywords.length * 149} estimated credits`
  );

  try {
    const casts = await searchAllKeywords(apiKey, activeKeywords, 5, 3);

    if (casts.length === 0) {
      elizaLogger.info("[LIKE] Keyword discovery — no casts found");
      return [];
    }

    // Filter already-liked and collect unliked hashes
    const unlikedHashes: string[] = [];
    for (const cast of casts) {
      if (!isHashLiked(state, cast.hash)) {
        unlikedHashes.push(cast.hash);
      }
    }

    const result = unlikedHashes.slice(0, budget);

    elizaLogger.info(
      `[LIKE] Keyword discovery — ${casts.length} total, ${unlikedHashes.length} unliked, taking ${result.length} for batch`
    );

    return result;
  } catch (err) {
    elizaLogger.warn(`[LIKE] Keyword discovery error: ${String(err)}`);
    return [];
  }
}

/**
 * Calculate per-batch budget with randomization to avoid patterns.
 * Returns a value between 1 and remaining budget.
 */
function calculateBatchBudget(maxDailyLikes: number, remaining: number): number {
  const baseBatch = Math.floor(maxDailyLikes / DEFAULT_BATCHES_PER_DAY);
  const jitter = Math.floor(baseBatch * BATCH_RANDOMIZE_FRACTION);

  // Randomized: baseBatch ± 20%
  const randomized = baseBatch + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;

  return Math.max(1, Math.min(randomized, remaining));
}

/**
 * Format the cycle result into a human-readable text for the callback.
 */
function formatCycleResult(
  result: LikeCycleResult,
  config: LikeConfig,
  batchNumber: number
): string {
  return (
    `LIKE cycle #${batchNumber} complete. ` +
    `Liked ${result.totalLiked} casts ` +
    `(${result.scoutCastsLiked} Scout + ${result.extraCastsLiked} extra). ` +
    `Daily: ${result.dailyBudgetRemaining}/${config.maxDailyLikes} remaining. ` +
    `Failed: ${result.totalFailed}.`
  );
}

// ---------------------------------------------------------------------------
// LIKE_FARCASTER Action
// ---------------------------------------------------------------------------

export const likeFarcasterAction: Action = {
  name: "LIKE_FARCASTER",

  similes: [
    "LIKE_CASTS",
    "BATCH_LIKE",
    "ENGAGE_LIKES",
    "RUN_LIKE_CYCLE",
    "LIKE_SCOUT_POSTS",
    "LIKE_CYCLE",
  ],

  description:
    "Like Farcaster posts identified by The Scout's discovery queue, " +
    "plus additional discovery layers (Issue #8): " +
    "Layer 1 — followers of cast authors, " +
    "Layer 2 — commenters on scout-identified casts, " +
    "Layer 3 — keyword-relevant content search. " +
    "Respects daily budget (configurable via LIKER_MAX_DAILY, default 270), " +
    "per-batch limits (~22/batch), and rate limits (3-5s delay between likes). " +
    "Each discovery layer is independently configurable via env vars. " +
    "Tracks liked hashes permanently to avoid duplicates.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID");
    if (!apiKey || !signerUuid) {
      elizaLogger.warn(
        "[LIKE] FARCASTER_NEYNAR_API_KEY or FARCASTER_NEYNAR_SIGNER_UUID not set — LIKE_FARCASTER disabled"
      );
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback: HandlerCallback
  ): Promise<boolean> => {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    try {
      // ===================================================================
      // 1. Build config
      // ===================================================================
      const config = createLikeConfig(runtime);

      if (!config.apiKey || !config.signerUuid) {
        const errMsg = "[LIKE] ERROR: API key or signer UUID not configured. Cycle aborted.";
        elizaLogger.error(errMsg);
        callback({ text: errMsg });
        return false;
      }

      elizaLogger.info(
        `[LIKE] LIKE_FARCASTER handler START — ${timestamp}, ` +
        `maxDaily=${config.maxDailyLikes}, delay=${config.minDelayMs}-${config.maxDelayMs}ms, ` +
        `extraPerAuthor=${config.extraCastsPerAuthor}`
      );

      // ===================================================================
      // 2. Load state & check rolling window
      // ===================================================================
      let likeState = loadLikeState(config.likedStatePath);
      const windowAge = getWindowAgeHours(likeState);
      likeState = checkAndResetWindow(likeState);

      elizaLogger.info(
        `[LIKE] State loaded — dailyCount=${likeState.dailyCount}/${config.maxDailyLikes}, ` +
        `windowAge=${windowAge}h, ` +
        `${Object.keys(likeState.likedHashes).length} liked hashes tracked, ` +
        `batch=${likeState.batchNumber}`
      );

      // ===================================================================
      // 3. Check daily budget
      // ===================================================================
      if (!isWithinBudget(likeState, config.maxDailyLikes)) {
        elizaLogger.warn(
          `[LIKE] Budget EXHAUSTED — dailyCount=${likeState.dailyCount}/${config.maxDailyLikes}. ` +
          `Skipping cycle. Window reset at ${new Date(likeState.windowStart + 86400000).toISOString()}.`
        );
        callback({
          text:
            `LIKE cycle skipped — budget exhausted. ` +
            `Daily: ${likeState.dailyCount}/${config.maxDailyLikes}. ` +
            `Next window reset approximately at ` +
            `${new Date(likeState.windowStart + 86400000).toISOString()}.`,
        });
        return true;
      }

      // ===================================================================
      // 4. Calculate batch budget
      // ===================================================================
      const remaining = getRemainingBudget(likeState, config.maxDailyLikes);
      const batchBudget = calculateBatchBudget(config.maxDailyLikes, remaining);

      elizaLogger.info(
        `[LIKE] Budget — daily=${likeState.dailyCount}/${config.maxDailyLikes}, ` +
        `remaining=${remaining}, batchBudget=${batchBudget}`
      );

      // ===================================================================
      // 5. Read Scout deliveries from Archon memory
      // ===================================================================
      const scoutDeliveries = await getScoutDeliveries(runtime);
      const castUrls = extractCastUrls(scoutDeliveries);

      elizaLogger.info(
        `[LIKE] Scout deliveries parsed — ${scoutDeliveries.length} deliveries, ` +
        `${castUrls.length} cast URLs found`
      );

      // ===================================================================
      // 6. Resolve short hashes → full hashes + author FIDs
      // ===================================================================
      let scoutFullHashes: string[] = [];
      let authorFids: number[] = [];
      // hashMap is declared here for use by commenter discovery (Layer 2)
      let hashMap = new Map<string, { fullHash: string; fid: number; handle: string }>();

      if (castUrls.length > 0) {
        // Pass full Warpcast URLs — lookupCast auto-detects and uses type=url
        hashMap = await resolveShortHashes(config.apiKey, castUrls);

        // Build arrays from resolved data
        for (const [, info] of hashMap) {
          scoutFullHashes.push(info.fullHash);
          authorFids.push(info.fid);
        }
      }

      // Deduplicate FIDs
      authorFids = [...new Set(authorFids)];

      // Filter out already-liked Scout hashes
      const unlikedScoutHashes = scoutFullHashes.filter(
        (h) => !isHashLiked(likeState, h)
      );
      const alreadyLikedCount = scoutFullHashes.length - unlikedScoutHashes.length;

      elizaLogger.info(
        `[LIKE] Scout hashes — ${scoutFullHashes.length} total resolved, ` +
        `${unlikedScoutHashes.length} unliked, ${alreadyLikedCount} already liked, ` +
        `${authorFids.length} unique authors`
      );

      // ===================================================================
      // 7. LIKE Scout-identified casts (highest priority)
      // ===================================================================
      const scoutBudget = Math.min(unlikedScoutHashes.length, batchBudget);
      let scoutLiked = 0;
      let scoutFailed = 0;
      let totalLiked = 0;
      let totalFailed = 0;

      if (scoutBudget > 0) {
        elizaLogger.info(
          `[LIKE] Liking Scout casts — ${scoutBudget} of ${unlikedScoutHashes.length} unliked in this batch`
        );

        const scoutResult = await batchLikeCasts(
          config.apiKey,
          config.signerUuid,
          unlikedScoutHashes,
          config.minDelayMs,
          config.maxDelayMs,
          scoutBudget
        );

        scoutLiked = scoutResult.liked;
        scoutFailed = scoutResult.failed;

        // Update state with Scout likes
        for (const hash of scoutResult.likedHashes) {
          recordLikedHash(likeState, hash);
        }
        likeState.dailyCount += scoutLiked;

        totalLiked = scoutLiked;
        totalFailed = scoutFailed;
      } else {
        elizaLogger.info("[LIKE] No unliked Scout casts to like in this batch");
      }

      // ===================================================================
      // 8. Layer 1 — Extra casts from followers of authors (existing)
      // ===================================================================
      let remainingBudget = Math.max(0, batchBudget - scoutLiked);
      let extraLiked = 0;
      let commenterLiked = 0;
      let keywordLiked = 0;

      if (remainingBudget > 0 && authorFids.length > 0) {
        elizaLogger.info(
          `[LIKE] Layer 1 (followers) — budget=${remainingBudget}, ` +
          `${authorFids.length} author FIDs available`
        );

        const extraHashes = await getExtraCastHashes(
          config.apiKey,
          authorFids,
          config.extraCastsPerAuthor,
          likeState,
          remainingBudget
        );

        if (extraHashes.length > 0) {
          const extraCount = Math.min(remainingBudget, extraHashes.length);

          elizaLogger.info(
            `[LIKE] Liking extra casts (followers) — ${extraCount} of ${extraHashes.length} candidates`
          );

          const extraResult = await batchLikeCasts(
            config.apiKey,
            config.signerUuid,
            extraHashes,
            config.minDelayMs,
            config.maxDelayMs,
            extraCount
          );

          extraLiked = extraResult.liked;

          // Update state with follower likes
          for (const hash of extraResult.likedHashes) {
            recordLikedHash(likeState, hash);
          }
          likeState.dailyCount += extraLiked;

          totalLiked += extraLiked;
          totalFailed += extraResult.failed;
          remainingBudget -= extraLiked;
        } else {
          elizaLogger.info("[LIKE] Layer 1 (followers) — no candidates found after filtering");
        }
      } else if (remainingBudget > 0) {
        elizaLogger.info(
          `[LIKE] Layer 1 (followers) — budget=${remainingBudget} but no author FIDs available`
        );
      }

      // ===================================================================
      // 8b. Layer 2 — Extra casts from commenters of scout casts (Issue #8)
      // ===================================================================
      if (remainingBudget > 0 && config.commenterDiscoveryEnabled && castUrls.length > 0 && hashMap.size > 0) {
        elizaLogger.info(
          `[LIKE] Layer 2 (commenters) — budget=${remainingBudget}, ` +
          `config: maxCommentersPerCast=${config.maxCommentersPerCast}, ` +
          `maxCastsPerCommenter=${config.maxCastsPerCommenter}`
        );

        // Extract commenter FIDs from scout cast conversations
        const commenterFids = await getCommenterFidsFromScoutCasts(
          config.apiKey,
          castUrls,
          hashMap,
          config.maxCommentersPerCast
        );

        if (commenterFids.length > 0) {
          const commenterHashes = await getExtraCastHashesFromCommenters(
            config.apiKey,
            commenterFids,
            config.maxCastsPerCommenter,
            likeState,
            remainingBudget
          );

          if (commenterHashes.length > 0) {
            const commenterCount = Math.min(remainingBudget, commenterHashes.length);

            elizaLogger.info(
              `[LIKE] Liking extra casts (commenters) — ${commenterCount} of ${commenterHashes.length} candidates`
            );

            const commenterResult = await batchLikeCasts(
              config.apiKey,
              config.signerUuid,
              commenterHashes,
              config.minDelayMs,
              config.maxDelayMs,
              commenterCount
            );

            commenterLiked = commenterResult.liked;

            // Update state with commenter likes
            for (const hash of commenterResult.likedHashes) {
              recordLikedHash(likeState, hash);
            }
            likeState.dailyCount += commenterLiked;

            totalLiked += commenterLiked;
            totalFailed += commenterResult.failed;
            remainingBudget -= commenterLiked;
          } else {
            elizaLogger.info("[LIKE] Layer 2 (commenters) — no unliked casts found");
          }
        } else {
          elizaLogger.info("[LIKE] Layer 2 (commenters) — no commenter FIDs extracted");
        }
      } else if (remainingBudget > 0 && !config.commenterDiscoveryEnabled) {
        elizaLogger.info("[LIKE] Layer 2 (commenters) — disabled by config");
      }

      // ===================================================================
      // 8c. Layer 3 — Relevant keyword discovery (Issue #8)
      // ===================================================================
      if (remainingBudget > 0 && config.keywordDiscoveryEnabled && config.keywordDiscoveryMaxKeywords > 0) {
        elizaLogger.info(
          `[LIKE] Layer 3 (keywords) — budget=${remainingBudget}, ` +
          `maxKeywords=${config.keywordDiscoveryMaxKeywords}`
        );

        // Use the default keywords from the Scout's corpus
        const defaultKeywords = [
          "EU energy", "European sovereignty", "European Parliament",
          "Austrian economics", "fiscal responsibility", "EU immigration",
          "European right", "crypto regulation EU", "European defense",
          "EU competitiveness", "re-industrialization", "MiCA",
          "Bitcoin Europe", "geopolitical Europe", "energy prices Europe",
        ];

        const keywordHashes = await getRelevantCastsByKeywords(
          config.apiKey,
          defaultKeywords,
          config.keywordDiscoveryMaxKeywords,
          likeState,
          remainingBudget
        );

        if (keywordHashes.length > 0) {
          const keywordCount = Math.min(remainingBudget, keywordHashes.length);

          elizaLogger.info(
            `[LIKE] Liking casts (keywords) — ${keywordCount} of ${keywordHashes.length} candidates`
          );

          const keywordResult = await batchLikeCasts(
            config.apiKey,
            config.signerUuid,
            keywordHashes,
            config.minDelayMs,
            config.maxDelayMs,
            keywordCount
          );

          keywordLiked = keywordResult.liked;

          // Update state with keyword likes
          for (const hash of keywordResult.likedHashes) {
            recordLikedHash(likeState, hash);
          }
          likeState.dailyCount += keywordLiked;

          totalLiked += keywordLiked;
          totalFailed += keywordResult.failed;
          remainingBudget -= keywordLiked;
        } else {
          elizaLogger.info("[LIKE] Layer 3 (keywords) — no relevant cast hashes found");
        }
      } else if (remainingBudget > 0 && !config.keywordDiscoveryEnabled) {
        elizaLogger.info("[LIKE] Layer 3 (keywords) — disabled by config");
      }

      // ===================================================================
      // 9. Finalize & persist state
      // ===================================================================
      likeState.batchNumber++;
      saveLikeState(likeState, config.likedStatePath);

      // ===================================================================
      // 10. Build result summary
      // ===================================================================
      const totalExtra = extraLiked + commenterLiked + keywordLiked;
      const result: LikeCycleResult = {
        totalAttempted: scoutBudget + Math.max(0, batchBudget - scoutLiked),
        totalLiked,
        totalFailed,
        scoutCastsLiked: scoutLiked,
        extraCastsLiked: totalExtra,
        dailyBudgetRemaining: getRemainingBudget(likeState, config.maxDailyLikes),
        batchBudgetUsed: totalLiked,
      };

      const duration = Date.now() - startTime;

      // --- Success log: prominent summary (easy to grep in docker logs) ---
      elizaLogger.success(
        `[LIKE] ===== ${totalLiked} posts liked ===== ` +
        `batch #${likeState.batchNumber}: ` +
        `scout=${scoutLiked}+followers=${extraLiked}+commenters=${commenterLiked}+keywords=${keywordLiked}, ` +
        `daily=${likeState.dailyCount}/${config.maxDailyLikes}, ` +
        `remaining=${result.dailyBudgetRemaining}, ` +
        `failed=${totalFailed}, ` +
        `duration=${duration}ms`
      );

      // --- State snapshot for debugging ---
      elizaLogger.info(
        `[LIKE] State snapshot — ` +
        `batch=${likeState.batchNumber}, ` +
        `dailyCount=${likeState.dailyCount}/${config.maxDailyLikes}, ` +
        `windowStart=${new Date(likeState.windowStart).toISOString()}, ` +
        `totalUniqueLiked=${Object.keys(likeState.likedHashes).length}, ` +
        `lastCycle=${likeState.lastCycleAt}`
      );

      const resultText = formatCycleResult(result, config, likeState.batchNumber);
      callback({ text: resultText });

      return true;
    } catch (err: any) {
      const duration = Date.now() - startTime;
      elizaLogger.error(
        `[LIKE] UNHANDLED ERROR — ${err.message}\n${err.stack ?? "(no stack)"} (${duration}ms)`
      );
      callback({
        text: `LIKE cycle failed after ${duration}ms: ${err.message}`,
      });
      return false;
    }
  },

  examples: [],
};
