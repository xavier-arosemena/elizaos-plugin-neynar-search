// =============================================================================
// scorer.ts — Three-axis weighted engagement opportunity scorer
//
// Three weighted axes (each 0–10), averaged to produce a 1–10 final score:
//   1. Author Reach       — log10(follower_count), +1 bonus for power badge  (weight: 3)
//   2. Engagement Velocity — likes + recasts + replies, linear scale          (weight: 3)
//   3. Topical Alignment  — keyword match count in cast text                  (weight: 4)
//
// Weights: Alignment (4) > Velocity (3) = Reach (3)
// Rationale: topical relevance matters most — the Scout's primary mission is
// finding casts that match Archon's strategic vectors. Engagement momentum and
// author reach are equally weighted as secondary signals.
// =============================================================================

import type { NeynarCast, ScoredOpportunity } from "../types.js";

// Weight constants — tunable
const WEIGHT_REACH = 3;
const WEIGHT_VELOCITY = 3;
const WEIGHT_ALIGNMENT = 4;
const WEIGHT_SUM = WEIGHT_REACH + WEIGHT_VELOCITY + WEIGHT_ALIGNMENT; // 10

// ---------------------------------------------------------------------------
// Axis 1: Author Reach
// ---------------------------------------------------------------------------
// log10 scale so massive accounts don't completely dominate.
// Reference points:
//   100 followers  → 2.0    (early community)
//   1 000          → 3.0
//   10 000         → 4.0
//   100 000        → 5.0    (mid-tier influencer)
//   1 000 000      → 6.0
// Normalized to 0–10 by dividing by 6 (1M is our practical max).
// Neynar power_badge adds +1 capped at 10.

function scoreAuthorReach(followerCount: number, powerBadge: boolean): number {
  if (followerCount <= 0) return 0;
  const log = Math.log10(followerCount);
  const normalized = Math.min(10, (log / 6) * 10);
  const bonus = powerBadge ? 1 : 0;
  return Math.min(10, normalized + bonus);
}

// ---------------------------------------------------------------------------
// Axis 2: Engagement Velocity
// ---------------------------------------------------------------------------
// Total interactions = likes + recasts + replies.
// Linear scale saturates at 500 total → score 10.
// Reference points:
//   0   → 0
//   10  → 0.2
//   50  → 1.0
//   100 → 2.0
//   250 → 5.0
//   500 → 10.0
//   500+→ 10.0 (capped)

function scoreEngagementVelocity(
  likesCount: number,
  recastsCount: number,
  repliesCount: number
): number {
  const total = (likesCount || 0) + (recastsCount || 0) + (repliesCount || 0);
  return Math.min(10, (total / 500) * 10);
}

// ---------------------------------------------------------------------------
// Axis 3: Topical Alignment
// ---------------------------------------------------------------------------
// Counts how many distinct keywords from the active corpus appear in the
// lower-cased cast text.
//   0 matches → 0
//   1 match   → 3.3
//   2 matches → 6.7
//   3+ matches → 10.0

function scoreTopicalAlignment(
  castText: string,
  keywords: string[]
): { score: number; matched: string[] } {
  const lower = castText.toLowerCase();
  const matched = keywords.filter((kw) => lower.includes(kw.toLowerCase()));
  const matchCount = matched.length;

  let score: number;
  if (matchCount === 0) score = 0;
  else if (matchCount === 1) score = 3.3;
  else if (matchCount === 2) score = 6.7;
  else score = 10;

  return { score, matched };
}

// ---------------------------------------------------------------------------
// Suggested reply angle generator
// ---------------------------------------------------------------------------
// One sentence, data-first, based on the strongest keyword match and
// engagement count.

