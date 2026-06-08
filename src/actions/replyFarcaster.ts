// =============================================================================
// replyFarcaster.ts — REPLY_FARCASTER ElizaOS Action
//
// Processes [REPLY_CANDIDATE] and optionally [QUOTE_CANDIDATE] items from
// Scout deliveries stored in Archon's message memory, generates context-aware
// public replies via LLM, and posts them via Neynar API.
//
// Flow:
//   1. Build ReplyConfig from runtime settings
//   2. Load ReplyState from disk, reset daily counters if new day
//   3. Check daily budget — if exhausted, return early
//   4. Read Scout deliveries from Archon memory (same as LIKE_FARCASTER)
//   5. Parse [REPLY_CANDIDATE] items + optional [QUOTE_CANDIDATE] from shared queue
//   6. Merge with pending queue from state
//   7. For each target (up to maxPerCycle):
//      a. Generate reply text via runtime.completion() with context-aware prompt
//      b. Post reply via replyToCast() API
//      c. Update state (dedup, daily counter)
//   8. Defer remaining targets to pendingQueue
//   9. Persist state and return formatted results via callback
//
// Logging: All reply-related logs use [REPLY] prefix for grep filtering.
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger, generateText, ModelClass } from "@elizaos/core";
import * as fs from "fs";
import * as path from "path";
import { replyToCast } from "../lib/neynarClient.js";
import type { ReplyConfig, ReplyTarget, ReplyState, ReplyCycleResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY_REPLIES = 5;
const DEFAULT_MAX_PER_CYCLE = 2;
const DEFAULT_MIN_DELAY_MS = 3000;
const DEFAULT_MAX_DELAY_MS = 8000;
const DEFAULT_MIN_SCORE_THRESHOLD = 0;
const DEFAULT_INCLUDE_QUOTED_ITEMS = true;
const MAX_MEMORIES_TO_SCAN = 200;
const MAX_PENDING_QUEUE_SIZE = 50;
const DEDUP_ARRAY_MAX = 500;

/** Path to the shared reply queue file (written by farcaster_quote_cycle.sh) */
const DEFAULT_REPLY_QUEUE_PATH = "/root/agents-ecosystem/engine/data/reply_queue.json";

/** Path to the reply state file */
const DEFAULT_REPLY_STATE_PATH = "/root/agents-ecosystem/engine/data/reply_state.json";

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

/**
 * Build a ReplyConfig from the agent runtime settings.
 * Every value can be overridden via character.json secrets / env vars.
 * Expected env vars (exported by social-intensity.sh):
 *   FARCASTER_REPLY_MAX_PER_DAY
 *   FARCASTER_REPLY_MAX_PER_CYCLE
 *   FARCASTER_REPLY_INCLUDE_QUOTED
 */
function createReplyConfig(runtime: IAgentRuntime): ReplyConfig {
  return {
    apiKey: runtime.getSetting("FARCASTER_NEYNAR_API_KEY") || "",
    signerUuid: runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID") || "",
    maxDailyReplies:
      Number(runtime.getSetting("FARCASTER_REPLY_MAX_PER_DAY")) || DEFAULT_MAX_DAILY_REPLIES,
    maxPerCycle:
      Number(runtime.getSetting("FARCASTER_REPLY_MAX_PER_CYCLE")) || DEFAULT_MAX_PER_CYCLE,
    minDelayMs:
      Number(runtime.getSetting("FARCASTER_REPLY_MIN_DELAY_MS")) || DEFAULT_MIN_DELAY_MS,
    maxDelayMs:
      Number(runtime.getSetting("FARCASTER_REPLY_MAX_DELAY_MS")) || DEFAULT_MAX_DELAY_MS,
    minScoreThreshold:
      Number(runtime.getSetting("FARCASTER_REPLY_MIN_SCORE")) || DEFAULT_MIN_SCORE_THRESHOLD,
    includeQuotedItems:
      runtime.getSetting("FARCASTER_REPLY_INCLUDE_QUOTED") !== "false"
        ? true
        : DEFAULT_INCLUDE_QUOTED_ITEMS,
    replyStatePath:
      runtime.getSetting("FARCASTER_REPLY_STATE_PATH") || DEFAULT_REPLY_STATE_PATH,
    replyQueuePath:
      runtime.getSetting("FARCASTER_REPLY_QUEUE_PATH") || DEFAULT_REPLY_QUEUE_PATH,
  };
}

// ---------------------------------------------------------------------------
// State Persistence
// ---------------------------------------------------------------------------

/**
 * Load ReplyState from disk. Returns a default state if the file doesn't exist.
 */
function loadReplyState(replyStatePath: string): ReplyState {
  try {
    if (fs.existsSync(replyStatePath)) {
      const raw = fs.readFileSync(replyStatePath, "utf-8");
      const parsed = JSON.parse(raw) as ReplyState;
      elizaLogger.info(
        `[REPLY] State loaded from ${replyStatePath} — dailyCount=${parsed.dailyCount}, ` +
        `${parsed.repliedHashes.length} replied hashes, ${parsed.pendingQueue.length} pending`
      );
      return parsed;
    }
  } catch (err) {
    elizaLogger.warn(`[REPLY] Could not load state from ${replyStatePath}: ${String(err)}`);
  }
  elizaLogger.info("[REPLY] No existing state found — starting fresh");
  return {
    repliedHashes: [],
    dailyCount: 0,
    dailyDate: "",
    pendingQueue: [],
    lastCycleAt: "",
  };
}

/**
 * Save ReplyState to disk as JSON.
 */
function saveReplyState(replyStatePath: string, state: ReplyState): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(replyStatePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Trim dedup arrays to prevent unbounded growth
    if (state.repliedHashes.length > DEDUP_ARRAY_MAX) {
      state.repliedHashes = state.repliedHashes.slice(-DEDUP_ARRAY_MAX);
    }
    // Trim pending queue
    if (state.pendingQueue.length > MAX_PENDING_QUEUE_SIZE) {
      state.pendingQueue = state.pendingQueue.slice(-MAX_PENDING_QUEUE_SIZE);
    }
    fs.writeFileSync(replyStatePath, JSON.stringify(state, null, 2), "utf-8");
    elizaLogger.debug(
      `[REPLY] State saved to ${replyStatePath} — dailyCount=${state.dailyCount}, ` +
      `${state.repliedHashes.length} replied hashes, ${state.pendingQueue.length} pending`
    );
  } catch (err) {
    elizaLogger.warn(`[REPLY] Could not save state to ${replyStatePath}: ${String(err)}`);
  }
}

