// =============================================================================
// neynarClient.ts — Read-only Neynar REST wrappers (raw fetch, no SDK)
//
// Neynar API v2 base: https://api.neynar.com
// Docs: https://docs.neynar.com/reference/search-casts
//       https://docs.neynar.com/reference/fetch-casts-for-user
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { NeynarCast, NeynarSearchResponse, NeynarUserCastsResponse, NeynarNotification, NeynarNotificationsResponse } from "../types.js";

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
        `[NeynarDebug] searchCasts rate-limited for "${query}" — backing off 2s`
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
          `[NeynarDebug] searchCasts retry FAILED for "${query}": ${retry.status} after ${Date.now() - startTime}ms`
        );
        return [];
      }
      const data = (await retry.json()) as NeynarSearchResponse;
      const count = data?.result?.casts?.length ?? 0;
      elizaLogger.info(
        `[NeynarDebug] searchCasts "${query}" — ${count} casts, ${Date.now() - startTime}ms, ~${estimatedCost} credits (retry)`
      );
      return data?.result?.casts ?? [];
    }

    if (!res.ok) {
      elizaLogger.warn(
        `[NeynarDebug] searchCasts FAILED for "${query}": ${res.status} ${res.statusText} after ${duration}ms`
      );
      return [];
    }

    const data = (await res.json()) as NeynarSearchResponse;
    const count = data?.result?.casts?.length ?? 0;
    elizaLogger.info(
      `[NeynarDebug] searchCasts "${query}" — ${count} casts, ${duration}ms, ~${estimatedCost} credits`
    );

    return data?.result?.casts ?? [];
  } catch (err) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NeynarDebug] searchCasts ERROR for "${query}": ${err} after ${duration}ms`
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
        `[NeynarDebug] getUserCasts FAILED for fid=${fid}: ${res.status} ${res.statusText} after ${duration}ms`
      );
      return [];
    }

    const data = (await res.json()) as NeynarUserCastsResponse;
    const count = data?.casts?.length ?? 0;
    elizaLogger.info(
      `[NeynarDebug] getUserCasts fid=${fid} — ${count} casts, ${duration}ms, ~38 credits`
    );

    return data?.casts ?? [];
  } catch (err) {
    const duration = Date.now() - startTime;
    elizaLogger.warn(
      `[NeynarDebug] getUserCasts ERROR for fid=${fid}: ${err} after ${duration}ms`
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
  hash: string
): Promise<NeynarCast | null> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/cast`);
  url.searchParams.set("hash", hash);
  url.searchParams.set("type", "hash");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[neynar] lookupCast failed for hash=${hash}: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as { cast?: NeynarCast };
    return data?.cast ?? null;
  } catch (err) {
    console.warn(`[neynar] lookupCast error for hash=${hash}:`, err);
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
          `[NeynarDebug] lookupUserByHandle "${handle}": 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[NeynarDebug] lookupUserByHandle FAILED for "${handle}": ${res.status} ${res.statusText}`
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
      `[NeynarDebug] lookupUserByHandle "${handle}" → fid=${fid} (${follower_count.toLocaleString()} followers)`
    );

    return { fid, username, followerCount: follower_count };
  } catch (err) {
    elizaLogger.warn(
      `[NeynarDebug] lookupUserByHandle ERROR for "${handle}": ${err}`
    );
    return null;
  }
}

/**
 * Fetch recent notifications (replies, mentions, recasts) for a given FID.
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
          `[NeynarDebug] getNotifications: 402 — endpoint not available on current plan`
        );
      } else {
        elizaLogger.warn(
          `[NeynarDebug] getNotifications FAILED: ${res.status} ${res.statusText}`
        );
      }
      return [];
    }

    const data = (await res.json()) as NeynarNotificationsResponse;
    
    if (!data?.notifications?.length) {
      elizaLogger.info(
        `[NeynarDebug] getNotifications: No notifications for FID ${fid}`
      );
      return [];
    }

    // Convert raw notifications to our NeynarNotification type
    const notifications: NeynarNotification[] = data.notifications
      .filter((n: any) => ["reply", "recast", "mention"].includes(n.type))
      .map((n: any) => ({
        type: n.type as "reply" | "recast" | "mention",
        cast: n.cast as NeynarCast,
        parent_cast: n.parent_cast as NeynarCast | undefined,
      }));

    elizaLogger.info(
      `[NeynarDebug] getNotifications: ${notifications.length} actionable notifications for FID ${fid}`
    );

    return notifications;
  } catch (err) {
    elizaLogger.warn(
      `[NeynarDebug] getNotifications ERROR: ${err}`
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
    `[NeynarDebug] searchAllKeywords START — ${keywords.length} keywords, limit=${limitPerKeyword}, concurrency=${concurrency}`
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
    `[NeynarDebug] searchAllKeywords COMPLETE — ${all.length} unique casts from ${keywords.length} keywords, ` +
    `${totalDuration}ms total, ~${totalEstimatedCredits} credits consumed`
  );

  return all;
}
