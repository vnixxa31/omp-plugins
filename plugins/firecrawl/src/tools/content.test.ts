/**
 * `firecrawl_scrape` / `firecrawl_parse` behavior: mutually exclusive modes,
 * path resolution, and the raw-markdown result exception (`AGENTS.md` §4.2,
 * §5.1, §5.3). The SDK client is stubbed, so nothing here touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api } from "../api";
import { registerContentTools } from "./content";

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

function contentTools(): Map<string, Executable> {
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerContentTools(pi);
	return tools;
}

function tool(name: string): Executable {
	const found = contentTools().get(name);
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

describe("firecrawl_scrape modes", () => {
	test("rejects a call with both url and alexandria, naming both", async () => {
		const result = await tool("firecrawl_scrape").execute("1", {
			url: "https://example.com",
			alexandria: { provider: "p", capability: "c" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("url");
		expect(text(result)).toContain("alexandria");
	});

	test("rejects a call with neither url nor alexandria", async () => {
		const result = await tool("firecrawl_scrape").execute("1", {});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("alexandria");
	});

	test("rejects URL scrape options combined with alexandria", async () => {
		const result = await tool("firecrawl_scrape").execute("1", {
			alexandria: { provider: "p", capability: "c" },
			formats: ["markdown"],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("formats");
	});

	test("scrapes the URL, drops the mode fields, and returns raw markdown", async () => {
		let seenUrl: unknown;
		let seenOptions: Record<string, unknown> = {};
		stub("scrape", async (url: unknown, options: Record<string, unknown>) => {
			seenUrl = url;
			seenOptions = options;
			return { markdown: "# Title\n\nBody", metadata: { scrapeId: "s_1" } };
		});

		const result = await tool("firecrawl_scrape").execute("1", {
			url: "https://example.com/docs",
			onlyMainContent: true,
		});

		expect(result.isError).toBeUndefined();
		expect(seenUrl).toBe("https://example.com/docs");
		expect(seenOptions).toEqual({ onlyMainContent: true });
		expect(text(result)).toBe("# Title\n\nBody");
		expect(result.details).toEqual({ markdown: "# Title\n\nBody", metadata: { scrapeId: "s_1" } });
	});

	test("runs an Alexandria call through the single-request overload", async () => {
		let seenRequest: Record<string, unknown> = {};
		stub("scrape", async (request: Record<string, unknown>) => {
			seenRequest = request;
			return {
				scrapeId: "s_2",
				requestId: "r_1",
				alexandria: [{ provider: "p", capability: "c", creditsCost: 1, data: { ok: true } }],
				creditsCost: 1,
			};
		});

		const result = await tool("firecrawl_scrape").execute("1", {
			alexandria: { provider: "p", capability: "c", options: { ticker: "ACME" } },
			requestId: "r_1",
		});

		expect(seenRequest).toEqual({
			alexandria: { provider: "p", capability: "c", options: { ticker: "ACME" } },
			requestId: "r_1",
		});
		expect(text(result)).toContain('"creditsCost":1');
	});
});

describe("firecrawl_parse", () => {
	test("reports a missing path as one line naming the path", async () => {
		const result = await tool("firecrawl_parse").execute("1", { filePath: "/tmp/definitely-missing.pdf" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("/tmp/definitely-missing.pdf");
	});

	test("uploads the file bytes with a derived filename and returns raw markdown", async () => {
		const dir = await mkdtemp(join(tmpdir(), "firecrawl-parse-"));
		const filePath = join(dir, "report.pdf");
		await Bun.write(filePath, "pdf-bytes");

		let seenFile: { data: Uint8Array; filename: string; contentType?: string } | undefined;
		let seenOptions: Record<string, unknown> = {};
		stub("parse", async (file: typeof seenFile, options: Record<string, unknown>) => {
			seenFile = file;
			seenOptions = options;
			return { markdown: "parsed body" };
		});

		try {
			const result = await tool("firecrawl_parse").execute("1", {
				filePath,
				contentType: "application/pdf",
				formats: ["markdown"],
			});

			expect(result.isError).toBeUndefined();
			expect(seenFile?.filename).toBe("report.pdf");
			expect(seenFile?.contentType).toBe("application/pdf");
			expect(new TextDecoder().decode(seenFile?.data)).toBe("pdf-bytes");
			expect(seenOptions).toEqual({ formats: ["markdown"] });
			expect(text(result)).toBe("parsed body");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("firecrawl_search", () => {
	test("rejects gov combined with another category", async () => {
		const result = await tool("firecrawl_search").execute("1", {
			query: "clean air act",
			categories: ["gov", "pdf"],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("cannot be combined with another category");
	});

	test("passes the query and options through and returns JSON", async () => {
		let seenQuery: unknown;
		let seenOptions: Record<string, unknown> = {};
		stub("search", async (query: unknown, options: Record<string, unknown>) => {
			seenQuery = query;
			seenOptions = options;
			return { web: [{ url: "https://example.com", title: "Example" }] };
		});

		const result = await tool("firecrawl_search").execute("1", {
			query: "latest bun release",
			limit: 3,
			sources: ["web"],
		});

		expect(seenQuery).toBe("latest bun release");
		expect(seenOptions).toEqual({ limit: 3, sources: ["web"] });
		expect(text(result)).toBe('{"web":[{"url":"https://example.com","title":"Example"}]}');
	});
});
