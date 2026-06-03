// =============================================================================
// neynarClient.ts — Neynar REST API wrappers (raw fetch, no SDK)
//
// Read operations: search, lookup, notifications
// Write operations: likes, direct casts (DMs)
//
// Neynar API v2 base: https://api.neynar.com
// Docs: https://docs.neynar.com/reference/search-casts
//       https://docs.neynar.com/reference/fetch-casts-for-user
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { NeynarCast, NeynarAuthor, NeynarSearchResponse, NeynarUserCastsResponse, NeynarNotification, NeynarNotificationsResponse } from "../types.js";

const NEYNAR_BASE = "https://api.neynar.com";

// Simple delay utility for rate-limit backoff
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build common Neynar request headers.
 */
function neynarHeaders(apiKey: string): Record<string, string> {
  return {
    "api_key": apiKey,
    "Accept": "application/json",
  };
}

/**
 * Search Farcaster casts matching `query`.
 *
 * GET /v2/farcaster/cast/search?q=QUERY&limit=LIMIT&priority_mode=true
 *
 * Returns an empty array on any error (resilience over completeness).
 */
export async function searchCasts(
  apiKey: string,
  query: string,
  limit = 10
): Promise<NeynarCast[]> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/cast/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  url.searchParams.set("priority_mode", "true");

  const startTime = Date.now();

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });

    const duration = Date.now() - startTime;
    const estimatedCost = 149; // ~149 credits per cast/search call

    if (res.status === 429) {
      elizaLogger.warn(
        `[NEYNAR-DEBUG] searchCasts rate-limited for "${query}" — backing off 2s`
      );
      // Rate-limited — back off 2s and retry once
      await sleep(2000);
      const retry = await fetch(url.toString(), {
        method: "GET",
        headers: neynarHeaders(apiKey),
        signal: AbortSignal.timeout(15_000),
      });
      if (!retry.ok) {
        elizaLogger.warn(
          `[NEYNAR-DEBUG] searchCasts retry FAILED for "${query}": ${retry.status} after ${Date.now() - startTime}ms`
        );
        return [];
      }
      const data = (await retry.json()) as NeynarSearchResponse;
      const count = data?.result?.casts?.length ?? 0;
      elizaLogger.info(
        `[NEYNAR-DEBUG] searchCasts "${query}" — ${count} casts, ${Date.now() - startTime}ms, ~${estimatedCost} credits (retry)`
      );
      return data?.result?.casts ?? [];
    }

    if (!res.ok) {
      elizaLogger.warn(
        `[NEYNAR-DEBUG] searchCasts FAILED for "${query}": ${res.status} ${res.statusText} after ${duration}ms`
      );
      return [];
    }

    const data = (await res.json()) as NeynarSearchResponse;
    const count = data?.result?.casts?.length ?? 0;
    elizaLogger.info(
      `[NEYNAR-DEBUG] searchCasts "${query}" — ${count} casts, ${duration}ms, ~${estimatedCost} credits`
    );

    return data?.result?.casts ?? [];
  } catch (err) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NEYNAR-DEBUG] searchCasts ERROR for "${query}": ${err} after ${duration}ms`
    );
    return [];
  }
}

/**
 * Fetch recent casts from a specific user by Farcaster ID (FID).
 *
 * GET /v2/farcaster/user/casts?fid=FID&limit=LIMIT
 *
 * Returns an empty array on any error.
 */
export async function getUserCasts(
  apiKey: string,
  fid: number,
  limit = 10
): Promise<NeynarCast[]> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/user/casts`);
  url.searchParams.set("fid", String(fid));
  url.searchParams.set("limit", String(Math.min(limit, 25)));

  const startTime = Date.now();

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });

    const duration = Date.now() - startTime;

    if (!res.ok) {
      elizaLogger.warn(
        `[NEYNAR-DEBUG] getUserCasts FAILED for fid=${fid}: ${res.status} ${res.statusText} after ${duration}ms`
      );
      return [];
    }

    const data = (await res.json()) as NeynarUserCastsResponse;
    const count = data?.casts?.length ?? 0;
    elizaLogger.info(
      `[NEYNAR-DEBUG] getUserCasts fid=${fid} — ${count} casts, ${duration}ms, ~38 credits`
    );

    return data?.casts ?? [];
  } catch (err) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NEYNAR-DEBUG] getUserCasts ERROR for fid=${fid}: ${err} after ${duration}ms`
    );
    return [];
  }
}
/**
 * Look up a single cast by its hash.
 *
 * GET /v2/farcaster/cast?hash=HASH&type=hash
 *
 * Returns null if the cast is not found or on any error.
 * Neynar docs: https://docs.neynar.com/reference/lookup-cast-by-hash-or-url
 */
export async function lookupCast(
  apiKey: string,
  identifier: string
): Promise<NeynarCast | null> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/cast`);

  // Auto-detect: if it looks like a URL (Warpcast link), use type=url
  // Otherwise, use type=hash (requires full 64-char hex hash)
  const isUrl = identifier.startsWith("http://") || identifier.startsWith("https://");
  url.searchParams.set("identifier", identifier);
  url.searchParams.set("type", isUrl ? "url" : "hash");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[NEYNAR] lookupCast failed for identifier=${identifier}: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as { cast?: NeynarCast };
    return data?.cast ?? null;
  } catch (err) {
    console.warn(`[NEYNAR] lookupCast error for identifier=${identifier}:`, err);
    return null;
  }
}

