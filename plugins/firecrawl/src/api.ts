/**
 * Firecrawl SDK wrapper — the single construction point for every tool module.
 *
 * Everything the SDK covers goes through `Firecrawl` methods; there is no
 * `fetch`, no `axios`, and no hand-written HTTP anywhere in this plugin. This
 * module owns the four cross-cutting concerns so no tool repeats them:
 *
 * - a lazily constructed client (a missing key or a bad `FIRECRAWL_API_URL`
 *   must not break session start),
 * - local cancellation for calls the SDK cannot cancel,
 * - the success/error result envelopes,
 * - mapping `SdkError` fields onto a readable message.
 *
 * `AGENTS.md` §4.1–4.3 is the authority for this file.
 */
import { Firecrawl, SdkError } from "firecrawl";
import pkg from "../package.json" with { type: "json" };

let client: Firecrawl | undefined;

/**
 * The shared SDK client, created on first use.
 *
 * The SDK reads `FIRECRAWL_API_KEY` and `FIRECRAWL_API_URL` itself; this
 * plugin adds no environment variables. `origin` is the only option we set, so
 * Firecrawl attributes traffic to this plugin instead of the SDK's own package.
 */
export function api(): Firecrawl {
	client ??= new Firecrawl({ origin: `omp-plugin-firecrawl@${pkg.version}` });
	return client;
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error(reason === undefined ? "aborted" : String(reason));
	error.name = "AbortError";
	return error;
}

/**
 * Race a promise against an abort signal.
 *
 * `crawl()` takes a `signal` natively and does a best-effort remote cancel. No
 * other SDK call accepts one, so they are raced locally: the await rejects
 * immediately, but the remote work keeps running and may still be billed.
 */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortReason(signal));

	const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return raced;
}

/** One text block: what the model reads. `details` carries the raw payload. */
export type ToolEnvelope<TDetails = unknown> = {
	content: { type: "text"; text: string }[];
	details: TDetails;
	isError?: boolean;
};

/** Local (pre-request) failure: a bad path, a mutually exclusive pair, … */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

/**
 * Success envelope with the payload rendered as compact JSON.
 *
 * `details` is always the untouched SDK payload; omp spills oversize output on
 * its own, so nothing here truncates.
 */
export function jsonResult<TDetails>(data: TDetails): ToolEnvelope<TDetails> {
	return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
}

/** Success envelope whose text is a caller-rendered string (see `documentText`). */
export function textResult<TDetails>(text: string, data: TDetails): ToolEnvelope<TDetails> {
	return { content: [{ type: "text", text }], details: data };
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	402: "Payment Required",
	403: "Forbidden",
	404: "Not Found",
	408: "Request Timeout",
	409: "Conflict",
	422: "Unprocessable Entity",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

const DETAILS_LIMIT = 2048;

function clip(value: unknown, limit = DETAILS_LIMIT): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === undefined) return "undefined";
	return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} chars clipped)` : text;
}

function httpLabel(status: number | undefined, fallback: string): string {
	if (status === undefined) return fallback;
	const text = STATUS_TEXT[status] ?? "HTTP Error";
	return `${status} ${text}`;
}

/** Structured error payload stored in `details.error`; the UI reads it. */
export type ToolErrorDetails = {
	name: string;
	message: string;
	status?: number;
	code?: string;
	requestId?: string;
	jobId?: string;
	chargeId?: string;
	requiresAction?: unknown;
	agentHints?: string[];
	details?: unknown;
};

function errorDetails(error: unknown): ToolErrorDetails {
	if (error instanceof SdkError) {
		const out: ToolErrorDetails = { name: error.name, message: error.message };
		if (error.status !== undefined) out.status = error.status;
		if (error.code !== undefined) out.code = error.code;
		if (error.requestId !== undefined) out.requestId = error.requestId;
		if (error.jobId !== undefined) out.jobId = error.jobId;
		if (error.chargeId !== undefined) out.chargeId = error.chargeId;
		if (error.requiresAction !== undefined) out.requiresAction = error.requiresAction;
		if (error.agent_hints !== undefined) out.agentHints = error.agent_hints;
		if (error.details !== undefined) out.details = error.details;
		return out;
	}
	if (error instanceof Error) return { name: error.name, message: error.message };
	return { name: "Error", message: String(error) };
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Error envelope: the API's own fields, never a bare stack trace.
 *
 * `AGENTS.md` §4.3 — status/code on the first line, then the message, then
 * whichever of requestId/jobId/requiresAction/agentHints/details exist, plus a
 * short actionable hint for 401/403/402.
 */
export function toError(toolName: string, error: unknown): ToolEnvelope<{ error: ToolErrorDetails }> {
	const details = errorDetails(error);
	const lines: string[] = [];

	if (isAbort(error)) {
		lines.push(`${toolName} aborted: ${details.message}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { error: details }, isError: true };
	}

	if (error instanceof SdkError) {
		const label = httpLabel(error.status, error.code ?? error.name);
		lines.push(`${toolName} failed: ${label}${error.code ? ` (${error.code})` : ""}`);
		if (error.message && error.message !== label) lines.push(error.message);
	} else {
		lines.push(`${toolName} failed: ${details.message}`);
	}

	if (details.requestId !== undefined) lines.push(`requestId: ${details.requestId}`);
	if (details.jobId !== undefined) lines.push(`jobId: ${details.jobId}`);
	if (details.chargeId !== undefined) lines.push(`chargeId: ${details.chargeId}`);
	if (details.requiresAction !== undefined) lines.push(`requiresAction: ${clip(details.requiresAction)}`);
	if (details.agentHints !== undefined) lines.push(`agentHints: ${clip(details.agentHints)}`);

	if (error instanceof SdkError) {
		const status = error.status;
		if (error.requiresAction === undefined) {
			if (status === 401 || status === 403) {
				lines.push(
					"hint: set FIRECRAWL_API_KEY; the keyless tier covers only scrape, search and interact — otherwise check your plan and team permissions for this endpoint.",
				);
			} else if (status === 402) {
				lines.push("hint: check remaining credits with firecrawl_credit_usage.");
			}
		}
		if (error.details !== undefined && !error.requiresAction) {
			lines.push(`details: ${clip(error.details)}`);
		}
	} else if (details.details !== undefined) {
		lines.push(`details: ${clip(details.details)}`);
	}

	return { content: [{ type: "text", text: lines.join("\n") }], details: { error: details }, isError: true };
}
