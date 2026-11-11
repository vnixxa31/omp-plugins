/**
 * Monitor tools: `firecrawl_monitor_create`/`update`/`list`/`get`/`delete`/
 * `run`/`check`/`checks` (`AGENTS.md` §5.6).
 *
 * Schemas mirror the installed SDK monitor types one field per option (§2),
 * minus the server-managed target `id`. `createMonitor` needs a full
 * `CreateMonitorRequest`, so the create tool builds it from either the simple
 * form (`page`/`pages` or `queries` plus an optional `goal`) or the advanced
 * form (explicit `targets`): default 30-minute schedule, name derived from
 * the first target, and `schedule.text` handed to the API untouched — the
 * API validates and normalizes schedules, we never repair them. Every SDK
 * call goes through `api()` and `withAbort()`; local validation failures
 * throw `ToolError` before any request leaves the process.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type {
	CreateMonitorRequest,
	ListMonitorsOptions,
	MonitorSchedule,
	MonitorTarget,
	UpdateMonitorRequest,
} from "firecrawl";
import { ToolError, api, withAbort } from "../api";
import { defineTool } from "../tool";

const MONITOR_CREATE = "firecrawl_monitor_create";
const MONITOR_UPDATE = "firecrawl_monitor_update";

/** The API's default cadence when the caller gives no cron and no text. */
const DEFAULT_SCHEDULE: MonitorSchedule = { text: "every 30 minutes" };

type ScheduleField = {
	cron?: string;
	text?: string;
	timezone?: string;
};

/**
 * The three monitor target kinds as one loose shape — the shim cannot express
 * the SDK's discriminated union, so `run` casts at the SDK boundary.
 */
type TargetField = {
	type?: string;
	url?: string;
	urls?: string[];
	queries?: string[];
	searchWindow?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
	maxResults?: number;
	scrapeOptions?: Record<string, unknown>;
	crawlOptions?: Record<string, unknown>;
};

type CreateMonitorParams = {
	name?: string;
	goal?: string;
	judgeEnabled?: boolean;
	retentionDays?: number;
	page?: string;
	pages?: string[];
	queries?: string[];
	schedule?: ScheduleField;
	targets?: TargetField[];
	webhook?: {
		url: string;
		headers?: Record<string, string>;
		metadata?: Record<string, string>;
		events?: string[];
	};
	notification?: {
		email?: { enabled?: boolean; recipients?: string[]; includeDiffs?: boolean };
	};
};

/**
 * Build a `MonitorSchedule`: `undefined` means the create default; otherwise
 * exactly one of `cron`/`text` must be present, `timezone` rides along, and
 * `text` is passed through untouched.
 */
function buildSchedule(schedule: ScheduleField | undefined, tool: string): MonitorSchedule {
	if (schedule === undefined) return { ...DEFAULT_SCHEDULE };
	const { cron, text, timezone } = schedule;
	if (cron !== undefined && text !== undefined) {
		throw new ToolError(`${tool}: schedule.cron and schedule.text are mutually exclusive — pass exactly one`);
	}
	if (cron === undefined && text === undefined) {
		throw new ToolError(`${tool}: schedule needs exactly one of \`cron\` or \`text\``);
	}
	const built: MonitorSchedule = cron !== undefined ? { cron } : { text };
	if (timezone !== undefined) built.timezone = timezone;
	return built;
}

/** `<first target host or query> monitor` — the API requires a name (§5.6). */
function deriveName(target: MonitorTarget | undefined): string {
	let seed: string | undefined;
	if (target?.type === "scrape") seed = target.urls[0];
	else if (target?.type === "crawl") seed = target.url;
	else if (target?.type === "search") seed = target.queries[0];
	if (seed === undefined) return "monitor";
	let host: string | undefined;
	try {
		host = new URL(seed).hostname || undefined;
	} catch {
		host = undefined;
	}
	return host ? `${host} monitor` : `${seed} monitor`;
}

