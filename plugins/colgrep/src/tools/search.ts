/**
 * `code_search` — semantic and hybrid code search over colgrep's index.
 *
 * The tool is thin on purpose: argv comes from `buildSearchArgs`, text from
 * `renderSearch`, failures from `failureMessage`/`thrownMessage`. It owns only
 * the ordering of those steps, the timeout, and the details payload.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Hit, SearchParams } from "../colgrep";
import {
	buildSearchArgs,
	colgrepBin,
	displayPath,
	envTimeout,
	errorResult,
	failureMessage,
	parseSearchJson,
	renderSearch,
	runColgrep,
	SEARCH_TIMEOUT_MS,
	textResult,
	thrownMessage,
} from "../colgrep";

/** Structured result the UI reads; code bodies stay out of it. */
type SearchDetails = {
	query?: string;
	pattern?: string;
	count: number;
	files: string[];
	scope: string;
	elapsedMs: number;
	hits: Omit<Hit, "code">[];
};

const TOOL = "code_search";

export function registerCodeSearch(pi: ExtensionAPI): void {
	const z = pi.zod;

	const parameters = z.object({
		query: z
			.string()
			.describe("Natural-language description of the behavior or code to find; omit only when pattern is set")
			.optional(),
		pattern: z.string().describe("Text or regex pre-filter; combine with query for hybrid ranking").optional(),
		fixed: z.boolean().describe("Treat pattern as a literal string instead of a regex").optional(),
		whole_word: z.boolean().describe("Match whole words only for pattern").optional(),
		case_sensitive: z.boolean().describe("Match pattern case-sensitively (default is case-insensitive)").optional(),
		path: z.string().describe("Directory, file, or several separated by ';'; default: session cwd").optional(),
		include: z.array(z.string()).describe("Only search files matching these patterns, e.g. '*.ts'").optional(),
		exclude: z.array(z.string()).describe("Skip files matching these patterns").optional(),
		exclude_dir: z.array(z.string()).describe("Skip directories by name or glob, e.g. 'node_modules'").optional(),
		results: z
			.number()
			.describe("Maximum ranked results; 20-30 when exploring; omit for the colgrep default")
			.optional(),
		context: z.number().describe("Context lines shown per match").optional(),
		files_only: z.boolean().describe("Return the ranked file list only, without code units").optional(),
		code_only: z.boolean().describe("Search code files only, skipping docs and config").optional(),
		content: z.boolean().describe("Include up to 50 lines of each unit's code").optional(),
		skip_index_update: z.boolean().describe("Search the existing index without updating it first").optional(),
	});

	pi.registerTool<typeof parameters, SearchDetails | { error: { tool: string; message: string } }>({
		name: TOOL,
		label: "Code Search",
		loadMode: "essential",
		approval: "read",
		description: `Search code by meaning (semantic index) with optional text or regex pre-filter; returns ranked code units.
Use for intent queries, subsystem exploration, or "where is this implemented" when you lack exact text.
Use native grep for exact regex, omp:// or skill:// URLs, archives, or line ranges; use glob for file names.
Pass content:true for bodies, or read the reported file:start-end.`,
		parameters,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as SearchParams;
			const query = params.query?.trim() ?? "";
			const pattern = params.pattern?.trim() ?? "";

			if (!query && !pattern) {
				return errorResult(TOOL, `${TOOL} needs a query, a pattern, or both.`);
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: "Searching with colgrep… (a project's first search builds its index)",
					},
				],
			});

			const timeoutMs = envTimeout("COLGREP_SEARCH_TIMEOUT_MS", SEARCH_TIMEOUT_MS);
			let run;
			try {
				run = await runColgrep(pi.exec, buildSearchArgs(params), {
					cwd: ctx.cwd,
					signal,
					timeoutMs,
				});
			} catch (error) {
				return errorResult(TOOL, thrownMessage(TOOL, colgrepBin(), error));
			}

			if (run.killed || run.code === -1) {
				if (signal?.aborted) return errorResult(TOOL, `${TOOL} cancelled.`);
				const seconds = Math.round(timeoutMs / 1000);
				return errorResult(
					TOOL,
					`${TOOL} timed out after ${seconds}s. Narrow path, raise COLGREP_SEARCH_TIMEOUT_MS, or run colgrep init first.`,
				);
			}

			if (run.code !== 0) {
				return errorResult(TOOL, failureMessage(TOOL, colgrepBin(), run));
			}

			let hits: Hit[];
			try {
				hits = parseSearchJson(run.stdout);
			} catch (error) {
				return errorResult(TOOL, error instanceof Error ? error.message : String(error));
			}

			return textResult(renderSearch(hits, params, ctx.cwd), {
				query: params.query,
				pattern: params.pattern,
				count: hits.length,
				files: [...new Set(hits.map((hit) => displayPath(hit.file, ctx.cwd)))],
				scope: params.path ?? ".",
				elapsedMs: run.elapsedMs,
				hits: hits.map(({ code, ...rest }) => rest),
			} satisfies SearchDetails);
		},
	});
}
