/**
 * `code_agent` — colgrep's local read-only localization agent.
 *
 * The agent picks its own searches and reads files, then answers with
 * locations; search-only flags are rejected by the CLI, so this tool sends the
 * query and paths and nothing else.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentLocation } from "../colgrep";
import {
	AGENT_TIMEOUT_MS,
	buildAgentArgs,
	colgrepBin,
	displayPath,
	envTimeout,
	errorResult,
	failureMessage,
	parseAgentJson,
	renderAgent,
	runColgrep,
	splitPaths,
	textResult,
	thrownMessage,
} from "../colgrep";

/** Structured result the UI reads; file paths are cwd-relative when inside it. */
type AgentDetails = {
	query: string;
	locations: AgentLocation[];
	endReason: string | null;
	error: string | null;
	turns: number;
	searches: number;
	reads: number;
	seconds: number;
	elapsedMs: number;
};

const TOOL = "code_agent";

export function registerCodeAgent(pi: ExtensionAPI): void {
	const z = pi.zod;

	const parameters = z.object({
		query: z.string().describe("Natural-language question about where behavior is implemented"),
		path: z.string().describe("Directory, file, or several separated by ';'; default: session cwd").optional(),
	});

	pi.registerTool<typeof parameters, AgentDetails | { error: { tool: string; message: string } }>({
		name: TOOL,
		label: "Code Agent",
		loadMode: "essential",
		approval: "read",
		description: `Localize code with colgrep's local read-only agent: it searches and reads files, then returns locations.
Use for vague behavior questions or a shortlist of files; slower than code_search, still free.
Accepts a natural-language query and optional paths; returns file:start-end plus turns/searches.`,
		parameters,
		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as { query: string; path?: string };
			const query = params.query.trim();

			if (!query) {
				return errorResult(TOOL, `${TOOL} needs a query.`);
			}

			onUpdate?.({
				content: [{ type: "text", text: "Local colgrep agent is searching…" }],
			});

			const timeoutMs = envTimeout("COLGREP_AGENT_TIMEOUT_MS", AGENT_TIMEOUT_MS);
			let run;
			try {
				run = await runColgrep(pi.exec, buildAgentArgs(query, splitPaths(params.path, ctx.cwd)), {
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
					`${TOOL} timed out after ${seconds}s. Narrow path, raise COLGREP_AGENT_TIMEOUT_MS, or run colgrep init first.`,
				);
			}

			if (run.code !== 0) {
				return errorResult(TOOL, failureMessage(TOOL, colgrepBin(), run));
			}

			let parsed;
			try {
				parsed = parseAgentJson(run.stdout);
			} catch (error) {
				return errorResult(TOOL, error instanceof Error ? error.message : String(error));
			}

			return textResult(renderAgent(parsed, query, ctx.cwd), {
				query,
				locations: parsed.locations.map((location) => ({
					file: displayPath(location.file, ctx.cwd),
					startLine: location.startLine,
					endLine: location.endLine,
				})),
				endReason: parsed.endReason,
				error: parsed.error,
				turns: parsed.turns,
				searches: parsed.searches,
				reads: parsed.reads,
				seconds: parsed.seconds,
				elapsedMs: run.elapsedMs,
			} satisfies AgentDetails);
		},
	});
}
