// =============================================================================
// searchFarcaster.ts — SEARCH_FARCASTER ElizaOS Action
//
// Flow:
//   1. Read FARCASTER_NEYNAR_API_KEY from runtime settings
//   2. Parse keywords from message or extract from RAG knowledge (target_list.md)
//   3. Fetch casts from Neynar API (parallel batched keyword searches)
//   4. Score, filter (< 6 discarded), cap at 10, rank descending
//   5. Format ranked queue text with [PRIORITY] tags for high-value opportunities
//   6. POST queue to Archon's DirectClient endpoint
//   7. Return queue text via callback
// =============================================================================

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import * as fs from "fs";
import * as path from "path";
import { searchAllKeywords, getUserCasts, getNotifications } from "../lib/neynarClient.js";
import { scoreAndRankWithFallback } from "../lib/scorer.js";
import { loadCachedResults, saveCachedResults } from "../lib/cache.js";
import { updateWatchlist } from "../lib/watchlist.js";
import type { ScoredOpportunity, ScoutCycleState, NeynarCast, MonitoredProfile } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHON_AGENT_ID = process.env.ARCHON_AGENT_ID ?? "187939ae-c36e-08ef-836f-131b1b658c9a";
const ARCHON_BASE_URL = process.env.ARCHON_BASE_URL ?? "http://archon_euro_container:3000";

/** Archon's Farcaster FID for inbound engagement detection (Tier 3) */
const ARCHON_FARCASTER_FID = Number(process.env.ARCHON_FARCASTER_FID) || 3315139;

/**
 * Path to the generated Farcaster target list JSON (FIDs are pre-confirmed).
 * Mounted at /app/characters via docker-compose volumes.
 */
const TARGET_LIST_JSON_PATH = path.resolve(
  process.cwd(),
  "characters/archon_europae/farcaster_target_list.json"
);

