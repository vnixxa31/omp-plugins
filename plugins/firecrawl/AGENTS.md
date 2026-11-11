# AGENTS.md — Firecrawl tools for omp

**Status (2026-11-11): all 27 tools are implemented.** `src/index.ts` registers
`src/tools/content.ts` (scrape, search, parse, map, crawl, check_crawl_status),
`src/tools/developer.ts` (developer_search), `src/tools/alexandria.ts`
(find_tools), `src/tools/monitor.ts` (the eight monitor_*),
`src/tools/research.ts` (gov_search + the four research_*), `src/tools/agent.ts`
(agent, agent_status), `src/tools/interact.ts` (interact, interact_stop) and
`src/tools/ops.ts` (credit_usage, feedback) through `src/api.ts` + `src/tool.ts`;
`bun run typecheck`, `bun run bundle` and `bun test` pass.

## 1. What this is

One omp extension that exposes Firecrawl's MCP tool surface as native omp
tools. Every API call goes through the official `firecrawl` Node SDK. There is
no MCP transport, no child process, and no hand-written HTTP client anywhere in
this plugin.

- Plugin root: `plugins/firecrawl/`; marketplace name `firecrawl`
  (`.omp-plugin/marketplace.json` at the repo root).
- Extension entry: `src/index.ts` (`package.json` → `omp.extensions`).
- Only runtime dependency: `firecrawl@^4.52` (MIT).
- The SDK client reads `FIRECRAWL_API_KEY` and `FIRECRAWL_API_URL` itself
  (`https://api.firecrawl.dev` default). The plugin adds no env vars.
- Without a key, `scrape`, `search` and `interact` still run on the keyless
  tier (IP rate-limited); every other endpoint answers 401 until a key is set.

The goal is the MCP surface with far less prompt weight and no extra process,
while keeping the MCP tool names and argument shapes so nothing has to be
relearned.

## 2. Hard rules

1. **SDK, not HTTP.** Call the shared client from `src/api.ts`. Never `fetch`,
   never `axios`, never a "temporary" fallback. If the SDK does not expose an
   endpoint or field, the tool does not ship (§6) and the gap is recorded in
   `README.md` and §6 here.
2. **Names match the MCP server** (`firecrawl_scrape`, `firecrawl_search`, …).
   No renaming, no prefix changes, no snake/camel variants.
3. **Schemas mirror the installed SDK option objects.** One Zod field per SDK
   option, same name, same meaning. Never invent a friendlier shape when the
   SDK already has one. When `firecrawl` is bumped, re-read
   `node_modules/firecrawl/dist/index.d.ts` and delete fields the SDK dropped —
   this plugin tracks the typings, not the MCP README.
4. **No `conversationId`.** The MCP client threads one across calls; the SDK
   neither returns nor accepts it. Do not synthesize it, do not add a tool
   parameter for it.
5. **No SDK extras.** Do not expose methods outside the MCP set without
   editing §3 first: `cancelCrawl`, `getCrawlErrors`, `getActiveCrawls`,
   `crawlParamsPreview`, `startExtract`/`extract`, `startBatchScrape`,
   `browser*`, `getAgentTrace`/`getAgentSnapshot`/`getAgentThread`,
   `cancelAgent`, `listAgents`, `getTokenUsage*`, `getConcurrency`,
   `getQueueStatus`, `research.searchGithub` (deprecated).
6. **One extension, one registration point.** `src/index.ts` registers the tool
   modules; it contains no tool logic and no `session_start` chatter.

## 3. Surface: 5 always-on + 22 discoverable

omp presents a tool in one of two ways (`ToolLoadMode`):

- `"essential"` — the full schema ships in the system prompt on every request.
- `"discoverable"` — removed from the tool schema and mounted as an
  `xd://<tool>` device (or found through BM25 tool search when `xd://` is
  off). With the default `tools.xdevDocs: "catalog"`, each discoverable tool
  costs one catalog line (its description capped at 200 chars). The model runs
  it with `write xd://<tool>` after `read xd://<tool>` for the schema.

Extension tools default to `"discoverable"`, so essential tools must set
`loadMode: "essential"` explicitly. In practice the model does not reach for
discoverable tools on its own: only the five below may be assumed.

### 3.1 Essential (5)