/**
 * Check if the daily counter needs resetting (new calendar day).
 */
function maybeResetDaily(state: ReplyState): ReplyState {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (state.dailyDate !== today) {
    elizaLogger.info(
      `[REPLY] Daily reset — previous date=${state.dailyDate || "none"}, ` +
      `new date=${today}, previous count=${state.dailyCount}`
    );
    state.dailyCount = 0;
    state.dailyDate = today;
  }
  return state;
}

/**
 * Check if we are within the daily reply budget.
 */
function isWithinBudget(state: ReplyState, maxDaily: number): boolean {
  return state.dailyCount < maxDaily;
}

/**
 * Get remaining daily reply budget.
 */
function getRemainingBudget(state: ReplyState, maxDaily: number): number {
  return Math.max(0, maxDaily - state.dailyCount);
}

/**
 * Check if a cast hash has already been replied to.
 */
function isAlreadyReplied(state: ReplyState, castHash: string): boolean {
  return state.repliedHashes.includes(castHash);
}

/**
 * Record a cast hash as replied (dedup).
 */
function recordRepliedHash(state: ReplyState, castHash: string): void {
  if (!state.repliedHashes.includes(castHash)) {
    state.repliedHashes.push(castHash);
  }
}

// ---------------------------------------------------------------------------
// Scout Delivery Parser
// ---------------------------------------------------------------------------

/**
 * Parse [REPLY_CANDIDATE] and [QUOTE_CANDIDATE] items from Scout delivery texts.
 *
 * Scout delivery format (per item):
 *   1. SCORE 8.5/10 [PRIORITY] — @username
 *      [QUOTE_CANDIDATE] or [REPLY_CANDIDATE]
 *      URL: https://warpcast.com/username/0x1234abcd
 *      Reach: ...
 *      Engagement: ...
 *      Keywords: ...
 *      Angle: Suggested angle text here
 */
