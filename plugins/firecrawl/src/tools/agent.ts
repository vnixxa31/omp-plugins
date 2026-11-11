/**
 * Deep-research tools: `firecrawl_agent` and `firecrawl_agent_status`
 * (`AGENTS.md` §5.5).
 *
 * `firecrawl_agent` is async by contract: it starts the job and returns
 * `{ id, threadId, threadTurn }` untouched — status lives in
 * `firecrawl_agent_status`, which the caller polls; nothing here loops.
 * The `exchange.approve`/`exchange.decline` rules (§5.5) are validated
 * locally before any request leaves the process; a `terms` `pendingApproval`
 * is returned exactly as the API gives it — there is no auto-accept mode.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { api, ToolError, withAbort } from "../api";
import { defineTool } from "../tool";

export function registerAgentTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	const agentParameters = z.object({
		prompt: z
			.string()
			.describe("Research goal in natural language: what to find, and in what shape to report it. The main research input."),
		urls: z
			.array(z.string())
			.describe("Seed URLs to focus or constrain the research on. With `strictConstrainToURLs`, the agent will not browse outside them.")
			.optional(),
		schema: z
			.record(z.unknown())
			.describe('JSON Schema the final answer must match, passed through untouched, e.g. { "type": "object", "properties": … }. Omit for a free-form answer; the SDK also accepts a Zod schema in its own API, but this tool takes plain JSON.')
			.optional(),
		effort: z
			.enum(["low", "medium", "high"])
			.describe("Reasoning effort for the run. Every level runs the same model; higher effort spends more credits for depth.")
			.optional(),
		maxCredits: z
			.number()
			.describe("Credit cap for the run; the job stops at the cap and reports `stopReason: \"credit_limit_reached\"` in status.")
			.optional(),
		strictConstrainToURLs: z
			.boolean()
			.describe("Restrict the agent to the supplied `urls` instead of browsing freely from them.")
			.optional(),
		threadId: z
			.string()
			.describe("Thread id from a previous firecrawl_agent run, to continue that conversation in a new turn instead of starting a new thread.")
			.optional(),
		mode: z
			.enum(["extract", "chat"])
			.describe('Run mode: "extract" (default) answers into the `data` field; "chat" answers as assistant text in `message`.')
			.optional(),
		exchange: z
			.object({
				enabled: z.boolean().describe("Turn the exchange tool layer on for this run.").optional(),
				toolkits: z.array(z.string()).describe("Exchange toolkits the run may use. At most 5.").optional(),
				maxCalls: z.number().describe("Maximum number of paid exchange calls for the run.").optional(),
				requireApproval: z
					.boolean()
					.describe("Hold every exchange call for human approval instead of executing it; the call surfaces as a `pendingApproval`.")
					.optional(),
				approve: z
					.object({
						approvalId: z.string().describe("`approvalId` from the pending approval this turn is answering."),
						callIds: z.array(z.string()).describe("Specific calls to approve. Ignored on a `terms` approval, which is accepted as a whole.").optional(),
						always: z.boolean().describe("Approve this class of calls for the rest of the thread. Ignored on a `terms` approval.").optional(),
					})
					.describe("Answer a pending approval from the previous turn by accepting it. Requires `threadId`; mutually exclusive with `decline`.")
					.optional(),
				decline: z
					.object({
						approvalId: z.string().describe("`approvalId` from the pending approval this turn is declining."),
					})
					.describe("Answer a pending approval from the previous turn by declining it. Requires `threadId`; mutually exclusive with `approve`.")
					.optional(),
				onTermsRequired: z
					.enum(["skip", "ask"])
					.describe('What to do when a provider needs data terms the team has not accepted: "skip" (server default) answers with accepted providers only; "ask" also returns `exchange.requiresAction` plus a `terms` pendingApproval for a human to decide. A follow-up turn that omits this inherits the previous turn\'s value.')
					.optional(),
			})
			.describe("Paid exchange-data options forwarded to the agent; the server owns every default. Omitted settings inherit the previous turn of the thread.")
			.optional(),
	});

	defineTool(pi, {
		name: "firecrawl_agent",
		label: "Firecrawl agent",
		description: `Run web research that returns structured data when the URLs are not known or the answer spans several sites.
Describe the fields you need in \`prompt\`, optionally a JSON \`schema\`, seed \`urls\`, and a \`maxCredits\` cap.
Starts the job and returns \`{ id, threadId, threadTurn }\` immediately — poll \`firecrawl_agent_status\`; this call never blocks.
A \`terms\` pendingApproval comes back untouched: after a human agrees, resume the same \`threadId\` with \`exchange.approve\`.`,
		parameters: agentParameters,
		approval: "write",
		run: async (params, signal) => {
			const exchange = params.exchange;
			if (exchange?.approve !== undefined && exchange.decline !== undefined) {
				throw new ToolError("firecrawl_agent: `exchange.approve` and `exchange.decline` are mutually exclusive — answer a pending approval with exactly one");
			}
			if ((exchange?.approve !== undefined || exchange?.decline !== undefined) && params.threadId === undefined) {
				throw new ToolError("firecrawl_agent: `exchange.approve`/`exchange.decline` answer a pending approval and need the `threadId` of its thread");
			}
			return withAbort(
				api().startAgent({
					prompt: params.prompt,
					urls: params.urls,
					schema: params.schema,
					effort: params.effort,
					maxCredits: params.maxCredits,
					strictConstrainToURLs: params.strictConstrainToURLs,
					threadId: params.threadId,
					mode: params.mode,
					exchange,
				}),
				signal,
			);
		},
	});

	const agentStatusParameters = z.object({
		id: z.string().describe("Agent job id returned by firecrawl_agent."),
	});

	defineTool(pi, {
		name: "firecrawl_agent_status",
		label: "Firecrawl agent status",
		description: `Retrieve progress or final results for a \`firecrawl_agent\` job ID.
A \`processing\` response is non-terminal and does not contain the final research result. Check again after 15–30 seconds until \`completed\` or \`failed\`.
\`completed\` carries the final JSON in \`data\`; \`failed\` may carry \`partial\`, \`partialSchemaValid\`, and \`stopReason\`.`,
		parameters: agentStatusParameters,
		approval: "read",
		run: async (params, signal) => withAbort(api().getAgentStatus(params.id), signal),
	});
}