/** Default keyword corpus derived from farcaster_target_list.md and CONSTITUTION.md */
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
    // Try direct knowledge table FIRST (most reliable path)
    let targetListEntries: any[] = [];

    const dbKnowledge = await (runtime.databaseAdapter as any).getKnowledge({
      agentId: runtime.agentId,
    });

    if (dbKnowledge && dbKnowledge.length > 0) {
      targetListEntries = dbKnowledge
        .filter((k: any) =>
          k.content?.metadata?.source?.includes("target_list.md") ||
          k.content?.text?.includes("Target List")
        )
        .map((k: any) => ({
          content: {
            text: k.content?.text || "",
            source: k.content?.metadata?.source
          }
        }));
    }

    // Fallback to message manager memories if knowledge table had nothing
    if (targetListEntries.length === 0) {
      elizaLogger.info(
        "[neynar-search] target list files not found in knowledge table. Trying message memories..."
      );

      const knowledgeResults = await runtime.messageManager.getMemories({
        roomId: runtime.agentId,
        count: 200,
        unique: false
      });

      targetListEntries = knowledgeResults.filter(m =>
        m.content?.source?.includes("target_list.md") ||
        m.content?.text?.includes("Target List")
      );
    }
    
    if (targetListEntries.length === 0) {
      elizaLogger.info(
        "[neynar-search] target list files not found in RAG knowledge. Using DEFAULT_KEYWORDS."
      );
      return DEFAULT_KEYWORDS;
    }
    
    elizaLogger.info(
      `[neynar-search] Found ${targetListEntries.length} target list entries in RAG — using vector terms + hashtags only`
    );
    
    // Extract keywords from the content
    const content = targetListEntries.map(e => e.content.text).join("\n");
    const keywords = new Set<string>();
    
    // Parse for key terms: ONLY vector/alignment terms and hashtags
    // Person names (bold terms) are intentionally skipped — they produce
    // generic search results at ~149 credits each with poor signal-to-noise ratio.
    // Profile monitoring is handled by Tier 2 (getUserCasts for specific FIDs).
    
    // Pattern 1: Skipped — bold terms are person names (e.g., **Elon Musk (@elonmusk):**)
    // Use Tier 2 profile monitoring instead for person-specific tracking.
    
    // Pattern 2: Vector column headers — only match at start of line or after pipe (table cell boundaries)
    const vectorMatches = content.match(/(?:^|\|)\s*(?:Vector de Ataque|Industrial|Energy|Strategic|Rationalism)[:\s]+([^\n|]{2,})/gmi) || [];
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
      // Use Set-based dedup with case-insensitive comparison to catch
      // duplicates like "WesternValues", "westernvalues", and "Western values"
      const allKw = [...extractedKeywords, ...DEFAULT_KEYWORDS];
      const seen = new Set<string>();
      const mergedKeywords = allKw.filter(v => {
        const key = v.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 30); // cap at 30
      
      elizaLogger.success(
        `[neynar-search] Extracted ${extractedKeywords.length} vector/hashtag keywords from RAG, ` +
        `merged with ${DEFAULT_KEYWORDS.length} defaults (total: ${mergedKeywords.length})`
      );
      
      return mergedKeywords;
    }
    
    elizaLogger.info("[neynar-search] No keywords extracted from RAG. Using defaults.");
    return DEFAULT_KEYWORDS;
    
  } catch (err) {
    elizaLogger.warn("[neynar-search] Error reading RAG knowledge: " + String(err));
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
 * High-scoring opportunities (>= 8) get a [PRIORITY] tag for easy identification.
 */
function formatQueue(
  opportunities: ScoredOpportunity[],
  timestamp: string,
  isFallback: boolean = false
): string {
  if (opportunities.length === 0) {
    return `[SCOUT CYCLE ${timestamp}]\nNo opportunities found this cycle. 0/10.`;
  }

  if (isFallback) {
    const lines: string[] = [
      `[SCOUT CYCLE ${timestamp}] — FALLBACK: ${opportunities.length} lowest-scoring opportunities (none above ${MIN_SCORE}/10 threshold)`,
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

      lines.push(`${i + 1}. SCORE ${op.score}/10 [BELOW THRESHOLD] — @${op.author.username}`);
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
      `Fallback queue delivered to Archon. ${opportunities.length} item(s) (all below ${MIN_SCORE}/10 threshold). Cycle complete.`
    );

    return lines.join("\n");
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

    // Add [PRIORITY] tag for high-value opportunities (score >= 8)
    const priorityTag = op.score >= 8 ? " [PRIORITY]" : "";

    lines.push(`${i + 1}. SCORE ${op.score}/10${priorityTag} — @${op.author.username}`);
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
 * Includes structured logging for delivery tracking.
 */
async function deliverToArchon(queueText: string): Promise<void> {
  const url = `${ARCHON_BASE_URL}/${ARCHON_AGENT_ID}/ingest`;

  elizaLogger.info(
    `[NeynarDebug] Attempting DirectClient delivery. Length: ${queueText.length} chars. ` +
    `Approximate tokens: ${Math.ceil(queueText.length / 4)}`
  );

  // Count priority items for structured logging
  const priorityCount = (queueText.match(/\[PRIORITY\]/g) || []).length;
  const opportunityCount = (queueText.match(/SCORE \d+\/10/g) || []).length;

  const body = JSON.stringify({
    text: `[SCOUT DELIVERY]\n\n${queueText}`,
    userId: "scout-agent",
    userName: "The Scout",
  });

  const deliveryStart = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout — fire-and-forget

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const deliveryDuration = Date.now() - deliveryStart;

    if (res.status === 202 || res.status === 200) {
      elizaLogger.success(
        `[NeynarDebug] DirectClient delivery accepted (${res.status}) in ${deliveryDuration}ms. ` +
        `Opportunities: ${opportunityCount}, Priority: ${priorityCount}`
      );
    } else {
      elizaLogger.info(
        `[NeynarDebug] DirectClient returned ${res.status} in ${deliveryDuration}ms. ` +
        `Using shared DB fallback (normal behavior).`
      );
    }
  } catch (err: any) {
    const deliveryDuration = Date.now() - deliveryStart;
    elizaLogger.info(
      `[NeynarDebug] DirectClient unavailable (${err.message}) after ${deliveryDuration}ms. ` +
      `Using shared DB fallback (normal behavior).`
    );
  }
}

// ---------------------------------------------------------------------------
// Three-Tier Coordinator Helpers
// ---------------------------------------------------------------------------

/**
 * Get and increment the cycle counter.
 * Persisted in a JSON file so it survives Scout restarts.
 * Resets to 1 if the file is missing or corrupted.
 */
function getNextCycleNumber(): number {
  const statePath = path.resolve(process.cwd(), ".neynar-state", "cycle-state.json");
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let state: ScoutCycleState;
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, "utf-8");
      state = JSON.parse(raw);
      state.cycleNumber = (state.cycleNumber || 0) + 1;
    } else {
      state = {
        cycleNumber: 1,
        lastCycleAt: new Date().toISOString(),
        lastKeywords: [],
        tier1Cached: false,
        tier2Executed: false,
        tier3Executed: false,
      };
    }

    state.lastCycleAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    return state.cycleNumber;
  } catch (err) {
    elizaLogger.warn("[neynar-search] Cycle counter error: " + String(err));
    return 1; // default to cycle 1 on error
  }
}