function parseReplyTargetsFromDeliveries(
  deliveries: string[],
  includeQuotedItems: boolean,
  alreadyRepliedHashes: Set<string>
): ReplyTarget[] {
  const targets: ReplyTarget[] = [];
  const seenHashes = new Set<string>();

  // Regex patterns
  const scoreRegex = /SCORE\s+(\d+(?:\.\d+)?)\/10/;
  const candidateTagRegex = /\[(QUOTE_CANDIDATE|REPLY_CANDIDATE)\]/;
  const urlRegex = /https:\/\/warpcast\.com\/[\w.-]+\/(\w+)/;
  const angleRegex = /Angle:\s*(.+)/;
  const handleRegex = /@([\w.-]+)/;

  for (const delivery of deliveries) {
    // Split delivery into lines
    const lines = delivery.split("\n");

    let currentTarget: Partial<ReplyTarget> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Detect start of a new item: "N. SCORE X/10 [PRIORITY?] — @username"
      const scoreMatch = line.match(scoreRegex);
      if (scoreMatch) {
        // If we were accumulating a target, add it
        if (currentTarget && currentTarget.castHash) {
          finalizeTarget(currentTarget, targets, includeQuotedItems, seenHashes, alreadyRepliedHashes);
        }

        // Extract handle
        const handleMatch = line.match(handleRegex);

        currentTarget = {
          score: parseFloat(scoreMatch[1]),
          authorHandle: handleMatch ? handleMatch[1] : "unknown",
          context: "n/a",
          originalText: "n/a",
        };

        // Look ahead at the next line for the candidate tag
        if (i + 1 < lines.length) {
          const tagLine = lines[i + 1].trim();
          const tagMatch = tagLine.match(candidateTagRegex);
          if (tagMatch) {
            // Map [QUOTE_CANDIDATE] from Scout delivery to QUOTE_CANDIDATE_EXTRA
            // since we're now processing it as a reply target
            const rawTag = tagMatch[1];
            currentTarget.sourceTag = rawTag === "QUOTE_CANDIDATE"
              ? "QUOTE_CANDIDATE_EXTRA"
              : "REPLY_CANDIDATE";
          }
        }

        continue;
      }

      // Detect URL line
      if (currentTarget && !currentTarget.castUrl) {
        const urlMatch = line.match(urlRegex);
        if (urlMatch) {
          currentTarget.castUrl = line; // Full URL
          currentTarget.castHash = urlMatch[1]; // Short hash (0x-prefixed)
          // Prepend "0x" if needed (Neynar uses full hashes)
          if (!currentTarget.castHash.startsWith("0x")) {
            currentTarget.castHash = "0x" + currentTarget.castHash;
          }
        }
      }

      // Detect Angle line
      if (currentTarget) {
        const angleMatch = line.match(angleRegex);
        if (angleMatch) {
          currentTarget.context = angleMatch[1].trim();
        }
      }
    }

    // Finalize last target in this delivery
    if (currentTarget && currentTarget.castHash) {
      finalizeTarget(currentTarget, targets, includeQuotedItems, seenHashes, alreadyRepliedHashes);
    }
  }

  elizaLogger.info(
    `[REPLY] Parsed ${targets.length} reply targets from Scout deliveries ` +
    `(includeQuotedItems=${includeQuotedItems})`
  );

  return targets;
}

/**
 * Finalize a partially-parsed target, adding it to the list if it passes filters.
 */
function finalizeTarget(
  current: Partial<ReplyTarget>,
  targets: ReplyTarget[],
  includeQuotedItems: boolean,
  seenHashes: Set<string>,
  alreadyRepliedHashes: Set<string>
): void {
  if (!current.castHash || !current.castUrl) return;

  // Filter by source tag — we map QUOTE_CANDIDATE → QUOTE_CANDIDATE_EXTRA in the parser,
  // so check against the mapped value
  if (current.sourceTag === "QUOTE_CANDIDATE_EXTRA" && !includeQuotedItems) return;

  // Dedup within this parse batch
  if (seenHashes.has(current.castHash)) return;
  seenHashes.add(current.castHash);

  // Dedup against already-replied hashes
  if (alreadyRepliedHashes.has(current.castHash)) return;

  targets.push({
    castHash: current.castHash,
    castUrl: current.castUrl,
    authorHandle: current.authorHandle || "unknown",
    authorFid: current.authorFid || 0,
    originalText: current.originalText || "n/a",
    context: current.context || "n/a",
    score: current.score || 0,
    sourceTag: (current.sourceTag as "REPLY_CANDIDATE" | "QUOTE_CANDIDATE_EXTRA") || "REPLY_CANDIDATE",
  });
}