/** Assemble a full `CreateMonitorRequest` from the simple or advanced form. */
function buildCreateMonitorRequest(params: CreateMonitorParams): CreateMonitorRequest {
	const simpleUrls = [...(params.page !== undefined ? [params.page] : []), ...(params.pages ?? [])];
	const simpleQueries = params.queries !== undefined && params.queries.length > 0 ? params.queries : undefined;

	if (params.targets !== undefined && (simpleUrls.length > 0 || simpleQueries !== undefined)) {
		throw new ToolError(
			`${MONITOR_CREATE}: \`targets\` is the advanced form — drop \`page\`/\`pages\`/\`queries\` when using it`,
		);
	}
	if (simpleUrls.length > 0 && simpleQueries !== undefined) {
		throw new ToolError(
			`${MONITOR_CREATE}: \`page\`/\`pages\` and \`queries\` are mutually exclusive — the simple form watches URLs or search queries, not both in one call; use \`targets\` to mix them`,
		);
	}

	let targets: MonitorTarget[];
	if (params.targets !== undefined) {
		targets = params.targets as unknown as MonitorTarget[];
	} else if (simpleUrls.length > 0 || simpleQueries !== undefined) {
		targets = [];
		if (simpleUrls.length > 0) targets.push({ type: "scrape", urls: simpleUrls });
		if (simpleQueries !== undefined) targets.push({ type: "search", queries: simpleQueries });
	} else {
		throw new ToolError(
			`${MONITOR_CREATE}: give URLs with \`page\`/\`pages\`, news with \`queries\`, or explicit \`targets\``,
		);
	}

	const request: CreateMonitorRequest = {
		name: params.name ?? deriveName(targets[0]),
		schedule: buildSchedule(params.schedule, MONITOR_CREATE),
		targets,
	};
	if (params.goal !== undefined) request.goal = params.goal;
	// `judgeEnabled` is passed through only when the caller set it: never
	// enabled implicitly, not even by `goal` (§5.6).
	if (params.judgeEnabled !== undefined) request.judgeEnabled = params.judgeEnabled;
	if (params.retentionDays !== undefined) request.retentionDays = params.retentionDays;
	if (params.webhook !== undefined) request.webhook = params.webhook;
	if (params.notification !== undefined) request.notification = params.notification;
	return request;
}

