// =============================================================================
// unfollowFarcaster.ts — UNFOLLOW_FARCASTER action
//
// Runs once per week (Sunday 04:00 UTC) on Archon.
// Uses staggered pagination: fetches 1 page of Archon's followers, compares
// against the followed FIDs list, and unfollows any that no longer follow back.
//
// Staggered pagination:
//   - Each cycle fetches one page (up to 150 follower FIDs) using the saved cursor
//   - Compares those FIDs against followedFids
//   - Any followed FID not in this page is an unfollow candidate
//   - Saves the cursor for next week (null = restart from page 1)
//   - Over N weekly cycles, the full follower set is covered with 1 API call/cycle
// =============================================================================

import type { IAgentRuntime, Memory, State, Action } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import {
  loadFollowState,
  saveFollowState,
  markUnfollowed,
  updateFollowerCursor,
} from "../lib/followState.js";
import { unfollowUsers, getFollowersPage } from "../lib/neynarClient.js";
import type { FollowState, UnfollowCycleResult } from "../types.js";

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const unfollowFarcasterAction: Action = {
  name: "UNFOLLOW_FARCASTER",
  similes: ["UNFOLLOW"],
  description:
    "Weekly reciprocal unfollow check. Fetches one page of Archon's " +
    "followers via staggered pagination, compares against the followed " +
    "FIDs list, and unfollows accounts that no longer follow back " +
    "(up to UNFOLLOW_MAX_PER_CYCLE).",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY");
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID");
    const archonFid = runtime.getSetting("FARCASTER_FID");

    elizaLogger.info(
      `[NeynarDebug] UNFOLLOW_FARCASTER: validate — ` +
      `apiKey=${!!apiKey} signerUuid=${!!signerUuid} archonFid=${!!archonFid}`
    );

    if (!apiKey || !signerUuid || !archonFid) {
      elizaLogger.warn(
        "[NeynarDebug] UNFOLLOW_FARCASTER: missing required settings " +
        "(FARCASTER_NEYNAR_API_KEY, FARCASTER_NEYNAR_SIGNER_UUID, FARCASTER_FID)"
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
    elizaLogger.info("[NeynarDebug] UNFOLLOW_FARCASTER: weekly cycle started");

    // -----------------------------------------------------------------------
    // Phase 1: Load config
    // -----------------------------------------------------------------------
    const apiKey = runtime.getSetting("FARCASTER_NEYNAR_API_KEY")!;
    const signerUuid = runtime.getSetting("FARCASTER_NEYNAR_SIGNER_UUID")!;
    const archonFid = parseInt(runtime.getSetting("FARCASTER_FID")!, 10);
    const maxUnfollows = parseInt(
      runtime.getSetting("UNFOLLOW_MAX_PER_CYCLE") || "5"
    );

    elizaLogger.info(
      `[NeynarDebug] UNFOLLOW_FARCASTER: config — ` +
      `archonFid=${archonFid} maxUnfollows=${maxUnfollows}`
    );

    // -----------------------------------------------------------------------
    // Phase 2: Load state
    // -----------------------------------------------------------------------
    const followState: FollowState = loadFollowState();

    elizaLogger.info(
      `[NeynarDebug] UNFOLLOW_FARCASTER: state loaded — ` +
      `${followState.followedFids.length} currently followed, ` +
      `cycle #${followState.unfollowCycleCount}, ` +
      `cursor=${followState.followerCursor || "null (starting fresh)"}`
    );

    // -----------------------------------------------------------------------
    // Phase 3: Fetch one page of followers
    // -----------------------------------------------------------------------
    const { fids: pageFids, nextCursor } = await getFollowersPage(
      apiKey,
      archonFid,
      150,
      followState.followerCursor
    );

    elizaLogger.info(
      `[NeynarDebug] UNFOLLOW_FARCASTER: received ${pageFids.length} follower FIDs from this page, ` +
      `hasMore=${nextCursor !== null}`
    );

    if (pageFids.length === 0) {
      elizaLogger.warn(
        "[NeynarDebug] UNFOLLOW_FARCASTER: no followers returned — " +
        "possible API issue or Archon has no followers yet"
      );
    }

    // -----------------------------------------------------------------------
    // Phase 4: Compare against followed FIDs
    // -----------------------------------------------------------------------
    const pageFollowerSet = new Set(pageFids);
    const toUnfollow = followState.followedFids
      .filter((fid) => !pageFollowerSet.has(fid))
      .slice(0, maxUnfollows);

    elizaLogger.info(
      `[NeynarDebug] UNFOLLOW_FARCASTER: ${toUnfollow.length} unfollow candidates ` +
      `(checked ${followState.followedFids.length} followed FIDs against ` +
      `${pageFids.length} follower FIDs on this page)`
    );

    // -----------------------------------------------------------------------
    // Phase 5: Execute unfollows
    // -----------------------------------------------------------------------
    const result: UnfollowCycleResult = {
      unfollowed: 0,
      pageSize: pageFids.length,
      pageRemaining: nextCursor !== null,
      checkedFids: followState.followedFids.length,
      errors: [],
    };

    if (toUnfollow.length > 0) {
      elizaLogger.info(
        `[NeynarDebug] UNFOLLOW_FARCASTER: unfollowing ${toUnfollow.length} users: [${toUnfollow.join(", ")}]`
      );

      const unfollowResult = await unfollowUsers(apiKey, signerUuid, toUnfollow);

      if (unfollowResult.success && unfollowResult.unfollowed.length > 0) {
        markUnfollowed(followState, unfollowResult.unfollowed);
        result.unfollowed = unfollowResult.unfollowed.length;
        elizaLogger.info(
          `[NeynarDebug] UNFOLLOW_FARCASTER: successfully unfollowed ${unfollowResult.unfollowed.length} users`
        );
      }

      if (unfollowResult.errors.length > 0) {
        result.errors = unfollowResult.errors.map(
          (e) => `FID ${e.fid}: ${e.reason}`
        );
        elizaLogger.warn(
          `[NeynarDebug] UNFOLLOW_FARCASTER: ${unfollowResult.errors.length} unfollow errors: ${result.errors.join("; ")}`
        );
      }
    } else {
      elizaLogger.info(
        "[NeynarDebug] UNFOLLOW_FARCASTER: all followed accounts reciprocate on this page — no unfollows needed"
      );
    }

    // -----------------------------------------------------------------------
    // Phase 6: Save cursor for next week
    // -----------------------------------------------------------------------
    updateFollowerCursor(followState, nextCursor, pageFids.length);
    followState.unfollowCycleCount++;
    followState.lastUnfollowCycle = new Date().toISOString();
    saveFollowState(followState);

    const passStatus = result.pageRemaining
      ? `More pages to check next week (${result.pageSize} FIDs checked this week)`
      : "Full follower pass complete — restarting from page 1 next week";

    elizaLogger.info(
      `[NeynarDebug] UNFOLLOW_FARCASTER: cycle #${followState.unfollowCycleCount} complete — ` +
      `unfollowed=${result.unfollowed} pageSize=${result.pageSize} ` +
      `pageRemaining=${result.pageRemaining} errors=${result.errors.length}`
    );

    callback({
      text: `UNFOLLOW_FARCASTER cycle #${followState.unfollowCycleCount} complete.
- Unfollowed: ${result.unfollowed} users
- Follower page checked: ${result.pageSize} FIDs
- Followed accounts checked against this page: ${result.checkedFids}
- Status: ${passStatus}
- Currently following: ${followState.followedFids.length} users
- Errors: ${result.errors.length > 0 ? result.errors.join("; ") : "none"}`,
    });
  },
};
