# @elizaos/plugin-neynar-search

**Read-only Farcaster engagement discovery for ElizaOS agents via the Neynar REST API.**

No signer. No posting. No Farcaster client dependency. Pure signal detection.

---

## What it does

Registers a `SEARCH_FARCASTER` action that:

1. Searches Farcaster casts matching a keyword corpus via `GET /v2/farcaster/cast/search`
2. Scores each cast on three axes (author reach · engagement velocity · topical alignment) → **1–10**
3. Discards anything below **6/10**, caps queue at **10 opportunities**
4. Delivers the ranked queue (post URL, handle, engagement counts, score, suggested reply angle) to a target agent's DirectClient endpoint

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

Add to your agent's `character.json`:

```json
{
  "plugins": ["@elizaos/plugin-neynar-search"],
  "clients": ["direct"],
  "settings": {
    "secrets": {
      "FARCASTER_NEYNAR_API_KEY": "your-neynar-api-key"
    }
  }
}
```

> **Important:** Use only `"direct"` in the `clients` array. The `auto` client drives autonomous posting — a read-only discovery agent must not post anything. The `direct` client exposes the HTTP endpoint that `scout_cycle.sh` calls.

Or set the API key via environment variable:

```bash
FARCASTER_NEYNAR_API_KEY=your-neynar-api-key
```

Get a free Neynar API key at [neynar.com](https://neynar.com).

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

The action will return a structured queue:

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

---

## Scoring Algorithm

Each cast is scored on three equal-weight axes (0–10 each), averaged to produce a final score:

### Axis 1 — Author Reach
`(log10(follower_count) / 6) * 10` normalized to 0–10 (1M followers = 10). +1 bonus for Neynar power badge, capped at 10.

| Followers | Score |
|-----------|-------|
| 100       | 3.3   |
| 1 000     | 5.0   |
| 10 000    | 6.7   |
| 100 000   | 8.3   |
| 1 000 000 | 10.0  |

### Axis 2 — Engagement Velocity
`(likes + recasts + replies)` linear scale, saturates at 500 total → 10.

| Total engagement | Score |
|-----------------|-------|
| 0               | 0     |
| 50              | 1.0   |
| 250             | 5.0   |
| 500+            | 10.0  |

### Axis 3 — Topical Alignment
Count of distinct keywords from the active corpus found in the cast text:

| Keyword matches | Score |
|----------------|-------|
| 0              | 0     |
| 1              | 3.3   |
| 2              | 6.7   |
| 3+             | 10.0  |

**Final score** = `mean(reach, velocity, alignment)` rounded to 1 decimal, clamped [1, 10].
Casts scoring **< 6** are discarded. Queue is **capped at 10**.

---

## Archon delivery

By default the plugin POSTs the queue to:
```
http://archon_euro_container:3000/{ARCHON_AGENT_ID}/message
```

This is hardcoded for the `agents-ecosystem` multi-agent setup. To adapt for a different target, edit `ARCHON_BASE_URL` and `ARCHON_AGENT_ID` in [`src/actions/searchFarcaster.ts`](src/actions/searchFarcaster.ts).

---

## Neynar API endpoints used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v2/farcaster/cast/search?q=QUERY&limit=25` | Keyword cast search |
| GET | `/v2/farcaster/user/casts?fid=FID&limit=10` | Target profile monitoring |

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

### 1. `pnpm-workspace.yaml` (engine root)
```yaml
packages:
  - 'plugins/*'
```

### 2. `package.json` (engine)
```json
{
  "dependencies": {
    "@elizaos/plugin-neynar-search": "workspace:*"
  }
}
```

### 3. `src/index.ts` (engine)
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

### 4. `Dockerfile`
```dockerfile
COPY pnpm-workspace.yaml ./
COPY plugins/ ./plugins/
# then:
RUN pnpm install --no-frozen-lockfile
```

---

## Repository structure

```
elizaos-plugin-neynar-search/
├── src/
│   ├── types.ts                    # NeynarCast, ScoredOpportunity interfaces
│   ├── index.ts                    # Plugin export
│   ├── lib/
│   │   ├── neynarClient.ts         # Raw fetch HTTP wrappers
│   │   └── scorer.ts               # Three-axis scoring engine
│   └── actions/
│       └── searchFarcaster.ts      # SEARCH_FARCASTER action
├── package.json
├── tsconfig.json
├── LICENSE                         # MIT
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE).
