// =============================================================================
// likeState.ts — Persisted state tracking for LIKE_FARCASTER action
//
// Tracks liked cast hashes (perma-set to prevent duplicates), daily rolling
// counter (24h window), and batch numbering. Mirrors the cache.ts pattern.
//
// State file: /app/.neynar-state/like-state.json
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { elizaLogger } from "@elizaos/core";
import type { LikeState } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STATE_DIR = path.resolve(process.cwd(), ".neynar-state");
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "like-state.json");
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours in ms

// ---------------------------------------------------------------------------
// Default state factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh LikeState with default values.
 */
export function createDefaultLikeState(): LikeState {
  return {
    likedHashes: {},
    dailyCount: 0,
    windowStart: Date.now(),
    lastCycleAt: new Date().toISOString(),
    batchNumber: 0,
  };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the persisted LikeState from disk.
 * Returns a default state if the file doesn't exist or is corrupted.
 */
export function loadLikeState(statePath?: string): LikeState {
  const filePath = statePath || DEFAULT_STATE_FILE;

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as LikeState;

      // Validate required fields
      if (
        typeof parsed.likedHashes === "object" &&
        typeof parsed.dailyCount === "number" &&
        typeof parsed.windowStart === "number"
      ) {
        elizaLogger.debug(
          `[LIKE] State loaded from ${filePath} — ` +
          `dailyCount=${parsed.dailyCount}, ` +
          `totalHashes=${Object.keys(parsed.likedHashes).length}, ` +
          `batch=${parsed.batchNumber}`
        );
        return parsed;
      }

      elizaLogger.warn("[LIKE] State file has invalid structure — resetting to defaults");
    } else {
      elizaLogger.debug(`[LIKE] No state file at ${filePath} — starting fresh`);
    }
  } catch (err) {
    elizaLogger.warn(`[LIKE] Error loading state from ${filePath}: ${String(err)} — resetting`);
  }

  return createDefaultLikeState();
}

/**
 * Persist LikeState to disk.
 */
export function saveLikeState(state: LikeState, statePath?: string): void {
  const filePath = statePath || DEFAULT_STATE_FILE;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    state.lastCycleAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");

    elizaLogger.debug(
      `[LIKE] State saved to ${filePath} — ` +
      `${JSON.stringify(state).length} bytes`
    );
  } catch (err) {
    elizaLogger.error(`[LIKE] Failed to save state to ${filePath}: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

/**
 * Check if the rolling 24h window has expired and reset if needed.
 * Returns the (possibly updated) state.
 */
export function checkAndResetWindow(state: LikeState): LikeState {
  const elapsed = Date.now() - state.windowStart;

  if (elapsed >= WINDOW_MS) {
    const oldCount = state.dailyCount;
    state.dailyCount = 0;
    state.windowStart = Date.now();
    state.batchNumber = 0;

    elizaLogger.info(
      `[LIKE] Rolling window expired (${Math.round(elapsed / 1000 / 60 / 60)}h old) — ` +
      `reset dailyCount ${oldCount} → 0`
    );
  }

  return state;
}

/**
 * Check if the daily budget has room for more likes.
 */
export function isWithinBudget(state: LikeState, maxDaily: number): boolean {
  return state.dailyCount < maxDaily;
}

/**
 * Get the remaining budget for the current window.
 */
export function getRemainingBudget(state: LikeState, maxDaily: number): number {
  return Math.max(0, maxDaily - state.dailyCount);
}

/**
 * Get the current window age in hours.
 */
export function getWindowAgeHours(state: LikeState): number {
  return Math.round((Date.now() - state.windowStart) / 1000 / 60 / 60 * 10) / 10;
}

/**
 * Check if a cast hash has already been liked.
 */
export function isHashLiked(state: LikeState, hash: string): boolean {
  return hash in state.likedHashes;
}

/**
 * Record a liked cast hash with the current timestamp.
 */
export function recordLikedHash(state: LikeState, hash: string): void {
  state.likedHashes[hash] = Date.now();
}