| Tool | Why it is always on |
| --- | --- |
| `firecrawl_search` | First move for any current-web, people, company, price, or release question. Also the Alexandria entry point via `sources: ["alexandria"]`. |
| `firecrawl_scrape` | Read one page as markdown/HTML/links/screenshot, and execute an Alexandria provider call (`scrape({ alexandria })`). |
| `firecrawl_parse` | Read a local PDF/DOCX/XLSX/HTML file the user points at. |
| `firecrawl_developer_search` | Everyday coding questions: public repos, issues, merged PRs, READMEs, docs. |
| `firecrawl_find_tools` | Zero-credit Alexandria catalogue lookup: categories → providers → tools → full contract. Without it the Alexandria path has no discovery surface. |

Alexandria is fully reachable from the essential set:
`find_tools` → `scrape { alexandria }` (or `search { sources: ["alexandria"] }`
to get suggested tools), so the paid-data surface never needs a discoverable
tool as its entry point.

### 3.2 Discoverable (22) — implemented

| Family | Tools |
| --- | --- |
| Site structure | `firecrawl_map`, `firecrawl_crawl`, `firecrawl_check_crawl_status` |
| Research indexes | `firecrawl_gov_search`, `firecrawl_research_search_papers`, `firecrawl_research_inspect_paper`, `firecrawl_research_read_paper`, `firecrawl_research_related_papers` |
| Deep research | `firecrawl_agent`, `firecrawl_agent_status` |
| Live browser | `firecrawl_interact`, `firecrawl_interact_stop` |
| Monitors | `firecrawl_monitor_create`, `firecrawl_monitor_update`, `firecrawl_monitor_list`, `firecrawl_monitor_get`, `firecrawl_monitor_delete`, `firecrawl_monitor_run`, `firecrawl_monitor_check`, `firecrawl_monitor_checks` |
| Account / quality | `firecrawl_credit_usage`, `firecrawl_feedback` |

Moving a tool between the two lists is a prompt-budget decision: edit this
section (and the reason) in the same change.

### 3.3 Description style

The first description line is what the catalog shows for a discoverable tool
and the first thing the model reads for an essential one.

- Line 1: one sentence, ≤120 chars, imperative, no "This tool".
- Then at most three short lines: when to use it, when not to, what it returns.
- Essential descriptions end with `Related devices: xd://firecrawl_x, xd://firecrawl_y.`
  (at most two) so the model knows the discoverable siblings exist.
- Name concrete inputs (`PDF`, `GitHub issue`, `law citation`) instead of
  adjectives; the description is the routing signal.

## 4. Layout and shared plumbing

```
src/index.ts            extension entry; registers every family
src/api.ts              SDK client singleton, abort, result/error envelopes
src/tool.ts             defineTool() — one wrapper for every registration
src/tools/content.ts    scrape, search, parse, map, crawl, check_crawl_status
src/tools/developer.ts  developer_search
src/tools/alexandria.ts find_tools
src/tools/research.ts   gov_search + the four research_* tools
src/tools/agent.ts      agent, agent_status
src/tools/monitor.ts    the eight monitor_* tools
src/tools/interact.ts   interact, interact_stop
src/tools/ops.ts        credit_usage, feedback
```

### 4.1 `src/api.ts`

- `api(): Firecrawl` — lazily constructed singleton; never at extension load
  (a missing key or a bad `FIRECRAWL_API_URL` must not break session start).
  Pass `origin: "omp-plugin-firecrawl@<pkg.version>"` so Firecrawl attribution
  is ours; the SDK otherwise reports its own package.
- `withAbort(promise, signal)` — the SDK accepts a per-call `signal` only on
  `crawl()`. For everything else, race the promise against the signal and
  reject with `signal.reason`. Aborting does **not** cancel remote work (only
  `crawl()` does a best-effort cancel); say so in the doc comment, not in the
  tool description.
- `toResult(data)` / `toError(toolName, error)` — the only place that builds
  `AgentToolResult`. No tool builds content blocks by hand.
- Version comes from `package.json` (JSON import). Do not hardcode it.

### 4.2 Result envelope

```ts
{ content: [{ type: "text", text }], details: data }            // success
{ content: [{ type: "text", text }], details: { error }, isError: true }
```

- `details` is always the untouched SDK payload (UI/renderers read it).
- `text` is `JSON.stringify(data)` (compact) for structured payloads.
- `firecrawl_scrape` and `firecrawl_parse` are the exception: when the result
  contains `markdown` (or the caller asked only for `html`/`rawHtml`), return
  that string raw. JSON-escaping a whole page costs tokens and reads badly.
