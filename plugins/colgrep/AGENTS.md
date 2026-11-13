# AGENTS.md — colgrep tools for omp

Source of truth for later sessions. Anything here overrides habit: if the code
and this document disagree, one of them is a bug — fix the code or amend this
file in the same change.

## 1. What this is

`plugins/colgrep/` is an omp extension package that exposes colgrep — semantic
grep that ranks code units by meaning — through two native tools:

| Tool | Purpose | Load mode | Approval |
|---|---|---|---|
| `code_search` | Semantic / hybrid code-unit search over colgrep's index | `essential` | `read` |
| `code_agent` | colgrep's local read-only localization agent | `essential` | `read` |

colgrep is an external Rust binary (1.8.5, custom build carrying an
OpenAI-compatible `--agent` endpoint). The plugin never bundles it: it runs the
binary named by `COLGREP_BIN` or the `colgrep` on `PATH`.

## 2. Hard rules

1. **No hooks.** The extension registers zero `pi.on(...)` handlers. Guidance
   reaches the model through the tool descriptions and `rules/colgrep.md`
   (always-apply) only. Do not add a `before_agent_start` injector to "make
   sure" the model sees the guidance — two injection points drift.
2. **No shadowing of the native `grep` tool.** `grep`, `glob`, `read` keep
   their exact semantics. Interception of bash `grep`/`rg`/`ag`/`ack` is an
   opt-in omp feature (`bashInterceptor`) documented in `README.md`, never
   enabled by the plugin.
3. **Two tools, both essential.** No discoverable tier: these tools are useful
   in every session, so `loadMode` is `"essential"` and the surface stays lean
   through concise descriptions.
4. **Read-only.** Both tools only read: `approval: "read"`, no index mutation
   beyond what colgrep's own auto-update does, no writes into the project.
5. **Structured output only.** colgrep is always invoked with `--json` and
   `--color never`; text output is never parsed. Malformed or mixed JSON is an
   error that names the first 300 characters, never a guess.
6. **Cancellation is uniform.** The omp `AbortSignal` is passed straight into
   `pi.exec`, so the process is killed and the tool reports `cancelled`.
7. **No invented results.** Zero hits is a normal answer, not an error;
   a failed run is `isError: true` with the CLI's own last lines.

## 3. Layout

```
plugins/colgrep/
├── package.json          # omp.extensions → ./src/index.ts, no runtime deps
├── tsconfig.json         # copied from plugins/firecrawl
├── AGENTS.md             # this file
├── README.md             # user-facing: requirements, params, env vars
├── LICENSE.md            # AGPL-3.0-or-later, copied from the repo root
├── rules/colgrep.md      # always-apply rule (single injection point)
└── src/
    ├── index.ts          # two registrations, nothing else
    ├── colgrep.ts        # binary lookup, exec wrapper, argv, JSON parse, render
    ├── index.test.ts     # surface policy
    ├── colgrep.test.ts   # argv / parse / render unit tests
    ├── live.test.ts      # real-binary smoke test (COLGREP_LIVE=1)
    └── tools/
        ├── search.ts     # code_search
        └── agent.ts      # code_agent
```

`src/colgrep.ts` is the only module that knows colgrep's CLI. A new tool must
add argv construction and rendering there (pure, exported, tested) and keep
`src/tools/*.ts` to ordering, timeouts, and the details payload.

## 4. colgrep contract (1.8.5)

### 4.1 Invocation

`runColgrep(exec, args, { cwd, signal, timeoutMs })` returns
`ExecResult & { elapsedMs }` — `{ stdout, stderr, code, killed, elapsedMs }` —
and never throws for a non-zero exit. A missing binary throws `ENOENT`, which
`thrownMessage` maps to one sentence. `code === -1` means the process was
killed by the timeout or the signal; `killed` says the same.

Timeouts: `COLGREP_SEARCH_TIMEOUT_MS` (default 300 000) and
`COLGREP_AGENT_TIMEOUT_MS` (default 600 000). A first search builds the index
inside the search timeout — that is the reason for the 5-minute default.

### 4.2 `code_search` argv

Emitted in this exact order:

```
--json --color never -y
[-k <results>] [-n <context>]
[--include <p>]... [--exclude <p>]... [--exclude-dir <p>]...
[-F] [-w] [-s] [--code-only] [--no-update]
[-e <pattern>]
[<query>]
[<path>...]
```

`-y` answers colgrep's large-repository index prompt so a non-interactive call
never blocks. `files_only` and `content` add **no** argv: `-l` replaces the JSON
with a filename list and `-c` replaces it with highlighted text, so both are
rendered from the JSON instead.

