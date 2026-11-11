/**
 * Surface policy (`AGENTS.md` §3–§4.4): five essential tools, 22 discoverable,
 * with the right load modes, approval tiers, and catalog-usable descriptions.
 */
import { describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";

type Registered = {
	name: string;
	description: string;
	loadMode?: string;
	approval?: string;
};

function registeredTools(): Registered[] {
	const tools: Registered[] = [];
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Registered) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return tools;
}

const ESSENTIAL = [
	"firecrawl_scrape",
	"firecrawl_search",
	"firecrawl_parse",
	"firecrawl_developer_search",
	"firecrawl_find_tools",
];

const DISCOVERABLE = [
	"firecrawl_map",
	"firecrawl_crawl",
	"firecrawl_check_crawl_status",
	"firecrawl_gov_search",
	"firecrawl_research_search_papers",
	"firecrawl_research_inspect_paper",
	"firecrawl_research_read_paper",
	"firecrawl_research_related_papers",
	"firecrawl_agent",
	"firecrawl_agent_status",
	"firecrawl_interact",
	"firecrawl_interact_stop",
	"firecrawl_monitor_create",
	"firecrawl_monitor_update",
	"firecrawl_monitor_list",
	"firecrawl_monitor_get",
	"firecrawl_monitor_delete",
	"firecrawl_monitor_run",
	"firecrawl_monitor_check",
	"firecrawl_monitor_checks",
	"firecrawl_credit_usage",
	"firecrawl_feedback",
];

/** Approval tier per `AGENTS.md` §4.4. */
const WRITE: Record<string, boolean> = {
	firecrawl_crawl: true,
	firecrawl_agent: true,
	firecrawl_monitor_create: true,
	firecrawl_monitor_update: true,
	firecrawl_monitor_delete: true,
	firecrawl_monitor_run: true,
	firecrawl_feedback: true,
};

const EXEC: Record<string, boolean> = { firecrawl_interact: true };

describe("tool surface", () => {
	test("registers exactly the five essential and 22 discoverable tools", () => {
		const names = registeredTools().map(tool => tool.name).sort();
		expect(names).toEqual([...ESSENTIAL, ...DISCOVERABLE].sort());
	});

	test("essential tools ship in the prompt; the rest mount as xd:// devices", () => {
		for (const tool of registeredTools()) {
			expect(tool.loadMode).toBe(ESSENTIAL.includes(tool.name) ? "essential" : "discoverable");
		}
	});

	test("approval tiers match §4.4", () => {
		for (const tool of registeredTools()) {
			expect(tool.approval).toBe(
				EXEC[tool.name] ? "exec" : WRITE[tool.name] ? "write" : "read",
			);
		}
	});

	test("descriptions follow §3.3: short imperative first line", () => {
		for (const tool of registeredTools()) {
			const lines = tool.description.split("\n");
			const first = lines[0] ?? "";
			expect(first.length).toBeLessThanOrEqual(120);
			expect(first.startsWith("This tool")).toBe(false);
			expect(first.endsWith(".")).toBe(true);
			expect(lines.length).toBeLessThanOrEqual(6);
		}
	});

	test("essential descriptions point at their discoverable siblings", () => {
		for (const tool of registeredTools()) {
			if (!ESSENTIAL.includes(tool.name)) continue;
			expect(tool.description).toContain("Related devices: xd://firecrawl_");
		}
	});

	test("developer_search description scopes license and names the passage fields", () => {
		const tool = registeredTools().find(candidate => candidate.name === "firecrawl_developer_search");
		expect(tool).toBeDefined();
		const description = tool?.description ?? "";
		expect(description).toContain("truncated");
		expect(description).toContain("full_tokens_est");
		expect(description).not.toContain("license disclosure");
		expect(description).toMatch(/`license`[^\n]*(repo|README)/i);
	});
});
