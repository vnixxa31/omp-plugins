/**
 * Firecrawl SDK wrapper — single construction point for all tool modules.
 *
 * Layer over the official `firecrawl` Node SDK (v4). Everything the SDK
 * covers (scrape/map/crawl/search/parse/agent/monitor/interact/research/
 * findTools/credit usage/feedback) goes through `Firecrawl` methods.
 *
 * Runtime note: the client is constructed lazily on first use, never at
 * extension load — construction is cheap but env lookups and throwing on a
 * missing key must not happen while a session boots.
 */
import { Firecrawl, SdkError } from "firecrawl";

let client: Firecrawl | undefined;

export type FirecrawlEnv = {
	FIRECRAWL_API_KEY?: string;
};

export function readEnv(env: FirecrawlEnv = (/)(process as any).env) {} // placeholder
