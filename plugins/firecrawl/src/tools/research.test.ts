/**
 * Research tools' non-trivial local logic: the `getPaper` detail-vs-read
 * overload split, `k` requiring `query`, required `intent`, and the tool
 * catalog itself (`AGENTS.md` §3.3, §5, §7). The `research` client is stubbed
 * on the shared `api()` singleton, so nothing here touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api } from "../api";
import { registerResearchTools } from "./research";

type Executable = {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details?: unknown; isError?: boolean }>;
};

function researchTools(): Map<string, Executable> {
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerResearchTools(pi);
	return tools;
}

function tool(name: string): Executable {
	const found = researchTools().get(name);
	if (!found) throw new Error(`${name} was not registered`);
	return found;
}

function text(envelope: { content: { text: string }[] }): string {
	return envelope.content[0]?.text ?? "";
}

const client = api() as unknown as Record<string, unknown>;
const originalResearch = Object.getOwnPropertyDescriptor(client, "research");

function stubResearch(implementation: Record<string, (...args: unknown[]) => Promise<unknown>>): void {
	Object.defineProperty(client, "research", { value: implementation, configurable: true, writable: true });
}

afterEach(() => {
	if (originalResearch) Object.defineProperty(client, "research", originalResearch);
	else delete client.research;
});

describe("research tool catalog", () => {
	test("registers all five research tools", () => {
		expect([...researchTools().keys()].sort()).toEqual([
			"firecrawl_gov_search",
			"firecrawl_research_inspect_paper",
			"firecrawl_research_read_paper",
			"firecrawl_research_related_papers",
			"firecrawl_research_search_papers",
		]);
	});

	test("every description's first line is one imperative sentence within 120 chars", () => {
		for (const [name, entry] of researchTools()) {
			const first = entry.description.split("\n")[0] ?? "";
			expect(first.length, `${name} first line is ${first.length} chars`).toBeLessThanOrEqual(120);
			expect(first.startsWith("This tool"), name).toBe(false);
		}
	});
});

describe("firecrawl_research_read_paper modes", () => {
	test("without query it calls the detail overload with the id only", async () => {
		let args: unknown[] = [];
		stubResearch({
			getPaper: async (...callArgs: unknown[]) => {
				args = callArgs;
				return { success: true, paper: { paperId: "1", title: "T", abstract: "A" } };
			},
		});

		const result = await tool("firecrawl_research_read_paper").execute("1", { id: "arxiv:2401.00001" });

		expect(result.isError).toBeUndefined();
		expect(args).toEqual(["arxiv:2401.00001"]);
	});

	test("with query it calls the read overload passing query and k", async () => {
		let args: unknown[] = [];
		stubResearch({
			getPaper: async (...callArgs: unknown[]) => {
				args = callArgs;
				return { success: true, paper: {}, paperId: "1", query: "methods", passages: [] };
			},
		});

		const result = await tool("firecrawl_research_read_paper").execute("1", {
			id: "pmid:123",
			query: "methods",
			k: 8,
		});

		expect(result.isError).toBeUndefined();
		expect(args).toEqual(["pmid:123", { query: "methods", k: 8 }]);
	});

	test("rejects k without query and sends no request", async () => {
		let called = false;
		stubResearch({
			getPaper: async () => {
				called = true;
				return {};
			},
		});

		const result = await tool("firecrawl_research_read_paper").execute("1", { id: "p1", k: 4 });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`query`");
		expect(called).toBe(false);
	});
});

describe("firecrawl_research_inspect_paper", () => {
	test("calls the detail overload with the id only", async () => {
		let args: unknown[] = [];
		stubResearch({
			getPaper: async (...callArgs: unknown[]) => {
				args = callArgs;
				return { success: true, paper: { paperId: "1", title: "T", abstract: "A" } };
			},
		});

		const result = await tool("firecrawl_research_inspect_paper").execute("1", { id: "doi:10.1/x" });

		expect(result.isError).toBeUndefined();
		expect(args).toEqual(["doi:10.1/x"]);
	});
});

describe("firecrawl_research_related_papers", () => {
	test("rejects a missing intent and sends no request", async () => {
		let called = false;
		stubResearch({
			similarPapers: async () => {
				called = true;
				return {};
			},
		});

		const result = await tool("firecrawl_research_related_papers").execute("1", { id: "p1", k: 5 });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`intent`");
		expect(called).toBe(false);
	});

	test("rejects a blank intent and sends no request", async () => {
		let called = false;
		stubResearch({
			similarPapers: async () => {
				called = true;
				return {};
			},
		});

		const result = await tool("firecrawl_research_related_papers").execute("1", { id: "p1", intent: "   " });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`intent`");
		expect(called).toBe(false);
	});
});
