# omp-plugin-colgrep

Native omp tools for colgrep semantic code search: `code_search` ranks code units by meaning, `code_agent` runs colgrep's local read-only localization agent. No shell `grep` calls, no MCP server.

## Requirements

- **colgrep 1.8.5 or newer on `PATH`.** Set `COLGREP_BIN` to use a different executable.
- **Agent endpoint configured** for `code_agent`: run `colgrep settings --agent-endpoint <url>` (and the related `--agent-*` options) once. Building the index the first search needs happens automatically.
- The index covers host files only: `omp://`, `skill://`, archive members, and other virtual paths stay with the native `grep`, `read`, and `glob` tools.

## Tools

Both tools are `loadMode: "essential"` (present in every session) and `approval: "read"`.

### `code_search`

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string | Natural-language description of the behavior or code to find; omit only when `pattern` is set |
| `pattern` | string | Text or regex pre-filter; with `query` it becomes hybrid ranking |
| `fixed` | boolean | Treat `pattern` as a literal string |
| `whole_word` | boolean | Match whole words only |
| `case_sensitive` | boolean | Case-sensitive `pattern` (default: insensitive) |
| `path` | string | Directory, file, or several separated by `;`; default: session cwd |
| `include` | string[] | Only search files matching these patterns, e.g. `*.ts` |
| `exclude` | string[] | Skip files matching these patterns |
| `exclude_dir` | string[] | Skip directories by name or glob, e.g. `node_modules` |
| `results` | number | Maximum ranked results; 20-30 when exploring; omit for the colgrep default |
| `context` | number | Context lines per match |
| `files_only` | boolean | Ranked file list only, no code units |
| `code_only` | boolean | Search code files only, skipping docs and config |
| `content` | boolean | Include up to 50 lines of each unit's code |
| `skip_index_update` | boolean | Search the existing index without updating it first |

The text reply is one block per hit — `<path>:<start>-<end>  <name>  [<unitType>]`, then the signature and docstring first lines — strongest first. `files_only` collapses it to one path per line; `content` adds numbered code lines under each block.

### `code_agent`

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string | Natural-language question about where behavior is implemented |
| `path` | string | Directory, file, or several separated by `;`; default: session cwd |

The agent runs several `code_search`-style searches itself and reads files, then answers with locations. The reply is `<path>:<start>-<end>` per location plus its own `turns`/`searches`/`seconds`. colgrep rejects search-only flags in agent mode, so this tool sends none.

## Index behavior

colgrep indexes on first use: the first search of a project builds the index and can take a while. The tools always pass `-y`, so a large-repository confirmation prompt never blocks the call. Inspect the index with `colgrep status`, rebuild it with `colgrep init`, clear it with `colgrep clear`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `COLGREP_BIN` | `colgrep` | Executable to run |
| `COLGREP_SEARCH_TIMEOUT_MS` | `300000` | Search timeout; the first search builds the index |
| `COLGREP_AGENT_TIMEOUT_MS` | `600000` | Agent timeout |

## Optional: routing bash greps to `code_search`

The plugin registers **no hooks** and does not shadow the native `grep` tool. To have omp nudge bash `grep`/`rg`/`ag`/`ack` calls toward `code_search`, enable the bash interceptor in your own omp config:

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(grep|rg|ripgrep|ag|ack)\s+'
      tool: code_search
      message: "Use the code_search tool (colgrep) for code search; it ranks code by meaning. Keep shell grep only for stdin filtering or flags colgrep lacks."
```

This is a user-configurable omp feature; the plugin does not enable it for you.

## Development

```sh
cd plugins/colgrep
bun install
bun run typecheck
bun test
COLGREP_LIVE=1 bun test src/live.test.ts   # real-index smoke test, needs colgrep
omp plugin link plugins/colgrep
```

`AGENTS.md` records the design decisions, tool contracts, and known limits for later sessions.

## License

AGPL-3.0-or-later — see `LICENSE.md`.
