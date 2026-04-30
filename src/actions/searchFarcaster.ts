// =============================================================================
// searchFarcaster.ts — SEARCH_FARCASTER ElizaOS Action
//
// Flow:
//   1. Read FARCASTER_NEYNAR_API_KEY from runtime settings
//   2. Parse keywords from message or fall back to default corpus
//   3. Fetch casts from Neynar API (parallel batched keyword searches)
//   4. Score, filter (< 6 discarded), cap at 10, rank descending
//   5. Format ranked queue text
//   6. POST queue to Archon's DirectClient endpoint
//   7. Return queue text via callback
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { searchAllKeywords } from "../lib/neynarClient.js";
import { scoreAndRank } from "../lib/scorer.js";
import type { ScoredOpportunity } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHON_AGENT_ID = "187939ae-c36e-08ef-836f-131b1b658c9a";
const ARCHON_BASE_URL = "http://archon_euro_container:3000";

/** Default keyword corpus derived from target_list.md and CONSTITUTION.md */
const DEFAULT_KEYWORDS = [
  "EU energy",
  "European sovereignty",
  "European Parliament",
  "Austrian economics",
  "fiscal responsibility",
  "EU immigration",
  "European right",
  "crypto regulation EU",
  "European defense",
  "netcongestie",
  "European realpolitik",
  "Western values",
  "EU competitiveness",
  "re-industrialization",
  "MiCA",
  "Bitcoin Europe",
  "geopolitical Europe",
  "energy prices Europe",
];

const MAX_RESULTS = 5;
const MIN_SCORE = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract keywords from message text. If the message contains a quoted list
 * or colon-delimited list, parse them. Otherwise fall back to defaults.
 */
function extractKeywords(text: string): string[] {
  if (!text) return DEFAULT_KEYWORDS;

  // Look for "keywords: ..." or "search for: ..." patterns
  const colonMatch = text.match(/(?:keywords?|search(?:\s+for)?)\s*:\s*(.+)/i);
  if (colonMatch) {
    const kws = colonMatch[1]
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (kws.length >= 2) return kws;
  }

  // Default: use the hardcoded corpus
  return DEFAULT_KEYWORDS;
}

/**
 * Format the scored opportunity queue as structured text for Archon.
 */
function formatQueue(opportunities: ScoredOpportunity[], timestamp: string): string {
  if (opportunities.length === 0) {
    return `[SCOUT CYCLE ${timestamp}]\nNo opportunities above threshold found this cycle. 0/10.`;
  }

  const lines: string[] = [
    `[SCOUT CYCLE ${timestamp}] — ${opportunities.length} opportunity(ies) queued`,
    "",
  ];

  for (let i = 0; i < opportunities.length; i++) {
    const op = opportunities[i];
    const totalEng =
      (op.reactions?.likes_count ?? 0) +
      (op.reactions?.recasts_count ?? 0) +
      (op.replies?.count ?? 0);

    // Truncate suggestedAngle to 150 chars max to avoid exceeding embedding context
    const truncatedAngle = op.suggestedAngle.length > 150
      ? op.suggestedAngle.slice(0, 147) + "..."
      : op.suggestedAngle;

    lines.push(`${i + 1}. SCORE ${op.score}/10 — @${op.author.username}`);
    lines.push(`   URL: ${op.castUrl}`);
    lines.push(
      `   Reach: ${op.author.follower_count.toLocaleString()} followers${op.author.power_badge ? " [⚡ power badge]" : ""}`
    );
    lines.push(
      `   Engagement: ${op.reactions.likes_count}L / ${op.reactions.recasts_count}RC / ${op.replies.count}R (${totalEng} total)`
    );
    lines.push(`   Keywords: ${op.matchedKeywords.join(", ") || "n/a"}`);
    lines.push(`   Angle: ${truncatedAngle}`);
    lines.push("");
  }

  lines.push(
    `Queue delivered to Archon. ${opportunities.length} item(s). Cycle complete.`
  );

  return lines.join("\n");
}

/**
 * Deliver the ranked queue to Archon's DirectClient endpoint.
 * Fire-and-forget; failure is logged but does not abort the action.
 */