/**
 * Look up a Farcaster user by their @handle (username).
 *
 * GET /v2/farcaster/user/by-username?username=HANDLE
 *
 * Returns null if the user is not found or on any error.
 * Neynar docs: https://docs.neynar.com/reference/user-by-username
 */
export async function lookupUserByHandle(
  apiKey: string,
  handle: string
): Promise<{ fid: number; username: string; followerCount: number } | null> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/user/by-username`);
  url.searchParams.set("username", handle.replace("@", "").trim().toLowerCase());

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 402) {
        elizaLogger.info(
          `[NEYNAR-DEBUG] lookupUserByHandle "${handle}": 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[NEYNAR-DEBUG] lookupUserByHandle FAILED for "${handle}": ${res.status} ${res.statusText}`
        );
      }
      return null;
    }

    const data = (await res.json()) as {
      user?: { fid: number; username: string; follower_count: number };
    };
    if (!data?.user) return null;

    const { fid, username, follower_count } = data.user;
    elizaLogger.info(
      `[NEYNAR-DEBUG] lookupUserByHandle "${handle}" → fid=${fid} (${follower_count.toLocaleString()} followers)`
    );

    return { fid, username, followerCount: follower_count };
  } catch (err) {
    elizaLogger.warn(
      `[NEYNAR-DEBUG] lookupUserByHandle ERROR for "${handle}": ${err}`
    );
    return null;
  }
}

/**
 * Look up a Farcaster user by their FID (numeric ID).
 *
 * GET /v2/farcaster/user/bulk?fids=FID
 * Returns user profile with follower count, power badge, etc.
 * ~5 credits per call (estimated, shared with other bulk lookups).
 */
export async function lookupUserByFid(
  apiKey: string,
  fid: number
): Promise<NeynarAuthor | null> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/user/bulk`);
  url.searchParams.set("fids", String(fid));

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 402) {
        elizaLogger.info(
          `[DIRECT_CAST] lookupUserByFid fid=${fid}: 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[DIRECT_CAST] lookupUserByFid FAILED for fid=${fid}: ${res.status} ${res.statusText}`
        );
      }
      return null;
    }

    const data = (await res.json()) as {
      users?: Array<{
        fid: number;
        username: string;
        display_name?: string;
        follower_count: number;
        following_count?: number;
        power_badge?: boolean;
        profile?: { bio?: { text?: string } };
      }>;
    };

    if (!data?.users?.length) {
      elizaLogger.warn(
        `[DIRECT_CAST] lookupUserByFid fid=${fid}: user not found`
      );
      return null;
    }

    const u = data.users[0];
    elizaLogger.info(
      `[DIRECT_CAST] lookupUserByFid fid=${fid} → @${u.username} (${u.follower_count.toLocaleString()} followers, power=${!!u.power_badge})`
    );

    return {
      fid: u.fid,
      username: u.username,
      display_name: u.display_name,
      follower_count: u.follower_count,
      following_count: u.following_count,
      power_badge: u.power_badge,
      profile: u.profile,
    };
  } catch (err) {
    elizaLogger.warn(
      `[DIRECT_CAST] lookupUserByFid ERROR for fid=${fid}: ${err}`
    );
    return null;
  }
}

/**
 * Fetch recent notifications (replies, mentions, recasts, direct casts) for a given FID.
 *
 * GET /v2/farcaster/notifications?fid={fid}&limit={limit}
 * ~148 credits per call.
 */