Paths come from `splitPaths(path, cwd)`: `;`-separated, trimmed, empties
dropped, relative entries unchanged (they resolve against the session cwd,
which is the exec cwd).

### 4.3 `code_search --json` shape

An array of `{ unit, score, matches }`; the plugin reads only:

`unit.file`, `unit.line`, `unit.end_line`, `unit.name`, `unit.qualified_name`,
`unit.unit_type`, `unit.signature`, `unit.docstring`, `unit.code`, and `score`.

`unit.docstring` is commonly `null`; `unit.code` is large, so `details.hits`
strips it. `matches` is unused — the unit is the result.

### 4.4 `code_agent` argv and JSON

```
--agent --json --color never <query> [<path>...]
```

Agent mode rejects search-only flags (`-k`, `--include`, `--exclude`, …) rather
than ignoring them, so the tool sends none. The JSON object is
`{ query, locations: [{ file, start_line, end_line }], submitted, end_reason,
error, turns, searches, reads, prompt_tokens, cached_prompt_tokens,
completion_tokens, llm_seconds, tool_seconds, seconds }`; the plugin reads
`locations`, `end_reason`, `error`, `turns`, `searches`, `reads`, `seconds`.

A non-null `error` inside a zero-exit response is rendered but not marked
`isError`: the CLI already produced a usable answer (or an explicit "no
locations") and the model can act on it.

### 4.5 Rendering

- Search header: `N results for "<query>"`, `N matches for /pattern/`, or
  `N results for "<query>" with /pattern/`; zero hits is one sentence that
  suggests rephrasing, widening the path, or passing `pattern`.
- Hit block: `<path>:<start>-<end>  <name>  [<unitType>]`, then the first
  signature line (≤160 chars) and the first docstring line (≤200 chars) when
  non-empty; a blank line separates hits.
- `files_only` replaces blocks with one deduplicated path per line.
- `content` adds up to 50 numbered code lines (`<lineNo>|<code>`, 1-based from
  `unit.line`) per block, then `… (truncated; read <path>:<start>)`.
- Agent reply: `N locations for "<query>" (Xs, N turns, N searches)`, one
  `<path>:<start>-<end>` per location, then `agent error:` / `end reason:` lines
  when applicable.
- Paths are cwd-relative when inside the session cwd, absolute otherwise.

## 5. Known limits

1. **Host files only.** The index covers files on disk. `omp://`, `skill://`,
   archive members, and `out://` are not indexed — the native `grep`/`read`
   tools remain the answer there. The rule says so.
2. **Agent mode has no search flags.** `code_agent` accepts a query and paths;
   any precision control belongs to `code_search`.
3. **JSON schema is 1.8.5.** A different colgrep build may rename fields;
   `parseSearchJson`/`parseAgentJson` fail with the raw output rather than
   guessing.
4. **No streaming.** The first index build shows one progress line, then
   silence for as long as indexing takes. Progress events from colgrep are not
   exposed in `--json` mode.
5. **Ranking is not evidence of absence.** Documented in the rule so the model
   rephrases instead of concluding code does not exist.
6. **Agent endpoint is user-configured.** `code_agent` requires the user's
   `colgrep settings --agent-endpoint*` configuration; without it the CLI's own
   error comes back verbatim.

## 6. Verification

```sh
cd plugins/colgrep
bun install
bun run typecheck
bun test                                   # unit tests, no binary needed
COLGREP_LIVE=1 bun test src/live.test.ts   # real index, real binary
omp plugin link plugins/colgrep
omp plugin list --json                     # omp-plugin-colgrep@0.1.0, enabled
omp plugin doctor                          # 0 errors
```

`src/live.test.ts` runs a stub `exec` that spawns the real binary, asserting:
`code_search` finds `plugins/firecrawl/src/tool.ts` for a
`query`+`pattern` hybrid, `files_only` returns only `plugins/` paths, a
pattern-only search returns hits, `code_agent` localizes `defineTool`, and a
missing binary reports `colgrep binary not found`.

## 7. Open items

1. **Custom TUI renderers.** Both tools print plain text; a `renderCall`/
   `renderResult` pair could collapse hit blocks and show the index spinner.
   `ToolDefinition` supports it on the installed host version (18.18.3).
2. **Streaming index progress.** colgrep emits no machine-readable progress in
   `--json` mode; the single `onUpdate` line is a placeholder until it does.
3. **Typecheck wiring.** Dev dependencies are installed, so `bun run typecheck`
   resolves host types today; a plugin installed from the marketplace has no
   `node_modules`, and nothing at runtime needs one (no `import` of host code,
   `import type` only). Keep it that way.
