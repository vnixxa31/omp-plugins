/**
 * `firecrawl_developer_search` — the Developer Index: public repositories,
 * GitHub issues, merged pull requests, repository READMEs, and code
 * documentation (`AGENTS.md` §5; `DeveloperSearchOptions` in the SDK).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { DeveloperSearchOptions } from "firecrawl";
import { api, withAbort } from "../api";
import { defineTool } from "../tool";

const DESCRIPTION =
	"Search public repositories, GitHub issues, merged pull requests, READMEs, and code docs.\n" +
	"Use it for programming questions that need upstream evidence; use firecrawl_search for news, people, or prices.\n" +
	"`skills: \"only\"` restricts results to packaged agent-skill evidence.\n" +
	"Returns ranked passages with citation URLs and license disclosure.\n" +
	"Related devices: xd://firecrawl_map, xd://firecrawl_crawl.";

export function registerDeveloperTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	// Keep the schema out of the `defineTool` call: an inline `z.object({...})`
	// argument makes TS fall back to the `ZodLikeSchema<unknown>` constraint,
	// so `run` would receive `params: unknown`.
	const parameters = z.object({
		query: z.string().describe("Search query."),
		k: z.number().describe("Total ranked results, 1–100 (default 10).").optional(),
		passages: z.number().describe("Passages per result, 1–5 (default 1).").optional(),
		types: z
			.array(z.enum(["doc", "issue", "pull_request", "readme"]))
			.describe("Result kinds to search: doc, issue, pull_request, readme (default all).")
			.optional(),
		repos: z.array(z.string()).describe("GitHub owner/name filters, at most 20.").optional(),
		sources: z.array(z.string()).describe("Developer documentation source IDs, at most 20.").optional(),
		language: z.string().describe("One case-insensitive GitHub Linguist primary language.").optional(),
		topic: z.array(z.string()).describe("Repository topics that must all match, at most 8.").optional(),
		license: z.string().describe("One case-insensitive SPDX repository license identifier.").optional(),
		minStars: z.number().describe("Minimum repository stars.").optional(),
		maxStars: z.number().describe("Maximum repository stars.").optional(),
		archived: z.boolean().describe("Filter by repository archived status.").optional(),
		fork: z.boolean().describe("Filter by repository fork status.").optional(),
		skills: z.literal("only").describe('Pass "only" to return packaged agent-skill evidence only.').optional(),
	});

	defineTool(pi, {
		name: "firecrawl_developer_search",
		label: "Firecrawl developer search",
		description: DESCRIPTION,
		approval: "read",
		loadMode: "essential",
		parameters,
		run: ({ query, ...rest }, signal) => {
			const options: DeveloperSearchOptions = rest;
			return withAbort(api().developerSearch(query, options), signal);
		},
	});
}