export async function getNotifications(
  apiKey: string,
  fid: number,
  limit: number = 25
): Promise<NeynarNotification[]> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/notifications`);
  url.searchParams.set("fid", String(fid));
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 402) {
        elizaLogger.info(
          `[NEYNAR-DEBUG] getNotifications: 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[NEYNAR-DEBUG] getNotifications FAILED: ${res.status} ${res.statusText}`
        );
      }
      return [];
    }

    const data = (await res.json()) as NeynarNotificationsResponse;
    
    if (!data?.notifications?.length) {
      elizaLogger.info(
        `[NEYNAR-DEBUG] getNotifications: No notifications for FID ${fid}`
      );
      return [];
    }

    // Convert raw notifications to our NeynarNotification type
    // Includes direct_cast + follow types (2026-06-01: follow-back detection)
    const notifications: NeynarNotification[] = data.notifications
      .filter((n: any) => ["reply", "recast", "mention", "direct_cast", "follow"].includes(n.type))
      .map((n: any) => ({
        type: n.type as "reply" | "recast" | "mention" | "direct_cast" | "follow",
        cast: n.cast as NeynarCast,
        parent_cast: n.parent_cast as NeynarCast | undefined,
      }));

    const dmCount = notifications.filter((n) => n.type === "direct_cast").length;
    const followCount = notifications.filter((n) => n.type === "follow").length;
    elizaLogger.info(
      `[NEYNAR-DEBUG] getNotifications: ${notifications.length} actionable ` +
      `(${dmCount} DMs, ${followCount} follows) for FID ${fid}`
    );

    return notifications;
  } catch (err) {
    elizaLogger.warn(
      `[NEYNAR-DEBUG] getNotifications ERROR: ${err}`
    );
    return [];
  }
}

/**
 * Run up to `concurrency` keyword searches in parallel batches.
 * Returns deduplicated casts (by hash) across all keyword results.
 */
export async function searchAllKeywords(
  apiKey: string,
  keywords: string[],
  limitPerKeyword = 10,
  concurrency = 5
): Promise<NeynarCast[]> {
  const seen = new Set<string>();
  const all: NeynarCast[] = [];
  const totalStart = Date.now();

  elizaLogger.info(
    `[NEYNAR-DEBUG] searchAllKeywords START — ${keywords.length} keywords, limit=${limitPerKeyword}, concurrency=${concurrency}`
  );

  // Process keywords in chunks of `concurrency`
  for (let i = 0; i < keywords.length; i += concurrency) {
    const chunk = keywords.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map((kw) => searchCasts(apiKey, kw, limitPerKeyword))
    );
    for (const casts of results) {
      for (const cast of casts) {
        if (!seen.has(cast.hash)) {
          seen.add(cast.hash);
          all.push(cast);
        }
      }
    }
    // Small pause between batches to stay within rate limits
    if (i + concurrency < keywords.length) {
      await sleep(300);
    }
  }

  const totalDuration = Date.now() - totalStart;
  const totalEstimatedCredits = keywords.length * 149;

  elizaLogger.info(
    `[NEYNAR-DEBUG] searchAllKeywords COMPLETE — ${all.length} unique casts from ${keywords.length} keywords, ` +
    `${totalDuration}ms total, ~${totalEstimatedCredits} credits consumed`
  );

  return all;
}

// =============================================================================
// Write operations — LIKE / REACTION / DIRECT CAST endpoints
// =============================================================================

/**
 * Send a Direct Cast (DM) reply to a Farcaster user.
 *
 * POST /v2/farcaster/message
 * Body: { signer_uuid, recipient_fid, message }
 * ~5 credits per call (estimated).
 *
 * Returns the messageId on success, null on failure.
 */
export async function sendDirectCast(
  apiKey: string,
  signerUuid: string,
  recipientFid: number,
  message: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const url = `${NEYNAR_BASE}/v2/farcaster/message`;
  const startTime = Date.now();

  elizaLogger.info(
    `[DIRECT_CAST] sendDirectCast → fid=${recipientFid} — POST /v2/farcaster/message`
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "api_key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        recipient_fid: recipientFid,
        message,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const duration = Date.now() - startTime;

    if (res.ok) {
      const data = await res.json();
      const messageId = data?.result?.message?.hash || data?.message?.hash || "unknown";
      elizaLogger.success(
        `[DIRECT_CAST] sendDirectCast SUCCESS → fid=${recipientFid} — msgId=${messageId} (${duration}ms, ~5 credits)`
      );
      return { success: true, messageId };
    }

    if (res.status === 429) {
      elizaLogger.warn(
        `[DIRECT_CAST] sendDirectCast RATE-LIMITED → fid=${recipientFid} (${duration}ms) — will retry next cycle`
      );
      return { success: false, error: "rate_limited" };
    }

    elizaLogger.warn(
      `[DIRECT_CAST] sendDirectCast FAILED → fid=${recipientFid}: ${res.status} ${res.statusText} (${duration}ms)`
    );
    return { success: false, error: `${res.status} ${res.statusText}` };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[DIRECT_CAST] sendDirectCast ERROR → fid=${recipientFid}: ${err.message} (${duration}ms)`
    );
    return { success: false, error: err.message };
  }
}