- Never truncate. omp spills oversize output on its own.
- Never rephrase, summarize, or reorder API data.

### 4.3 Error envelope

Surface the API's own fields; never a bare stack trace:

```
firecrawl_scrape failed: 402 Payment Required (INSUFFICIENT_CREDITS)
<message>
requestId: <id>            // when present
jobId: <id>                // when present
requiresAction: {"type":"accept_terms","terms":…,"url":…}
agentHints: <JSON>         // when present
details: <JSON, clipped to ~2 KB>
```

- `SdkError` is the normal path: read `status`, `code`, `details`, `jobId`,
  `chargeId`, `requestId`, `requiresAction`, `agent_hints`.
- 401/403 without `requiresAction` → add a hint: set `FIRECRAWL_API_KEY`; the
  keyless tier covers only scrape/search/interact; otherwise check plan and
  team permissions for this endpoint.
- 402 → add a pointer to `firecrawl_credit_usage`.
- `requiresAction.type === "accept_terms"` → return it verbatim and tell the
  caller a human must accept; never auto-accept (`firecrawl_agent` resumes the
  same `threadId` with `exchange.approve` after consent).
- Non-`SdkError` (local file missing, schema mismatch) → one line with the
  concrete cause and path.

### 4.4 Approval tier

Declare `approval` on every tool (extension tools otherwise count as `exec`):

| Tier | Tools |
| --- | --- |
| `read` | search, scrape, parse, developer_search, find_tools, map, check_crawl_status, gov_search, all four research_*, agent_status, monitor_list/get/checks/check, credit_usage, interact_stop |
| `write` | crawl, agent, monitor_create/update/delete/run, feedback |
| `exec` | interact (runs browser code) |

### 4.5 Progress and cancellation

- Do not fabricate progress. The SDK waiters expose no page-level stream, so no
  `onUpdate` is emitted; `details` carries the terminal payload.
- `firecrawl_crawl` uses the SDK waiter (`crawl(url, { …, signal, timeout })`),
  not a hand-rolled poll loop. The SDK waiter has **no default deadline**
  (`pollInterval` 2 s, `timeout` undefined), so the tool must pass one:
  `timeout` (seconds), default 600, and report `JobTimeoutError` with its
  `jobId`.
- `firecrawl_agent` is async by contract: start and return the job id. Status
  lives in `firecrawl_agent_status`, which returns `status`, `creditsUsed`,
  `partial`, `pendingApproval`, and `threadId` as the API gives them.

## 5. Tool contracts

Every tool: `defineTool` wrapper, Zod schema via **`pi.zod`** (never
`import { z } from "zod"` — the plugin has no zod dependency and must not add
one), `execute(toolCallId, params, signal, onUpdate, ctx)` returning the
envelope from §4.2/§4.3, and `describe()` on every field. Omit `integration`
and `origin` from all schemas; the client owns them.

