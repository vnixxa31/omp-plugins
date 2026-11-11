/**
 * Error-envelope and cancellation behavior (`AGENTS.md` §4.1, §4.3).
 */
import { describe, expect, test } from "bun:test";
import { SdkError } from "firecrawl";
import { toError, withAbort } from "./api";

function text(envelope: { content: { text: string }[] }): string {
	return envelope.content[0]?.text ?? "";
}

describe("toError", () => {
	test("renders status, code, requestId and details for an SdkError", () => {
		const error = new SdkError(
			"Not enough credits",
			402,
			"INSUFFICIENT_CREDITS",
			{ remaining: 0 },
			undefined,
			"charge_1",
		);
		error.requestId = "req_123";

		const envelope = toError("firecrawl_scrape", error);
		const body = text(envelope);

		expect(envelope.isError).toBe(true);
		expect(body).toContain("firecrawl_scrape failed: 402 Payment Required (INSUFFICIENT_CREDITS)");
		expect(body).toContain("Not enough credits");
		expect(body).toContain("requestId: req_123");
		expect(body).toContain("chargeId: charge_1");
		expect(body).toContain("details:");
		expect(body).toContain("firecrawl_credit_usage");
		expect(envelope.details.error.status).toBe(402);
	});

	test("keeps a requiresAction payload verbatim and skips the key hint", () => {
		const requiresAction = {
			type: "accept_terms",
			terms: "Data may be resold",
			url: "https://example.com/terms",
		};
		const error = new SdkError(
			"Provider terms must be accepted",
			403,
			"PROVIDER_TERMS_REQUIRED",
			undefined,
			"job_9",
			undefined,
			requiresAction,
		);

		const body = text(toError("firecrawl_agent", error));

		expect(body).toContain("403 Forbidden (PROVIDER_TERMS_REQUIRED)");
		expect(body).toContain("jobId: job_9");
		expect(body).toContain('"type":"accept_terms"');
		expect(body).toContain("https://example.com/terms");
		expect(body).not.toContain("FIRECRAWL_API_KEY");
	});

	test("adds the key hint for a bare 401", () => {
		const body = text(toError("firecrawl_map", new SdkError("Unauthorized", 401, "UNAUTHORIZED")));
		expect(body).toContain("hint: set FIRECRAWL_API_KEY");
	});

	test("renders a non-SDK error as one concrete line", () => {
		const envelope = toError("firecrawl_parse", new Error("ENOENT: /tmp/missing.pdf"));
		expect(envelope.isError).toBe(true);
		expect(text(envelope)).toBe("firecrawl_parse failed: ENOENT: /tmp/missing.pdf");
	});
});

describe("withAbort", () => {
	test("passes the value through untouched without a signal", async () => {
		await expect(withAbort(Promise.resolve(7), undefined)).resolves.toBe(7);
	});

	test("rejects with the signal reason when aborted mid-flight", async () => {
		const controller = new AbortController();
		const pending = withAbort(new Promise<number>(() => {}), controller.signal);
		controller.abort(new Error("stop now"));

		await expect(pending).rejects.toThrow("stop now");
	});

	test("rejects immediately for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(withAbort(Promise.resolve(1), controller.signal)).rejects.toThrow();
	});

	test("envelopes an abort as an isError result, not a throw", () => {
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));
		const envelope = toError("firecrawl_search", controller.signal.reason);
		expect(envelope.isError).toBe(true);
	});
});