/**
 * Like a single Farcaster cast by its hash.
 *
 * POST /v2/farcaster/reactions
 * Body: { signer_uuid, reaction_type: "like", target: castHash }
 * ~5 credits per call (estimated).
 *
 * Returns true on success (2xx), false on any error.
 * On 429 (rate-limited), backs off 2s and retries once.
 */
export async function likeCast(
  apiKey: string,
  signerUuid: string,
  castHash: string
): Promise<boolean> {
  const url = `${NEYNAR_BASE}/v2/farcaster/reaction`;
  const startTime = Date.now();

  elizaLogger.info(
    `[LIKE] likeCast hash=${castHash} — POST /v2/farcaster/reaction`
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "api_key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        reaction_type: "like",
        target: castHash,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const duration = Date.now() - startTime;

    if (res.status === 429) {
      elizaLogger.warn(
        `[LIKE] likeCast RATE-LIMITED hash=${castHash} — backing off 2s for retry`
      );
      await sleep(2000);

      const retry = await fetch(url, {
        method: "POST",
        headers: {
          "api_key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          signer_uuid: signerUuid,
          reaction_type: "like",
          target: castHash,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const retryDuration = Date.now() - startTime;

      if (retry.ok) {
        elizaLogger.success(
          `[LIKE] likeCast SUCCESS hash=${castHash} — status=${retry.status} (retry, ${retryDuration}ms, ~5 credits)`
        );
        return true;
      }

      elizaLogger.warn(
        `[LIKE] likeCast FAILED hash=${castHash} — ${retry.status} ${retry.statusText} (retry, ${retryDuration}ms)`
      );
      return false;
    }

    if (res.ok) {
      elizaLogger.success(
        `[LIKE] likeCast SUCCESS hash=${castHash} — status=${res.status} (${duration}ms, ~5 credits)`
      );
      return true;
    }

    elizaLogger.warn(
      `[LIKE] likeCast FAILED hash=${castHash} — ${res.status} ${res.statusText} (${duration}ms)`
    );
    return false;
  } catch (err: any) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[LIKE] likeCast ERROR hash=${castHash} — ${err.message} (${duration}ms)`
    );
    return false;
  }
}

/**
 * Like multiple Farcaster casts with randomized delay between each.
 *
 * Iterates through `castHashes` in order, calling likeCast() for each
 * with a randomized delay of `minDelayMs`–`maxDelayMs` between calls.
 * Stops early if `maxCount` likes have been attempted.
 *
 * Returns a summary with counts and the list of successfully liked hashes.
 */
export async function batchLikeCasts(
  apiKey: string,
  signerUuid: string,
  castHashes: string[],
  minDelayMs: number = 3000,
  maxDelayMs: number = 5000,
  maxCount: number = 50
): Promise<{ liked: number; failed: number; likedHashes: string[] }> {
  const startTime = Date.now();
  const targets = castHashes.slice(0, maxCount);

  elizaLogger.info(
    `[LIKE] batchLikeCasts START — ${targets.length} targets (of ${castHashes.length} available), ` +
    `max=${maxCount}, delay=${minDelayMs}-${maxDelayMs}ms`
  );

  let liked = 0;
  let failed = 0;
  const likedHashes: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const hash = targets[i];
    const success = await likeCast(apiKey, signerUuid, hash);

    if (success) {
      liked++;
      likedHashes.push(hash);
    } else {
      failed++;
    }

    // Randomized delay between calls (not after the last one)
    if (i < targets.length - 1) {
      const delay = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
      elizaLogger.debug(
        `[LIKE] batchLikeCasts progress — ${i + 1}/${targets.length} processed, ` +
        `liked=${liked} failed=${failed}, next delay=${delay}ms`
      );
      await sleep(delay);
    }
  }

  const totalDuration = Date.now() - startTime;
  elizaLogger.success(
    `[LIKE] batchLikeCasts COMPLETE — liked=${liked} failed=${failed} ` +
    `(${totalDuration}ms, avg ${Math.round(totalDuration / targets.length)}ms/cast)`
  );

  return { liked, failed, likedHashes };
}

// =============================================================================
// Conversation / Replies — for commenter discovery (Issue #8 Wider Liking)
// =============================================================================

/**
 * Fetch a cast with its conversation context (replies/commenters).
 *
 * GET /v2/farcaster/cast/conversation
 * Parameters: cast_hash (required), reply_depth (default 1), limit (default 25)
 *
 * Returns the cast with its direct replies, which allows extraction of
 * commenter FIDs for the commenter discovery layer.
 * ~5-10 credits per call (estimated).
 */
export async function getCastConversation(
  apiKey: string,
  castHash: string,
  replyDepth: number = 1,
  limit: number = 25
): Promise<{ cast: NeynarCast | null; replies: NeynarCast[] }> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/cast/conversation`);
  url.searchParams.set("cast_hash", castHash);
  url.searchParams.set("reply_depth", String(replyDepth));
  url.searchParams.set("limit", String(limit));

  const startTime = Date.now();

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    const duration = Date.now() - startTime;

    if (!res.ok) {
      if (res.status === 402) {
        elizaLogger.info(
          `[NEYNAR-DEBUG] getCastConversation: 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[NEYNAR-DEBUG] getCastConversation FAILED for ${castHash.slice(0, 14)}...: ${res.status} ${res.statusText} (${duration}ms)`
        );
      }
      return { cast: null, replies: [] };
    }

    const data = (await res.json()) as {
      conversation?: {
        cast?: NeynarCast;
        replies?: {
          count?: number;
          casts?: NeynarCast[];
        };
      };
    };

    const cast = data?.conversation?.cast ?? null;
    const replies = data?.conversation?.replies?.casts ?? [];

    elizaLogger.info(
      `[NEYNAR-DEBUG] getCastConversation: ${castHash.slice(0, 14)}... — ` +
      `${replies.length} replies, ${duration}ms, ~5-10 credits`
    );

    return { cast, replies };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NEYNAR-DEBUG] getCastConversation ERROR for ${castHash.slice(0, 14)}...: ${err.message} (${duration}ms)`
    );
    return { cast: null, replies: [] };
  }
}

// =============================================================================
// Follow / Unfollow API wrappers
// =============================================================================

/**
 * Follow one or more Farcaster users by their FIDs.
 *
 * POST /v2/farcaster/follows
 * Body: { signer_uuid, target_fids: [FID1, FID2, ...] }
 * ~5 credits per call (estimated).
 *
 * Returns a summary with successfully followed FIDs and any errors.
 */
export async function followUsers(
  apiKey: string,
  signerUuid: string,
  targetFids: number[]
): Promise<{ success: boolean; followed: number[]; errors: { fid: number; reason: string }[] }> {
  const url = `${NEYNAR_BASE}/v2/farcaster/follows`;
  const startTime = Date.now();

  elizaLogger.info(
    `[NEYNAR-DEBUG] followUsers: POST /v2/farcaster/follows — targetFids=[${targetFids.join(", ")}]`
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "api_key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        target_fids: targetFids,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const duration = Date.now() - startTime;

    if (res.ok) {
      elizaLogger.success(
        `[NEYNAR-DEBUG] followUsers SUCCESS — followed ${targetFids.length} users (${duration}ms, ~5 credits)`
      );
      return { success: true, followed: [...targetFids], errors: [] };
    }

    if (res.status === 429) {
      elizaLogger.warn(
        `[NEYNAR-DEBUG] followUsers RATE-LIMITED — ${duration}ms — will retry next cycle`
      );
      return { success: false, followed: [], errors: targetFids.map(fid => ({ fid, reason: "rate_limited" })) };
    }

    elizaLogger.warn(
      `[NEYNAR-DEBUG] followUsers FAILED — ${res.status} ${res.statusText} (${duration}ms)`
    );
    return { success: false, followed: [], errors: targetFids.map(fid => ({ fid, reason: `${res.status} ${res.statusText}` })) };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NEYNAR-DEBUG] followUsers ERROR — ${err.message} (${duration}ms)`
    );
    return { success: false, followed: [], errors: targetFids.map(fid => ({ fid, reason: err.message })) };
  }
}