export function registerMonitorTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	// Nested option objects shared by create and update; define once,
	// reference. Keep every schema in a variable: an inline `z.object({...})`
	// argument to `defineTool` makes TS fall back to the
	// `ZodLikeSchema<unknown>` constraint, so `run` would receive
	// `params: unknown` (see src/tools/developer.ts).
	const scheduleShape = {
		cron: z.string().describe('5-field cron expression, e.g. "*/30 * * * *". Mutually exclusive with `text`.').optional(),
		text: z
			.string()
			.describe('Natural-language schedule, e.g. "every 30 minutes", "hourly", "daily at 9:00"; the API normalizes it. Mutually exclusive with `cron`.')
			.optional(),
		timezone: z.string().describe('IANA timezone the schedule runs in, e.g. "Europe/Berlin".').optional(),
	};

	const targetShape = {
		type: z
			.enum(["scrape", "crawl", "search"])
			.describe('Target kind: "scrape" diffs `urls` pages, "crawl" diffs a crawled site rooted at `url`, "search" re-runs `queries`.'),
		urls: z.array(z.string()).describe('Pages to scrape and diff each check (type: "scrape").').optional(),
		url: z.string().describe('Root URL to crawl and diff each check (type: "crawl").').optional(),
		queries: z.array(z.string()).describe('Search queries to re-run each check (type: "search").').optional(),
		searchWindow: z
			.enum(["5m", "15m", "1h", "6h", "24h", "7d"])
			.describe('Freshness window for search results (type: "search").')
			.optional(),
		includeDomains: z.array(z.string()).describe('Restrict search results to these domains (type: "search").').optional(),
		excludeDomains: z.array(z.string()).describe('Drop search results from these domains (type: "search").').optional(),
		maxResults: z.number().describe('Maximum search results to consider per check (type: "search").').optional(),
		scrapeOptions: z
			.record(z.unknown())
			.describe('Per-target scrape options applied to every scrape (types: "scrape", "crawl").')
			.optional(),
		crawlOptions: z.record(z.unknown()).describe('Crawl options for the target crawl (type: "crawl").').optional(),
	};

	const webhookBase = z
		.object({
			url: z.string().describe("URL the monitor POSTs check events to."),
			headers: z.record(z.string()).describe("Additional HTTP headers on each webhook delivery.").optional(),
			metadata: z.record(z.string()).describe("Key-value pairs echoed back in each webhook payload.").optional(),
			events: z.array(z.string()).describe("Event names to notify on; omit to notify on all events.").optional(),
		})
		.describe("Webhook notified on monitor check events.");

	const notificationBase = z
		.object({
			email: z
				.object({
					enabled: z.boolean().describe("Turn email notifications on or off.").optional(),
					recipients: z
						.array(z.string())
						.describe("Email addresses to notify; recipients outside the team must confirm a one-time email.")
						.optional(),
					includeDiffs: z.boolean().describe("Include the page diffs in the email.").optional(),
				})
				.describe("Email notification settings.")
				.optional(),
		})
		.describe("Email notification settings for check results.");

	const createParameters = z.object({
		name: z
			.string()
			.describe("Display name; the API requires one — derived from the first target's host or query when omitted.")
			.optional(),
		goal: z
			.string()
			.describe("Plain-language statement of what counts as a meaningful change; the goal judge grades diffs against it.")
			.optional(),
		judgeEnabled: z
			.boolean()
			.describe("Ask the goal judge whether each change is meaningful. Passed through only when set — never enabled implicitly.")
			.optional(),
		retentionDays: z.number().describe("Days of check history Firecrawl retains; the plan default applies when omitted.").optional(),
		page: z
			.string()
			.describe("Single URL to watch — simple form, builds one scrape target. Mutually exclusive with `queries` and `targets`.")
			.optional(),
		pages: z
			.array(z.string())
			.describe("URLs to watch — simple form, builds one scrape target. Mutually exclusive with `queries` and `targets`.")
			.optional(),
		queries: z
			.array(z.string())
			.describe("Search queries to re-run each check — simple form, builds one search target. Mutually exclusive with `page`/`pages` and `targets`.")
			.optional(),
		schedule: z
			.object(scheduleShape)
			.describe('When to run checks: exactly one of cron or text. Defaults to "every 30 minutes".')
			.optional(),
		targets: z
			.array(z.object(targetShape))
			.describe("Advanced form: explicit scrape/crawl/search targets. Mutually exclusive with `page`/`pages`/`queries`.")
			.optional(),
		webhook: webhookBase.optional(),
		notification: notificationBase.optional(),
	});

	defineTool(pi, {
		name: MONITOR_CREATE,
		label: "Firecrawl monitor create",
		description: `Create a recurring scrape, crawl, or search monitor that compares each check with its retained predecessor.
Give \`page\`/\`pages\` or \`queries\` plus an optional \`goal\` for the simple form; explicit \`targets\` and \`schedule\` for the advanced one.
Defaults to \`every 30 minutes\`; the API normalizes \`schedule.text\` — it is never rewritten here.
Returns the created Monitor with its normalized cron schedule and estimated monthly credits.`,
		parameters: createParameters,
		approval: "write",
		run: (params, signal) => withAbort(api().createMonitor(buildCreateMonitorRequest(params)), signal),
	});

	const updateParameters = z.object({
		id: z.string().describe("Monitor id to update, from firecrawl_monitor_list or firecrawl_monitor_create."),
		name: z.string().describe("New display name for the monitor.").optional(),
		status: z.enum(["active", "paused"]).describe('Pause the schedule with "paused", resume with "active".').optional(),
		schedule: z.object(scheduleShape).describe("Replace the schedule: exactly one of cron or text.").optional(),
		webhook: webhookBase.nullable().describe("Replace the webhook config; null removes it.").optional(),
		notification: notificationBase.nullable().describe("Replace the notification config; null removes it.").optional(),
		targets: z.array(z.object(targetShape)).describe("Replace every monitor target in one patch.").optional(),
		retentionDays: z.number().describe("Days of check history Firecrawl retains.").optional(),
		goal: z.string().nullable().describe("Plain-language meaningful-change goal; null clears it.").optional(),
		judgeEnabled: z.boolean().describe("Ask the goal judge whether each change is meaningful.").optional(),
	});

	defineTool(pi, {
		name: MONITOR_UPDATE,
		label: "Firecrawl monitor update",
		description: `Patch an existing monitor by id: name, status, schedule, webhook, notification, targets, retention, or goal.
Use \`status\` to pause or resume and \`schedule\` (exactly one of cron/text) to reschedule without touching targets.
Returns the updated Monitor with reconciled email-recipient state.`,
		parameters: updateParameters,
		approval: "write",
		run: async ({ id, ...patch }, signal) => {
			const request: UpdateMonitorRequest = {};
			if (patch.name !== undefined) request.name = patch.name;
			if (patch.status !== undefined) request.status = patch.status;
			if (patch.schedule !== undefined) request.schedule = buildSchedule(patch.schedule, MONITOR_UPDATE);
			if (patch.targets !== undefined) request.targets = patch.targets as unknown as MonitorTarget[];
			if (patch.retentionDays !== undefined) request.retentionDays = patch.retentionDays;
			if (patch.goal !== undefined) request.goal = patch.goal;
			if (patch.judgeEnabled !== undefined) request.judgeEnabled = patch.judgeEnabled;
			if (patch.webhook !== undefined) request.webhook = patch.webhook;
			if (patch.notification !== undefined) request.notification = patch.notification;
			return withAbort(api().updateMonitor(id, request), signal);
		},
	});

	const listParameters = z.object({
		limit: z.number().describe("Maximum monitors to return.").optional(),
		offset: z.number().describe("Number of monitors to skip for pagination.").optional(),
	});

	defineTool(pi, {
		name: "firecrawl_monitor_list",
		label: "Firecrawl monitor list",
		description: `List monitors for the authenticated team with optional limit and offset.
Use it to find a monitor id; use firecrawl_monitor_get for one monitor's full configuration.
Returns a plain Monitor[] array — the SDK exposes no pagination metadata.`,
		parameters: listParameters,
		approval: "read",
		run: async ({ limit, offset }, signal) => {
			const options: ListMonitorsOptions = {};
			if (limit !== undefined) options.limit = limit;
			if (offset !== undefined) options.offset = offset;
			return withAbort(api().listMonitors(options), signal);
		},
	});

	const getParameters = z.object({
		id: z.string().describe("Monitor id, from firecrawl_monitor_list or firecrawl_monitor_create."),
	});

	defineTool(pi, {
		name: "firecrawl_monitor_get",
		label: "Firecrawl monitor get",
		description: `Retrieve one monitor by id, including its configuration and current state.
This does not run or modify the monitor; use firecrawl_monitor_run for an immediate check.
Returns the Monitor: targets, normalized schedule, status, next run, and last check summary.`,
		parameters: getParameters,
		approval: "read",
		run: ({ id }, signal) => withAbort(api().getMonitor(id), signal),
	});

	const deleteParameters = z.object({
		id: z.string().describe("Monitor id to delete; this cannot be undone."),
	});

	defineTool(pi, {
		name: "firecrawl_monitor_delete",
		label: "Firecrawl monitor delete",
		description: `Permanently delete a monitor by id and stop its future schedule.
Use firecrawl_monitor_update with status "paused" to stop checks without losing history.
Returns true on deletion, surfaced verbatim.`,
		parameters: deleteParameters,
		approval: "write",
		run: ({ id }, signal) => withAbort(api().deleteMonitor(id), signal),
	});

	const runParameters = z.object({
		id: z.string().describe("Monitor id to check now, from firecrawl_monitor_list."),
	});

	defineTool(pi, {
		name: "firecrawl_monitor_run",
		label: "Firecrawl monitor run",
		description: `Queue an immediate check for a monitor outside its normal schedule.
It starts network work on the monitor's configured targets; the check runs async.
Returns the queued MonitorCheck (status "queued") — read results with firecrawl_monitor_check.`,
		parameters: runParameters,
		approval: "write",
		run: ({ id }, signal) => withAbort(api().runMonitor(id), signal),
	});

	const checkParameters = z.object({
		monitorId: z.string().describe("Monitor the check belongs to."),
		checkId: z.string().describe("Check id, from firecrawl_monitor_checks or the monitor's currentCheckId."),
		status: z
			.enum(["same", "new", "changed", "removed", "error"])
			.describe("Keep only pages whose per-page result has this status; the check itself always returns.")
			.optional(),
		limit: z.number().describe("Maximum pages to return.").optional(),
		skip: z.number().describe("Number of pages to skip.").optional(),
	});

	defineTool(pi, {
		name: "firecrawl_monitor_check",
		label: "Firecrawl monitor check",
		description: `Retrieve one monitor check and its page-level results, optionally filtered by page status.
Get the check id from firecrawl_monitor_checks; this read observes a check, it never runs one.
Returns the MonitorCheckDetail: summary, per-page entries with inline diffs, and a \`next\` cursor.`,
		parameters: checkParameters,
		approval: "read",
		run: ({ monitorId, checkId, ...options }, signal) => withAbort(api().getMonitorCheck(monitorId, checkId, options), signal),
	});

	const checksParameters = z.object({
		monitorId: z.string().describe("Monitor whose check history to list."),
		limit: z.number().describe("Maximum checks to return.").optional(),
		offset: z.number().describe("Number of checks to skip for pagination.").optional(),
	});

	defineTool(pi, {
		name: "firecrawl_monitor_checks",
		label: "Firecrawl monitor checks",
		description: `List historical checks for a monitor with optional limit and offset.
This SDK method takes no status filter; filter pages inside firecrawl_monitor_check.
Returns one page of MonitorCheck summaries: status, trigger, timestamps, credits, and per-page counts.`,
		parameters: checksParameters,
		approval: "read",
		run: async ({ monitorId, limit, offset }, signal) => {
			const options: ListMonitorsOptions = {};
			if (limit !== undefined) options.limit = limit;
			if (offset !== undefined) options.offset = offset;
			return withAbort(api().listMonitorChecks(monitorId, options), signal);
		},
	});
}
