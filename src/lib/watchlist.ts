// =============================================================================
// watchlist.ts — Auto-discovery watchlist for high-scoring Farcaster authors
//
// Purpose:
//   Tracks authors who consistently score high (>= 7/10) across multiple cycles
//   and auto-promotes them to Tier 2 profile monitoring. Creates a feedback loop
//   so the Scout doesn't forget interesting authors after a single keyword search.
//
// Flow:
//   1. After each scoring pass, updateWatchlist() is called with opportunities
//   2. New authors are added; existing authors have their scores accumulated
//   3. Authors with >= 3 appearances AND avg score >= 7 are auto-promoted
//   4. resolveMonitoredProfiles() merges static + auto-discovered FIDs for Tier 2
//
// Storage:
//   /app/.neynar-state/watchlist.json (same directory pattern as cycle state)
// =============================================================================

import * as fs from "fs";
import { elizaLogger } from "@elizaos/core";
import type { ScoredOpportunity } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchlistEntry {
  fid: number;
  handle: string;
  firstSeenAt: number;       // timestamp
  lastSeenAt: number;        // timestamp
  appearanceCount: number;   // how many cycles this author appeared
  cumulativeScore: number;   // sum of all scores (for avg calculation)
  avgScore: number;          // cumulativeScore / appearanceCount
  isMonitored: boolean;      // promoted to Tier 2?
  matchedKeywords: string[]; // which keywords matched
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WATCHLIST_PATH = "/app/.neynar-state/watchlist.json";

/** Minimum appearances before auto-promotion to Tier 2 */
const MIN_APPEARANCES_FOR_PROMOTION = 3;

/** Average score threshold for auto-promotion */
const PROMOTION_SCORE_THRESHOLD = 7;

/** Maximum number of auto-discovered monitored profiles */
const MAX_AUTO_MONITORED = 10;

/** If a monitored author's avg score drops below this, track for demotion */
const DEMOTION_SCORE_FLOOR = 5;

/** Consecutive cycles below floor before demotion */
const DEMOTION_CYCLES_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Read / Write helpers
// ---------------------------------------------------------------------------

function loadWatchlist(): WatchlistEntry[] {
  try {
    if (fs.existsSync(WATCHLIST_PATH)) {
      const raw = fs.readFileSync(WATCHLIST_PATH, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    elizaLogger.warn(
      `[watchlist] Could not load watchlist from ${WATCHLIST_PATH} — starting fresh: ${String(err)}`
    );
  }
  return [];
}

function saveWatchlist(entries: WatchlistEntry[]): void {
  try {
    const dir = WATCHLIST_PATH.substring(0, WATCHLIST_PATH.lastIndexOf("/"));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(entries, null, 2));
  } catch (err) {
    elizaLogger.error(`[watchlist] Failed to save watchlist: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Core update function
// ---------------------------------------------------------------------------

/**
 * Update the watchlist with scored opportunities from the latest cycle.
 *
 * - New authors: create a fresh entry
 * - Existing authors: increment appearance count, accumulate score, recalc avg
 * - Auto-promote to Tier 2 if criteria are met
 * - Demote monitored authors whose avg score has dropped below floor
 *
 * Call this AFTER scoring/ranking, BEFORE delivery.
 */
export async function updateWatchlist(opportunities: ScoredOpportunity[]): Promise<void> {
  if (!opportunities || opportunities.length === 0) {
    elizaLogger.info("[watchlist] No opportunities to track — skipping watchlist update");
    return;
  }

  const watchlist = loadWatchlist();
  const now = Date.now();
  let promotions = 0;
  let newEntries = 0;

  for (const op of opportunities) {
    const fid = op.author.fid;
    if (!fid) continue;

    const existing = watchlist.find((w) => w.fid === fid);

    if (existing) {
      // Update existing entry
      existing.appearanceCount++;
      existing.cumulativeScore += op.score;
      existing.lastSeenAt = now;
      existing.avgScore = existing.cumulativeScore / existing.appearanceCount;
      existing.matchedKeywords = [
        ...new Set([...existing.matchedKeywords, ...(op.matchedKeywords || [])]),
      ];

      // Auto-promote to Tier 2 if consistently high-scoring
      if (
        !existing.isMonitored &&
        existing.appearanceCount >= MIN_APPEARANCES_FOR_PROMOTION &&
        existing.avgScore >= PROMOTION_SCORE_THRESHOLD
      ) {
        const autoCount = watchlist.filter((w) => w.isMonitored).length;
        if (autoCount < MAX_AUTO_MONITORED) {
          existing.isMonitored = true;
          promotions++;
          elizaLogger.info(
            `[watchlist] @${op.author.username} FID:${fid} ` +
              `auto-promoted to Tier 2 (avg ${existing.avgScore.toFixed(1)}/10 ` +
              `over ${existing.appearanceCount} appearances)`
          );
        } else {
          elizaLogger.info(
            `[watchlist] @${op.author.username} FID:${fid} qualifies for promotion ` +
              `but ${MAX_AUTO_MONITORED} limit reached`
          );
        }
      }
    } else {
      // New author — create entry
      watchlist.push({
        fid,
        handle: op.author.username ?? `fid_${fid}`,
        firstSeenAt: now,
        lastSeenAt: now,
        appearanceCount: 1,
        cumulativeScore: op.score,
        avgScore: op.score,
        isMonitored: false,
        matchedKeywords: op.matchedKeywords ?? [],
      });
      newEntries++;
    }
  }

  // -----------------------------------------------------------------------
  // Demotion check: if a monitored author's avg score drops below floor
  // for DEMOTION_CYCLES_THRESHOLD consecutive cycles, demote them.
  // We track this via a 'consecutiveLowScoreCycles' field (ephemeral).
  // -----------------------------------------------------------------------
  for (const entry of watchlist) {
    if (entry.isMonitored) {
      // Read previous consecutiveLowScoreCycles from a hidden field, default 0
      const prevLow = (entry as any).__consecutiveLow ?? 0;

      if (entry.avgScore < DEMOTION_SCORE_FLOOR) {
        (entry as any).__consecutiveLow = prevLow + 1;

        if (prevLow + 1 >= DEMOTION_CYCLES_THRESHOLD) {
          entry.isMonitored = false;
          (entry as any).__consecutiveLow = 0;
          elizaLogger.info(
            `[watchlist] @${entry.handle} FID:${entry.fid} demoted from Tier 2 ` +
              `(avg ${entry.avgScore.toFixed(1)}/10 below ${DEMOTION_SCORE_FLOOR} for ` +
              `${DEMOTION_CYCLES_THRESHOLD} cycles)`
          );
        }
      } else {
        // Score recovered — reset counter
        (entry as any).__consecutiveLow = 0;
      }
    }
  }

  // Persist
  saveWatchlist(watchlist);

  const monitoredCount = watchlist.filter((w) => w.isMonitored).length;
  elizaLogger.info(
    `[watchlist] Updated: ${watchlist.length} total entries, ` +
      `${newEntries} new, ${promotions} promoted, ${monitoredCount} now monitored`
  );
}

/**
 * Get the list of auto-discovered monitored FIDs from the watchlist.
 * Used by resolveMonitoredProfiles() to merge with static FIDs.
 */
export function getAutoDiscoveredFids(): { fid: number; handle: string }[] {
  try {
    const watchlist = loadWatchlist();
    return watchlist
      .filter((w) => w.isMonitored)
      .map((w) => ({ fid: w.fid, handle: w.handle }));
  } catch {
    return [];
  }
}