/**
 * Unfollow one or more Farcaster users by their FIDs.
 *
 * DELETE /v2/farcaster/follows
 * Body: { signer_uuid, target_fids: [FID1, FID2, ...] }
 * ~5 credits per call (estimated).
 *
 * Returns a summary with successfully unfollowed FIDs and any errors.
 */
export async function unfollowUsers(
  apiKey: string,
  signerUuid: string,
  targetFids: number[]
): Promise<{ success: boolean; unfollowed: number[]; errors: { fid: number; reason: string }[] }> {
  const url = `${NEYNAR_BASE}/v2/farcaster/follows`;
  const startTime = Date.now();

  elizaLogger.info(
    `[NEYNAR-DEBUG] unfollowUsers: DELETE /v2/farcaster/follows — targetFids=[${targetFids.join(", ")}]`
  );

  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "api_key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        target_fids: targetFids,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const duration = Date.now() - startTime;

    if (res.ok) {
      elizaLogger.success(
        `[NEYNAR-DEBUG] unfollowUsers SUCCESS — unfollowed ${targetFids.length} users (${duration}ms, ~5 credits)`
      );
      return { success: true, unfollowed: [...targetFids], errors: [] };
    }

    if (res.status === 429) {
      elizaLogger.warn(
        `[NEYNAR-DEBUG] unfollowUsers RATE-LIMITED — ${duration}ms — will retry next cycle`
      );
      return { success: false, unfollowed: [], errors: targetFids.map(fid => ({ fid, reason: "rate_limited" })) };
    }

    elizaLogger.warn(
      `[NEYNAR-DEBUG] unfollowUsers FAILED — ${res.status} ${res.statusText} (${duration}ms)`
    );
    return { success: false, unfollowed: [], errors: targetFids.map(fid => ({ fid, reason: `${res.status} ${res.statusText}` })) };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NEYNAR-DEBUG] unfollowUsers ERROR — ${err.message} (${duration}ms)`
    );
    return { success: false, unfollowed: [], errors: targetFids.map(fid => ({ fid, reason: err.message })) };
  }
}

/**
 * Get one page of followers for a given FID (staggered pagination).
 *
 * GET /v2/farcaster/followers?fid={fid}&limit={limit}
 * Optionally pass a cursor for pagination.
 * ~5 credits per call (estimated).
 *
 * Returns the follower FIDs from this page and the next cursor (null if last page).
 */
export async function getFollowersPage(
  apiKey: string,
  fid: number,
  limit: number = 150,
  cursor?: string | null
): Promise<{ fids: number[]; nextCursor: string | null }> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/followers`);
  url.searchParams.set("fid", String(fid));
  url.searchParams.set("limit", String(limit));
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const startTime = Date.now();

  elizaLogger.info(
    `[NEYNAR-DEBUG] getFollowersPage: fid=${fid} limit=${limit} cursor=${cursor || "null"}`
  );

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    const duration = Date.now() - startTime;

    if (!res.ok) {
      if (res.status === 402) {
        elizaLogger.info(
          `[NEYNAR-DEBUG] getFollowersPage: 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[NEYNAR-DEBUG] getFollowersPage FAILED for fid=${fid}: ${res.status} ${res.statusText} (${duration}ms)`
        );
      }
      return { fids: [], nextCursor: null };
    }

    const data = (await res.json()) as {
      users?: Array<{ fid: number }>;
      next?: { cursor?: string };
    };

    const fids = (data?.users || []).map((u: any) => u.fid || u.user?.fid).filter(Boolean);
    const nextCursor = data?.next?.cursor || null;

    elizaLogger.info(
      `[NEYNAR-DEBUG] getFollowersPage: ${fids.length} FIDs, hasMore=${nextCursor !== null} (${duration}ms, ~5 credits)`
    );

    return { fids, nextCursor };
  } catch (err: any) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NEYNAR-DEBUG] getFollowersPage ERROR for fid=${fid}: ${err.message} (${duration}ms)`
    );
    return { fids: [], nextCursor: null };
  }
}
