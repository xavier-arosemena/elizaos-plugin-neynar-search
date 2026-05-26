// =============================================================================
// cache.ts — Simple JSON file-based cache with TTL for Neynar search results
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { elizaLogger } from "@elizaos/core";
import type { NeynarCast } from "../types.js";

const CACHE_DIR = path.resolve(process.cwd(), ".neynar-cache");
const CACHE_TTL_MS = 6.5 * 60 * 60 * 1000; // 6.5 hours (slightly > 6h cycle)

interface CacheEntry {
  timestamp: number;  // epoch ms
  ttlMs: number;
  keywords: string[]; // which keywords were searched
  results: NeynarCast[];
  version: number;    // bump to invalidate all caches on code changes
}

const CACHE_VERSION = 1;

function getCachePath(): string {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  return path.join(CACHE_DIR, "tier1-results.json");
}

/**
 * Load cached search results.
 * Returns null if cache is missing, expired, or version mismatch.
 */
export function loadCachedResults(): CacheEntry | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) {
      elizaLogger.log("[NeynarCache] No cache file found");
      return null;
    }

    const raw = fs.readFileSync(cachePath, "utf-8");
    const entry: CacheEntry = JSON.parse(raw);

    // Version mismatch → invalidate
    if (entry.version !== CACHE_VERSION) {
      elizaLogger.log("[NeynarCache] Cache version mismatch — invalidating");
      fs.unlinkSync(cachePath);
      return null;
    }

    // Expired?
    const age = Date.now() - entry.timestamp;
    if (age > entry.ttlMs) {
      elizaLogger.log(`[NeynarCache] Cache expired (age=${Math.round(age/1000/60)}m, ttl=${Math.round(entry.ttlMs/1000/60)}m)`);
      fs.unlinkSync(cachePath);
      return null;
    }

    elizaLogger.log(`[NeynarCache] Cache HIT — age=${Math.round(age/1000/60)}m, ${entry.results.length} casts, ${entry.keywords.length} keywords`);
    return entry;
  } catch (err) {
    elizaLogger.warn("[NeynarCache] Error loading cache: " + String(err));
    return null;
  }
}

/**
 * Save search results to cache with current timestamp.
 */
export function saveCachedResults(
  results: NeynarCast[],
  keywords: string[]
): void {
  try {
    const entry: CacheEntry = {
      timestamp: Date.now(),
      ttlMs: CACHE_TTL_MS,
      keywords,
      results,
      version: CACHE_VERSION,
    };

    fs.writeFileSync(getCachePath(), JSON.stringify(entry, null, 2), "utf-8");
    elizaLogger.log(`[NeynarCache] Cache SAVED — ${results.length} casts, expires in ${Math.round(CACHE_TTL_MS/1000/60)}m`);
  } catch (err) {
    elizaLogger.warn("[NeynarCache] Error saving cache: " + String(err));
  }
}

/**
 * Clear all cached data (force fresh search next cycle).
 */
export function clearCache(): void {
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      elizaLogger.log("[NeynarCache] Cache cleared");
    }
  } catch (err) {
    elizaLogger.warn("[NeynarCache] Error clearing cache: " + String(err));
  }
}
