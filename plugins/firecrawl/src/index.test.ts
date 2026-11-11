/**
 * Surface policy (`AGENTS.md` §3): the five essential tools registered, with
 * descriptions that keep the catalog usable.
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

describe("essential surface", () => {
	test("registers exactly the five essential tools", () => {
		expect(registeredTools().map(tool => tool.name).sort()).toEqual([...ESSENTIAL].sort());
	});

	test("every tool is essential and read-only", () => {
		for (const tool of registeredTools()) {
			expect(tool.loadMode).toBe("essential");
			expect(tool.approval).toBe("read");
		}
	});

	test("first description line is imperative, short, and names a sibling device", () => {
		for (const tool of registeredTools()) {
			const lines = tool.description.split("\n");
			const first = lines[0] ?? "";
			expect(first.length).toBeLessThanOrEqual(120);
			expect(first.startsWith("This tool")).toBe(false);
			expect(first.endsWith(".")).toBe(true);
			expect(lines.length).toBeLessThanOrEqual(6);
			expect(tool.description).toContain("Related devices: xd://firecrawl_");
		}
	});
});