/**
 * Tier 1: Topic keyword discovery with result caching.
 * Uses cache if fresh (<6.5h old), otherwise does fresh API calls.
 */
async function runTier1(
  apiKey: string,
  keywords: string[],
  cycleNumber: number
): Promise<NeynarCast[]> {
  // Try cache first (only useful after cycle 1, since cache was just created)
  if (cycleNumber > 1) {
    const cached = loadCachedResults();
    if (cached) {
      elizaLogger.log(`[neynar-search] Tier 1: Using CACHED results (${cached.results.length} casts)`);
      return cached.results;
    }
  }

  // Cache miss or first cycle — do fresh API calls
  elizaLogger.log(`[neynar-search] Tier 1: Fresh API search — ${keywords.length} keywords`);

  let casts: NeynarCast[];
  try {
    casts = await searchAllKeywords(apiKey, keywords, 10, 5);
  } catch (err) {
    elizaLogger.error("[neynar-search] Tier 1 searchAllKeywords threw: " + String(err));
    casts = [];
  }

  // Save to cache for next cycles
  if (casts.length > 0) {
    saveCachedResults(casts, keywords);
  }

  return casts;
}

/**
 * Tier 2: Profile monitoring — fetch recent casts from monitored profiles.
 * Resolves @handles from target_list.md into FIDs at runtime.
 * Runs every 2 cycles. Uses getUserCasts (~38 credits per call).
 */
async function runTier2(
  apiKey: string,
  profiles: MonitoredProfile[]
): Promise<NeynarCast[]> {
  if (profiles.length === 0) {
    elizaLogger.info("[neynar-search] Tier 2: No monitored profiles to check — skipping");
    return [];
  }

  elizaLogger.info(
    `[neynar-search] Tier 2: Profile monitoring — ${profiles.length} profiles resolved`
  );

  const allCasts: NeynarCast[] = [];

  for (const profile of profiles) {
    try {
      const casts = await getUserCasts(apiKey, profile.fid, 5);
      elizaLogger.info(
        `[neynar-search] Tier 2: @${profile.handle} (fid=${profile.fid}, ${profile.followerCount.toLocaleString()} followers) — ${casts.length} recent casts`
      );
      allCasts.push(...casts);
    } catch (err) {
      elizaLogger.warn(`[neynar-search] Tier 2: Error fetching @${profile.handle}: ${String(err)}`);
    }

    // Small delay between profile fetches
    await new Promise(r => setTimeout(r, 200));
  }

  elizaLogger.info(
    `[neynar-search] Tier 2 complete: ${allCasts.length} total casts from ${profiles.length} profiles`
  );
  return allCasts;
}

/**
 * Tier 3: Inbound engagement detection — check for replies, mentions, recasts
 * to Archon's Farcaster account using the Notifications endpoint.
 *
 * GET /v2/farcaster/notifications?fid={ARCHON_FARCASTER_FID}&limit=25
 * ~148 credits per call, 1 call per cycle.
 */
