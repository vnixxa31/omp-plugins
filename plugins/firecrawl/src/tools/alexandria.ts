/**
 * `firecrawl_find_tools` — zero-credit discovery over the Alexandria
 * catalogue: categories → providers → groups → tools → full contracts
 * (`AGENTS.md` §3.1/§5; `FindToolsOptions` in the SDK). The paid-data path
 * always starts here; running a contract happens in `firecrawl_scrape`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { FindToolsOptions } from "firecrawl";
import { api, withAbort } from "../api";
import { defineTool } from "../tool";

const DESCRIPTION =
	"Browse Alexandria data providers and workflows, or read one provider's full contract.\n" +
	"Start here for company, people, jobs, finance, records, or real-estate data before any paid call.\n" +
	"Free: it never executes a provider. Omit `level` for categories, then narrow to providers, groups, tools.\n" +
	"Run the contract you pick with firecrawl_scrape { alexandria }.\n" +
	"Related devices: xd://firecrawl_credit_usage.";

export function registerAlexandriaTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	// Keep the schema out of the `defineTool` call: an inline `z.object({...})`
	// argument makes TS fall back to the `ZodLikeSchema<unknown>` constraint,
	// so `run` would receive `params: unknown`.
	const parameters = z.object({
		urls: z.array(z.string()).describe("Match only catalogue providers relevant to these page URLs.").optional(),
		providers: z.array(z.string()).describe("Provider ids to read the full contracts for.").optional(),
		categories: z.array(z.string()).describe("Restrict the listing to these catalogue categories.").optional(),
		groups: z.array(z.string()).describe("Restrict the listing to these provider groups.").optional(),
		capabilities: z.array(z.string()).describe("Restrict the listing to these capability ids.").optional(),
		level: z
			.enum(["providers", "groups", "tools"])
			.describe("providers lists today's catalogue, groups narrows by family, tools return full contracts; omit it to list categories.")
			.optional(),
		expand: z
			.array(z.enum(["options", "response", "examples"]))
			.describe("Extra contract sections to return with level \"tools\": options, response, examples.")
			.optional(),
		limit: z.number().describe("Maximum number of items to return.").optional(),
		offset: z.number().describe("Number of items to skip for pagination.").optional(),
	});

	defineTool(pi, {
		name: "firecrawl_find_tools",
		label: "Firecrawl find tools",
		description: DESCRIPTION,
		approval: "read",
		loadMode: "essential",
		parameters,
		run: (params, signal) => {
			const options: FindToolsOptions = params;
			return withAbort(api().findTools(options), signal);
		},
	});
}
