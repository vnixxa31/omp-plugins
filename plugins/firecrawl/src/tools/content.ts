/**
 * Content tools: `firecrawl_scrape`, `firecrawl_search`, `firecrawl_parse`
 * (`AGENTS.md` §5.1–5.3).
 *
 * Schemas mirror the installed SDK option objects one field per option, minus
 * `integration`/`origin` (§2). The shim cannot express the SDK's
 * string-or-option-object unions, so those fields accept `{ type, … }` records
 * and the SDK calls carry a single cast at the boundary. Every SDK call goes
 * through `api()` and `withAbort()`; local validation failures throw
 * `ToolError` before any request leaves the process.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AlexandriaCall, ParseOptions, ScrapeOptions, SearchRequest } from "firecrawl";
import { ToolError, api, withAbort } from "../api";
import { defineTool, documentText } from "../tool";

export function registerContentTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	// Nested option objects shared by several tools; define once, reference.
	const redactPIIField = z
		.union([
			z.boolean(),
			z.object({
				mode: z
					.enum(["accurate", "aggressive", "fast"])
					.describe(
						"accurate (default): model-only redaction, best precision. aggressive: model + Presidio + spaCy, higher recall. fast: Presidio only, no model call.",
					)
					.optional(),
				entities: z
					.array(z.enum(["PERSON", "EMAIL", "PHONE", "LOCATION", "FINANCIAL", "SECRET"]))
					.describe("Restrict redaction to these entity buckets. Unset means all entities.")
					.optional(),
				replaceStyle: z
					.enum(["tag", "mask", "remove"])
					.describe("tag (default): replace spans with <KIND> placeholders. mask: replace with equally long *. remove: drop span characters.")
					.optional(),
			}),
		])
		.describe("Redact PII from extracted content: true uses the defaults, or pass mode/entities/replaceStyle.")
		.optional();

	const threatProtectionField = z
		.object({
			mode: z
				.enum(["off", "manual-only", "normal", "zscaler"])
				.describe(
					"off disables scanning for this request; manual-only enforces only blacklist/whitelist/blocked TLDs (no scan fee); normal scans with Google Web Risk; zscaler classifies through your organization's connection.",
				)
				.optional(),
			riskScoreThreshold: z.number().describe("Block verdicts at or above this risk score (integer 0-100).").optional(),
			blacklist: z.array(z.string()).describe('Exact domains or globs like "*.example.com" to always block (max 1000).').optional(),
			whitelist: z.array(z.string()).describe("Exact domains or globs to always allow; wins over everything (max 1000).").optional(),
			blockedTlds: z.array(z.string()).describe('Lowercase TLDs without the leading dot, e.g. "zip" (max 1000).').optional(),
			failurePolicy: z.enum(["open", "closed"]).describe("Behavior when scanning is unavailable: closed blocks, open allows.").optional(),
		})
		.describe("Enterprise per-request override of your team's threat-protection policy; requires threat protection enabled with request overrides allowed.")
		.optional();

	const auditMetadataField = z
		.object({
			username: z.string().describe("Username recorded in the Firecrawl audit trail."),
		})
		.describe("Audit metadata recorded with this request.")
		.optional();

	const profileField = z
		.object({
			name: z.string().describe("Persistent browser profile name to load for this request."),
			saveChanges: z.boolean().describe("Persist browser-state changes back to the profile; the save happens on firecrawl_interact_stop.").optional(),
		})
		.describe("Persistent browser profile to load for this request.")
		.optional();

	// Option fields shared verbatim by ScrapeOptions and ParseOptions.
	const commonFields = {
		headers: z.record(z.string()).describe("Additional HTTP headers to send with the request.").optional(),
		includeTags: z.array(z.string()).describe("Keep only these HTML tags in the extraction.").optional(),
		excludeTags: z.array(z.string()).describe("Remove these HTML tags before extraction.").optional(),
		onlyMainContent: z.boolean().describe("Keep only the main content, dropping navigation, footers, and boilerplate.").optional(),
		timeout: z.number().describe("Maximum time for the request, in milliseconds.").optional(),
		parsers: z
			.array(z.union([z.string(), z.record(z.unknown())]))
			.describe('Document parsers: "pdf", "image" (OCR raster images), or a { type: "pdf", mode: "fast"|"auto"|"ocr", maxPages, pages, blocks, pageMarkers } object.')
			.optional(),
		skipTlsVerification: z.boolean().describe("Skip TLS certificate verification of the target server.").optional(),
		removeBase64Images: z.boolean().describe("Strip base64-encoded images from the output.").optional(),
		fastMode: z.boolean().describe("Prioritize extraction speed over accuracy.").optional(),
		useMock: z.string().describe("Mock data identifier to serve instead of a live fetch (testing on supported deployments).").optional(),
		blockAds: z.boolean().describe("Block ads and analytics scripts during extraction.").optional(),
		checkPromptInjection: z
			.boolean()
			.describe("Scan the content for prompt injection before LLM-backed formats run; a detection fails the request. Adds 4 credits when the check scans the whole page.")
			.optional(),
		redactPII: redactPIIField,
		auditMetadata: auditMetadataField,
		profile: profileField,
		domainTools: z.boolean().describe("Include domain-matched Alexandria tools for this input in `tools`. Default off.").optional(),
	};

	// Shared scrape option shape: every ScrapeOptions field except
	// integration/origin/toolDetail; spread into firecrawl_scrape (which adds
	// toolDetail) and into firecrawl_search's scrapeOptions (which omits it).
	const scrapeShape = {
		formats: z
			.array(z.union([z.string(), z.record(z.unknown())]))
			.describe(
				'Output formats as strings or option objects: markdown, html, rawHtml, links, images, screenshot, summary, changeTracking, json, attributes, branding, product, menu, audio, video (json: prompt/schema; screenshot: fullPage/quality/viewport; changeTracking: modes/schema/prompt/tag; attributes: selectors).',
			)
			.optional(),
		waitFor: z.number().describe("Extra time, in milliseconds, to wait for the page to finish loading before extracting.").optional(),
		mobile: z.boolean().describe("Simulate a mobile device for the scrape.").optional(),
		actions: z
			.array(z.record(z.unknown()))
			.describe('Browser actions run before extraction, in order, as objects: { type: "wait", milliseconds?, selector? }, "click" (selector), "write" (text), "press" (key), "scroll" (direction, selector?), "scrape", "executeJavascript" (script), "screenshot" (fullPage?, quality?, viewport?), "pdf" (format?, landscape?, scale?).')
			.optional(),
		location: z
			.object({
				country: z.string().describe('ISO country code to scrape from, e.g. "us".').optional(),
				languages: z.array(z.string()).describe('Language codes to localize content to, e.g. ["en", "de"].').optional(),
			})
			.describe("Location settings for the scrape.")
			.optional(),
		proxy: z.string().describe('Proxy tier: "basic", "stealth", "enhanced", "auto", or a deployment-specific tier.').optional(),
		maxAge: z.number().describe("Maximum age, in milliseconds, of indexed content that may be reused. Set to 0 to bypass index reuse.").optional(),
		minAge: z.number().describe("Minimum age, in milliseconds, of indexed content that may be reused.").optional(),
		storeInCache: z.boolean().describe("Store the result in the Firecrawl cache.").optional(),
		lockdown: z.boolean().describe("Lockdown mode: restrict media delivery and cached reuse of the result.").optional(),
		threatProtection: threatProtectionField,
		...commonFields,
	};

	const alexandriaCall = z.object({
		provider: z.string().describe("Provider id, from firecrawl_find_tools or a firecrawl_search alexandria suggestion."),
		capability: z.string().describe("Capability id within the provider, from the tool contract."),
		options: z.record(z.unknown()).describe("Provider-specific call options, taken from the tool contract.").optional(),
	});

	// omptype rejects `union([object, array(object)])` at build time
	// ("overlapping morph inputs"), so `alexandria` is declared as unknown and
	// validated here against the same per-call schema. Single call and array
	// are both accepted, as in the SDK overload.
	const parseAlexandria = (value: unknown): AlexandriaCall | AlexandriaCall[] => {
		const calls = Array.isArray(value) ? value : [value];
		if (calls.length === 0) {
			throw new ToolError("firecrawl_scrape: `alexandria` needs at least one provider call");
		}
		for (const call of calls) {
			const parsed = alexandriaCall.safeParse(call);
			if (!parsed.success) {
				throw new ToolError(
					`firecrawl_scrape: invalid alexandria call (${parsed.error.message}): ${JSON.stringify(call)}`,
				);
			}
		}
		return value as AlexandriaCall | AlexandriaCall[];
	};

	const scrapeParameters = z.object({
		url: z.string().describe("Absolute URL to fetch, scheme included. Mutually exclusive with `alexandria`.").optional(),
		alexandria: z
			.unknown()
			.describe(
				"Alexandria mode: one provider call object { provider, capability, options? }, or an array of them. Mutually exclusive with `url`; only `requestId` and `timeout` may accompany it.",
			)
			.optional(),
		requestId: z.string().describe("Reuse this ID with the identical payload when retrying an Alexandria execution.").optional(),
		...scrapeShape,
		toolDetail: z
			.enum(["compact", "summary", "full"])
			.describe("Alexandria contract verbosity in `tools`: summary by default; compact returns identity and description, full includes contracts.")
			.optional(),
	});

	defineTool(pi, {
		name: "firecrawl_scrape",
		label: "Firecrawl scrape",
		description: `Fetch one URL as markdown, HTML, links, screenshot, JSON, summary, or branding data.
Use it when the request names the page; use the search tools first when it does not.
\`alexandria\` runs one catalogued provider call instead — never combine it with URL options.
Returns raw markdown, or the requested format; per-provider \`error\` and \`creditsCost\` are data, not failures.
Related devices: xd://firecrawl_map, xd://firecrawl_interact.`,
		parameters: scrapeParameters,
		approval: "read",
		loadMode: "essential",
		render: (data, params) => documentText(data, params),
		run: async (params, signal) => {
			const { url, alexandria, requestId, ...options } = params;
			if (url !== undefined) {
				if (alexandria !== undefined) {
					throw new ToolError("firecrawl_scrape: `url` and `alexandria` are mutually exclusive — set exactly one");
				}
				if (requestId !== undefined) {
					throw new ToolError("firecrawl_scrape: `requestId` only applies to an `alexandria` call — remove it for URL scrapes");
				}
				return withAbort(api().scrape(url, options as unknown as ScrapeOptions), signal);
			}
			if (alexandria === undefined) {
				throw new ToolError("firecrawl_scrape: exactly one of `url` or `alexandria` is required");
			}
			const forbidden = Object.entries(options)
				.filter(([key, value]) => key !== "timeout" && value !== undefined)
				.map(([key]) => `\`${key}\``);
			if (forbidden.length > 0) {
				throw new ToolError(`firecrawl_scrape: with \`alexandria\` only \`requestId\` and \`timeout\` are allowed — remove ${forbidden.join(", ")}`);
			}
			return withAbort(
				api().scrape({ alexandria: parseAlexandria(alexandria), requestId, timeout: options.timeout }),
				signal,
			);
		},
	});

	const searchParameters = z.object({
		query: z.string().describe("Search query."),
		domainTools: z.boolean().describe("Include domain-matched Alexandria tools in `tools` alongside semantic matches.").optional(),
		toolDetail: z.enum(["compact", "summary", "full"]).describe("Alexandria contract verbosity: compact by default; summary adds metadata, full includes contracts.").optional(),
		sources: z
			.array(z.union([z.enum(["web", "news", "images", "alexandria"]), z.record(z.unknown())]))
			.describe('Result sources, strings or { type } objects: "web", "news", "images", or "alexandria" — the provider-suggestion path, returning catalogued provider calls to run through firecrawl_scrape.')
			.optional(),
		categories: z
			.array(z.union([z.enum(["github", "research", "pdf", "developer", "gov"]), z.record(z.unknown())]))
			.describe(
				'Narrow web search, strings or { type } objects: "research" limits results to ~14 academic websites (not the paper index), "pdf" to PDFs, "developer" to the developer index, "gov" to the Government index; "developer" and "gov" must each be the only category.',
			)
			.optional(),
		includeDomains: z.array(z.string()).describe("Return only results from these domains.").optional(),
		excludeDomains: z.array(z.string()).describe("Drop results from these domains.").optional(),
		limit: z.number().describe("Maximum number of results to return per source.").optional(),
		tbs: z.string().describe('Google-style time-based search filter, e.g. "qdr:d" for the last day.').optional(),
		location: z.string().describe('Location used to localize the search results, e.g. "Germany".').optional(),
		country: z.string().describe("ISO 3166-1 alpha-2 country code used to geo-target the search results.").optional(),
		ignoreInvalidURLs: z.boolean().describe("Skip invalid URLs instead of failing the search.").optional(),
		timeout: z.number().describe("Maximum time for the search request, in milliseconds.").optional(),
		highlights: z.boolean().describe("Generate query-relevant highlights for search results. Defaults to true.").optional(),
		scrapeOptions: z.object(scrapeShape).describe("Scrape each result and attach its content — bills one scrape per returned result.").optional(),
		enterprise: z
			.array(z.enum(["default", "anon", "zdr"]))
			.describe('Enterprise options, ["zdr"] for end-to-end Zero Data Retention or ["anon"] for anonymized search. Must be enabled for your team.')
			.optional(),
		threatProtection: threatProtectionField,
	});

	defineTool(pi, {
		name: "firecrawl_search",
		label: "Firecrawl search",
		description: `Search the live web for current facts: releases, prices, people, companies, statistics.
Use it before scraping: it returns URLs plus optional content; \`scrapeOptions\` bills one scrape per result.
\`sources: ["alexandria"]\` also returns provider suggestions to run through firecrawl_scrape.
\`categories\` \`gov\` and \`developer\` must each be the only category in the call.
Related devices: xd://firecrawl_map, xd://firecrawl_agent.`,
		parameters: searchParameters,
		approval: "read",
		loadMode: "essential",
		run: async (params, signal) => {
			const categories = params.categories ?? [];
			for (const solo of ["gov", "developer"] as const) {
				if (categories.includes(solo) && categories.length > 1) {
					throw new ToolError(`categories: ["${solo}"] cannot be combined with another category`);
				}
			}
			const { query, ...rest } = params;
			return withAbort(api().search(params.query, rest as unknown as Omit<SearchRequest, "query">), signal);
		},
	});

	const parseParameters = z.object({
		filePath: z.string().describe("Path to the local file to parse (PDF, DOCX, XLSX, RTF, OpenDocument, HTML, images, …)."),
		contentType: z.string().describe("Override the MIME content type otherwise derived from the file name and contents.").optional(),
		formats: z
			.array(z.union([z.string(), z.record(z.unknown())]))
			.describe(
				'Output formats as strings or option objects: markdown, html, rawHtml, links, images, summary, json, attributes, product, menu (json: prompt/schema; attributes: selectors; question/highlights: query).',
			)
			.optional(),
		proxy: z.enum(["basic", "auto"]).describe("Proxy tier for the parse: basic or auto.").optional(),
		...commonFields,
	});

	defineTool(pi, {
		name: "firecrawl_parse",
		label: "Firecrawl parse",
		description: `Parse a local PDF, DOCX, XLSX, or HTML file into markdown, HTML, links, summary, or JSON.
Give a filesystem path; the SDK performs the multipart upload, so no upload reference is needed.
Use firecrawl_scrape instead when the document already has a URL.
Related devices: xd://firecrawl_credit_usage, xd://firecrawl_feedback.`,
		parameters: parseParameters,
		approval: "read",
		loadMode: "essential",
		render: (data, params) => documentText(data, params),
		run: async (params, signal) => {
			const { filePath, contentType, ...options } = params;
			const file = Bun.file(filePath);
			if (!(await file.exists())) {
				throw new ToolError(`firecrawl_parse: no such file: ${filePath}`);
			}
			const bytes = await file.arrayBuffer();
			const filename = filePath.split(/[\\/]/).pop() ?? filePath;
			return withAbort(api().parse({ data: new Uint8Array(bytes), filename, contentType }, options as unknown as ParseOptions), signal);
		},
	});
}