| Tool | SDK call | Notes |
| --- | --- | --- |
| `firecrawl_scrape` | `scrape(url, opts)` or `scrape({ alexandria, requestId?, timeout? })` | Exactly one of `url`/`alexandria` (Zod refine). Params = `ScrapeOptions` minus `integration`/`origin`. |
| `firecrawl_search` | `search(query, opts)` | Params = `SearchRequest` minus `query`/`integration`/`origin`. |
| `firecrawl_parse` | `parse({ data, filename, contentType? }, opts)` | Tool takes `filePath`; read it with `Bun.file`, pass bytes. Params = `ParseOptions`. |
| `firecrawl_map` | `map(url, opts)` | Params = `MapOptions` minus `integration`/`origin`. Returns `{ id, links }`. |
| `firecrawl_crawl` | `crawl(url, { …opts, signal, timeout })` | Blocks to terminal state; returns `CrawlJob`. |
| `firecrawl_check_crawl_status` | `getCrawlStatus(id)` | Single read, no polling. |
| `firecrawl_developer_search` | `developerSearch(query, opts)` | `skills: "only"` restricts to packaged agent-skill evidence. |
| `firecrawl_find_tools` | `findTools(opts)` | Zero credits. `level` ∈ `providers`/`groups`/`tools`; no args → categories. |
| `firecrawl_gov_search` | `govSearch(query, opts)` | `jurisdiction` `"us"`/`"us-<state>"`, `court` (CourtListener id), `courtType`, `cites`, `domain`. |
| `firecrawl_research_search_papers` | `research.searchPapers(query, opts)` | Paper index, not `search({ categories: ["research"] })`. |
| `firecrawl_research_inspect_paper` | `research.getPaper(id)` | Detail mode. |
| `firecrawl_research_read_paper` | `research.getPaper(id, { query, k })` | Read mode; `k` requires `query`. |
| `firecrawl_research_related_papers` | `research.similarPapers(id, opts)` | `intent` required; `mode` `similar`/`citers`/`references`; extra seeds via `anchor[]`. |
| `firecrawl_agent` | `startAgent({ prompt, … })` | Async; returns `{ id, threadId, threadTurn }`. |
| `firecrawl_agent_status` | `getAgentStatus(id)` | `processing` is non-terminal; poll again later. |
| `firecrawl_interact` | `interact(scrapeId, { prompt \| code, language?, timeout? })` | Exactly one of `url`/`scrapeId` and one of `prompt`/`code`. |
| `firecrawl_interact_stop` | `stopInteraction(scrapeId)` | Also saves profile changes when the session was opened with `saveChanges`. |
| `firecrawl_monitor_create` | `createMonitor(request)` | Simple form or explicit request (§5.6). |
| `firecrawl_monitor_update` | `updateMonitor(id, patch)` | `status` ∈ `active`/`paused`; `schedule` is `{ cron?, text?, timezone? }`. |
| `firecrawl_monitor_list` | `listMonitors({ limit, offset })` | Returns a plain `Monitor[]`; no pagination metadata. |
| `firecrawl_monitor_get` | `getMonitor(id)` | |
| `firecrawl_monitor_delete` | `deleteMonitor(id)` | Destructive; returns `boolean`; surface verbatim. |
| `firecrawl_monitor_run` | `runMonitor(id)` | Queues an immediate check; returns the queued `MonitorCheck`. |
| `firecrawl_monitor_check` | `getMonitorCheck(monitorId, checkId, { status?, limit?, skip? })` | `status` filters page-level results. |
| `firecrawl_monitor_checks` | `listMonitorChecks(monitorId, { limit, offset })` | No status filter in this SDK method. |
| `firecrawl_credit_usage` | `getCreditUsage()` / `getCreditUsageHistorical(byApiKey?)` | `view` selects current balance or the fixed historical period list (no date-range parameters). |
| `firecrawl_feedback` | `feedback(request)` | `endpoint` ∈ `search`/`scrape`/`parse`/`map`; `jobId` required. |

### 5.1 `firecrawl_scrape` — url **or** Alexandria

`scrape` has two overloads and the tool must pick exactly one:

- `url` + `ScrapeOptions` → `Document` (`markdown`, `html`, `rawHtml`, `links`,
  `images`, `screenshot`, `json`, `summary`, `metadata`, `branding`, …).
- `alexandria` (`AlexandriaCall | AlexandriaCall[]`) → `AlexandriaScrapeData`
  (`scrapeId`, `requestId`, `alexandria[]` with per-provider
  `data`/`creditsCost`/`error`, total `creditsCost`).

Both present or neither → tool error naming both fields; do not silently
prefer one. `requestId` may be passed to the Alexandria overload and reused
with an identical payload when retrying. Per-provider errors are data, not
tool failures: return them and let the caller retry just the failed providers.

Implementation note: omptype refuses `union([object, array(object)])` at build
time ("overlapping morph inputs"), so `alexandria` is declared as
`z.unknown()` with the contract in its description and each call is validated
against the `AlexandriaCall` schema inside `run`. `requestId` with `url` is a
tool error, not a silent drop.

### 5.2 `firecrawl_search`

- `sources` includes `alexandria` to get provider suggestions in
  `data.tools` (`DiscoveredTool` with `next`/`execute` descriptors to follow
  via `firecrawl_scrape { alexandria }`).
- `categories: ["gov"]` cannot be combined with another category → tool error
  with that sentence, rather than a round trip.
- `scrapeOptions` bills one scrape per returned result; say so in the field
  description.
- `toolDetail` (`compact`/`summary`/`full`) controls Alexandria contract
  verbosity; default stays compact.
- The SDK rebuilds the search response and drops the search job id, so this
  tool cannot feed `firecrawl_search_feedback` (skipped, §6).

### 5.3 `firecrawl_parse`

- Input is a path, not bytes: resolve it, read via `Bun.file`, derive
  `filename` from the basename, pass an optional explicit `contentType`.
- SDK `parse` does the multipart upload itself; the MCP `uploadRef` two-phase
  handshake does not exist here.