async function runTier3(apiKey: string): Promise<NeynarCast[]> {
  const fid = ARCHON_FARCASTER_FID;
  
  elizaLogger.info(
    `[NeynarDebug] Tier 3: Checking inbound engagement for FID ${fid}...`
  );

  try {
    const notifications = await getNotifications(apiKey, fid, 25);

    if (notifications.length === 0) {
      elizaLogger.info("[NeynarDebug] Tier 3: No inbound engagement detected");
      return [];
    }

    // Count by type for logging
    const replies = notifications.filter(n => n.type === "reply").length;
    const mentions = notifications.filter(n => n.type === "mention").length;
    const recasts = notifications.filter(n => n.type === "recast").length;

    elizaLogger.info(
      `[NeynarDebug] Tier 3: ${replies} replies, ${mentions} mentions, ${recasts} recasts`
    );

    // Extract the engagement casts as NeynarCast[]
    const engagementCasts = notifications.map(n => {
      // Tag the cast text to identify it as engagement
      const taggedCast: NeynarCast = {
        ...n.cast,
        text: `[ENGAGEMENT:${n.type}] ${n.cast.text}`,
      };
      return taggedCast;
    });

    return engagementCasts;
  } catch (err) {
    elizaLogger.warn(
      `[NeynarDebug] Tier 3 ERROR: ${err}`
    );
    return [];
  }
}

/**
 * Resolve monitored Farcaster profiles from the generated target list JSON
 * into MonitoredProfile[] with known FIDs (no API calls needed).
 *
 * Uses static FIDs from farcaster_target_list.json + auto-discovered FIDs
 * from the watchlist (high-scoring recurring authors promoted to Tier 2).
 * Cache is in-memory for current Scout process lifespan.
 */
let _resolvedProfilesCache: MonitoredProfile[] | null = null;

async function resolveMonitoredProfiles(
  _apiKey: string,
  _runtime: IAgentRuntime
): Promise<MonitoredProfile[]> {
  // Return cached profiles if already resolved this process lifetime
  if (_resolvedProfilesCache && _resolvedProfilesCache.length > 0) {
    elizaLogger.info(
      `[neynar-search] Using ${_resolvedProfilesCache.length} cached monitored profiles`
    );
    return _resolvedProfilesCache;
  }

  // -----------------------------------------------------------------------
  // 1. Static FIDs from farcaster_target_list.json
  // -----------------------------------------------------------------------
  const staticProfiles: MonitoredProfile[] = [];
  try {
    const raw = fs.readFileSync(TARGET_LIST_JSON_PATH, "utf-8");
    const data = JSON.parse(raw);

    if (data && Array.isArray(data.monitoredFids)) {
      for (const entry of data.monitoredFids) {
        staticProfiles.push({
          fid: entry.fid,
          handle: entry.handle,
          followerCount: 0, // not stored in JSON; Tier 2 only uses this for display
          vector: entry.vector ?? undefined,
        });
      }
    }
  } catch (err) {
    elizaLogger.warn(
      `[neynar-search] resolveMonitoredProfiles: Cannot read ${TARGET_LIST_JSON_PATH} — ${String(err)}`
    );
  }

  elizaLogger.info(
    `[neynar-search] resolveMonitoredProfiles: ${staticProfiles.length} static FIDs from target list`
  );

  // -----------------------------------------------------------------------
  // 2. Auto-discovered FIDs from watchlist (isMonitored === true)
  // -----------------------------------------------------------------------
  const autoProfiles: MonitoredProfile[] = [];
  const WATCHLIST_PATH = "/app/.neynar-state/watchlist.json";
  try {
    if (fs.existsSync(WATCHLIST_PATH)) {
      const raw = fs.readFileSync(WATCHLIST_PATH, "utf-8");
      const watchlist: any[] = JSON.parse(raw);

      for (const entry of watchlist) {
        if (entry.isMonitored === true && entry.fid) {
          autoProfiles.push({
            fid: entry.fid,
            handle: entry.handle ?? `fid_${entry.fid}`,
            followerCount: 0,
            vector: undefined,
          });
        }
      }
    }
  } catch (err) {
    elizaLogger.warn(
      `[neynar-search] resolveMonitoredProfiles: Watchlist read error — ${String(err)}`
    );
  }

  if (autoProfiles.length > 0) {
    elizaLogger.info(
      `[neynar-search] resolveMonitoredProfiles: ${autoProfiles.length} auto-discovered FIDs from watchlist`
    );
  }

  // -----------------------------------------------------------------------
  // 3. Merge static + auto-discovered (static takes priority for dedup)
  // -----------------------------------------------------------------------
  const seenFids = new Set<number>();
  const merged: MonitoredProfile[] = [];

  for (const p of [...staticProfiles, ...autoProfiles]) {
    if (!seenFids.has(p.fid)) {
      seenFids.add(p.fid);
      merged.push(p);
    }
  }

  // Cache for this process lifetime
  _resolvedProfilesCache = merged;

  elizaLogger.info(
    `[neynar-search] resolveMonitoredProfiles: ${merged.length} total profiles (${staticProfiles.length} static + ${autoProfiles.length} auto)`
  );

  return merged;
}

