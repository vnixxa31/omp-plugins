/**
 * `firecrawl_credit_usage` view → SDK-method mapping (`AGENTS.md` §5.8) and
 * the §3.3 description budget for the ops family. The SDK client is stubbed,
 * so nothing here touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api } from "../api";
import { registerOpsTools } from "./ops";

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

function opsTools(): Map<string, Executable> {
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerOpsTools(pi);
	return tools;
}

function tool(name: string): Executable {
	const found = opsTools().get(name);
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

describe("firecrawl_credit_usage view mapping", () => {
	test("an empty request reads the current balance, not history", async () => {
		let currentCalls = 0;
		let historicalCalls = 0;
		stub("getCreditUsage", async () => {
			currentCalls += 1;
			return { remainingCredits: 100 };
		});
		stub("getCreditUsageHistorical", async () => {
			historicalCalls += 1;
			return { success: true, periods: [] };
		});

		const result = await tool("firecrawl_credit_usage").execute("1", {});

		expect(result.isError).toBeUndefined();
		expect(currentCalls).toBe(1);
		expect(historicalCalls).toBe(0);
		expect(text(result)).toBe('{"remainingCredits":100}');
	});

	test("the historical view calls the historical endpoint with byApiKey", async () => {
		let currentCalls = 0;
		let seenByApiKey: unknown = "unset";
		stub("getCreditUsage", async () => {
			currentCalls += 1;
			return { remainingCredits: 100 };
		});
		stub("getCreditUsageHistorical", async (byApiKey?: boolean) => {
			seenByApiKey = byApiKey;
			return { success: true, periods: [{ startDate: null, endDate: null, creditsUsed: 5 }] };
		});

		const result = await tool("firecrawl_credit_usage").execute("1", { view: "historical", byApiKey: true });

		expect(result.isError).toBeUndefined();
		expect(currentCalls).toBe(0);
		expect(seenByApiKey).toBe(true);
		expect(result.details).toEqual({ success: true, periods: [{ startDate: null, endDate: null, creditsUsed: 5 }] });
	});
});

describe("ops family descriptions", () => {
	test("every first line is one imperative sentence of at most 120 chars", () => {
		for (const toolDef of opsTools().values()) {
			const first = toolDef.description.split("\n")[0] ?? "";
			expect(first.length).toBeLessThanOrEqual(120);
			expect(first.toLowerCase().startsWith("this tool")).toBe(false);
		}
	});
});