- Missing/unreadable path → one-line tool error with the path.
- Supported formats come from the SDK (`ParseFormatOption`); there is no
  separate formats-listing tool.

### 5.4 `firecrawl_crawl`

- Root URL plus `CrawlOptions` (v4.52): `prompt`, `excludePaths`,
  `includePaths`, `maxDiscoveryDepth`, `sitemap`, `ignoreQueryParameters`,
  `deduplicateSimilarURLs`, `limit`, `crawlEntireDomain`, `allowExternalLinks`,
  `allowSubdomains`, `ignoreRobotsTxt`, `robotsUserAgent`, `delay`,
  `maxConcurrency`, `scrapeOptions`, `regexOnFullURL`, `zeroDataRetention`.
- `timeout` (seconds) is the waiter deadline, not a page timeout; when it
  expires the SDK throws `JobTimeoutError`, which the envelope reports with the
  job id.
- On abort the SDK stops polling and asks the API to cancel. Do not add a
  second polling loop.

### 5.5 `firecrawl_agent` / `firecrawl_agent_status`

- Start: `{ prompt (required), urls?, schema?, effort?, maxCredits?,
  strictConstrainToURLs?, threadId?, mode?, exchange? }`.
- `schema` is a JSON Schema object passed through untouched (SDK also accepts
  Zod, but the tool must accept JSON so non-TS callers work).
- `exchange.approve`/`decline` require `threadId` and are mutually exclusive;
  a follow-up turn inherits omitted exchange settings.
- A turn can end on a `terms` `pendingApproval` with `exchange.requiresAction`.
  Return both as the API gives them; the calling agent shows the terms to a
  human, then either executes `requiresAction.providers[].accept` through
  `firecrawl_scrape { alexandria }` (after explicit consent) and resumes the
  same `threadId` with `exchange.approve: { approvalId }`, or declines. There
  is no auto-accept mode.
- Status: `processing` is not terminal. `completed` carries the final JSON in
  `data`; `failed` may carry `partial`, `partialSchemaValid`, `stopReason`.

### 5.6 `firecrawl_monitor_create`

The SDK requires a full `CreateMonitorRequest`; the tool offers two forms and
builds it:

- Simple: `page`/`pages` (or `queries`) + `goal` → `targets` (`scrape` target
  for URLs, `search` target for `queries`), default schedule
  `{ text: "every 30 minutes" }`.
- Advanced: explicit `targets` (`scrape { urls }`, `crawl { url }`,
  `search { queries, searchWindow?, includeDomains?, excludeDomains?, maxResults? }`),
  `schedule` (`{ cron?, text?, timezone? }` — exactly one of cron/text),
  `name`, `goal`, `judgeEnabled`, `retentionDays`, `webhook`, `notification`.
- The API requires `name`; when the caller omits it derive
  `<first target host or query> monitor` rather than failing.
- Pass `schedule.text` through unchanged; the API validates and normalizes it.
  Never repair a schedule ourselves.
- Never enable `judgeEnabled` implicitly: only when `goal` or the flag says so.

### 5.7 `firecrawl_interact`

- `scrapeId` mode is the native path: `interact(scrapeId, { prompt | code })`.
- `url` mode must scrape first and derive the id from
  `Document.metadata.scrapeId`, then interact. **Verify this id is present on a
  real scrape before shipping url mode** (§9); if it is absent there is no
  SDK-only way to open a session by URL.
- `scrapeOptions.profile { name, saveChanges }` persists browser state; the
  save happens on `firecrawl_interact_stop`, so say that in the stop
  description.

### 5.8 `firecrawl_credit_usage` / `firecrawl_feedback`

- `credit_usage`: `view: "current"` → `getCreditUsage()`; `view:
  "historical"` → `getCreditUsageHistorical(byApiKey?)`. The SDK has no
  `byEndpoint`, no `bin`, and no date-range parameters — do not offer them.
- `feedback`: the SDK accepts `endpoint` `search`/`scrape`/`parse`/`map` and a
  required `jobId`. Ids the SDK hands back: `metadata.scrapeId` from scrape
  (and from parse when the response carries it), `MapData.id` from map.
  `endpoint: "search"` needs a search job id no SDK response exposes, so it
  is accepted by the schema but practically unusable — say so in the field
  description. Crawl and alexandria feedback are not typed; do not guess them.
  Feedback is rejected outside the API's 20-minute window, so keep the
  description short and specific.

## 6. Skipped MCP tools and known SDK gaps

