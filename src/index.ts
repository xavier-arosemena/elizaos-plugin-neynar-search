// =============================================================================
// @elizaos/plugin-neynar-search — ElizaOS plugin entry point
//
// Registers the SEARCH_FARCASTER action for read-only Farcaster discovery
// via the Neynar REST API. No signer required. No Farcaster client needed.
// =============================================================================

import type { Plugin } from "@elizaos/core";
import { searchFarcasterAction } from "./actions/searchFarcaster.js";

export const neynarSearchPlugin: Plugin = {
  name: "@elizaos/plugin-neynar-search",
  description:
    "Read-only Farcaster engagement discovery via Neynar REST API. " +
    "Provides the SEARCH_FARCASTER action: searches, scores (1–10), filters, " +
    "and delivers a ranked engagement queue to Archon's DirectClient.",
  actions: [searchFarcasterAction],
  evaluators: [],
  providers: [],
};

export default neynarSearchPlugin;

// Named re-exports for convenience
export { searchFarcasterAction } from "./actions/searchFarcaster.js";
export type { NeynarCast, ScoredOpportunity, PluginConfig } from "./types.js";
