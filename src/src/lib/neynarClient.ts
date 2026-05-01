// =============================================================================
// neynarClient.ts — Read-only Neynar REST wrappers (raw fetch, no SDK)
//
// Neynar API v2 base: https://api.neynar.com
// Docs: https://docs.neynar.com/reference/search-casts
//       https://docs.neynar.com/reference/fetch-casts-for-user
// =============================================================================

import type { NeynarCast, NeynarSearchResponse, NeynarUserCastsResponse } from "../types.js";

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
  limit = 25
): Promise<NeynarCast[]> {
  const url = new URL(`${NEYNAR_BASE}/v2/farcaster/cast/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(limit, 25)));
  url.searchParams.set("priority_mode", "false");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      // Rate-limited — back off 2s and retry once
      await sleep(2000);
      const retry = await fetch(url.toString(), {
        method: "GET",
        headers: neynarHeaders(apiKey),
        signal: AbortSignal.timeout(15_000),
      });
      if (!retry.ok) {
        console.warn(`[neynar] searchCasts retry failed for "${query}": ${retry.status}`);
        return [];
      }
      const data = (await retry.json()) as NeynarSearchResponse;
      return data?.result?.casts ?? [];
    }

    if (!res.ok) {
      console.warn(`[neynar] searchCasts failed for "${query}": ${res.status} ${res.statusText}`);
      return [];
    }

    const data = (await res.json()) as NeynarSearchResponse;
    return data?.result?.casts ?? [];
  } catch (err) {
    console.warn(`[neynar] searchCasts error for "${query}":`, err);
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

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: neynarHeaders(apiKey),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[neynar] getUserCasts failed for fid=${fid}: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = (await res.json()) as NeynarUserCastsResponse;
    return data?.casts ?? [];
  } catch (err) {
    console.warn(`[neynar] getUserCasts error for fid=${fid}:`, err);
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
  limitPerKeyword = 25,
  concurrency = 5
): Promise<NeynarCast[]> {
  const seen = new Set<string>();
  const all: NeynarCast[] = [];

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

  return all;
}
