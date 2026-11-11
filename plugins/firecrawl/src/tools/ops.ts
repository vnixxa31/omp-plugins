/**
 * Account and quality tools: `firecrawl_credit_usage` and
 * `firecrawl_feedback` (`AGENTS.md` §5.8).
 *
 * The SDK exposes current balance (`getCreditUsage`) and a fixed historical
 * period list (`getCreditUsageHistorical(byApiKey?)`) — no `byEndpoint`, no
 * `bin`, no date-range parameters, so the tool offers none (§6). Generic
 * feedback covers the `search`/`scrape`/`parse`/`map` endpoints only; crawl
 * and Alexandria feedback are not typed and are not accepted.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api, withAbort } from "../api";
import { defineTool } from "../tool";

export function registerOpsTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	const creditUsageParameters = z.object({
		view: z
			.enum(["current", "historical"])
			.describe('"current" (default): the live balance and billing-period dates. "historical": credits used in each past billing period (fixed list — the SDK has no per-endpoint split, day bins, or date ranges).')
			.optional(),
		byApiKey: z
			.boolean()
			.describe("Historical view only: one row per API key instead of one per billing period.")
			.optional(),
	});

	defineTool(pi, {
		name: "firecrawl_credit_usage",
		label: "Firecrawl credit usage",
		description: `Get the authenticated Firecrawl team's current credit balance or its credit usage over the last 90 days.
Use the current view to answer how many credits remain or to check billing-period boundaries.
The SDK exposes no per-endpoint split, day bins, or date range, so this tool accepts none.`,
		parameters: creditUsageParameters,
		approval: "read",
		run: async (params, signal) =>
			params.view === "historical"
				? withAbort(api().getCreditUsageHistorical(params.byApiKey), signal)
				: withAbort(api().getCreditUsage(), signal),
	});

	const feedbackParameters = z.object({
		endpoint: z
			.enum(["search", "scrape", "parse", "map"])
			.describe("Which kind of job `jobId` refers to. Ids the SDK hands back: scrape `metadata.scrapeId`, parse `metadata.scrapeId` when the response carries it, map `MapData.id`. \"search\" is schema-valid but practically unusable — no SDK search response exposes a search job id. Crawl and Alexandria feedback are not typed; do not use them here."),
		jobId: z.string().describe("Job id of the completed job being rated, taken from that job's own response."),
		rating: z.enum(["good", "partial", "bad"]).describe("Overall verdict on the job's result."),
		valuableSources: z
			.array(
				z.object({
					url: z.string().describe("URL of a result that was valuable."),
					reason: z.string().describe("Why this source was valuable.").optional(),
				}),
			)
			.describe("Results the job returned that were genuinely useful.")
			.optional(),
		missingContent: z
			.array(
				z.object({
					topic: z.string().describe("Topic the result was missing."),
					description: z.string().describe("What about the topic the result failed to cover.").optional(),
				}),
			)
			.describe("Content the result should have covered but did not.")
			.optional(),
		querySuggestions: z.string().describe("Suggested rephrasing of the original query.").optional(),
		issues: z.array(z.string()).describe("Short issue codes or labels for what went wrong.").optional(),
		tags: z.array(z.string()).describe("Free-form tags to classify the feedback.").optional(),
		note: z.string().describe("Free-form note for the team.").optional(),
		url: z.string().describe("URL associated with the job being rated.").optional(),
		pageNumbers: z.array(z.number()).describe("Endpoint-specific page numbers relevant to the feedback.").optional(),
		metadata: z.record(z.unknown()).describe("Small endpoint-specific metadata object. Must be 8KB or smaller.").optional(),
	});

	defineTool(pi, {
		name: "firecrawl_feedback",
		label: "Firecrawl feedback",
		description: `Record quality feedback on a completed scrape, parse, or map job — the API's 20-minute window applies.
\`jobId\` comes from the job itself: scrape \`metadata.scrapeId\`, map \`MapData.id\`, parse when the response carries it.
Returns the feedback id, credits refunded, and daily-cap flags. Crawl and Alexandria jobs have no feedback endpoint.`,
		parameters: feedbackParameters,
		approval: "write",
		run: (params, signal) => withAbort(api().feedback(params), signal),
	});
}