async function deliverToArchon(queueText: string): Promise<void> {
  const url = `${ARCHON_BASE_URL}/${ARCHON_AGENT_ID}/message`;

  elizaLogger.log(
    `[neynar-search] Delivering queue to Archon. Length: ${queueText.length} chars. Approximate tokens: ${Math.ceil(queueText.length / 4)}`
  );

  const body = JSON.stringify({
    text: `[SCOUT DELIVERY]\n\n${queueText}`,
    userId: "scout-agent",
    userName: "The Scout",
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      elizaLogger.warn(
        `[neynar-search] Archon delivery failed: ${res.status} ${res.statusText}`
      );
    } else {
      elizaLogger.success(`[neynar-search] Queue delivered to Archon (${res.status})`);
    }
  } catch (err) {
    elizaLogger.warn(`[neynar-search] Archon delivery error:`, err);
  }
}

// ---------------------------------------------------------------------------
// SEARCH_FARCASTER Action
// ---------------------------------------------------------------------------

export const searchFarcasterAction: Action = {
  name: "SEARCH_FARCASTER",

  similes: [
    "FARCASTER_SEARCH",
    "NEYNAR_SEARCH",
    "DISCOVER_FARCASTER",
    "RUN_SCOUT_CYCLE",
    "SCOUT_CYCLE",
    "SEARCH_CASTS",
    "FIND_FARCASTER_POSTS",
  ],

  description:
    "Search Farcaster via the Neynar REST API for high-signal posts matching Archon's keyword corpus. " +
    "Scores each cast on author reach, engagement velocity, and topical alignment (1–10). " +
    "Discards scores below 6, caps queue at 10, and delivers the ranked list to Archon's DirectClient.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    if (!apiKey) {
      elizaLogger.warn(
        "[neynar-search] FARCASTER_NEYNAR_API_KEY not set — SEARCH_FARCASTER disabled"
      );
      return false;
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

    elizaLogger.log(`[neynar-search] Starting discovery cycle at ${timestamp}`);

    // 1. API key
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    if (!apiKey) {
      const errText = "[SCOUT] ERROR: FARCASTER_NEYNAR_API_KEY not configured. Cycle aborted.";
      elizaLogger.error("[neynar-search]", errText);
      callback({ text: errText });
      return false;
    }

    // 2. Keywords
    const messageText = (message?.content?.text as string) ?? "";
    const keywords = extractKeywords(messageText);
    elizaLogger.log(`[neynar-search] Searching ${keywords.length} keywords...`);

    // 3. Fetch casts (batched parallel, max 5 concurrent)
    let casts;
    try {
      casts = await searchAllKeywords(apiKey, keywords, 25, 5);
    } catch (err) {
      elizaLogger.error("[neynar-search] searchAllKeywords threw:", err);
      casts = [];
    }

    elizaLogger.log(
      `[neynar-search] Fetched ${casts.length} unique casts across ${keywords.length} keywords`
    );

    // 4. Score, filter, rank
    const opportunities = scoreAndRank(casts, keywords, MIN_SCORE, MAX_RESULTS);

    elizaLogger.log(
      `[neynar-search] ${opportunities.length} opportunities above threshold (min ${MIN_SCORE}/10)`
    );

    // 5. Format queue
    const queueText = formatQueue(opportunities, timestamp);

    // 6. Deliver to Archon (non-blocking)
    deliverToArchon(queueText).catch(() => {
      /* logged inside */
    });

    // 7. Return to Scout via callback
    callback({ text: queueText });

    return true;
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Run a discovery cycle on Farcaster for EU energy policy.",
        },
      },
      {
        user: "The Scout",
        content: {
          text: "[SCOUT CYCLE 2024-01-15T10:00:00Z] — 3 opportunity(ies) queued\n\n1. SCORE 9/10 — @ischinger\n   URL: https://warpcast.com/ischinger/0x1a2b3c4d\n   Reach: 84,700 followers [⚡ power badge]\n   Engagement: 847L / 32RC / 62R (941 total)\n   Keywords: EU energy, European sovereignty\n   Angle: Lead with a data-rich counterpoint on \"EU energy\" — @ischinger's 941 total interactions signal peak thread momentum.\n\nQueue delivered to Archon. 3 item(s). Cycle complete.",
          action: "SEARCH_FARCASTER",
        },
      },
    ],
  ],
};
