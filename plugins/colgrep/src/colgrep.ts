/**
 * colgrep process layer — the only module that knows colgrep's CLI.
 *
 * Every tool call goes through `runColgrep`, which owns the binary lookup, the
 * timeout, and the elapsed-time measurement. Argument construction, JSON
 * parsing, and text rendering are pure functions exported for tests, so tool
 * modules contain no argv strings and no output shape knowledge.
 *
 * colgrep 1.8.5 contract (see `AGENTS.md` §4):
 * - search: `--json` prints an array of `{ unit: {…}, score, matches }`.
 * - agent: `--agent --json` prints one object with `locations`, `end_reason`,
 *   `error`, `turns`, `searches`, `reads`, `seconds`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExecResult } from "@oh-my-pi/pi-coding-agent";

/** Default search timeout: the first search of a project builds its index. */
export const SEARCH_TIMEOUT_MS = 300_000;
/** Default agent timeout: the local model runs several searches and reads. */
export const AGENT_TIMEOUT_MS = 600_000;

/** A colgrep run plus the wall time it took, which the text footer reports. */
export type ColgrepRun = ExecResult & { elapsedMs: number };

/** One text block: what the model reads. `details` carries the structured data. */
export type ToolEnvelope<TDetails = unknown> = {
	content: { type: "text"; text: string }[];
	details: TDetails;
	isError?: boolean;
};

/** Success envelope whose text a renderer produced. */
export function textResult<TDetails>(text: string, details: TDetails): ToolEnvelope<TDetails> {
	return { content: [{ type: "text", text }], details };
}

/** Failure envelope: the model reads the message, the UI reads the details. */
export function errorResult<TTool extends string>(
	tool: TTool,
	message: string,
): ToolEnvelope<{ error: { tool: TTool; message: string } }> {
	return {
		content: [{ type: "text", text: message }],
		details: { error: { tool, message } },
		isError: true,
	};
}

/** The colgrep executable: `COLGREP_BIN` when set, otherwise the PATH entry. */
export function colgrepBin(): string {
	const override = process.env.COLGREP_BIN?.trim();
	return override && override.length > 0 ? override : "colgrep";
}