These do not ship. Each is listed in `README.md` under "Not implemented" with
the same reason.

| MCP tool | Why it is skipped |
| --- | --- |
| `people_company_search` | No SDK method (would need a hand-written HTTP call). |
| `people_company_enrich` | No SDK method. |
| `firecrawl_search_feedback` | `searchFeedback(jobId, …)` needs a search job id, and the SDK's `search()` mapping drops it. |
| `firecrawl_provider_directory` | Duplicate of `firecrawl_find_tools { level: "providers" }`; one catalogue tool is enough. |
| `firecrawl_agent_activity` | MCP sidebar view over live agent steps; the SDK exposes only `getAgentTrace` (raw trace events), not that aggregated activity contract. |
| `firecrawl_recommended_providers` | No SDK method (activity-derived recommendations). |
| `firecrawl_usage_dashboard` | Not an API tool: a UI sidebar for providers and usage. |

Other gaps inherited from the SDK (documented, not worked around):

- No `conversationId` on any response or request.
- Credit history: no per-endpoint split, no day binning, no date range.
- Generic feedback: no `crawl`/`alexandria` endpoint value.
- Generic feedback ids: only `scrape` (`metadata.scrapeId`), `parse` (when the
  response carries it) and `map` (`MapData.id`) exist; no SDK response exposes
  a search id.
- Optional signal coverage: only `crawl()` accepts `signal`; other calls are
  raced locally (§4.1).

## 7. Verification

Tooling (applied):

- `package.json` devDependencies: `typescript`, `@types/bun`,
  `@oh-my-pi/pi-coding-agent@18.18.x`, `@oh-my-pi/omptype@18.18.x` (dev-only,
  pinned to the running omp minor; never imported at runtime — `pi.zod` and
  the `ExtensionAPI` types come from the host).
- Scripts: `typecheck` (`tsc --noEmit`), `bundle` (`bun build src/index.ts
  --outdir dist --target bun`), `test` (`bun test`).
- `tsconfig.json`: `strict`, `noEmit`, `module: "Preserve"`, `moduleResolution:
  "bundler"`, `resolveJsonModule` (for the `package.json` version import),
  `types: ["bun"]`.

Checks, in order:

1. `bun install && bun run typecheck && bun run bundle`
2. `omp plugin link .` then `omp plugin doctor` (0 errors) and
   `omp plugin list --json` shows the extension.
3. Real session with a key: an essential tool dispatches
   (`omp -p --tools=firecrawl_find_tools …`). The `xd://` half of this check
   starts applying when the first discoverable tool lands
   (`read xd://firecrawl_credit_usage`, then `write xd://firecrawl_credit_usage`
   with `{}`).
4. `FIRECRAWL_LIVE=1 bun test` runs the optional live checks; the default
   `bun test` run is offline.

Test policy: Bun tests only where logic is non-trivial — scrape url/alexandria
refine, monitor request building, crawl waiter option mapping, parse path
resolution, `SdkError` → envelope mapping, description/catalog first lines.
Do not write per-tool tests that only assert the SDK was called with the args
it was given, and do not record fixtures for the whole surface.

## 8. Definition of done (per tool)

- [ ] Zod schema from the SDK option type, every field described, no invented
      fields.
- [ ] Correct `loadMode` and `approval` per §3/§4.4.
- [ ] SDK call through `api()`; no HTTP.
- [ ] Success envelope (§4.2), including the raw-markdown exception for
      scrape/parse.
- [ ] Error path exercised: one `SdkError` case with status/code/requestId and,
      where relevant, `requiresAction`.
- [ ] Abort path: signal reaches `withAbort` (or `crawl()` natively).
- [ ] Description follows §3.3.
- [ ] No entry in §6 changed without updating `README.md` too.

## 9. Open questions

- `firecrawl_interact` url mode: shipped with a guard — url mode scrapes first
  and fails with a `ToolError` naming `metadata.scrapeId` when a plain scrape
  does not carry it. Still confirm on a live scrape that `metadata.scrapeId` is
  populated for a plain scrape; if it is not, drop url mode to §6 and keep only
  the `scrapeId` mode.
- Essential-set size: five tools is the current budget. If real sessions show
  the model failing to find `map`/`crawl`, promote one tool at a time and
  record the prompt cost here.
- `@oh-my-pi/*` devDependency pinning: it must match the user's omp minor
  (18.18.x today). Revisit if omp's extension API changes shape; the runtime
  types are the contract, not npm.
