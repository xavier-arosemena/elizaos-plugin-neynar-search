# @elizaos/plugin-neynar-search

**Read-only Farcaster engagement discovery for ElizaOS agents via the Neynar REST API.**

No signer. No posting. No Farcaster client dependency. Pure signal detection.

---

## What it does

Registers a `SEARCH_FARCASTER` action that:

1. **Dynamically extracts keywords** from the agent's RAG knowledge (prioritizing `farcaster_target_list.md` and `twitter_target_list.md` content from the `knowledge` table) or parses them from the triggering message.
2. **Searches Farcaster casts** matching the keyword corpus via `GET /v2/farcaster/cast/search`.
3. **Scores each cast** on three axes (author reach · engagement velocity · topical alignment) → **1–10**
4. **Filters to scores ≥ 6/10**, caps queue at **5 opportunities** (configurable via `MAX_RESULTS`)
5. **Fallback**: if no opportunities meet the 6/10 threshold, returns the **top 5 highest-scoring** casts tagged as `[BELOW THRESHOLD]`
6. **Delivers the ranked queue** (post URL, handle, engagement counts, score, suggested reply angle) to a target agent's DirectClient endpoint.

Designed for a **Scout agent** that feeds engagement opportunities to a publishing agent (e.g. Archon Europae) without ever touching the social graph itself.

---

## Installation

```bash
# From within a pnpm workspace that includes this plugin:
pnpm install

# Or as a published package:
pnpm add @elizaos/plugin-neynar-search
```

---

## Configuration

### Required

