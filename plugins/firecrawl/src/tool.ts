/**
 * `defineTool()` — the one registration wrapper every Firecrawl tool uses.
 *
 * It fixes the parts of a registration that must never differ between tools:
 * the approval tier spelling, the load mode default, the envelope, and the
 * error mapping. A tool module supplies a name, a description, a `pi.zod`
 * schema, an approval tier, and a `run` function that returns the raw SDK
 * payload; it never builds content blocks or formats errors.
 *
 * `AGENTS.md` §5 is the authority for tool contracts, §4.4 for approval tiers.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { zod } from "@oh-my-pi/pi-coding-agent";
import { jsonResult, textResult, toError } from "./api";

/** Approval tier per `AGENTS.md` §4.4. */
export type ApprovalTier = "read" | "write" | "exec";

/** `"essential"` ships in the system prompt; `"discoverable"` mounts as `xd://`. */
export type LoadMode = "essential" | "discoverable";

export type ToolSpec<TParams extends zod.ZodLikeSchema<unknown>, TDetails> = {
	/** MCP-server name, unchanged (`firecrawl_scrape`, …). */
	name: string;
	label: string;
	/** `AGENTS.md` §3.3: one ≤120-char imperative line, then ≤3 short lines. */
	description: string;
	parameters: TParams;
	approval: ApprovalTier;
	loadMode?: LoadMode;
	/**
	 * Optional text renderer for the payload. Default is compact JSON.
	 * Only `scrape`/`parse` use this, to return raw markdown instead of a
	 * JSON-escaped page (`AGENTS.md` §4.2).
	 */
	render?: (data: TDetails, params: zod.infer<TParams>) => string;
	/** Perform the SDK call and return its payload untouched. */
	run: (params: zod.infer<TParams>, signal: AbortSignal | undefined) => Promise<TDetails>;
};

export function defineTool<TParams extends zod.ZodLikeSchema<unknown>, TDetails>(
	pi: ExtensionAPI,
	spec: ToolSpec<TParams, TDetails>,
): void {
	pi.registerTool<TParams, TDetails | { error: unknown }>({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		parameters: spec.parameters,
		loadMode: spec.loadMode ?? "discoverable",
		approval: spec.approval,
		async execute(_toolCallId, rawParams, signal) {
			const params = rawParams as zod.infer<TParams>;
			try {
				const data = await spec.run(params, signal ?? undefined);
				return spec.render ? textResult(spec.render(data, params), data) : jsonResult(data);
			} catch (error) {
				return toError(spec.name, error);
			}
		},
	});
}

/**
 * Text for a `Document` payload: raw markdown when present, otherwise the one
 * format the caller asked for, otherwise compact JSON so nothing is hidden.
 */
export function documentText(data: unknown, params: { formats?: unknown[] }): string {
	const doc = (data ?? {}) as {
		markdown?: unknown;
		html?: unknown;
		rawHtml?: unknown;
		summary?: unknown;
		links?: unknown;
	};
	if (typeof doc.markdown === "string") return doc.markdown;
	if (typeof doc.html === "string") return doc.html;
	if (typeof doc.rawHtml === "string") return doc.rawHtml;
	if (typeof doc.summary === "string") return doc.summary;

	const formats = Array.isArray(params.formats) ? params.formats : [];
	if (formats.length === 1 && formats[0] === "links" && Array.isArray(doc.links)) {
		return (doc.links as string[]).join("\n");
	}
	return JSON.stringify(data);
}