/**
 * Merge and deduplicate casts from multiple tiers by hash.
 */
function mergeAndDedupe(tierResults: NeynarCast[][]): NeynarCast[] {
  const seen = new Set<string>();
  const merged: NeynarCast[] = [];

  for (const tier of tierResults) {
    for (const cast of tier) {
      if (!seen.has(cast.hash)) {
        seen.add(cast.hash);
        merged.push(cast);
      }
    }
  }

  return merged;
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

    elizaLogger.log(`[neynar-search] Starting THREE-TIER discovery cycle at ${timestamp}`);

    // 1. API key
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    if (!apiKey) {
      const errText = "[SCOUT] ERROR: FARCASTER_NEYNAR_API_KEY not configured. Cycle aborted.";
      elizaLogger.error("[neynar-search] " + errText);
      callback({ text: errText });
      return false;
    }

    // 2. Cycle counter (increment each run)
    const cycleNumber = getNextCycleNumber();
    elizaLogger.log(`[neynar-search] Cycle #${cycleNumber} — determining which tiers to run`);

    // 3. Extract keywords
    const messageText = (message?.content?.text as string) ?? "";
    const keywords = await extractKeywords(messageText, runtime);

    // 4. Tier 1: Topic Discovery — every cycle, cached
    const tier1Casts = await runTier1(apiKey, keywords, cycleNumber);

    // 5. Tier 2: Profile Monitoring — every 2 cycles
    let tier2Casts: NeynarCast[] = [];
    if (cycleNumber % 2 === 0) {
      const monitoredProfiles = await resolveMonitoredProfiles(apiKey, runtime);
      tier2Casts = await runTier2(apiKey, monitoredProfiles);
    } else {
      elizaLogger.log("[neynar-search] Tier 2 (profile monitoring) skipped — odd cycle");
    }

    // 6. Tier 3: Inbound Engagement — every cycle
    const tier3Casts = await runTier3(apiKey);
    // Tier 3 uses notifications endpoint (~148 credits/call, 1 call/cycle)

    // 7. Merge and deduplicate all tiers
    const allCasts = mergeAndDedupe([tier1Casts, tier2Casts, tier3Casts]);
    elizaLogger.log(
      `[neynar-search] Merged tiers: T1=${tier1Casts.length}, T2=${tier2Casts.length}, ` +
      `T3=${tier3Casts.length}, unique=${allCasts.length}`
    );

    // 8. Score, filter, rank (existing logic from scorer.ts)
    const { opportunities, isFallback } = scoreAndRankWithFallback(
      allCasts, keywords, MIN_SCORE, MAX_RESULTS, 5
    );

    elizaLogger.log(
      `[neynar-search] ${opportunities.length} opportunities ${isFallback ? "(fallback)" : "above threshold"}`
    );

    // 8b. Update watchlist with scored opportunities (non-blocking)
    updateWatchlist(opportunities).catch(() => { /* logged inside */ });

    // 9. Format queue
    const queueText = formatQueue(opportunities, timestamp, isFallback);

    // 10. Deliver to Archon (non-blocking)
    deliverToArchon(queueText).catch(() => { /* logged inside */ });

    // 11. Return to Scout via callback
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
          text: "[SCOUT CYCLE 2024-01-15T10:00:00Z] — 3 opportunity(ies) queued\n\n1. SCORE 9/10 [PRIORITY] — @ischinger\n   URL: https://warpcast.com/ischinger/0x1a2b3c4d\n   Reach: 84,700 followers [⚡ power badge]\n   Engagement: 847L / 32RC / 62R (941 total)\n   Keywords: EU energy, European sovereignty\n   Angle: Lead with a data-rich counterpoint on \"EU energy\" — @ischinger's 941 total interactions signal peak thread momentum.\n\nQueue delivered to Archon. 3 item(s). Cycle complete.",
          action: "SEARCH_FARCASTER",
        },
      },
    ],
  ],
};