| Setting | Description |
|---------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | Neynar API key for all API calls. Get a free key at [neynar.com](https://neynar.com). |

### Optional

All optional settings have sensible defaults. Override any of them via environment variables or `character.json` > `settings.secrets`.

| Setting | Default | Description |
|---------|---------|-------------|
| `ARCHON_BASE_URL` | `http://archon_euro_container:3000` | Base URL of the target agent's DirectClient |
| `ARCHON_AGENT_ID` | `187939ae-c36e-08ef-836f-131b1b658c9a` | Agent ID receiving the scout queue |
| `ARCHON_FARCASTER_FID` | `3315139` | FID of the target agent (for Tier 3 inbound engagement detection) |
| `TARGET_LIST_JSON_PATH` | `{cwd}/characters/archon_europae/farcaster_target_list.json` | Path to the generated target list JSON (Tier 2 profile monitoring) |
| `SCOUT_MAX_RESULTS` | `5` | Maximum number of opportunities in the ranked queue |
| `SCOUT_MIN_SCORE` | `6` | Minimum score threshold; casts below this are discarded (unless fallback triggers) |

### Example: `character.json`

```json
{
  "plugins": ["@elizaos/plugin-neynar-search"],
  "clients": ["direct"],
  "settings": {
    "secrets": {
      "FARCASTER_NEYNAR_API_KEY": "your-neynar-api-key",
      "ARCHON_BASE_URL": "http://my-agent:3000",
      "ARCHON_AGENT_ID": "my-agent-id",
      "ARCHON_FARCASTER_FID": "123456",
      "TARGET_LIST_JSON_PATH": "/app/data/targets.json",
      "SCOUT_MAX_RESULTS": "10",
      "SCOUT_MIN_SCORE": "4"
    }
  }
}
```

> **Important:** Use only `"direct"` in the `clients` array. The `auto` client drives autonomous posting — a read-only discovery agent must not post anything. The `direct` client exposes the HTTP endpoint that `scout_cycle.sh` calls.

Or set any setting via environment variable:

```bash
FARCASTER_NEYNAR_API_KEY=your-neynar-api-key
ARCHON_BASE_URL=http://my-agent:3000
SCOUT_MAX_RESULTS=10
```

---

## Usage

Trigger the action by messaging the agent:

```
Run a Farcaster discovery cycle.
```

Or with a custom keyword list:

```
Search Farcaster keywords: EU energy, European sovereignty, Austrian economics
```

The action will return a structured queue. When opportunities meet the threshold:

```
[SCOUT CYCLE 2024-01-15T10:00:00Z] — 3 opportunity(ies) queued

1. SCORE 9.2/10 — @ischinger
   URL: https://warpcast.com/ischinger/0x1a2b3c
   Reach: 84,700 followers [⚡ power badge]
   Engagement: 847L / 32RC / 62R (941 total)
   Keywords: EU energy, European sovereignty
   Angle: Lead with a data-rich counterpoint on "EU energy" — @ischinger's 941 interactions signal peak momentum.

...

Queue delivered to Archon. 3 item(s). Cycle complete.
```

When no opportunities meet the 6/10 threshold, a fallback queue is returned with the top 5 highest-scoring casts:

```
[SCOUT CYCLE 2024-01-15T10:00:00Z] — FALLBACK: 5 lowest-scoring opportunities (none above 6/10 threshold)

1. SCORE 4.5/10 [BELOW THRESHOLD] — @username
   URL: https://warpcast.com/username/0x...
   Reach: 1,200 followers
   Engagement: 12L / 3RC / 1R (16 total)
   Keywords: EU energy
   Angle: Reply to @username on "EU energy" with a sourced data point to qualify the thread (16 interactions, score 4.5/10).

...

Fallback queue delivered to Archon. 5 item(s) (all below 6/10 threshold). Cycle complete.
```

---

## Scoring Algorithm

Each cast is scored on three **weighted** axes (0–10 each), combined to produce a final score:

| Axis | Weight | Rationale |
|------|:------:|-----------|
| **Topical Alignment** | **×4** | Most important — the Scout's primary mission is finding casts matching Archon's strategic vectors |
| **Engagement Velocity** | **×3** | Measures active conversation momentum, secondary to relevance |
| **Author Reach** | **×3** | Lowest weight to avoid celebrity bias; niche experts on-topic are worth more than big accounts rambling |

### Axis 1 — Author Reach  (weight: 3)
`(log10(follower_count) / 6) * 10` normalized to 0–10 (1M followers = 10). +1 bonus for Neynar power badge, capped at 10.

| Followers | Score |
|-----------|-------|
| 100       | 3.3   |
| 1 000     | 5.0   |
| 10 000    | 6.7   |
| 100 000   | 8.3   |
| 1 000 000 | 10.0  |

### Axis 2 — Engagement Velocity  (weight: 3)
`(likes + recasts + replies)` linear scale, saturates at 500 total → 10.

| Total engagement | Score |
|-----------------|-------|
| 0               | 0     |
| 50              | 1.0   |
| 250             | 5.0   |
| 500+            | 10.0  |

### Axis 3 — Topical Alignment  (weight: 4)
Count of distinct keywords from the active corpus found in the cast text:

| Keyword matches | Score |
|----------------|-------|
| 0              | 0     |
| 1              | 3.3   |
| 2              | 6.7   |
| 3+             | 10.0  |

**Final score** = `(reach × 3 + velocity × 3 + alignment × 4) / 10` rounded to 1 decimal, clamped [1, 10].

### Filtering

- Casts scoring **≥ 6** are included in the normal queue, capped at `MAX_RESULTS` (default: 5).
- If **no casts** score ≥ 6, the **top 5 highest-scoring** casts are returned as a **fallback queue**, each tagged with `[BELOW THRESHOLD]`.
- This ensures Archon always receives actionable intelligence, even during low-signal periods.

---

## Delivery to target agent

The plugin POSTs the ranked queue to the target agent's DirectClient `/ingest` endpoint (skips LLM inference — ~50ms response):
```
{ARCHON_BASE_URL}/{ARCHON_AGENT_ID}/ingest
```

Configure the target via `ARCHON_BASE_URL` and `ARCHON_AGENT_ID` runtime settings (see [Configuration](#configuration)). No code changes needed.

---

## Neynar API endpoints used

| Method | Endpoint | Purpose | Tier |
|--------|----------|---------|:----:|
| GET | `/v2/farcaster/cast/search?q=QUERY&limit=25` | Keyword cast search | T1 |
| GET | `/v2/farcaster/user/casts?fid=FID&limit=10` | Target profile monitoring | T2 |
| GET | `/v2/farcaster/notifications?fid={FID}&limit=25` | Inbound engagement detection | T3 |

**Auth**: `api_key` header. No signer UUID. Fully read-only.

---

## Trigger mechanism

The Scout agent is driven by a cron job on the host that calls its `DirectClient` HTTP endpoint every 3 hours:

```bash
# Install on the host (run once):
(crontab -l 2>/dev/null; echo "0 */3 * * * /root/agents-ecosystem/engine/scripts/scout_cycle.sh >> /var/log/scout_cycle.log 2>&1") | crontab -
```

The script [`scripts/scout_cycle.sh`](../../scripts/scout_cycle.sh) sends a discovery prompt via `curl` to:

```
POST http://localhost:3003/{SCOUT_AGENT_ID}/message
```

This triggers the `SEARCH_FARCASTER` action inside the container and returns the ranked queue to the shell log.

---

## Integration with ElizaOS engine

### 1. Add the dependency

```bash
pnpm add @elizaos/plugin-neynar-search@github:xavier-arosemena/elizaos-plugin-neynar-search
```

Or add it manually to `package.json`:

```json
{
  "dependencies": {
    "@elizaos/plugin-neynar-search": "github:xavier-arosemena/elizaos-plugin-neynar-search"
  }
}
```

### 2. `src/index.ts` (engine)

```typescript
import { neynarSearchPlugin } from "@elizaos/plugin-neynar-search";

// In createAgent(), add to plugins array:
const needsNeynarPlugin = pluginStrings.includes("@elizaos/plugin-neynar-search");

plugins: [
  bootstrapPlugin,
  webSearchPlugin,
  needsNeynarPlugin ? neynarSearchPlugin : null,
  // ...
].filter(Boolean),
```

### 3. Run install

```bash
pnpm install
```

The plugin is downloaded from the GitHub repository and installed like any other npm dependency. No workspace copy needed.

---

## Development workflow

This plugin is developed in its own repository at `elizaos-plugin-neynar-search/` and consumed by the engine as a git dependency. For local development, use the **link-based workflow**:

### Link-based development (recommended)

```bash
# 1. Temporarily switch to a local symlink
cd /root/agents-ecosystem/engine
# Edit package.json:
#   "@elizaos/plugin-neynar-search": "link:/root/elizaos-plugin-neynar-search"
pnpm install

# 2. Edit files in /root/elizaos-plugin-neynar-search/ — changes reflect immediately

# 3. When ready to publish, commit and push to GitHub
cd /root/elizaos-plugin-neynar-search
git add -A && git commit -m "..."
git push origin master
git tag v0.1.2 && git push origin v0.1.2

# 4. Switch engine back to the git dependency
cd /root/agents-ecosystem/engine
# Edit package.json:
#   "@elizaos/plugin-neynar-search": "github:xavier-arosemena/elizaos-plugin-neynar-search"
pnpm install
```

### Development cycle

1. Edit plugin source in `elizaos-plugin-neynar-search/src/`
2. Test with `link:` dependency in the engine project
3. Commit, tag, push to GitHub
4. Switch engine back to `github:` dependency
5. Run `pnpm install` in the engine to pull the latest version

---

## Repository structure

```
elizaos-plugin-neynar-search/
├── src/
│   ├── index.ts                    # Plugin entry point
│   ├── types.ts                    # NeynarCast, ScoredOpportunity interfaces
│   ├── actions/
│   │   └── searchFarcaster.ts      # SEARCH_FARCASTER action
│   └── lib/
│       ├── neynarClient.ts         # Raw fetch HTTP wrappers
│       ├── scorer.ts               # Three-axis scoring engine
│       ├── cache.ts                # Search result cache with TTL
│       └── watchlist.ts            # Auto-discovery author watchlist
├── package.json
├── tsconfig.json
├── LICENSE                         # MIT
├── README.md
└── .gitignore
```

---

## License

MIT — see [LICENSE](LICENSE).
