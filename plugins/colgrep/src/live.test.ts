/**
 * Live smoke test against the real colgrep binary and the repository's index.
 *
 * Opt-in (`COLGREP_LIVE=1 bun test src/live.test.ts`): it builds or updates the
 * index, runs the local agent, and takes as long as colgrep needs. The stub
 * `exec` spawns the binary so the tool's own argv and parsing are what run.
 */
import { describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";

const LIVE = process.env.COLGREP_LIVE === "1";
const REPO = new URL("../../..", import.meta.url).pathname;
const LIVE_TIMEOUT_MS = 300_000;

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

async function spawnExec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
	const proc = Bun.spawn([command, ...args], {
		cwd: options?.cwd ?? process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { stdout, stderr, code: await proc.exited, killed: false };
}

function tools(exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>) {
	const registered = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			registered.set(tool.name, tool);
		},
		exec,
	} as unknown as ExtensionAPI;
	extension(pi);
	return registered;
}

function text(envelope: Envelope): string {
	return envelope.content[0]?.text ?? "";
}

const live = LIVE ? describe : describe.skip;

live("live colgrep", () => {
	const tools_ = tools(spawnExec);
	const run = (name: string, params: unknown) =>
		tools_.get(name)!.execute("live", params, undefined, undefined, { cwd: REPO });

	test(
		"hybrid search finds the tool registration wrapper",
		async () => {
			const result = await run("code_search", {
				query: "registration wrapper for extension tools",
				pattern: "defineTool",
				fixed: true,
			});
			expect(result.isError).toBeUndefined();
			expect(text(result)).toContain("plugins/firecrawl/src/tool.ts:");
			const details = result.details as { count: number };
			expect(details.count).toBeGreaterThanOrEqual(1);
		},
		LIVE_TIMEOUT_MS,
	);

	test(
		"files_only returns only paths under the given scope",
		async () => {
			const result = await run("code_search", {
				query: "extension tool registration",
				path: "plugins",
				files_only: true,
			});
			expect(result.isError).toBeUndefined();
			const body = text(result).split("\n").slice(2).filter((line) => line.length > 0);
			expect(body.length).toBeGreaterThan(0);
			for (const line of body) expect(line.startsWith("plugins/")).toBe(true);
		},
		LIVE_TIMEOUT_MS,
	);

	test(
		"pattern-only search returns hits",
		async () => {
			const result = await run("code_search", { pattern: "defineTool", fixed: true, path: "plugins" });
			expect(result.isError).toBeUndefined();
			expect((result.details as { count: number }).count).toBeGreaterThan(0);
			expect(text(result)).toContain("defineTool");
		},
		LIVE_TIMEOUT_MS,
	);

	test(
		"the local agent localizes defineTool",
		async () => {
			const result = await run("code_agent", { query: "where is defineTool defined" });
			expect(result.isError).toBeUndefined();
			const details = result.details as {
				locations: { file: string }[];
				endReason: string | null;
			};
			expect(details.locations.some((location) => location.file.endsWith("plugins/firecrawl/src/tool.ts"))).toBe(
				true,
			);
			expect(typeof details.endReason).toBe("string");
		},
		LIVE_TIMEOUT_MS,
	);
});

describe("missing binary", () => {
	test("reports one actionable sentence", async () => {
		const tools_ = tools(async () => {
			throw new Error("spawn colgrep ENOENT");
		});
		const result = await tools_
			.get("code_search")!
			.execute("live", { query: "anything" }, undefined, undefined, { cwd: REPO });
		expect(result.isError).toBe(true);
		expect(text(result).startsWith("colgrep binary not found")).toBe(true);
	});
});