/** Timeout from an env var in milliseconds; an invalid or non-positive value falls back. */
export function envTimeout(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Run colgrep and return stdout/stderr/exit code plus elapsed time.
 *
 * A non-zero exit is a normal result, never a throw: the tools render it. A
 * missing binary still throws (`ENOENT`), which the tools map to one message.
 */
export async function runColgrep(
	exec: ExtensionAPI["exec"],
	args: string[],
	opts: { cwd: string; signal?: AbortSignal; timeoutMs: number },
): Promise<ColgrepRun> {
	const started = performance.now();
	const result = await exec(colgrepBin(), args, {
		cwd: opts.cwd,
		signal: opts.signal,
		timeout: opts.timeoutMs,
	});
	return { ...result, elapsedMs: Math.round(performance.now() - started) };
}

/** Search parameters after transport cleanup (paths are resolved at exec time). */
export type SearchParams = {
	query?: string;
	pattern?: string;
	fixed?: boolean;
	whole_word?: boolean;
	case_sensitive?: boolean;
	path?: string;
	include?: string[];
	exclude?: string[];
	exclude_dir?: string[];
	results?: number;
	context?: number;
	code_only?: boolean;
	files_only?: boolean;
	content?: boolean;
	skip_index_update?: boolean;
};

/**
 * Split a `;`-separated path list into colgrep positionals.
 *
 * Relative entries are returned unchanged: they resolve against the run's cwd,
 * which is the session cwd, so no rewriting is needed or wanted.
 */
export function splitPaths(path: string | undefined, _cwd: string): string[] {
	if (!path) return [];
	return path
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function present(value: string | undefined): value is string {
	return value !== undefined && value.length > 0;
}

/**
 * Search argv. `--json` and `--color never` are unconditional so the caller
 * always parses structured output with no ANSI noise; `-y` answers the index
 * prompt that would otherwise block a non-interactive run.
 *
 * `files_only` and `content` are rendered from the JSON, not from `-l`/`-c`:
 * those flags replace the JSON with a different shape.
 */
export function buildSearchArgs(p: SearchParams): string[] {
	const args = ["--json", "--color", "never", "-y"];

	if (p.results !== undefined && p.results > 0) args.push("-k", String(p.results));
	if (p.context !== undefined && p.context >= 0) args.push("-n", String(p.context));

	for (const pattern of p.include ?? []) args.push("--include", pattern);
	for (const pattern of p.exclude ?? []) args.push("--exclude", pattern);
	for (const dir of p.exclude_dir ?? []) args.push("--exclude-dir", dir);

	if (p.fixed) args.push("-F");
	if (p.whole_word) args.push("-w");
	if (p.case_sensitive) args.push("-s");
	if (p.code_only) args.push("--code-only");
	if (p.skip_index_update) args.push("--no-update");

	if (present(p.pattern)) args.push("-e", p.pattern);
	if (present(p.query)) args.push(p.query);

	args.push(...splitPaths(p.path, "."));
	return args;
}

/** Agent argv: positional query, then paths. Search-only flags are rejected upstream. */
export function buildAgentArgs(query: string, paths: string[]): string[] {
	return ["--agent", "--json", "--color", "never", query, ...paths];
}

/** One ranked code unit. `code` is present only when the caller asked for bodies. */
export type Hit = {
	file: string;
	startLine: number;
	endLine: number;
	name: string;
	qualifiedName: string;
	unitType: string;
	signature: string;
	docstring?: string;
	score: number;
	code?: string;
};

/** One location the local agent localized. */
export type AgentLocation = { file: string; startLine: number; endLine: number };

/** The agent's answer, reduced to the fields the tools use. */
export type AgentResult = {
	locations: AgentLocation[];
	endReason: string | null;
	error: string | null;
	turns: number;
	searches: number;
	reads: number;
	seconds: number;
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse `colgrep --json` search output.
 *
 * Mixed output (a warning line before the array) is an error, not something to
 * repair: the first 300 characters say exactly what arrived.
 */
export function parseSearchJson(stdout: string): Hit[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`colgrep returned non-JSON output: ${stdout.slice(0, 300)}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`colgrep returned non-JSON output: ${stdout.slice(0, 300)}`);
	}

	const hits: Hit[] = [];
	for (const entry of parsed) {
		const unit = asRecord(asRecord(entry).unit);
		const file = str(unit.file);
		if (!file) throw new Error(`colgrep returned a result without a file path: ${JSON.stringify(entry).slice(0, 300)}`);
		const startLine = num(unit.line, 1);
		const docstring = str(unit.docstring);
		hits.push({
			file,
			startLine,
			endLine: num(unit.end_line, startLine),
			name: str(unit.name),
			qualifiedName: str(unit.qualified_name),
			unitType: str(unit.unit_type),
			signature: str(unit.signature),
			...(docstring ? { docstring } : {}),
			score: num(asRecord(entry).score),
			...(typeof unit.code === "string" ? { code: unit.code } : {}),
		});
	}
	return hits;
}

/** Parse `colgrep --agent --json` output. */
export function parseAgentJson(stdout: string): AgentResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`colgrep returned non-JSON output: ${stdout.slice(0, 300)}`);
	}
	const root = asRecord(parsed);
	if (!Array.isArray(root.locations)) {
		throw new Error(`colgrep returned non-JSON output: ${stdout.slice(0, 300)}`);
	}

	const locations: AgentLocation[] = [];
	for (const entry of root.locations) {
		const location = asRecord(entry);
		const file = str(location.file);
		if (!file) continue;
		const startLine = num(location.start_line, 1);
		locations.push({ file, startLine, endLine: num(location.end_line, startLine) });
	}

	return {
		locations,
		endReason: typeof root.end_reason === "string" ? root.end_reason : null,
		error: typeof root.error === "string" ? root.error : null,
		turns: num(root.turns),
		searches: num(root.searches),
		reads: num(root.reads),
		seconds: num(root.seconds),
	};
}

/** `<cwd>`-relative when the path is inside the session, absolute otherwise. */
export function displayPath(file: string, cwd: string): string {
	const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return file.startsWith(base) ? file.slice(base.length) : file;
}

/** Counted noun with its irregular plural kept inline: `3 results`, `2 matches`. */
function plural(count: number, noun: string, nounPlural = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : nounPlural}`;
}

/** One line describing what was searched, shared by every search header. */
function searchSubject(p: SearchParams): string {
	const query = p.query?.trim() ?? "";
	const pattern = present(p.pattern) ? `/${p.pattern}/` : "";
	if (query && pattern) return `"${query}" with ${pattern}`;
	if (query) return `"${query}"`;
	return pattern || "(no query)";
}

const CONTENT_LINE_LIMIT = 50;

/** Render search hits as ranked blocks, a file list, or code bodies. */
export function renderSearch(hits: Hit[], p: SearchParams, cwd: string): string {
	const subject = searchSubject(p);
	const query = p.query?.trim() ?? "";
	const patternOnly = !query && present(p.pattern);
	const countText = patternOnly ? plural(hits.length, "match", "matches") : plural(hits.length, "result");

	if (hits.length === 0) {
		return `No matches for ${subject}. Rephrase the query, widen the path, or pass pattern for an exact string.`;
	}

	const lines = [`${countText} for ${subject}`, ""];

	if (p.files_only) {
		const seen = new Set<string>();
		for (const hit of hits) {
			const path = displayPath(hit.file, cwd);
			if (seen.has(path)) continue;
			seen.add(path);
			lines.push(path);
		}
		return lines.join("\n");
	}

	const blocks: string[] = [];
	for (const hit of hits) {
		const path = displayPath(hit.file, cwd);
		const block = [`${path}:${hit.startLine}-${hit.endLine}  ${hit.name}  [${hit.unitType}]`];

		const signature = hit.signature.split("\n")[0]?.trim() ?? "";
		if (signature) block.push(`  ${signature.slice(0, 160)}`);

		const docstring = hit.docstring?.split("\n")[0]?.trim() ?? "";
		if (docstring) block.push(`  ${docstring.slice(0, 200)}`);

		if (p.content && hit.code) {
			const body = hit.code.split("\n");
			const shown = body.slice(0, CONTENT_LINE_LIMIT);
			shown.forEach((line, index) => {
				block.push(`    ${hit.startLine + index}|${line}`);
			});
			if (body.length > shown.length) {
				block.push(`    … (truncated; read ${path}:${hit.startLine + shown.length})`);
			}
		}

		blocks.push(block.join("\n"));
	}

	lines.push(blocks.join("\n\n"));
	return lines.join("\n");
}

/** Render the agent's locations plus its own run statistics. */
export function renderAgent(result: AgentResult, query: string, cwd: string): string {
	if (result.locations.length === 0) {
		const error = result.error ? `\nagent error: ${result.error}` : "";
		return `No locations for "${query}". Rephrase the query or use code_search.${error}`;
	}

	const lines = [
		`${plural(result.locations.length, "location")} for "${query}" (${result.seconds.toFixed(1)}s, ${plural(result.turns, "turn")}, ${plural(result.searches, "search", "searches")})`,
		...result.locations.map(
			(location) => `${displayPath(location.file, cwd)}:${location.startLine}-${location.endLine}`,
		),
	];
	if (result.error) lines.push(`agent error: ${result.error}`);
	if (result.endReason !== "Answered") lines.push(`end reason: ${result.endReason ?? "unknown"}`);
	return lines.join("\n");
}

const STDERR_TAIL_LINES = 20;

/**
 * Render a failed run as the model-facing message.
 *
 * A missing binary is the one failure with its own actionable sentence; every
 * other non-zero exit shows the CLI's own last lines so the cause stays visible.
 */
export function failureMessage(toolName: string, bin: string, run: ColgrepRun): string {
	const output = run.stderr.trim() || run.stdout.trim();
	const lines = output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);

	const first = lines[0] ?? "";
	if (/No such file or directory|ENOENT/.test(first)) {
		return `colgrep binary not found (${bin}). Put colgrep on PATH or set COLGREP_BIN.`;
	}

	const tail = lines.slice(-STDERR_TAIL_LINES).join("\n");
	return `${toolName} failed (exit ${run.code}): ${tail || "no output"}`;
}

/** Render a throw from the exec layer (missing binary, spawn refusal) as a message. */
export function thrownMessage(toolName: string, bin: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/ENOENT|No such file or directory/i.test(message)) {
		return `colgrep binary not found (${bin}). Put colgrep on PATH or set COLGREP_BIN.`;
	}
	return `${toolName} failed: ${message}`;
}
