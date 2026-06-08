// =============================================================================
// replyDirectCast.ts — REPLY_DIRECT_CAST ElizaOS Action
//
// Processes incoming Direct Casts (DMs) via Neynar notifications API:
//   1. Fetch notifications (include direct_cast type)
//   2. Filter spam (follower count, power badge, text patterns, rate limits)
//   3. Review past interactions with sender (messageManager)
//   4. Review knowledge relevance (RAG via messageManager embeddings)
//   5. Score & prioritize DMs (0-100 scale)
//   6. Generate reply via runtime LLM with full context
//   7. Send reply via POST /v2/farcaster/message
//   8. Track state (dedup, daily counters, per-sender rate limits)
//
// ISSUE #9 — Direct Cast Reply System (2026-06-01)
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger, stringToUuid, generateText, embed, ModelClass } from "@elizaos/core";
import * as fs from "fs";
import * as path from "path";
import { getNotifications, lookupUserByFid, sendDirectCast } from "../lib/neynarClient.js";
import type {
  NeynarAuthor,
  DmConfig,
  DmPriorityState,
} from "../types.js";

// ---------------------------------------------------------------------------
// Logging tag
// ---------------------------------------------------------------------------
const TAG = "[DIRECT_CAST]";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SPAM_MIN_FOLLOWERS = 50;
const DEFAULT_SPAM_MIN_FOLLOWERS_POWER = 200;
const DEFAULT_MAX_DMS_PER_SENDER = 3;
const DEFAULT_MAX_DMS_PER_CYCLE = 3;
const DEFAULT_MIN_SCORE_FOR_REPLY = 30;
const DEFAULT_DAILY_REPLY_LIMIT = 10;

// State file path (relative to engine cwd)
const DM_STATE_PATH = path.resolve(process.cwd(), "data", "dm_priority_state.json");

// Minimum interval between DM processing cycles (6 hours = 4 cycles/day max)
const DM_MIN_CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Max entries in dedup arrays before trimming
const MAX_DEDUP_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Spam regex patterns
// ---------------------------------------------------------------------------
const SPAM_PATTERNS = [
  /https?:\/\/[^\s]+\s*(?:free|earn|claim|giveaway|airdrop)/i,
  /(?:free|earn|claim|giveaway|airdrop)\s*(?:eth|btc|token|nft|crypto)/i,
  /(?:congratulations|you.?ve?\s*won|you.?re?\s*a?\s*winner)/i,
  /(?:click|tap)\s*(?:here|link|below)\s*(?:to|for|and)/i,
  /^[A-Z]{2,}\s+(?:ALERT|URGENT|ACTION REQUIRED|IMPORTANT)/,
];

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/**
 * Build DmConfig from runtime settings.
 * Every value can be overridden via environment variables / character.json secrets.
 */
