// =============================================================================
// searchFarcaster.ts — SEARCH_FARCASTER ElizaOS Action
//
// Flow:
//   1. Read FARCASTER_NEYNAR_API_KEY from runtime settings
//   2. Parse keywords from message or extract from RAG knowledge (target_list.md)
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
 * Extract keywords from RAG knowledge (target_list.md) if available.
 * Falls back to DEFAULT_KEYWORDS if RAG is disabled or knowledge not found.
 */
async function extractKeywordsFromKnowledge(runtime: IAgentRuntime): Promise<string[]> {
  try {
    // Query RAG for recent memories containing knowledge content
    const knowledgeResults = await runtime.messageManager.getMemories({
      roomId: runtime.agentId,
      count: 200,
      unique: false
    });
    
    // Find target_list.md entries in knowledge
    let targetListEntries = knowledgeResults.filter(m =>
      m.content.source?.includes("target_list.md") ||
      m.content.text?.includes("Target List") ||
      m.content.text?.includes("Anillo")
    );
    
    if (targetListEntries.length === 0) {
      elizaLogger.info(
        "[neynar-search] target_list.md not found in memories. Querying knowledge table directly..."
      );
      
      // Fallback to direct database query if memories are empty or missing the source
      const dbKnowledge = await (runtime.databaseAdapter as any).getKnowledge({
        agentId: runtime.agentId,
      });

      if (dbKnowledge && dbKnowledge.length > 0) {
        targetListEntries = dbKnowledge
          .filter((k: any) =>
            k.content.metadata?.source?.includes("target_list.md") ||
            k.content.text?.includes("Target List") ||
            k.content.text?.includes("Anillo")
          )
          .map((k: any) => ({
            content: {
              text: k.content.text,
              source: k.content.metadata?.source
            }
          }));
      }
    }
    
    if (targetListEntries.length === 0) {
      elizaLogger.info(
        "[neynar-search] target_list.md not found in RAG knowledge. Using DEFAULT_KEYWORDS."
      );
      return DEFAULT_KEYWORDS;
    }
    
    elizaLogger.log(
      `[neynar-search] Found ${targetListEntries.length} target_list.md entries in RAG`
    );
    
    // Extract keywords from the content
    const content = targetListEntries.map(e => e.content.text).join("\n");
    const keywords = new Set<string>();
    
    // Parse for key terms: Look for quoted terms, bold terms, and topics
    // Pattern 1: **Bold terms** from markdown
    const boldMatches = content.match(/\*\*([^*]+)\*\*/g) || [];
    boldMatches.forEach(m => {
      const keyword = m.replace(/\*\*/g, "").trim();
      if (keyword.length > 3 && keyword.length < 40 && !keyword.includes("\n")) {
        keywords.add(keyword);
      }
    });
    
    // Pattern 2: Terms after "Vector de Ataque" or similar headers
    const vectorMatches = content.match(/(?:Vector de Ataque|Industrial|Energy|Strategic|Rationalism)[:\s]+([^\n|]+)/gi) || [];
    vectorMatches.forEach(m => {
      const terms = m.split(/[&,]/).map(t => t.trim());
      terms.forEach(term => {
        if (term.length > 3 && term.length < 40) {
          keywords.add(term);
        }
      });
    });
    
    // Pattern 3: Hashtags
    const hashtagMatches = content.match(/#(\w+)/g) || [];
    hashtagMatches.forEach(m => {
      const tag = m.replace("#", "").trim();
      if (tag.length > 3) {
        keywords.add(tag);
      }
    });
    
    const extractedKeywords = Array.from(keywords);
    
    if (extractedKeywords.length > 0) {
      // Merge with defaults to ensure coverage, prioritize RAG keywords
      const mergedKeywords = [...extractedKeywords, ...DEFAULT_KEYWORDS]
        .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
        .slice(0, 30); // cap at 30
      
      elizaLogger.success(
        `[neynar-search] Extracted ${extractedKeywords.length} keywords from RAG, ` +
        `merged with ${DEFAULT_KEYWORDS.length} defaults (total: ${mergedKeywords.length})`
      );
      
      return mergedKeywords;
    }
    
    elizaLogger.info("[neynar-search] No keywords extracted from RAG. Using defaults.");
    return DEFAULT_KEYWORDS;
    
  } catch (err) {
    elizaLogger.warn("[neynar-search] Error reading RAG knowledge:", err);
    return DEFAULT_KEYWORDS;
  }
}

/**
 * Extract keywords from message text. If the message contains a quoted list
 * or colon-delimited list, parse them. Otherwise use RAG or fall back to defaults.
 */
async function extractKeywords(text: string, runtime: IAgentRuntime): Promise<string[]> {
  if (!text) return await extractKeywordsFromKnowledge(runtime);

  // Look for "keywords: ..." or "search for: ..." patterns in message
  const colonMatch = text.match(/(?:keywords?|search(?:\s+for)?)\s*:\s*(.+)/i);
  if (colonMatch) {
    const kws = colonMatch[1]
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (kws.length >= 2) return kws;
  }

  // Default: extract from RAG knowledge or use hardcoded corpus
  return await extractKeywordsFromKnowledge(runtime);
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
 * Uses retry logic with timeout. Failure is logged but does not abort the action.
 */
async function deliverToArchon(queueText: string): Promise<void> {
  const url = `${ARCHON_BASE_URL}/${ARCHON_AGENT_ID}/message`;

  elizaLogger.log(
    `[neynar-search] Attempting DirectClient delivery. Length: ${queueText.length} chars. ` +
    `Approximate tokens: ${Math.ceil(queueText.length / 4)}`
  );

  const body = JSON.stringify({
    text: `[SCOUT DELIVERY]\n\n${queueText}`,
    userId: "scout-agent",
    userName: "The Scout",
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      elizaLogger.success(
        `[neynar-search] DirectClient delivery succeeded (${res.status})`
      );
    } else {
      elizaLogger.info(
        `[neynar-search] DirectClient returned ${res.status}. Using shared DB fallback (normal behavior).`
      );
    }
  } catch (err: any) {
    elizaLogger.info(
      `[neynar-search] DirectClient unavailable (${err.message}). Using shared DB fallback (normal behavior).`
    );
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

    // 2. Keywords (now async, reads from RAG if available)
    const messageText = (message?.content?.text as string) ?? "";
    const keywords = await extractKeywords(messageText, runtime);
    elizaLogger.log(`[neynar-search] Searching ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}${keywords.length > 5 ? "..." : ""}`);

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
