# Firecrawl Tools for omp

Native `omp` tools for [Firecrawl](https://firecrawl.dev), replacing the
`firecrawl-mcp-server` MCP server. One plugin, one native tool per MCP tool it
can support, every call through the official `firecrawl` Node SDK — no MCP
transport, no child process, no hand-written HTTP client.

AGPL-3.0-or-later. See `LICENSE.md`.

## Install

Once published to the `omp-plugins` marketplace:

```
omp plugin marketplace add vnixxa31/omp-plugins
omp plugin install firecrawl@omp-plugins
```

Set `FIRECRAWL_API_KEY` (and optionally `FIRECRAWL_API_URL` for a self-hosted
instance). Without a key, `scrape`, `search` and `interact` still run on the
keyless tier; the other tools return 401.

## Tools

Five tools are always in the system prompt because they carry the everyday
paths and the whole Alexandria reach:

`firecrawl_search` · `firecrawl_scrape` · `firecrawl_parse` ·
`firecrawl_developer_search` · `firecrawl_find_tools`

Alexandria runs from those: `firecrawl_find_tools` → provider contract, then
`firecrawl_scrape { alexandria }` (or `firecrawl_search` with
`sources: ["alexandria"]` for suggestions).

The remaining 22 (`map`, `crawl`, `check_crawl_status`, `gov_search`, the four
`research_*`, `agent`/`agent_status`, `interact`/`interact_stop`, the eight
`monitor_*`, `credit_usage`, `feedback`) are **discoverable**: omp mounts them
as `xd://` devices instead of shipping their schemas on every request. Run one
with `read xd://firecrawl_credit_usage` for its schema, then
`write xd://firecrawl_credit_usage {}`.

## Not implemented

These MCP tools are deliberately absent: the SDK exposes no method or no usable
handle for them without a hand-written HTTP call, or they duplicate a tool
above.

| MCP tool | Reason |
| --- | --- |
| `people_company_search` | No SDK method. |
| `people_company_enrich` | No SDK method. |
| `firecrawl_search_feedback` | Needs a search job id that the SDK's `search()` drops. |
| `firecrawl_provider_directory` | Duplicate of `firecrawl_find_tools { level: "providers" }`. |
| `firecrawl_agent_activity` | MCP sidebar view; the SDK only exposes agent traces. |
| `firecrawl_recommended_providers` | No SDK method. |
| `firecrawl_usage_dashboard` | UI sidebar, not an API tool. |

Also missing because the SDK does not expose them: a cross-call
`conversationId`, credit usage broken down per endpoint or per day, and
`crawl`/`alexandria` generic feedback. See `AGENTS.md` §6 for the full list.

## Development

Bun drives build and test; behavior is smoke-tested from a real omp session.

```
plugins/firecrawl/
  package.json          # omp.extensions manifest → ./src/index.ts
  src/index.ts          # extension entry; registers every tool family
  src/api.ts            # SDK client singleton, abort + result/error envelopes
  src/tool.ts           # defineTool() wrapper shared by all registrations
  src/tools/            # one module per tool family
  AGENTS.md             # architecture, surface policy, per-tool contracts
  LICENSE.md
```

`AGENTS.md` is the source of truth for what each tool must do and which SDK
fields it maps. Read it before contributing.