function createDmConfig(runtime: IAgentRuntime): DmConfig {
  return {
    apiKey: runtime.getSetting("FARCASTER_NEYNAR_API_KEY") || "",
    signerUuid: runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID") || "",
    archonFid: Number(runtime.getSetting("ARCHON_FARCASTER_FID")) || 3315139,
    spamMinFollowers:
      Number(runtime.getSetting("DM_MIN_FOLLOWERS")) || DEFAULT_SPAM_MIN_FOLLOWERS,
    spamMinFollowersPower:
      Number(runtime.getSetting("DM_MIN_FOLLOWERS_POWER")) || DEFAULT_SPAM_MIN_FOLLOWERS_POWER,
    maxDmsPerSender:
      Number(runtime.getSetting("DM_MAX_PER_SENDER")) || DEFAULT_MAX_DMS_PER_SENDER,
    maxDmsPerCycle:
      Number(runtime.getSetting("DM_MAX_PER_CYCLE")) || DEFAULT_MAX_DMS_PER_CYCLE,
    minScoreForReply:
      Number(runtime.getSetting("DM_MIN_SCORE")) || DEFAULT_MIN_SCORE_FOR_REPLY,
    dailyReplyLimit:
      Number(runtime.getSetting("DM_DAILY_REPLY_LIMIT")) || DEFAULT_DAILY_REPLY_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function loadDmState(): DmPriorityState {
  try {
    if (fs.existsSync(DM_STATE_PATH)) {
      const raw = fs.readFileSync(DM_STATE_PATH, "utf-8");
      const state = JSON.parse(raw) as DmPriorityState;
      elizaLogger.info(
        `${TAG} loadDmState: loaded — ${state.processedDmHashes.length} processed, ` +
        `${state.sentReplyHashes.length} replied, ${state.dailyReplyCount}/${state.dailyReplyDate} today`
      );
      return state;
    }
  } catch (err) {
    elizaLogger.warn(`${TAG} loadDmState: failed to load state file — starting fresh: ${err}`);
  }

  // Fresh state
  return {
    lastFetchTimestamp: new Date(0).toISOString(),
    processedDmHashes: [],
    sentReplyHashes: [],
    dailyReplyCount: 0,
    dailyReplyDate: new Date().toISOString().slice(0, 10),
    pendingReplies: [],
  };
}

function saveDmState(state: DmPriorityState): void {
  try {
    const dir = path.dirname(DM_STATE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DM_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    elizaLogger.info(
      `${TAG} saveDmState: saved — ${state.processedDmHashes.length} processed, ` +
      `${state.sentReplyHashes.length} replied, ${state.dailyReplyCount} today`
    );
  } catch (err) {
    elizaLogger.warn(`${TAG} saveDmState: failed to save state: ${err}`);
  }
}

/**
 * Reset daily counters if the date has changed.
 */
function maybeResetDaily(state: DmPriorityState): void {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyReplyDate !== today) {
    elizaLogger.info(
      `${TAG} Daily reset: ${state.dailyReplyDate} → ${today} (was ${state.dailyReplyCount} replies)`
    );
    state.dailyReplyCount = 0;
    state.dailyReplyDate = today;
  }
}

/**
 * Trim dedup arrays to prevent unbounded growth.
 */
function trimDedupArrays(state: DmPriorityState): void {
  if (state.processedDmHashes.length > MAX_DEDUP_ENTRIES) {
    state.processedDmHashes = state.processedDmHashes.slice(-MAX_DEDUP_ENTRIES);
  }
  if (state.sentReplyHashes.length > MAX_DEDUP_ENTRIES) {
    state.sentReplyHashes = state.sentReplyHashes.slice(-MAX_DEDUP_ENTRIES);
  }
}

// ---------------------------------------------------------------------------
// Spam detection
// ---------------------------------------------------------------------------

interface SpamCheckResult {
  isSpam: boolean;
  reason?: string;
}

function checkSpamByPatterns(text: string): SpamCheckResult {
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) {
      return { isSpam: true, reason: `Matched spam pattern: ${pattern.source.slice(0, 60)}` };
    }
  }
  return { isSpam: false };
}

function checkSpamByProfile(
  author: NeynarAuthor,
  config: DmConfig
): SpamCheckResult {
  const followers = author.follower_count ?? 0;

  // Hard floor: absolute minimum followers
  if (followers < config.spamMinFollowers) {
    return {
      isSpam: true,
      reason: `Follower count ${followers} < spamMinFollowers (${config.spamMinFollowers})`,
    };
  }

  // Stricter threshold for non-power-badge accounts
  if (!author.power_badge && followers < config.spamMinFollowersPower) {
    return {
      isSpam: true,
      reason: `No power badge and ${followers} followers < spamMinFollowersPower (${config.spamMinFollowersPower})`,
    };
  }

  return { isSpam: false };
}

// ---------------------------------------------------------------------------
// Past interaction review
// ---------------------------------------------------------------------------

interface PastInteractionSummary {
  hasPastInteraction: boolean;
  messageCount: number;
  lastMessageAt?: string;
  lastMessagePreview?: string;
}