function buildSuggestedAngle(
  cast: NeynarCast,
  matchedKeywords: string[],
  finalScore: number
): string {
  const totalEngagement =
    (cast.reactions?.likes_count || 0) +
    (cast.reactions?.recasts_count || 0) +
    (cast.replies?.count || 0);

  const topKeyword = matchedKeywords[0] ?? "this topic";
  const handleRef = `@${cast.author.username}`;

  if (finalScore >= 9) {
    return `Lead with a data-rich counterpoint on "${topKeyword}" — ${handleRef}'s ${totalEngagement} total interactions signal peak thread momentum.`;
  } else if (finalScore >= 7) {
    return `Engage ${handleRef} with a specific statistic on "${topKeyword}" — thread has ${totalEngagement} interactions and is still active.`;
  } else {
    return `Reply to ${handleRef} on "${topKeyword}" with a sourced data point to qualify the thread (${totalEngagement} interactions, score ${finalScore}/10).`;
  }
}

// ---------------------------------------------------------------------------
// Cast URL builder
// ---------------------------------------------------------------------------

function buildCastUrl(cast: NeynarCast): string {
  const username = cast.author?.username ?? "unknown";
  // Neynar hash is 0x-prefixed hex; Warpcast URL uses the short hash
  const shortHash = cast.hash?.slice(0, 10) ?? cast.hash;
  return `https://warpcast.com/${username}/${shortHash}`;
}

// ---------------------------------------------------------------------------
// Main scorer — accepts a cast and keyword corpus, returns a ScoredOpportunity
// ---------------------------------------------------------------------------

export function scoreCast(cast: NeynarCast, keywords: string[]): ScoredOpportunity {
  const reach = scoreAuthorReach(
    cast.author?.follower_count ?? 0,
    cast.author?.power_badge ?? false
  );
  const velocity = scoreEngagementVelocity(
    cast.reactions?.likes_count ?? 0,
    cast.reactions?.recasts_count ?? 0,
    cast.replies?.count ?? 0
  );
  const { score: alignment, matched } = scoreTopicalAlignment(cast.text ?? "", keywords);

  // Weighted average: Alignment (4) > Velocity (3) = Reach (3)
  const raw = (reach * WEIGHT_REACH + velocity * WEIGHT_VELOCITY + alignment * WEIGHT_ALIGNMENT) / WEIGHT_SUM;
  // Round to 1 decimal place, clamp to [1, 10]
  const score = Math.min(10, Math.max(1, Math.round(raw * 10) / 10));

  const suggestedAngle = buildSuggestedAngle(cast, matched, score);
  const castUrl = buildCastUrl(cast);

  return {
    ...cast,
    score,
    suggestedAngle,
    castUrl,
    matchedKeywords: matched,
  };
}

// ---------------------------------------------------------------------------
// Batch scorer + filter + sort
// ---------------------------------------------------------------------------

export function scoreAndRank(
  casts: NeynarCast[],
  keywords: string[],
  minScore = 6,
  maxResults = 10
): ScoredOpportunity[] {
  return casts
    .map((c) => scoreCast(c, keywords))
    .filter((o) => o.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Score, filter, and rank with fallback behavior.
 *
 * First tries the standard logic (filter ≥ minScore, sort, cap at maxResults).
 * If no opportunities meet the threshold, falls back to returning the top
 * `fallbackCount` highest-scoring casts regardless of score, tagged as fallback.
 *
 * Returns an object with:
 *   - opportunities: the ranked list
 *   - isFallback: true if no opportunities met the threshold
 */
export function scoreAndRankWithFallback(
  casts: NeynarCast[],
  keywords: string[],
  minScore = 6,
  maxResults = 10,
  fallbackCount = 5
): { opportunities: ScoredOpportunity[]; isFallback: boolean } {
  const scored = casts.map((c) => scoreCast(c, keywords));

  const aboveThreshold = scored
    .filter((o) => o.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (aboveThreshold.length > 0) {
    return { opportunities: aboveThreshold, isFallback: false };
  }

  // Fallback: take top N highest-scoring regardless of threshold
  const fallback = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, fallbackCount);

  return { opportunities: fallback, isFallback: true };
}
