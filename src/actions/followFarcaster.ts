// =============================================================================
// followFarcaster.ts — FOLLOW_FARCASTER action
//
// Runs every 12h (03:00 / 15:00 UTC) on Archon.
// Follows high-scoring authors from the Scout's watchlist and deliveries.
//
// Flow:
//   1. Load follow-state.json + watchlist.json
//   2. Build candidate list from watchlist (auto-promoted Tier 2 authors)
//   3. Filter: remove already-followed, spam check (min followers + patterns)
//   4. Execute follows via Neynar API (max FOLLOW_MAX_PER_CYCLE)
//   5. Save updated state
// =============================================================================

import type { IAgentRuntime, Memory, State, Action } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { loadFollowState, saveFollowState, markFollowed, createDefaultFollowState } from "../lib/followState.js";
import { followUsers, lookupUserByFid } from "../lib/neynarClient.js";
import { getAutoDiscoveredFids } from "../lib/watchlist.js";
import type { FollowState, FollowCycleResult } from "../types.js";

// ---------------------------------------------------------------------------
// Spam filter patterns
// ---------------------------------------------------------------------------

function isSpamPattern(username: string, bio?: string): boolean {
  const patterns = [
    /crypto.?giveaway/i,
    /airdrop.?claim/i,
    /free.?nft/i,
    /^[A-Za-z0-9]{15,}$/,
    /earn.?btc/i,
    /click.?link/i,
    /claim.?reward/i,
  ];
  const text = `${username} ${bio || ""}`;
  return patterns.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const followFarcasterAction: Action = {
  name: "FOLLOW_FARCASTER",
  similes: ["FOLLOW"],
  description:
    "Follow new profiles discovered by the Scout. Reads the watchlist " +
    "for auto-promoted high-scoring authors and follows them up to the " +
    "configured limit per cycle. Filters spam accounts by minimum follower " +
    "count and pattern matching.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID");

    elizaLogger.info(
      `[NEYNAR-DEBUG] FOLLOW_FARCASTER: validate — apiKey=${!!apiKey} signerUuid=${!!signerUuid}`
    );

    if (!apiKey || !signerUuid) {
      elizaLogger.warn(
        "[NEYNAR-DEBUG] FOLLOW_FARCASTER: missing required settings (FARCASTER_NEYNAR_API_KEY, FARCASTER_NEYNAR_SIGNER_UUID)"
      );
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    callback: any
  ): Promise<void> => {
    elizaLogger.info("[NEYNAR-DEBUG] FOLLOW_FARCASTER: cycle started");

    // -----------------------------------------------------------------------
    // Phase 1: Load config
    // -----------------------------------------------------------------------
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY")!;
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID")!;
    const maxFollowsPerCycle = parseInt(
      runtime.getSetting("FOLLOW_MAX_PER_CYCLE") || "5"
    );
    const spamMinFollowers = parseInt(
      runtime.getSetting("FOLLOW_SPAM_MIN_FOLLOWERS") || "10"
    );

    elizaLogger.info(
      `[NEYNAR-DEBUG] FOLLOW_FARCASTER: config — maxFollows=${maxFollowsPerCycle} spamMinFollowers=${spamMinFollowers}`
    );

    // -----------------------------------------------------------------------
    // Phase 2: Load state
    // -----------------------------------------------------------------------
    const followState: FollowState = loadFollowState();

    elizaLogger.info(
      `[NEYNAR-DEBUG] FOLLOW_FARCASTER: state loaded — ${followState.followedFids.length} currently followed, ` +
      `cycle #${followState.followCycleCount}`
    );

    // -----------------------------------------------------------------------
    // Phase 3: Build candidate list from watchlist
    // -----------------------------------------------------------------------
    const candidates: Set<number> = new Set();
    const watchlistFids = getAutoDiscoveredFids();
    watchlistFids.forEach((e) => candidates.add(e.fid));

    elizaLogger.info(
      `[NEYNAR-DEBUG] FOLLOW_FARCASTER: ${watchlistFids.length} watchlist candidates`
    );

    // -----------------------------------------------------------------------
    // Phase 4: Filter candidates
    // -----------------------------------------------------------------------
    const followedSet = new Set(followState.followedFids);
    const toFollow: number[] = [];
    const stats = {
      alreadyFollowed: 0,
      spamFiltered: 0,
      lowFollowers: 0,
    };

    for (const fid of candidates) {
      if (toFollow.length >= maxFollowsPerCycle) {
        elizaLogger.info(
          `[NEYNAR-DEBUG] FOLLOW_FARCASTER: hit max follows (${maxFollowsPerCycle}), stopping candidate processing`
        );
        break;
      }

      // Skip already followed
      if (followedSet.has(fid)) {
        stats.alreadyFollowed++;
        continue;
      }

      // Look up user for spam check
      const user = await lookupUserByFid(apiKey, fid);
      if (!user) {
        elizaLogger.debug(
          `[NEYNAR-DEBUG] FOLLOW_FARCASTER: lookup failed for FID ${fid} — skipping`
        );
        continue;
      }

      // Check minimum followers
      if (user.follower_count < spamMinFollowers) {
        stats.lowFollowers++;
        elizaLogger.debug(
          `[NEYNAR-DEBUG] FOLLOW_FARCASTER: FID ${fid} @${user.username} ` +
          `has ${user.follower_count} followers (< ${spamMinFollowers}) — skipping`
        );
        continue;
      }

      // Check spam patterns
      if (isSpamPattern(user.username, user.profile?.bio?.text)) {
        stats.spamFiltered++;
        elizaLogger.debug(
          `[NEYNAR-DEBUG] FOLLOW_FARCASTER: FID ${fid} @${user.username} matched spam pattern — skipping`
        );
        continue;
      }

      toFollow.push(fid);
      elizaLogger.debug(
        `[NEYNAR-DEBUG] FOLLOW_FARCASTER: candidate accepted FID ${fid} @${user.username}`
      );
    }

    elizaLogger.info(
      `[NEYNAR-DEBUG] FOLLOW_FARCASTER: filtering complete — ` +
      `${stats.alreadyFollowed} already followed, ` +
      `${stats.lowFollowers} low followers, ` +
      `${stats.spamFiltered} spam patterns, ` +
      `${toFollow.length} to follow`
    );

    // -----------------------------------------------------------------------
    // Phase 5: Execute follows
    // -----------------------------------------------------------------------
    const result: FollowCycleResult = {
      followed: 0,
      attempted: candidates.size,
      skipped: candidates.size - toFollow.length - stats.alreadyFollowed,
      alreadyFollowed: stats.alreadyFollowed,
      spamFiltered: stats.lowFollowers + stats.spamFiltered,
      errors: [],
    };

    if (toFollow.length > 0) {
      elizaLogger.info(
        `[NEYNAR-DEBUG] FOLLOW_FARCASTER: following ${toFollow.length} users: [${toFollow.join(", ")}]`
      );

      const followResult = await followUsers(apiKey, signerUuid, toFollow);

      if (followResult.success && followResult.followed.length > 0) {
        markFollowed(followState, followResult.followed);
        result.followed = followResult.followed.length;
        elizaLogger.info(
          `[NEYNAR-DEBUG] FOLLOW_FARCASTER: successfully followed ${followResult.followed.length} users`
        );
      }

      if (followResult.errors.length > 0) {
        result.errors = followResult.errors.map((e) => `FID ${e.fid}: ${e.reason}`);
        elizaLogger.warn(
          `[NEYNAR-DEBUG] FOLLOW_FARCASTER: ${followResult.errors.length} follow errors: ${result.errors.join("; ")}`
        );
      }
    } else {
      elizaLogger.info("[NEYNAR-DEBUG] FOLLOW_FARCASTER: no candidates to follow this cycle");
    }

    // -----------------------------------------------------------------------
    // Phase 6: Finalize
    // -----------------------------------------------------------------------
    followState.followCycleCount++;
    followState.lastFollowCycle = new Date().toISOString();
    saveFollowState(followState);

    elizaLogger.info(
      `[NEYNAR-DEBUG] FOLLOW_FARCASTER: cycle #${followState.followCycleCount} complete — ` +
      `followed=${result.followed} attempted=${result.attempted} ` +
      `skipped=${result.skipped} spamFiltered=${result.spamFiltered} ` +
      `errors=${result.errors.length}`
    );

    callback({
      text: `FOLLOW_FARCASTER cycle #${followState.followCycleCount} complete.
- Followed: ${result.followed} users
- Attempted: ${result.attempted} candidates
- Skipped (already followed): ${result.alreadyFollowed}
- Filtered (spam / low followers): ${result.spamFiltered}
- Currently following: ${followState.followedFids.length} users
- Errors: ${result.errors.length > 0 ? result.errors.join("; ") : "none"}`,
    });
  },

  examples: [],
};
