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
import { batchLikeCasts, getUserCasts, lookupCast, getFollowersPage } from "../lib/neynarClient.js";
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
    "plus additional posts from followers of those authors (extra discovery " +
    "via follower network) to build network presence. " +
    "Respects daily budget (configurable via LIKER_MAX_DAILY, default 270), " +
    "per-batch limits (~22/batch), and rate limits (3-5s delay between likes). " +
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

      if (castUrls.length > 0) {
        // Pass full Warpcast URLs — lookupCast auto-detects and uses type=url
        const hashMap = await resolveShortHashes(config.apiKey, castUrls);

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
      // 8. Extra casts — fill remaining batch budget from followers of authors
      // ===================================================================
      const extraBudget = Math.max(0, batchBudget - scoutLiked);
      let extraLiked = 0;

      if (extraBudget > 0 && authorFids.length > 0) {
        elizaLogger.info(
          `[LIKE] Seeking extra casts — budget=${extraBudget}, ` +
          `${authorFids.length} author FIDs available`
        );

        const extraHashes = await getExtraCastHashes(
          config.apiKey,
          authorFids,
          config.extraCastsPerAuthor,
          likeState,
          extraBudget
        );

        if (extraHashes.length > 0) {
          const extraCount = Math.min(extraBudget, extraHashes.length);

          elizaLogger.info(
            `[LIKE] Liking extra casts — ${extraCount} of ${extraHashes.length} candidates`
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

          // Update state with extra likes
          for (const hash of extraResult.likedHashes) {
            recordLikedHash(likeState, hash);
          }
          likeState.dailyCount += extraLiked;

          totalLiked += extraLiked;
          totalFailed += extraResult.failed;
        } else {
          elizaLogger.info("[LIKE] No extra candidates found after filtering");
        }
      } else if (extraBudget > 0) {
        elizaLogger.info(
          `[LIKE] Cannot fetch extra casts — budget=${extraBudget} but no author FIDs available`
        );
      }

      // ===================================================================
      // 9. Finalize & persist state
      // ===================================================================
      likeState.batchNumber++;
      saveLikeState(likeState, config.likedStatePath);

      // ===================================================================
      // 10. Build result summary
      // ===================================================================
      const result: LikeCycleResult = {
        totalAttempted: scoutBudget + (extraBudget > 0 ? extraBudget : 0),
        totalLiked,
        totalFailed,
        scoutCastsLiked: scoutLiked,
        extraCastsLiked: extraLiked,
        dailyBudgetRemaining: getRemainingBudget(likeState, config.maxDailyLikes),
        batchBudgetUsed: totalLiked,
      };

      const duration = Date.now() - startTime;

      // --- Success log: prominent summary (easy to grep in docker logs) ---
      elizaLogger.success(
        `[LIKE] ===== ${totalLiked} posts liked ===== ` +
        `batch #${likeState.batchNumber}: ` +
        `scout=${scoutLiked}+extra=${extraLiked}, ` +
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
