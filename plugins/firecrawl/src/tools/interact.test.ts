/**
 * `firecrawl_interact` / `firecrawl_interact_stop` behavior: the mutually
 * exclusive `url`/`scrapeId` and `prompt`/`code` modes, the url-mode
 * derivation through `metadata.scrapeId`, and the missing-id failure
 * (`AGENTS.md` §5.7). The SDK client is stubbed, so nothing here touches the
 * network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api } from "../api";
import { registerInteractTools } from "./interact";

type Executable = {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details?: any; isError?: boolean }>;
};

function interactTools(): Map<string, Executable> {
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerInteractTools(pi);
	return tools;
}

function tool(name: string): Executable {
	const found = interactTools().get(name);
	if (!found) throw new Error(`${name} was not registered`);
	return found;
}

function text(envelope: { content: { text: string }[] }): string {
	return envelope.content[0]?.text ?? "";
}

const client = api() as unknown as Record<string, unknown>;
const originals = new Map<string, unknown>();

function stub(method: string, implementation: (...args: any[]) => Promise<unknown>): void {
	if (!originals.has(method)) originals.set(method, client[method]);
	client[method] = implementation;
}

afterEach(() => {
	for (const [method, original] of originals) client[method] = original;
	originals.clear();
});

describe("firecrawl_interact modes", () => {
	test("rejects a call with both url and scrapeId", async () => {
		const result = await tool("firecrawl_interact").execute("1", {
			url: "https://example.com",
			scrapeId: "s_1",
			prompt: "click the button",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`url` or `scrapeId`");
	});

	test("rejects a call with neither url nor scrapeId", async () => {
		const result = await tool("firecrawl_interact").execute("1", { prompt: "click the button" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`url` or `scrapeId`");
	});

	test("rejects a call with both prompt and code", async () => {
		const result = await tool("firecrawl_interact").execute("1", {
			scrapeId: "s_1",
			prompt: "click the button",
			code: "page.click('#go')",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`prompt` or `code`");
	});

	test("rejects a call with neither prompt nor code", async () => {
		const result = await tool("firecrawl_interact").execute("1", { scrapeId: "s_1" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`prompt` or `code`");
	});
});

describe("firecrawl_interact paths", () => {
	test("scrapeId mode talks to interact() directly and never scrapes", async () => {
		let seenJob: unknown;
		let seenArgs: Record<string, unknown> = {};
		stub("scrape", async () => {
			throw new Error("url mode must not trigger for a scrapeId call");
		});
		stub("interact", async (jobId: unknown, args: Record<string, unknown>) => {
			seenJob = jobId;
			seenArgs = args;
			return { success: true, output: "clicked" };
		});

		const result = await tool("firecrawl_interact").execute("1", {
			scrapeId: "s_42",
			code: "page.click('#go')",
			language: "node",
			timeout: 45,
		});

		expect(result.isError).toBeUndefined();
		expect(seenJob).toBe("s_42");
		expect(seenArgs).toEqual({ prompt: undefined, code: "page.click('#go')", language: "node", timeout: 45 });
		expect(text(result)).toBe('{"success":true,"output":"clicked"}');
	});

	test("url mode scrapes first, derives the session from metadata.scrapeId, and carries the profile", async () => {
		let seenScrapeOptions: Record<string, unknown> = {};
		let seenJob: unknown;
		stub("scrape", async (_url: unknown, options: Record<string, unknown>) => {
			seenScrapeOptions = options ?? {};
			return { markdown: "# Page", metadata: { scrapeId: "s_9" } };
		});
		stub("interact", async (jobId: unknown) => {
			seenJob = jobId;
			return { success: true, output: "ok" };
		});

		const result = await tool("firecrawl_interact").execute("1", {
			url: "https://example.com/app",
			prompt: "log in",
			profile: { name: "acct", saveChanges: true },
		});

		expect(result.isError).toBeUndefined();
		expect(seenScrapeOptions).toEqual({ profile: { name: "acct", saveChanges: true } });
		expect(seenJob).toBe("s_9");
	});

	test("url mode fails naming metadata.scrapeId when the document carries none", async () => {
		let interactCalled = false;
		stub("scrape", async () => ({ markdown: "# Page", metadata: { title: "Page" } }));
		stub("interact", async () => {
			interactCalled = true;
			return { success: true };
		});

		const result = await tool("firecrawl_interact").execute("1", {
			url: "https://example.com/app",
			prompt: "log in",
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("metadata.scrapeId");
		expect(interactCalled).toBe(false);
	});
});
