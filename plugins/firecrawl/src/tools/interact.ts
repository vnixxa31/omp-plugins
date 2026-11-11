/**
 * Live-browser tools: `firecrawl_interact`, `firecrawl_interact_stop`
 * (`AGENTS.md` §5.7).
 *
 * `scrapeId` mode is the native path: `interact(scrapeId, …)` acts on the
 * browser session attached to a scrape job. `url` mode is a two-step
 * derivation — scrape the page first, read `metadata.scrapeId` off the
 * returned document, and open the session on that id. The scrape id is the
 * only handle the SDK can open a session with, so a document without
 * `metadata.scrapeId` is a tool error naming the field, never a guess.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ScrapeExecuteRequest, ScrapeOptions } from "firecrawl";
import { ToolError, api, withAbort } from "../api";
import { defineTool } from "../tool";

export function registerInteractTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	const interactParameters = z.object({
		scrapeId: z
			.string()
			.describe("Scrape job id whose browser session to reuse — the `metadata.scrapeId` of a prior scrape. Mutually exclusive with `url`.")
			.optional(),
		url: z
			.string()
			.describe("Open a session on a fresh page instead: the URL is scraped first and the session opened from the resulting scrape id. Mutually exclusive with `scrapeId`.")
			.optional(),
		prompt: z
			.string()
			.describe("Natural-language instruction the browser agent executes. Exactly one of `prompt` or `code`.")
			.optional(),
		code: z
			.string()
			.describe("Browser code to execute verbatim, in `language`. Exactly one of `prompt` or `code`.")
			.optional(),
		language: z.enum(["python", "node", "bash"]).describe("Language of `code`; defaults to node.").optional(),
		timeout: z.number().describe("Interaction timeout, in seconds.").optional(),
		profile: z
			.object({
				name: z.string().describe("Persistent browser profile name to load for the url-mode scrape that opens the session."),
				saveChanges: z
					.boolean()
					.describe("Persist browser-state changes back to the profile; the save happens on firecrawl_interact_stop.")
					.optional(),
			})
			.describe("Browser profile for the url-mode scrape that opens the session; ignored with `scrapeId`.")
			.optional(),
	});

	defineTool(pi, {
		name: "firecrawl_interact",
		label: "Firecrawl interact",
		description: `Drive a live browser session on a scraped page: run a natural-language prompt or python/node/bash code.
Use \`scrapeId\` to reuse a prior scrape's session or \`url\` to open a fresh page; exactly one of \`prompt\`/\`code\`.
Returns the execution result: output, stdout/stderr, exitCode, killed, and the session's live-view URLs.`,
		parameters: interactParameters,
		approval: "exec",
		run: async ({ url, scrapeId, prompt, code, language, timeout, profile }, signal) => {
			if ((url === undefined) === (scrapeId === undefined)) {
				throw new ToolError("firecrawl_interact: exactly one of `url` or `scrapeId` is required");
			}
			if ((prompt === undefined) === (code === undefined)) {
				throw new ToolError("firecrawl_interact: exactly one of `prompt` or `code` is required");
			}

			let sessionId = scrapeId;
			if (sessionId === undefined) {
				// url mode lives or dies on `metadata.scrapeId` (§5.7): it is the
				// only handle the SDK can open an interact session with.
				const document = await withAbort(api().scrape(url!, profile ? ({ profile } satisfies ScrapeOptions) : {}), signal);
				const derived = document.metadata?.scrapeId;
				if (typeof derived !== "string" || derived.length === 0) {
					throw new ToolError(
						"firecrawl_interact: the scraped document has no `metadata.scrapeId`, so no browser session could be opened — pass `scrapeId` from a scrape that returns one",
					);
				}
				sessionId = derived;
			}

			const args: ScrapeExecuteRequest = { prompt, code, language, timeout };
			return withAbort(api().interact(sessionId, args), signal);
		},
	});

	const interactStopParameters = z.object({
		scrapeId: z.string().describe("Scrape job id whose interaction session to stop."),
	});

	defineTool(pi, {
		name: "firecrawl_interact_stop",
		label: "Firecrawl interact stop",
		description: `Stop the live browser session attached to a scrape job and release its resources.
Call it after the last firecrawl_interact on a job; pending profile changes are saved here when the session was opened with \`profile.saveChanges\`.
Returns success, session status, duration, and credits billed.`,
		parameters: interactStopParameters,
		approval: "read",
		run: async ({ scrapeId }, signal) => withAbort(api().stopInteraction(scrapeId), signal),
	});
}
