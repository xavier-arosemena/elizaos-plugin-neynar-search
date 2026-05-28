// =============================================================================
// @elizaos/plugin-neynar-search — ElizaOS plugin entry point
//
// Registers SEARCH_FARCASTER (read-only discovery) and LIKE_FARCASTER
// (write-action like) actions via the Neynar REST API.
// =============================================================================

import type { Plugin } from "@elizaos/core";
import { searchFarcasterAction } from "./actions/searchFarcaster.js";
import { likeFarcasterAction } from "./actions/likeFarcaster.js";

export const neynarSearchPlugin: Plugin = {
  name: "@elizaos/plugin-neynar-search",
  description:
    "Farcaster engagement discovery and like actions via Neynar REST API. " +
    "Provides SEARCH_FARCASTER (scout/topic discovery) and LIKE_FARCASTER " +
    "(batch like with daily budget, rate limiting, dedup).",
  actions: [searchFarcasterAction, likeFarcasterAction],
  evaluators: [],
  providers: [],
};

export default neynarSearchPlugin;

// Named re-exports for convenience
export { searchFarcasterAction } from "./actions/searchFarcaster.js";
export { likeFarcasterAction } from "./actions/likeFarcaster.js";
export { createPluginConfig } from "./actions/searchFarcaster.js";
export { lookupCast, searchCasts, getUserCasts, searchAllKeywords, likeCast, batchLikeCasts } from "./lib/neynarClient.js";
export type {
  NeynarCast,
  ScoredOpportunity,
  PluginConfig,
  ScoutCycleState,
  MonitoredProfile,
  LikeConfig,
  LikeState,
  LikeCycleResult,
} from "./types.js";
