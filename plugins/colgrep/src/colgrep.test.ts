/**
 * colgrep process layer and tool pipeline.
 *
 * argv construction, JSON parsing, and rendering are pure; tool-level tests
 * stub `pi.exec` so no binary is needed. The real-binary smoke test lives in
 * `live.test.ts` (`COLGREP_LIVE=1`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";
import {
	buildAgentArgs,
	buildSearchArgs,
	displayPath,
	envTimeout,
	failureMessage,
	parseAgentJson,
	parseSearchJson,
	renderAgent,
	renderSearch,
	splitPaths,
	type ColgrepRun,
} from "./colgrep";

type Envelope = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };
type Executable = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<Envelope>;
};
type Call = { command: string; args: string[]; options?: ExecOptions };

const CWD = "/repo";

function harness(handler: (call: Call) => Promise<ExecResult>) {
	const calls: Call[] = [];
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
		exec: async (command: string, args: string[], options?: ExecOptions) => {
			const call = { command, args, options };
			calls.push(call);
			return handler(call);
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return { calls, tools };
}

function text(envelope: Envelope): string {
	return envelope.content[0]?.text ?? "";
}

function ok(stdout: string): () => Promise<ExecResult> {
	return async () => ({ stdout, stderr: "", code: 0, killed: false });
}

const SEARCH_JSON = JSON.stringify([
	{
		unit: {
			name: "defineTool",
			qualified_name: "plugins/firecrawl/src/tool.ts::defineTool",
			file: "/repo/plugins/firecrawl/src/tool.ts",
			line: 26,
			end_line: 58,
			language: "typescript",
			unit_type: "function",
			signature: "export function defineTool<TParams extends ZodLikeSchema<unknown>, TDetails>(",
			docstring: null,
			code: "line one\nline two",
		},
		score: 1.25,
		matches: [{ line: 26, end_line: 58, name: "defineTool", score: 1.25 }],
	},
	{
		unit: {
			name: "registerOpsTools",
			qualified_name: "plugins/firecrawl/src/tools/ops.ts::registerOpsTools",
			file: "/repo/plugins/firecrawl/src/tools/ops.ts",
			line: 12,
			end_line: 20,
			unit_type: "function",
			signature: "export function registerOpsTools(pi: ExtensionAPI): void {",
			docstring: "Account and quality tools.",
			code: "body",
		},
		score: 0.4,
		matches: [],
	},
]);

const AGENT_JSON = JSON.stringify({
	query: "where is defineTool defined",
	locations: [{ file: "/repo/plugins/firecrawl/src/tool.ts", start_line: 1, end_line: 86 }],
	submitted: true,
	end_reason: "Answered",
	error: null,
	turns: 8,
	searches: 6,
	reads: 0,
	seconds: 2.4881,
});

afterEach(() => {
	delete process.env.COLGREP_BIN;
	delete process.env.COLGREP_SEARCH_TIMEOUT_MS;
	delete process.env.COLGREP_AGENT_TIMEOUT_MS;
});

describe("buildSearchArgs", () => {
	test("query only", () => {
		expect(buildSearchArgs({ query: "error handling" })).toEqual([
			"--json",
			"--color",
			"never",
			"-y",
			"error handling",
		]);
	});

	test("pattern only", () => {
		expect(buildSearchArgs({ pattern: "defineTool" })).toEqual([
			"--json",
			"--color",
			"never",
			"-y",
			"-e",
			"defineTool",
		]);
	});

	test("hybrid with every flag in contract order", () => {
		expect(
			buildSearchArgs({
				query: "registration wrapper",
				pattern: "defineTool",
				results: 25,
				context: 4,
				include: ["*.ts", "*.rs"],
				exclude: ["*.test.ts"],
				exclude_dir: ["node_modules", "dist"],
				fixed: true,
				whole_word: true,
				case_sensitive: true,
				code_only: true,
				skip_index_update: true,
				path: "plugins; src/web",
			}),
		).toEqual([
			"--json",
			"--color",
			"never",
			"-y",
			"-k",
			"25",
			"-n",
			"4",
			"--include",
			"*.ts",
			"--include",
			"*.rs",
			"--exclude",
			"*.test.ts",
			"--exclude-dir",
			"node_modules",
			"--exclude-dir",
			"dist",
			"-F",
			"-w",
			"-s",
			"--code-only",
			"--no-update",
			"-e",
			"defineTool",
			"registration wrapper",
			"plugins",
			"src/web",
		]);
	});

	test("files_only and content add no argv", () => {
		expect(buildSearchArgs({ query: "q", files_only: true, content: true })).toEqual(
			buildSearchArgs({ query: "q" }),
		);
	});

	test("zero or negative results and context are omitted", () => {
		expect(buildSearchArgs({ query: "q", results: 0, context: -1 })).toEqual([
			"--json",
			"--color",
			"never",
			"-y",
			"q",
		]);
	});
});

describe("buildAgentArgs and splitPaths", () => {
	test("agent argv carries the query then paths", () => {
		expect(buildAgentArgs("where is defineTool", ["plugins", "src"])).toEqual([
			"--agent",
			"--json",
			"--color",
			"never",
			"where is defineTool",
			"plugins",
			"src",
		]);
	});

	test("splits on ';' and drops blanks", () => {
		expect(splitPaths("plugins; ;src/ ", CWD)).toEqual(["plugins", "src/"]);
		expect(splitPaths(undefined, CWD)).toEqual([]);
	});
});

describe("parseSearchJson", () => {
	test("maps units to hits and treats a null docstring as absent", () => {
		const hits = parseSearchJson(SEARCH_JSON);
		expect(hits).toHaveLength(2);
		expect(hits[0]).toMatchObject({
			file: "/repo/plugins/firecrawl/src/tool.ts",
			startLine: 26,
			endLine: 58,
			name: "defineTool",
			unitType: "function",
			score: 1.25,
		});
		expect(hits[0]?.docstring).toBeUndefined();
		expect(hits[1]?.docstring).toBe("Account and quality tools.");
	});

	test("non-JSON output is an error naming the first 300 characters", () => {
		const noisy = `warning: index update skipped\n${SEARCH_JSON}`;
		expect(() => parseSearchJson(noisy)).toThrow(/^colgrep returned non-JSON output: warning: index/);
	});

	test("an object instead of an array is an error", () => {
		expect(() => parseSearchJson('{"units":[]}')).toThrow(/non-JSON output/);
	});
});

describe("parseAgentJson", () => {
	test("maps locations and run statistics", () => {
		const answer = parseAgentJson(AGENT_JSON);
		expect(answer.locations).toEqual([
			{ file: "/repo/plugins/firecrawl/src/tool.ts", startLine: 1, endLine: 86 },
		]);
		expect(answer.endReason).toBe("Answered");
		expect(answer.error).toBeNull();
		expect(answer).toMatchObject({ turns: 8, searches: 6, reads: 0 });
	});

	test("non-JSON output throws", () => {
		expect(() => parseAgentJson("not json")).toThrow(/non-JSON output/);
	});
});

describe("displayPath", () => {
	test("strips the session cwd and keeps outside paths absolute", () => {
		expect(displayPath("/repo/plugins/a.ts", CWD)).toBe("plugins/a.ts");
		expect(displayPath("/repo/plugins/a.ts", "/repo/")).toBe("plugins/a.ts");
		expect(displayPath("/elsewhere/a.ts", CWD)).toBe("/elsewhere/a.ts");
	});
});

describe("renderSearch", () => {
	const hits = parseSearchJson(SEARCH_JSON);

	test("hybrid header, ranked blocks, docstring line", () => {
		const out = renderSearch(hits, { query: "registration wrapper", pattern: "defineTool" }, CWD);
		const lines = out.split("\n");
		expect(lines[0]).toBe('2 results for "registration wrapper" with /defineTool/');
		expect(lines[2]).toBe("plugins/firecrawl/src/tool.ts:26-58  defineTool  [function]");
		expect(lines[3]).toBe("  export function defineTool<TParams extends ZodLikeSchema<unknown>, TDetails>(");
		expect(out).toContain("plugins/firecrawl/src/tools/ops.ts:12-20  registerOpsTools  [function]");
		expect(out).toContain("  Account and quality tools.");
	});

	test("pattern-only header counts matches", () => {
		expect(renderSearch(hits, { pattern: "defineTool" }, CWD).split("\n")[0]).toBe("2 matches for /defineTool/");
	});

	test("zero hits is a normal answer", () => {
		expect(renderSearch([], { query: "nothing" }, CWD)).toBe(
			'No matches for "nothing". Rephrase the query, widen the path, or pass pattern for an exact string.',
		);
	});

	test("files_only lists each file once, strongest first", () => {
		const out = renderSearch(hits, { query: "q", files_only: true }, CWD);
		expect(out.split("\n").slice(2)).toEqual([
			"plugins/firecrawl/src/tool.ts",
			"plugins/firecrawl/src/tools/ops.ts",
		]);
	});

	test("content numbers the unit lines from its start line", () => {
		const out = renderSearch(hits, { query: "q", content: true }, CWD);
		expect(out).toContain("    26|line one");
		expect(out).toContain("    27|line two");
	});

	test("content truncates past 50 lines and points at the remainder", () => {
		const long = { ...hits[0]!, code: Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n") };
		const out = renderSearch([long], { query: "q", content: true }, CWD);
		expect(out).toContain("    50|l24");
		expect(out).toContain("    75|l49");
		expect(out).not.toContain("l50");
		expect(out).toContain("… (truncated; read plugins/firecrawl/src/tool.ts:76)");
	});
});

describe("renderAgent", () => {
	test("locations plus run statistics", () => {
		const out = renderAgent(parseAgentJson(AGENT_JSON), "where is defineTool defined", CWD);
		expect(out.split("\n")).toEqual([
			'1 location for "where is defineTool defined" (2.5s, 8 turns, 6 searches)',
			"plugins/firecrawl/src/tool.ts:1-86",
		]);
	});

	test("reports a non-Answered end reason and an error", () => {
		const out = renderAgent(
			{ locations: [{ file: "/repo/a.ts", startLine: 1, endLine: 2 }], endReason: "MaxTurns", error: "boom", turns: 10, searches: 2, reads: 0, seconds: 9.04 },
			"q",
			CWD,
		);
		expect(out).toContain("a.ts:1-2");
		expect(out).toContain("agent error: boom");
		expect(out).toContain("end reason: MaxTurns");
	});

	test("zero locations suggests rephrasing", () => {
		expect(
			renderAgent({ locations: [], endReason: "Answered", error: null, turns: 1, searches: 1, reads: 0, seconds: 1 }, "q", CWD),
		).toBe('No locations for "q". Rephrase the query or use code_search.');
	});
});

describe("failureMessage", () => {
	const run = (overrides: Partial<ColgrepRun>): ColgrepRun => ({
		stdout: "",
		stderr: "",
		code: 2,
		killed: false,
		elapsedMs: 5,
		...overrides,
	});

	test("a missing binary is one actionable sentence", () => {
		expect(failureMessage("code_search", "colgrep", run({ stderr: "Error: No such file or directory (os error 2)" }))).toBe(
			"colgrep binary not found (colgrep). Put colgrep on PATH or set COLGREP_BIN.",
		);
	});

	test("other failures keep the CLI's own last lines", () => {
		const stderr = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
		const message = failureMessage("code_search", "colgrep", run({ stderr }));
		expect(message.startsWith("code_search failed (exit 2): line 5")).toBe(true);
		expect(message).toContain("line 24");
		expect(message).not.toContain("line 4\n");
	});

	test("empty stderr falls back to stdout, then to a placeholder", () => {
		expect(failureMessage("code_agent", "colgrep", run({ code: 1, stdout: "no endpoint configured" }))).toBe(
			"code_agent failed (exit 1): no endpoint configured",
		);
		expect(failureMessage("code_agent", "colgrep", run({ code: 1 }))).toBe("code_agent failed (exit 1): no output");
	});
});

describe("envTimeout", () => {
	test("reads a positive integer and ignores junk", () => {
		expect(envTimeout("COLGREP_SEARCH_TIMEOUT_MS", 300_000)).toBe(300_000);
		process.env.COLGREP_SEARCH_TIMEOUT_MS = "9000";
		expect(envTimeout("COLGREP_SEARCH_TIMEOUT_MS", 300_000)).toBe(9000);
		process.env.COLGREP_SEARCH_TIMEOUT_MS = "0";
		expect(envTimeout("COLGREP_SEARCH_TIMEOUT_MS", 300_000)).toBe(300_000);
		process.env.COLGREP_SEARCH_TIMEOUT_MS = "soon";
		expect(envTimeout("COLGREP_SEARCH_TIMEOUT_MS", 300_000)).toBe(300_000);
	});
});

describe("code_search execution", () => {
	test("rejects a call with neither query nor pattern before spawning", async () => {
		const { calls, tools } = harness(ok(SEARCH_JSON));
		const result = await tools.get("code_search")!.execute("1", {}, undefined, undefined, { cwd: CWD });
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("code_search needs a query, a pattern, or both.");
		expect(calls).toHaveLength(0);
	});

	test("runs from the session cwd with the default timeout", async () => {
		const { calls, tools } = harness(ok(SEARCH_JSON));
		await tools.get("code_search")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(calls[0]?.command).toBe("colgrep");
		expect(calls[0]?.options).toMatchObject({ cwd: CWD, timeout: 300_000 });
	});

	test("renders hits and keeps code bodies out of details", async () => {
		const { tools } = harness(ok(SEARCH_JSON));
		const result = await tools.get("code_search")!.execute(
			"1",
			{ query: "registration wrapper", path: "plugins" },
			undefined,
			undefined,
			{ cwd: CWD },
		);
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("plugins/firecrawl/src/tool.ts:26-58  defineTool  [function]");
		expect(result.details).toMatchObject({
			query: "registration wrapper",
			count: 2,
			files: ["plugins/firecrawl/src/tool.ts", "plugins/firecrawl/src/tools/ops.ts"],
			scope: "plugins",
		});
		// The tool's own details payload; `details` is `unknown` on the envelope.
		const details = result.details as { hits: { name?: unknown; code?: unknown }[] };
		expect(details.hits[0]?.code).toBeUndefined();
		expect(details.hits[0]?.name).toBe("defineTool");
	});

	test("a missing binary is reported, not thrown", async () => {
		const { tools } = harness(async () => {
			throw new Error("spawn colgrep ENOENT");
		});
		const result = await tools.get("code_search")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("colgrep binary not found (colgrep). Put colgrep on PATH or set COLGREP_BIN.");
	});

	test("COLGREP_BIN overrides the executable", async () => {
		process.env.COLGREP_BIN = "/opt/colgrep";
		const { calls, tools } = harness(ok(SEARCH_JSON));
		await tools.get("code_search")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(calls[0]?.command).toBe("/opt/colgrep");
	});

	test("a non-zero exit surfaces the CLI's message", async () => {
		const { tools } = harness(async () => ({ stdout: "", stderr: "error: index is locked", code: 3, killed: false }));
		const result = await tools.get("code_search")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("code_search failed (exit 3): error: index is locked");
	});

	test("a timeout names the env var", async () => {
		const { tools } = harness(async () => ({ stdout: "", stderr: "", code: -1, killed: true }));
		const result = await tools.get("code_search")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("code_search timed out after 300s");
		expect(text(result)).toContain("COLGREP_SEARCH_TIMEOUT_MS");
	});

	test("an aborted signal reports cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const { tools } = harness(async () => ({ stdout: "", stderr: "", code: -1, killed: true }));
		const result = await tools
			.get("code_search")!
			.execute("1", { query: "q" }, controller.signal, undefined, { cwd: CWD });
		expect(text(result)).toBe("code_search cancelled.");
	});

	test("malformed JSON is an error, never an empty result", async () => {
		const { tools } = harness(ok("warning: something\n[]"));
		const result = await tools.get("code_search")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("colgrep returned non-JSON output: warning: something");
	});
});

describe("code_agent execution", () => {
	test("passes the query and paths, then reports locations", async () => {
		const { calls, tools } = harness(ok(AGENT_JSON));
		const result = await tools
			.get("code_agent")!
			.execute("1", { query: "where is defineTool defined", path: "plugins" }, undefined, undefined, {
				cwd: CWD,
			});
		expect(calls[0]?.args).toEqual([
			"--agent",
			"--json",
			"--color",
			"never",
			"where is defineTool defined",
			"plugins",
		]);
		expect(calls[0]?.options).toMatchObject({ timeout: 600_000 });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("plugins/firecrawl/src/tool.ts:1-86");
		expect(result.details).toMatchObject({
			query: "where is defineTool defined",
			locations: [{ file: "plugins/firecrawl/src/tool.ts", startLine: 1, endLine: 86 }],
			endReason: "Answered",
			turns: 8,
		});
	});

	test("an agent error inside a zero exit is rendered but not an error result", async () => {
		const payload = JSON.parse(AGENT_JSON);
		payload.error = "endpoint timeout";
		payload.end_reason = "Error";
		const { tools } = harness(ok(JSON.stringify(payload)));
		const result = await tools.get("code_agent")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("agent error: endpoint timeout");
		expect(text(result)).toContain("end reason: Error");
	});

	test("a non-zero exit surfaces the CLI's message", async () => {
		const { tools } = harness(async () => ({
			stdout: "",
			stderr: "error: unknown option '-k'",
			code: 2,
			killed: false,
		}));
		const result = await tools.get("code_agent")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(text(result)).toBe("code_agent failed (exit 2): error: unknown option '-k'");
	});

	test("a missing binary is reported", async () => {
		const { tools } = harness(async () => {
			throw new Error("ENOENT: colgrep not found");
		});
		const result = await tools.get("code_agent")!.execute("1", { query: "q" }, undefined, undefined, { cwd: CWD });
		expect(text(result)).toBe("colgrep binary not found (colgrep). Put colgrep on PATH or set COLGREP_BIN.");
	});
});
