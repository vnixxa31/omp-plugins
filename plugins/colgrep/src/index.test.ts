/**
 * Surface policy: two essential, read-only tools and no event handlers.
 * Any growth here is a design change — update `AGENTS.md` §2 with it.
 */
import { describe, expect, test } from "bun:test";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";

/** The part of a registered schema the surface tests exercise. */
type Schema = { safeParse(value: unknown): { success: boolean } };

type Registered = {
	name: string;
	label: string;
	description: string;
	loadMode?: string;
	approval?: string;
	parameters: Schema;
};

function capture(): { tools: Registered[]; events: string[] } {
	const tools: Registered[] = [];
	const events: string[] = [];
	const pi = {
		zod: z,
		setLabel: () => {},
		registerTool: (tool: Registered) => {
			tools.push(tool);
		},
		on: (event: string) => {
			events.push(event);
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return { tools, events };
}

describe("tool surface", () => {
	test("registers exactly code_search and code_agent", () => {
		expect(capture().tools.map((tool) => tool.name)).toEqual(["code_search", "code_agent"]);
	});

	test("both tools are essential and read-only", () => {
		for (const tool of capture().tools) {
			expect(tool.loadMode).toBe("essential");
			expect(tool.approval).toBe("read");
		}
	});

	test("registers no event handlers", () => {
		expect(capture().events).toEqual([]);
	});

	test("descriptions steer intent search and name the grep boundary", () => {
		const [search, agent] = capture().tools;
		expect(search?.description).toContain("semantic index");
		expect(search?.description).toContain("native grep");
		expect(agent?.description).toContain("read-only agent");
	});

	test("code_search accepts an empty call and code_agent requires a query", () => {
		const [search, agent] = capture().tools;
		expect(search?.parameters.safeParse({}).success).toBe(true);
		expect(agent?.parameters.safeParse({}).success).toBe(false);
		expect(agent?.parameters.safeParse({ query: "where is defineTool" }).success).toBe(true);
	});
});