async function reviewPastInteractions(
  runtime: IAgentRuntime,
  senderFid: number
): Promise<PastInteractionSummary> {
  try {
    // The sender's userId in ElizaOS is a deterministic UUID from their FID
    const senderUserId = stringToUuid(senderFid.toString());

    // Search messageManager for recent messages from this user
    // We look in the agent's default room and general memory
    const memories = await runtime.messageManager.getMemories({
      roomId: runtime.agentId,
      count: 10,
      unique: false,
    });

    // Filter memories that mention this sender's FID or have matching userId
    const relevantMemories = memories.filter((m: Memory) => {
      const text = (m.content?.text as string) ?? "";
      return (
        m.userId?.toString()?.includes(senderUserId.toString().slice(0, 14)) ||
        text.includes(`@${senderFid}`) ||
        text.includes(`fid=${senderFid}`) ||
        text.includes(`FID:${senderFid}`)
      );
    });

    if (relevantMemories.length === 0) {
      return { hasPastInteraction: false, messageCount: 0 };
    }

    const sorted = relevantMemories.sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );
    const latest = sorted[0];

    elizaLogger.info(
      `${TAG} reviewPastInteractions: fid=${senderFid} — ${relevantMemories.length} past interactions found`
    );

    return {
      hasPastInteraction: true,
      messageCount: relevantMemories.length,
      lastMessageAt: latest.createdAt
        ? new Date(latest.createdAt).toISOString()
        : undefined,
      lastMessagePreview: ((latest.content?.text as string) ?? "").slice(0, 100),
    };
  } catch (err) {
    elizaLogger.warn(`${TAG} reviewPastInteractions ERROR for fid=${senderFid}: ${err}`);
    return { hasPastInteraction: false, messageCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Knowledge relevance scoring (via messageManager embedding search)
// ---------------------------------------------------------------------------

async function scoreKnowledgeRelevance(
  runtime: IAgentRuntime,
  dmText: string
): Promise<number> {
  try {
    // Embed the DM text first, then use it for similarity search
    const embedding = await embed(runtime, dmText);
    const searchMemories = await runtime.messageManager.searchMemoriesByEmbedding(
      embedding,
      {
        roomId: runtime.agentId,
        count: 3,
        match_threshold: 0.3,
        unique: true,
      }
    );

    if (!searchMemories?.length) {
      return 0;
    }

    // Score based on similarity: 0-30 points scaled by average similarity
    const similarities = searchMemories.map((m: any) => m.similarity ?? 0.3);
    const avgSimilarity = similarities.reduce((a: number, b: number) => a + b, 0) / similarities.length;

    // Scale: 0.3 similarity → 0 points, 0.9+ similarity → 30 points
    const score = Math.min(30, Math.max(0, Math.round(((avgSimilarity - 0.3) / 0.6) * 30)));

    if (score > 0) {
      elizaLogger.info(
        `${TAG} scoreKnowledgeRelevance: avgSimilarity=${avgSimilarity.toFixed(3)}, relevanceScore=${score}`
      );
    }

    return score;
  } catch (err) {
    elizaLogger.warn(`${TAG} scoreKnowledgeRelevance ERROR: ${err}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

function calculatePriorityScore(
  author: NeynarAuthor,
  isMutualFollow: boolean,
  pastInteraction: PastInteractionSummary,
  knowledgeRelevanceScore: number
): number {
  let score = 20; // Base: all non-spam DMs start at 20

  // Mutual follow bonus
  if (isMutualFollow) {
    score += 15;
  }

  // Power badge bonus
  if (author.power_badge) {
    score += 10;
  }

  // Follower tier bonus
  const followers = author.follower_count ?? 0;
  if (followers >= 50_000) score += 15;
  else if (followers >= 10_000) score += 10;
  else if (followers >= 1_000) score += 5;

  // Past interaction bonus
  if (pastInteraction.hasPastInteraction) {
    score += 10;
  }

  // Knowledge relevance bonus (0-30)
  score += knowledgeRelevanceScore;

  return Math.min(100, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// Generate reply text
// ---------------------------------------------------------------------------

async function generateDmReply(
  runtime: IAgentRuntime,
  dmText: string,
  senderHandle: string,
  senderProfile: NeynarAuthor,
  pastInteraction: PastInteractionSummary
): Promise<string> {
  try {
    const contextPieces: string[] = [];

    contextPieces.push(`You are Archon Europae. You received a Direct Cast (DM) on Farcaster from @${senderHandle}.`);
    contextPieces.push(`Sender profile: ${senderProfile.follower_count?.toLocaleString() ?? "?"} followers${senderProfile.power_badge ? " [⚡ power badge]" : ""}.`);

    if (pastInteraction.hasPastInteraction) {
      contextPieces.push(`You have interacted with this person before (${pastInteraction.messageCount} previous messages).`);
      contextPieces.push(`Last interaction: "${pastInteraction.lastMessagePreview}".`);
    }

    contextPieces.push(`The DM says: "${dmText}"`);
    contextPieces.push("");
    contextPieces.push("Generate a concise, helpful reply in Archon's voice — data-backed, analytical, sovereign.");
    contextPieces.push("Keep the reply under 320 characters (Farcaster DM limit).");
    contextPieces.push("Do NOT use hashtags or emojis. Be direct and substantive.");
    contextPieces.push("");

    const context = contextPieces.join("\n");

    // Use generateText to generate response via the LLM provider
    const response = await generateText({
      runtime,
      context,
      modelClass: ModelClass.LARGE,
      stop: [],
    });

    const reply = (response || "").trim();

    if (!reply) {
      elizaLogger.warn(`${TAG} generateDmReply: empty response for @${senderHandle}`);
      return "";
    }

    elizaLogger.info(
      `${TAG} generateDmReply: @${senderHandle} — "${reply.slice(0, 80)}..." (${reply.length} chars)`
    );

    return reply;
  } catch (err) {
    elizaLogger.warn(`${TAG} generateDmReply ERROR for @${senderHandle}: ${err}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Format inbox text for callback
// ---------------------------------------------------------------------------

function formatDmInbox(
  pendingReplies: DmPriorityState["pendingReplies"],
  state: DmPriorityState,
  config: DmConfig
): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  lines.push(`[DIRECT_CAST_INBOX ${timestamp}]`);
  lines.push(`Replied today: ${state.dailyReplyCount}/${config.dailyReplyLimit}`);
  lines.push(`Processed ${state.processedDmHashes.length} DMs total.`);

  if (pendingReplies.length === 0) {
    lines.push("No pending DMs to process.");
    return lines.join("\n");
  }

  lines.push(`\n${pendingReplies.length} DM(s) requiring attention:`);
  lines.push("");

  for (let i = 0; i < pendingReplies.length; i++) {
    const dm = pendingReplies[i];
    lines.push(`${i + 1}. [SCORE ${dm.score}/100] — @${dm.senderHandle}`);
    lines.push(`   Message: "${dm.dmText.slice(0, 120)}"`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export const replyDirectCastAction: Action = {
  name: "REPLY_DIRECT_CAST",

  similes: [
    "DIRECT_CAST_REPLY",
    "DM_REPLY",
    "PROCESS_DIRECT_CASTS",
    "PROCESS_DMS",
    "REPLY_DM",
    "HANDLE_DIRECT_CASTS",
  ],

  description:
    "Fetch incoming Direct Casts (DMs) from Farcaster via Neynar notifications, " +
    "filter spam, review past interactions and knowledge relevance, score and prioritize, " +
    "generate replies via LLM, and send replies via Neynar message API.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    if (!apiKey) {
      elizaLogger.warn(
        `${TAG} FARCASTER_NEYNAR_API_KEY not set — REPLY_DIRECT_CAST disabled`
      );
      return false;
    }
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID");
    if (!signerUuid) {
      elizaLogger.warn(
        `${TAG} FARCASTER_NEYNAR_SIGNER_UUID not set — REPLY_DIRECT_CAST disabled`
      );
      return false;
    }

    // Cooldown check: enforce minimum interval between cycles (default 6h)
    try {
      if (fs.existsSync(DM_STATE_PATH)) {
        const raw = fs.readFileSync(DM_STATE_PATH, "utf-8");
        const state = JSON.parse(raw) as DmPriorityState;
        const lastFetch = new Date(state.lastFetchTimestamp).getTime();
        const elapsed = Date.now() - lastFetch;
        if (!isNaN(lastFetch) && elapsed < DM_MIN_CYCLE_INTERVAL_MS) {
          elizaLogger.info(
            `${TAG} Cooldown active — last cycle was ${Math.round(elapsed / 60000)}m ago ` +
            `(min ${DM_MIN_CYCLE_INTERVAL_MS / 60000}m). Skipping.`
          );
          return false;
        }
      }
    } catch (err) {
      elizaLogger.warn(`${TAG} Cooldown check error (proceeding anyway): ${err}`);
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback: HandlerCallback
  ): Promise<boolean> => {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    elizaLogger.log(`${TAG} Starting DM processing cycle at ${timestamp}`);

    // -----------------------------------------------------------------------
    // 1. Build config
    // -----------------------------------------------------------------------
    const config = createDmConfig(runtime);
    const apiKey = config.apiKey;
    const signerUuid = config.signerUuid;

    if (!apiKey || !signerUuid) {
      const errText = `${TAG} ERROR: API key or signer UUID not configured. Cycle aborted.`;
      elizaLogger.error(errText);
      callback({ text: errText });
      return false;
    }

    elizaLogger.log(
      `${TAG} Config: minFollowers=${config.spamMinFollowers}, ` +
      `minFollowersPower=${config.spamMinFollowersPower}, ` +
      `maxPerSender=${config.maxDmsPerSender}, maxPerCycle=${config.maxDmsPerCycle}, ` +
      `minScore=${config.minScoreForReply}, dailyLimit=${config.dailyReplyLimit}`
    );

    // -----------------------------------------------------------------------
    // 2. Load state
    // -----------------------------------------------------------------------
    const state = loadDmState();
    maybeResetDaily(state);

    // -----------------------------------------------------------------------
    // 3. Fetch notifications
    // -----------------------------------------------------------------------
    elizaLogger.log(`${TAG} Fetching notifications for FID ${config.archonFid}...`);
    const notifications = await getNotifications(apiKey, config.archonFid, 25);

    // -----------------------------------------------------------------------
    // 4. Filter to only direct_cast type
    // -----------------------------------------------------------------------
    const dmNotifications = notifications.filter((n) => n.type === "direct_cast");
    elizaLogger.log(
      `${TAG} ${dmNotifications.length} DM(s) in notifications (${notifications.length} total notification actions)`
    );

    if (dmNotifications.length === 0) {
      elizaLogger.log(`${TAG} No DMs to process. Cycle complete.`);
      const inboxText = formatDmInbox(state.pendingReplies, state, config);
      saveDmState(state);
      callback({ text: inboxText });
      return true;
    }

    // -----------------------------------------------------------------------
    // 5. Filter new DMs (not yet processed)
    // -----------------------------------------------------------------------
    const newDms = dmNotifications.filter(
      (n) => !state.processedDmHashes.includes(n.cast.hash)
    );
    elizaLogger.log(
      `${TAG} ${newDms.length} new DM(s) (${dmNotifications.length - newDms.length} already processed)`
    );

    if (newDms.length === 0) {
      elizaLogger.log(`${TAG} No new DMs to process. Cycle complete.`);
      const inboxText = formatDmInbox(state.pendingReplies, state, config);
      saveDmState(state);
      callback({ text: inboxText });
      return true;
    }

    // -----------------------------------------------------------------------
    // 6. Process each new DM: spam check, review past interactions, score
    // -----------------------------------------------------------------------
    const processed: Array<{
      castHash: string;
      senderFid: number;
      senderHandle: string;
      dmText: string;
      score: number;
      isSpam: boolean;
      spamReason?: string;
    }> = [];

    for (let i = 0; i < newDms.length; i++) {
      const dm = newDms[i];
      const cast = dm.cast;
      const senderFid = cast.author?.fid || 0;
      const senderHandle = cast.author?.username || `fid:${senderFid}`;
      const dmText = cast.text || "";

      elizaLogger.log(
        `${TAG} [${i + 1}/${newDms.length}] Processing DM from @${senderHandle} (fid=${senderFid}): "${dmText.slice(0, 80)}..."`
      );

      // Mark as processed immediately (prevents re-processing on failure)
      state.processedDmHashes.push(cast.hash);

      // 6a. Look up sender profile
      let author: NeynarAuthor | null = cast.author;
      if (!author || !author.follower_count) {
        author = await lookupUserByFid(apiKey, senderFid);
      }

      if (!author) {
        elizaLogger.warn(`${TAG} Could not resolve profile for fid=${senderFid} — treating as spam`);
        processed.push({
          castHash: cast.hash,
          senderFid,
          senderHandle,
          dmText,
          score: 0,
          isSpam: true,
          spamReason: "Could not resolve sender profile",
        });
        continue;
      }

      // 6b. Spam check by profile
      const profileSpam = checkSpamByProfile(author, config);
      if (profileSpam.isSpam) {
        elizaLogger.info(
          `${TAG} SPAM (profile) — @${senderHandle}: ${profileSpam.reason}`
        );
        processed.push({
          castHash: cast.hash,
          senderFid,
          senderHandle,
          dmText,
          score: 0,
          isSpam: true,
          spamReason: profileSpam.reason,
        });
        continue;
      }

      // 6c. Spam check by text patterns
      const textSpam = checkSpamByPatterns(dmText);
      if (textSpam.isSpam) {
        elizaLogger.info(
          `${TAG} SPAM (text) — @${senderHandle}: ${textSpam.reason}`
        );
        processed.push({
          castHash: cast.hash,
          senderFid,
          senderHandle,
          dmText,
          score: 0,
          isSpam: true,
          spamReason: textSpam.reason,
        });
        continue;
      }

      // 6d. Check rate limit per sender
      const senderDmCount = state.pendingReplies.filter(
        (r) => r.senderFid === senderFid
      ).length;
      if (senderDmCount >= config.maxDmsPerSender) {
        elizaLogger.info(
          `${TAG} RATE-LIMITED — @${senderHandle}: already ${senderDmCount} DMs in queue (max ${config.maxDmsPerSender})`
        );
        processed.push({
          castHash: cast.hash,
          senderFid,
          senderHandle,
          dmText,
          score: 0,
          isSpam: true,
          spamReason: `Rate-limited: ${senderDmCount} DMs already queued`,
        });
        continue;
      }

      // 6e. Review past interactions
      const pastInteraction = await reviewPastInteractions(runtime, senderFid);

      // 6f. Score knowledge relevance
      const knowledgeScore = await scoreKnowledgeRelevance(runtime, dmText);

      // 6g. Calculate priority score
      const isMutual = author.following_count != null && author.following_count > 0;
      const score = calculatePriorityScore(
        author,
        isMutual,
        pastInteraction,
        knowledgeScore
      );

      elizaLogger.info(
        `${TAG} SCORE ${score}/100 — @${senderHandle} ` +
        `(followers=${author.follower_count}, power=${!!author.power_badge}, ` +
        `mutual=${isMutual}, pastInteraction=${pastInteraction.hasPastInteraction}, ` +
        `knowledgeScore=${knowledgeScore})`
      );

      processed.push({
        castHash: cast.hash,
        senderFid,
        senderHandle,
        dmText,
        score,
        isSpam: false,
      });
    }

    // -----------------------------------------------------------------------
    // 7. Sort non-spam DMs by score descending
    // -----------------------------------------------------------------------
    const legitimate = processed
      .filter((p) => !p.isSpam)
      .sort((a, b) => b.score - a.score);

    const spamCount = processed.filter((p) => p.isSpam).length;

    elizaLogger.log(
      `${TAG} ${legitimate.length} legitimate DM(s), ${spamCount} spam discarded`
    );

    // -----------------------------------------------------------------------
    // 8. Process top N DMs: generate reply + send
    // -----------------------------------------------------------------------
    const dmsToReply = legitimate.slice(0, config.maxDmsPerCycle);
    let replied = 0;
    let skippedDueToDailyLimit = 0;
    let sendErrors = 0;

    for (let i = 0; i < dmsToReply.length; i++) {
      const dm = dmsToReply[i];

      // Check daily limit
      if (state.dailyReplyCount >= config.dailyReplyLimit) {
        elizaLogger.warn(
          `${TAG} Daily reply limit reached (${state.dailyReplyCount}/${config.dailyReplyLimit}) — skipping @${dm.senderHandle}`
        );
        skippedDueToDailyLimit++;
        // Still add to pendingReplies for next day
        state.pendingReplies.push({
          dmHash: dm.castHash,
          senderFid: dm.senderFid,
          senderHandle: dm.senderHandle,
          dmText: dm.dmText,
          score: dm.score,
        });
        continue;
      }

      // 8a. Generate reply
      elizaLogger.log(
        `${TAG} Generating reply for @${dm.senderHandle} (score=${dm.score})...`
      );

      const replyText = await generateDmReply(
        runtime,
        dm.dmText,
        dm.senderHandle,
        { fid: dm.senderFid, username: dm.senderHandle, follower_count: 0 },
        await reviewPastInteractions(runtime, dm.senderFid)
      );

      if (!replyText) {
        elizaLogger.warn(
          `${TAG} Empty reply generated for @${dm.senderHandle} — skipping`
        );
        skippedDueToDailyLimit++;
        continue;
      }

      // 8b. Send reply
      elizaLogger.log(
        `${TAG} Sending reply to @${dm.senderHandle} (fid=${dm.senderFid})...`
      );

      const sendResult = await sendDirectCast(
        apiKey,
        signerUuid,
        dm.senderFid,
        replyText
      );

      if (sendResult.success) {
        replied++;
        state.dailyReplyCount++;
        state.sentReplyHashes.push(dm.castHash);
        elizaLogger.success(
          `${TAG} REPLY SENT → @${dm.senderHandle} (msgId=${sendResult.messageId}) — ` +
          `${state.dailyReplyCount}/${config.dailyReplyLimit} today`
        );
      } else {
        sendErrors++;
        elizaLogger.warn(
          `${TAG} REPLY FAILED → @${dm.senderHandle}: ${sendResult.error}`
        );
        // Add to pendingReplies for retry next cycle
        state.pendingReplies.push({
          dmHash: dm.castHash,
          senderFid: dm.senderFid,
          senderHandle: dm.senderHandle,
          dmText: dm.dmText,
          score: dm.score,
        });
      }
    }

    // Add remaining legitimate DMs that weren't processed this cycle to pending
    const remainingDms = legitimate.slice(config.maxDmsPerCycle);
    for (const dm of remainingDms) {
      // Check if already in pending
      const alreadyPending = state.pendingReplies.some(
        (r) => r.dmHash === dm.castHash
      );
      if (!alreadyPending) {
        state.pendingReplies.push({
          dmHash: dm.castHash,
          senderFid: dm.senderFid,
          senderHandle: dm.senderHandle,
          dmText: dm.dmText,
          score: dm.score,
        });
      }
    }

    // Trim dedup arrays
    trimDedupArrays(state);

    // -----------------------------------------------------------------------
    // 9. Save state
    // -----------------------------------------------------------------------
    state.lastFetchTimestamp = timestamp;
    saveDmState(state);

    // -----------------------------------------------------------------------
    // 10. Format and return result
    // -----------------------------------------------------------------------
    const inboxText = formatDmInbox(state.pendingReplies, state, config);

    const summary = [
      `${TAG} CYCLE COMPLETE at ${timestamp}`,
      `  Received: ${newDms.length} new DM(s)`,
      `  Spam filtered: ${spamCount}`,
      `  Replied: ${replied}`,
      `  Send errors: ${sendErrors}`,
      `  Daily limit skipped: ${skippedDueToDailyLimit}`,
      `  Daily count: ${state.dailyReplyCount}/${config.dailyReplyLimit}`,
      `  Pending in queue: ${state.pendingReplies.length}`,
    ].join("\n");

    elizaLogger.log(summary);

    callback({ text: inboxText });

    return true;
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Process pending direct casts on Farcaster.",
        },
      },
      {
        user: "Archon Europae",
        content: {
          text: "[DIRECT_CAST_INBOX 2026-06-01T12:00:00Z]\nReplied today: 2/10\nProcessed 15 DMs total.\n\n2 DM(s) requiring attention:\n\n1. [SCORE 65/100] — @vitalik.eth\n   Message: \"Love your recent post on European energy grids. Curious about your take on nuclear + renewables hybrid models.\"\n\n2. [SCORE 42/100] — @cryptoresearcher\n   Message: \"What do you think about the latest MiCA regulations on stablecoins?\"",
          action: "REPLY_DIRECT_CAST",
        },
      },
    ],
  ],
};
