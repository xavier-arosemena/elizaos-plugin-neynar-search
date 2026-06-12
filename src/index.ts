// =============================================================================
// elizaos-plugin-neynar-search — ElizaOS plugin entry point
//
// Registers six actions:
//   SEARCH_FARCASTER    — Topic discovery and opportunity scoring
//   LIKE_FARCASTER      — Batch like with daily budget, rate limiting, dedup
//   REPLY_DIRECT_CAST   — Direct Cast (DM) processing and reply (ISSUE #9)
//   REPLY_FARCASTER     — Public reply on Scout-identified casts (ISSUE #10)
//   FOLLOW_FARCASTER    — Follow profiles from Scout watchlist (every 12h)
//   UNFOLLOW_FARCASTER  — Weekly reciprocal unfollow check (staggered pagination)
// =============================================================================

import type { Plugin } from "@elizaos/core";
import { searchFarcasterAction } from "./actions/searchFarcaster.js";
import { likeFarcasterAction } from "./actions/likeFarcaster.js";
import { replyDirectCastAction } from "./actions/replyDirectCast.js";
import { replyFarcasterAction } from "./actions/replyFarcaster.js";
import { followFarcasterAction } from "./actions/followFarcaster.js";
import { unfollowFarcasterAction } from "./actions/unfollowFarcaster.js";

export const neynarSearchPlugin: Plugin = {
  name: "elizaos-plugin-neynar-search",
  description:
    "Farcaster engagement discovery, like, reply, and follow/unfollow actions " +
    "via Neynar REST API. Provides SEARCH_FARCASTER (scout/topic discovery), " +
    "LIKE_FARCASTER (batch like with daily budget), REPLY_DIRECT_CAST " +
    "(DM processing, spam filtering, priority scoring), REPLY_FARCASTER " +
    "(public replies on Scout-identified casts with LLM generation), " +
    "FOLLOW_FARCASTER (follow profiles from Scout watchlist), and " +
    "UNFOLLOW_FARCASTER (weekly reciprocal unfollow with staggered pagination).",
  actions: [
    searchFarcasterAction,
    likeFarcasterAction,
    replyDirectCastAction,
    replyFarcasterAction,
    followFarcasterAction,
    unfollowFarcasterAction,
  ],
  evaluators: [],
  providers: [],
};

export default neynarSearchPlugin;

// Named re-exports for convenience
export { searchFarcasterAction } from "./actions/searchFarcaster.js";
export { likeFarcasterAction } from "./actions/likeFarcaster.js";
export { replyDirectCastAction } from "./actions/replyDirectCast.js";
export { replyFarcasterAction } from "./actions/replyFarcaster.js";
export { followFarcasterAction } from "./actions/followFarcaster.js";
export { unfollowFarcasterAction } from "./actions/unfollowFarcaster.js";
export { createPluginConfig } from "./actions/searchFarcaster.js";
export {
  lookupCast,
  searchCasts,
  getUserCasts,
  searchAllKeywords,
  likeCast,
  batchLikeCasts,
  replyToCast,
  sendDirectCast,
  lookupUserByFid,
  followUsers,
  unfollowUsers,
  getFollowersPage,
} from "./lib/neynarClient.js";
export type {
  NeynarCast,
  ScoredOpportunity,
  PluginConfig,
  ScoutCycleState,
  MonitoredProfile,
  LikeConfig,
  LikeState,
  LikeCycleResult,
  DirectCastNotification,
  DmConfig,
  DmPriorityState,
  FollowConfig,
  FollowState,
  FollowCycleResult,
  UnfollowCycleResult,
  ReplyConfig,
  ReplyTarget,
  ReplyState,
  ReplyCycleResult,
} from "./types.js";
