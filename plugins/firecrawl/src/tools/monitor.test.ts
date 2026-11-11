/**
 * `firecrawl_monitor_create`/`update` request building: simple-form target
 * synthesis, the derived name and default schedule, cron/text mutual
 * exclusion, form conflicts, and patch passthrough (`AGENTS.md` §5.6, §7).
 * The SDK client is stubbed, so nothing here touches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api } from "../api";
import { registerMonitorTools } from "./monitor";

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

function monitorTools(): Map<string, Executable> {
	const tools = new Map<string, Executable>();
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Executable) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerMonitorTools(pi);
	return tools;
}

function tool(name: string): Executable {
	const found = monitorTools().get(name);
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

describe("firecrawl_monitor_create", () => {
	test("builds the simple URL form with the passed schedule, derived name, and judge untouched", async () => {
		let seen: Record<string, unknown> = {};
		stub("createMonitor", async (request: Record<string, unknown>) => {
			seen = request;
			return { id: "m_1" };
		});

		const result = await tool("firecrawl_monitor_create").execute("1", {
			pages: ["https://blog.example.com/changelog"],
			goal: "flag pricing changes",
			schedule: { text: "hourly", timezone: "Europe/Berlin" },
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual({
			name: "blog.example.com monitor",
			schedule: { text: "hourly", timezone: "Europe/Berlin" },
			targets: [{ type: "scrape", urls: ["https://blog.example.com/changelog"] }],
			goal: "flag pricing changes",
		});
	});

	test("combines page and pages into one scrape target", async () => {
		let seen: Record<string, unknown> = {};
		stub("createMonitor", async (request: Record<string, unknown>) => {
			seen = request;
			return { id: "m_1" };
		});

		await tool("firecrawl_monitor_create").execute("1", {
			page: "https://a.example/pricing",
			pages: ["https://b.example/changelog"],
		});

		expect(seen.targets).toEqual([{ type: "scrape", urls: ["https://a.example/pricing", "https://b.example/changelog"] }]);
	});

	test("defaults the schedule and derives the name from the first query", async () => {
		let seen: Record<string, unknown> = {};
		stub("createMonitor", async (request: Record<string, unknown>) => {
			seen = request;
			return { id: "m_1" };
		});

		await tool("firecrawl_monitor_create").execute("1", { queries: ["openai status", "anthropic status"] });

		expect(seen).toEqual({
			name: "openai status monitor",
			schedule: { text: "every 30 minutes" },
			targets: [{ type: "search", queries: ["openai status", "anthropic status"] }],
		});
	});

	test("passes advanced targets, webhook, goal, judge flag, and retention through untouched", async () => {
		let seen: Record<string, unknown> = {};
		stub("createMonitor", async (request: Record<string, unknown>) => {
			seen = request;
			return { id: "m_1" };
		});

		await tool("firecrawl_monitor_create").execute("1", {
			name: "Pricing watch",
			targets: [
				{ type: "crawl", url: "https://example.com/pricing" },
				{ type: "search", queries: ["acme earnings"], searchWindow: "24h", maxResults: 10 },
			],
			schedule: { cron: "0 9 * * 1", timezone: "UTC" },
			webhook: { url: "https://hooks.example.com/firecrawl", events: ["check.completed"] },
			goal: "only pricing matters",
			judgeEnabled: true,
			retentionDays: 90,
		});

		expect(seen).toEqual({
			name: "Pricing watch",
			schedule: { cron: "0 9 * * 1", timezone: "UTC" },
			targets: [
				{ type: "crawl", url: "https://example.com/pricing" },
				{ type: "search", queries: ["acme earnings"], searchWindow: "24h", maxResults: 10 },
			],
			webhook: { url: "https://hooks.example.com/firecrawl", events: ["check.completed"] },
			goal: "only pricing matters",
			judgeEnabled: true,
			retentionDays: 90,
		});
	});

	test("rejects schedule.cron together with schedule.text", async () => {
		const result = await tool("firecrawl_monitor_create").execute("1", {
			targets: [{ type: "scrape", urls: ["https://example.com"] }],
			schedule: { cron: "0 9 * * *", text: "daily" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("mutually exclusive");
	});

	test("rejects a schedule with neither cron nor text", async () => {
		const result = await tool("firecrawl_monitor_create").execute("1", {
			targets: [{ type: "scrape", urls: ["https://example.com"] }],
			schedule: { timezone: "UTC" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("exactly one");
	});

	test("rejects mixing simple URLs with explicit targets", async () => {
		const result = await tool("firecrawl_monitor_create").execute("1", {
			page: "https://example.com",
			targets: [{ type: "scrape", urls: ["https://other.example"] }],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("targets");
	});

	test("rejects simple URLs together with queries", async () => {
		const result = await tool("firecrawl_monitor_create").execute("1", {
			pages: ["https://example.com"],
			queries: ["example"],
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("mutually exclusive");
	});

	test("rejects a create with no targets at all", async () => {
		const result = await tool("firecrawl_monitor_create").execute("1", {});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("`page`/`pages`");
	});
});

describe("firecrawl_monitor_update", () => {
	test("patches only the supplied fields", async () => {
		let seenId: unknown;
		let seenRequest: Record<string, unknown> = {};
		stub("updateMonitor", async (id: unknown, request: Record<string, unknown>) => {
			seenId = id;
			seenRequest = request;
			return { id };
		});

		const result = await tool("firecrawl_monitor_update").execute("1", { id: "m_1", status: "paused" });

		expect(result.isError).toBeUndefined();
		expect(seenId).toBe("m_1");
		expect(seenRequest).toEqual({ status: "paused" });
	});

	test("rejects a schedule patch with both cron and text", async () => {
		const result = await tool("firecrawl_monitor_update").execute("1", {
			id: "m_1",
			schedule: { cron: "* * * * *", text: "hourly" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("mutually exclusive");
	});

	test("rejects a schedule patch with neither cron nor text", async () => {
		const result = await tool("firecrawl_monitor_update").execute("1", {
			id: "m_1",
			schedule: { timezone: "UTC" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("exactly one");
	});
});

describe("firecrawl_monitor reads", () => {
	test("list passes only the supplied pagination options and returns the plain array", async () => {
		let seenOptions: Record<string, unknown> = {};
		stub("listMonitors", async (options: Record<string, unknown>) => {
			seenOptions = options;
			return [{ id: "m_1", name: "blog.example.com monitor" }];
		});

		const result = await tool("firecrawl_monitor_list").execute("1", { limit: 5 });

		expect(result.isError).toBeUndefined();
		expect(seenOptions).toEqual({ limit: 5 });
		expect(result.details).toEqual([{ id: "m_1", name: "blog.example.com monitor" }]);
	});

	test("check passes only the supplied page filter options", async () => {
		let seenArgs: unknown[] = [];
		stub("getMonitorCheck", async (...args: unknown[]) => {
			seenArgs = args;
			return { id: "c_1", pages: [] };
		});

		await tool("firecrawl_monitor_check").execute("1", { monitorId: "m_1", checkId: "c_1", status: "changed" });

		expect(seenArgs).toEqual(["m_1", "c_1", { status: "changed" }]);
	});
});