// ---------------------------------------------------------------------------
// Shared Reply Queue (written by farcaster_quote_cycle.sh)
// ---------------------------------------------------------------------------

/**
 * Read the shared reply queue file (JSON array of cast hashes).
 * Written by farcaster_quote_cycle.sh after posting a quote cast.
 */
function readReplyQueue(queuePath: string): string[] {
  try {
    if (fs.existsSync(queuePath)) {
      const raw = fs.readFileSync(queuePath, "utf-8");
      const hashes = JSON.parse(raw) as string[];
      elizaLogger.info(
        `[REPLY] Shared reply queue read from ${queuePath} — ${hashes.length} hashes queued`
      );
      return hashes;
    }
  } catch (err) {
    elizaLogger.warn(`[REPLY] Could not read shared reply queue ${queuePath}: ${String(err)}`);
  }
  return [];
}

/**
 * Clear the shared reply queue file (after processing).
 */
function clearReplyQueue(queuePath: string): void {
  try {
    fs.writeFileSync(queuePath, "[]", "utf-8");
    elizaLogger.debug(`[REPLY] Shared reply queue cleared: ${queuePath}`);
  } catch (err) {
    elizaLogger.warn(`[REPLY] Could not clear shared reply queue: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Scout Delivery Reader (same pattern as LIKE_FARCASTER)
// ---------------------------------------------------------------------------

/**
 * Read Scout delivery texts from Archon's message memory.
 * Identical pattern to likeFarcaster.ts getScoutDeliveries().
 */
async function getScoutDeliveries(runtime: IAgentRuntime): Promise<string[]> {
  const deliveries: string[] = [];

  try {
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
        `[REPLY] Scout deliveries found — ${deliveries.length} delivery memories ` +
        `from ${memories.length} total in room ${runtime.agentId}`
      );
    } else {
      elizaLogger.info(
        "[REPLY] No memories returned from getMemories — trying getMemoriesWithoutEmbedding fallback"
      );
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
          `[REPLY] Scout deliveries found via fallback — ${deliveries.length} of ${flat.length} memories`
        );
      } else {
        elizaLogger.warn("[REPLY] No memories found in any query path");
      }
    }
  } catch (err) {
    elizaLogger.warn(`[REPLY] Error reading Scout deliveries: ${String(err)}`);
  }

  return deliveries;
}

// ---------------------------------------------------------------------------
// Reply Generation via LLM
// ---------------------------------------------------------------------------

/**
 * Generate a reply text for a given target using the agent's LLM.
 *
 * The prompt provides:
 * - The original cast text
 * - The suggested angle from Scout
 * - The author handle (for natural addressing)
 * - Anti-ban instructions for content variety
 */
async function generateReplyText(
  runtime: IAgentRuntime,
  target: ReplyTarget
): Promise<string> {
  const prompt = `You are Archon, a thoughtful analyst engaging in Farcaster conversations.

You are replying to a cast by @${target.authorHandle}.

ORIGINAL CAST CONTEXT:
${target.originalText}

SUGGESTED ANGLE (from Scout):
${target.context}

INSTRUCTIONS:
- Write a SINGLE short reply (1-3 sentences, max 280 characters).
- Be conversational, analytical, and add value to the discussion.
- Reference specific data points or arguments from the original cast.
- Do NOT use hashtags.
- Do NOT sound like a bot or use formulaic phrases.
- Vary your tone between analytical and conversational across different replies.
- Do NOT mention that you are an AI or Archon.

Reply with ONLY the reply text, no additional commentary:`;

  try {
    // Use generateText() to generate via the agent's LLM
    const response = await generateText({
      runtime,
      context: prompt,
      stop: [], // Let the model decide when to stop
      modelClass: ModelClass.LARGE, // Use the most capable model available
    });

    // Extract and clean the response text
    let replyText = (response || "").trim();

    // Fallback in case of empty response
    if (!replyText) {
      elizaLogger.warn(
        `[REPLY] Empty LLM response for ${target.castHash.slice(0, 14)}... — using fallback`
      );
      replyText = `Interesting perspective from @${target.authorHandle}. The data around ${target.context.split(" ").slice(0, 5).join(" ")} is worth deeper analysis.`;
    }

    // Truncate if somehow too long
    if (replyText.length > 320) {
      replyText = replyText.slice(0, 317) + "...";
    }

    elizaLogger.debug(
      `[REPLY] Generated reply for ${target.castHash.slice(0, 14)}... — ` +
      `${replyText.length} chars, preview="${replyText.slice(0, 80)}..."`
    );

    return replyText;
  } catch (err) {
    elizaLogger.warn(
      `[REPLY] LLM generation error for ${target.castHash.slice(0, 14)}...: ${String(err)}`
    );
    // Fallback reply
    return `Interesting point from @${target.authorHandle}. Would be valuable to see how this develops further.`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sleep for a random duration between minMs and maxMs.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get a random integer between min and max (inclusive).
 */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Format the cycle result into a human-readable text for the callback.
 */
function formatCycleResult(result: ReplyCycleResult): string {
  return (
    `[REPLY] Cycle complete. ` +
    `Replied: ${result.replied}. ` +
    `Failed: ${result.failed}. ` +
    `Skipped: ${result.skipped}. ` +
    `Daily: ${result.dailyCount}/${result.dailyLimit}. ` +
    `Pending: ${result.pendingRemaining}.`
  );
}

// ---------------------------------------------------------------------------
// REPLY_FARCASTER Action
// ---------------------------------------------------------------------------

export const replyFarcasterAction: Action = {
  name: "REPLY_FARCASTER",

  similes: [
    "REPLY_CASTS",
    "COMMENT_ON_CASTS",
    "PUBLIC_REPLY",
    "ENGAGE_REPLIES",
    "RUN_REPLY_CYCLE",
    "REPLY_SCOUT_POSTS",
  ],

  description:
    "Generate and post public replies on Farcaster casts identified by " +
    "The Scout's discovery queue. Processes [REPLY_CANDIDATE] items (score < 8) " +
    "and optionally [QUOTE_CANDIDATE] items (score >= 8) for extra engagement. " +
    "Respects daily reply limits (default 5/day for beginner plan), " +
    "per-cycle limits (default 2), and randomized 3-8s delays between replies. " +
    "Tracks replied hashes durably to avoid duplicates. " +
    "Uses Archon's LLM to generate context-aware replies based on the original " +
    "cast text and the Scout's suggested angle.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID");
    if (!apiKey || !signerUuid) {
      elizaLogger.warn(
        "[REPLY] FARCASTER_NEYNAR_API_KEY or FARCASTER_NEYNAR_SIGNER_UUID not set — REPLY_FARCASTER disabled"
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
      const config = createReplyConfig(runtime);

      if (!config.apiKey || !config.signerUuid) {
        const errMsg = "[REPLY] ERROR: API key or signer UUID not configured. Cycle aborted.";
        elizaLogger.error(errMsg);
        callback({ text: errMsg });
        return false;
      }

      elizaLogger.info(
        `[REPLY] REPLY_FARCASTER handler START — ${timestamp}, ` +
        `maxDaily=${config.maxDailyReplies}, maxPerCycle=${config.maxPerCycle}, ` +
        `delay=${config.minDelayMs}-${config.maxDelayMs}ms, ` +
        `includeQuoted=${config.includeQuotedItems}`
      );

      // ===================================================================
      // 2. Load state & reset daily if needed
      // ===================================================================
      let replyState = loadReplyState(config.replyStatePath);
      replyState = maybeResetDaily(replyState);

      elizaLogger.info(
        `[REPLY] State loaded — dailyCount=${replyState.dailyCount}/${config.maxDailyReplies}, ` +
        `${replyState.repliedHashes.length} replied hashes tracked, ` +
        `${replyState.pendingQueue.length} pending from previous cycles`
      );

      // ===================================================================
      // 3. Check daily budget
      // ===================================================================
      if (!isWithinBudget(replyState, config.maxDailyReplies)) {
        elizaLogger.warn(
          `[REPLY] Budget EXHAUSTED — dailyCount=${replyState.dailyCount}/${config.maxDailyReplies}. ` +
          `Skipping cycle.`
        );
        callback({
          text:
            `[REPLY] Reply cycle skipped — budget exhausted. ` +
            `Daily: ${replyState.dailyCount}/${config.maxDailyReplies}.`,
        });
        return true;
      }

      const remaining = getRemainingBudget(replyState, config.maxDailyReplies);
      const cycleBudget = Math.min(config.maxPerCycle, remaining);

      elizaLogger.info(
        `[REPLY] Budget — daily=${replyState.dailyCount}/${config.maxDailyReplies}, ` +
        `remaining=${remaining}, cycleBudget=${cycleBudget}`
      );

      // ===================================================================
      // 4. Read Scout deliveries from Archon memory
      // ===================================================================
      const scoutDeliveries = await getScoutDeliveries(runtime);

      if (scoutDeliveries.length === 0) {
        elizaLogger.info("[REPLY] No Scout deliveries found in memory — checking pending queue only");
      }

      // ===================================================================
      // 5. Build set of already-replied hashes for dedup
      // ===================================================================
      const alreadyRepliedSet = new Set(replyState.repliedHashes);

      // ===================================================================
      // 6. Parse reply targets from Scout deliveries
      // ===================================================================
      const deliveryTargets = parseReplyTargetsFromDeliveries(
        scoutDeliveries,
        config.includeQuotedItems,
        alreadyRepliedSet
      );

      // ===================================================================
      // 7. Read shared reply queue from quote cycle
      // ===================================================================
      let queueHashes: string[] = [];
      if (config.includeQuotedItems) {
        queueHashes = readReplyQueue(config.replyQueuePath);
        // Clear the shared queue after reading (items will be in state dedup)
        clearReplyQueue(config.replyQueuePath);

        if (queueHashes.length > 0) {
          elizaLogger.info(
            `[REPLY] Shared reply queue — ${queueHashes.length} hashes from quote cycle`
          );
        }
      }

      // ===================================================================
      // 8. Merge all targets into a single work list
      //    Priority: pendingQueue (deferred) > deliveryTargets > queueHashes
      // ===================================================================
      const workList: ReplyTarget[] = [];

      // Add pending queue first (deferred from previous cycles)
      for (const pending of replyState.pendingQueue) {
        if (!alreadyRepliedSet.has(pending.castHash)) {
          workList.push(pending);
        }
      }

      // Add delivery targets
      for (const target of deliveryTargets) {
        if (!alreadyRepliedSet.has(target.castHash)) {
          workList.push(target);
        }
      }

      // Add queue hashes as QUOTE_CANDIDATE_EXTRA targets
      if (queueHashes.length > 0) {
        // We need basic cast info for queue hashes. Create minimal targets.
        for (const hash of queueHashes) {
          if (!alreadyRepliedSet.has(hash)) {
            workList.push({
              castHash: hash,
              castUrl: `https://warpcast.com/archon/${hash.replace("0x", "")}`,
              authorHandle: "unknown",
              authorFid: 0,
              originalText: "n/a",
              context: "Extra comment on quoted cast",
              score: 8, // Assumed high since it was deemed quote-worthy
              sourceTag: "QUOTE_CANDIDATE_EXTRA",
            });
          }
        }
      }

      // Filter by minimum score
      const filteredWorkList = workList.filter(
        (t) => t.score >= config.minScoreThreshold
      );

      // Dedup within work list (keep first occurrence)
      const seenInWorkList = new Set<string>();
      const dedupedWorkList: ReplyTarget[] = [];
      for (const target of filteredWorkList) {
        if (!seenInWorkList.has(target.castHash)) {
          seenInWorkList.add(target.castHash);
          dedupedWorkList.push(target);
        }
      }

      // Remove pending queue items that are in the work list (will process now)
      replyState.pendingQueue = replyState.pendingQueue.filter(
        (p) => !seenInWorkList.has(p.castHash)
      );

      const totalTargets = dedupedWorkList.length;
      const toProcess = dedupedWorkList.slice(0, cycleBudget);
      const toDefer = dedupedWorkList.slice(cycleBudget);

      elizaLogger.info(
        `[REPLY] Targets — ${totalTargets} total, ${toProcess.length} to process now, ` +
        `${toDefer.length} deferred to next cycle`
      );

      if (totalTargets === 0) {
        elizaLogger.info("[REPLY] No targets to process — cycle complete");
        saveReplyState(config.replyStatePath, replyState);
        callback({
          text: `[REPLY] Reply cycle complete — no targets found. Daily: ${replyState.dailyCount}/${config.maxDailyReplies}.`,
        });
        return true;
      }

      // ===================================================================
      // 9. Process targets: generate reply text + post via API
      // ===================================================================
      let replied = 0;
      let failed = 0;
      let skipped = 0;

      for (let i = 0; i < toProcess.length; i++) {
        const target = toProcess[i];
        const itemNum = i + 1;

        // Random delay before each reply (3-8s)
        if (i > 0) {
          const delayMs = randomBetween(config.minDelayMs, config.maxDelayMs);
          elizaLogger.debug(
            `[REPLY] Waiting ${delayMs}ms before next reply (item ${itemNum}/${toProcess.length})`
          );
          await sleep(delayMs);
        }

        elizaLogger.info(
          `[REPLY] Processing item ${itemNum}/${toProcess.length} — ` +
          `hash=${target.castHash.slice(0, 14)}..., ` +
          `@${target.authorHandle}, score=${target.score}, ` +
          `source=${target.sourceTag}`
        );

        try {
          // Generate reply text via LLM
          const replyText = await generateReplyText(runtime, target);

          // Post reply via Neynar API
          const result = await replyToCast(
            config.apiKey,
            config.signerUuid,
            target.castHash,
            replyText
          );

          if (result.success) {
            replied++;
            replyState.dailyCount++;
            recordRepliedHash(replyState, target.castHash);
            elizaLogger.success(
              `[REPLY] SUCCESS item ${itemNum}/${toProcess.length} — ` +
              `hash=${target.castHash.slice(0, 14)}..., ` +
              `castHash=${result.castHash || "unknown"}, ` +
              `dailyCount=${replyState.dailyCount}/${config.maxDailyReplies}`
            );
          } else {
            failed++;
            elizaLogger.warn(
              `[REPLY] FAILED item ${itemNum}/${toProcess.length} — ` +
              `hash=${target.castHash.slice(0, 14)}..., ` +
              `error=${result.error || "unknown"}`
            );
          }
        } catch (err) {
          failed++;
          elizaLogger.warn(
            `[REPLY] ERROR item ${itemNum}/${toProcess.length} — ` +
            `hash=${target.castHash.slice(0, 14)}...: ${String(err)}`
          );
        }

        // Check if daily budget exhausted mid-cycle
        if (!isWithinBudget(replyState, config.maxDailyReplies)) {
          elizaLogger.warn(
            `[REPLY] Daily budget reached mid-cycle — stopping. ` +
            `Replied=${replied}, remaining items deferred.`
          );
          // Add remaining items to defer list
          for (let j = i + 1; j < toProcess.length; j++) {
            toDefer.push(toProcess[j]);
          }
          break;
        }
      }

      // ===================================================================
      // 10. Defer remaining targets to pending queue
      // ===================================================================
      const existingPendingHashes = new Set(replyState.pendingQueue.map((p) => p.castHash));
      for (const defer of toDefer) {
        if (!existingPendingHashes.has(defer.castHash)) {
          replyState.pendingQueue.push(defer);
          existingPendingHashes.add(defer.castHash);
        }
      }

      // Cap pending queue size
      if (replyState.pendingQueue.length > MAX_PENDING_QUEUE_SIZE) {
        replyState.pendingQueue = replyState.pendingQueue.slice(-MAX_PENDING_QUEUE_SIZE);
      }

      replyState.lastCycleAt = new Date().toISOString();

      // ===================================================================
      // 11. Persist state
      // ===================================================================
      saveReplyState(config.replyStatePath, replyState);

      // ===================================================================
      // 12. Format and return results
      // ===================================================================
      const totalDuration = Date.now() - startTime;
      const result: ReplyCycleResult = {
        replied,
        failed,
        skipped,
        dailyCount: replyState.dailyCount,
        dailyLimit: config.maxDailyReplies,
        pendingRemaining: replyState.pendingQueue.length,
      };

      elizaLogger.info(
        `[REPLY] Cycle complete — ${formatCycleResult(result)} (${totalDuration}ms)`
      );

      // Log total credit estimate for audit
      const estimatedCredits = replied * 25;
      elizaLogger.info(
        `[REPLY] Credit estimate — ${replied} replies × ~25 = ~${estimatedCredits} credits consumed`
      );

      callback({
        text:
          `[REPLY] Cycle complete. ` +
          `Replied to ${replied} cast(s). ` +
          `Daily: ${replyState.dailyCount}/${config.maxDailyReplies}. ` +
          `Pending: ${replyState.pendingQueue.length}. ` +
          `Failed: ${failed}. ` +
          `~${estimatedCredits} credits.`,
      });

      return true;
    } catch (err) {
      const duration = Date.now() - startTime;
      const errMsg = `[REPLY] Fatal error in handler: ${String(err)} (${duration}ms)`;
      elizaLogger.error(errMsg);
      callback({ text: errMsg });
      return false;
    }
  },

  examples: [],
};

export default replyFarcasterAction;
