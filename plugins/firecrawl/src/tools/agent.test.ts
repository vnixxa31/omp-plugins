/**
 * `firecrawl_agent` exchange validation (`AGENTS.md` §5.5) and the §3.3
 * description budget for the agent family. The SDK client is stubbed, so
 * nothing here touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api } from "../api";
import { registerAgentTools } from "./agent";

type Executable = {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details?: unknown; isError?: boolean }>;
};

function agentTools(): Map<string, Executable> {
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerAgentTools(pi);
	return tools;
}

function tool(name: string): Executable {
	const found = agentTools().get(name);
	if (!found) throw new Error(`${name} was not registered`);
	return found;
}

function text(envelope: { content: { text: string }[] }): string {
	return envelope.content[0]?.text ?? "";
}

const client = api() as unknown as Record<string, unknown>;
const originals = new Map<string, unknown>();

// `never[]` parameters make any promise-returning function assignable (contravariance)
// without a bare `any`. The stub only stores the implementation, never calls it.
function stub(method: string, implementation: (...args: never[]) => Promise<unknown>): void {
	if (!originals.has(method)) originals.set(method, client[method]);
	client[method] = implementation;
}

afterEach(() => {
	for (const [method, original] of originals) client[method] = original;
	originals.clear();
});

describe("firecrawl_agent exchange validation", () => {
	test("rejects exchange.approve without a threadId, before any SDK call", async () => {
		let called = false;
		stub("startAgent", async () => {
			called = true;
			return { success: true, id: "job_1" };
		});

		const result = await tool("firecrawl_agent").execute("1", {
			prompt: "anything",
			exchange: { approve: { approvalId: "ap_1" } },
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("threadId");
		expect(called).toBe(false);
	});

	test("rejects exchange.decline without a threadId, before any SDK call", async () => {
		let called = false;
		stub("startAgent", async () => {
			called = true;
			return { success: true, id: "job_1" };
		});

		const result = await tool("firecrawl_agent").execute("1", {
			prompt: "anything",
			exchange: { decline: { approvalId: "ap_1" } },
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("threadId");
		expect(called).toBe(false);
	});

	test("rejects approve and decline in the same exchange, even on a thread", async () => {
		let called = false;
		stub("startAgent", async () => {
			called = true;
			return { success: true, id: "job_1" };
		});

		const result = await tool("firecrawl_agent").execute("1", {
			prompt: "anything",
			threadId: "th_1",
			exchange: { approve: { approvalId: "ap_1" }, decline: { approvalId: "ap_1" } },
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("mutually exclusive");
		expect(called).toBe(false);
	});
});

describe("agent family descriptions", () => {
	test("every first line is one imperative sentence of at most 120 chars", () => {
		for (const toolDef of agentTools().values()) {
			const first = toolDef.description.split("\n")[0] ?? "";
			expect(first.length).toBeLessThanOrEqual(120);
			expect(first.toLowerCase().startsWith("this tool")).toBe(false);
		}
	});
});
