/**
 * Research index tools: `firecrawl_gov_search` plus the four
 * `firecrawl_research_*` tools (`AGENTS.md` §5).
 *
 * Schemas mirror the installed SDK option objects one field per option
 * (`GovSearchOptions`, `SearchPapersOptions`, `GetPaperOptions`,
 * `SimilarPapersOptions` in the SDK typings). The paper tools run on the
 * `firecrawl.research` client (`/v2/search/research`), not on
 * `search({ categories: ["research"] })`, which only narrows ordinary web
 * search to ~14 academic websites. Local validation failures throw `ToolError`
 * before any request leaves the process.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { GovSearchOptions, SearchPapersOptions, SimilarPapersOptions } from "firecrawl";
import { ToolError, api, withAbort } from "../api";
import { defineTool } from "../tool";

export function registerResearchTools(pi: ExtensionAPI): void {
	const z = pi.zod;

	const govSearchParameters = z.object({
		query: z.string().describe("Search query."),
		k: z.number().describe("Total ranked results, 1–100 (default 10).").optional(),
		jurisdiction: z
			.string()
			.describe(
				'Keep only pages of one jurisdiction: "us" for federal, or "us-" plus a two-letter state or territory code, such as "us-ca" or "us-dc".',
			)
			.optional(),
		court: z
			.string()
			.describe('Keep only pages labeled for one court, by CourtListener court id, such as "scotus", "ca9" or "nysd".')
			.optional(),
		courtType: z
			.enum([
				"federal-supreme",
				"federal-appellate",
				"federal-district",
				"federal-bankruptcy",
				"federal-special",
				"military",
				"state-supreme",
				"state-appellate",
				"state-trial",
				"state-special",
				"state-attorney-general",
			])
			.describe("Keep only pages from one type of court.")
			.optional(),
		cites: z
			.string()
			.describe(
				'Keep only pages that cite one law or case, as a printed citation such as "42 U.S.C. § 1983" or "5 U.S. 137", or a citation id such as "us:usc:42:1983".',
			)
			.optional(),
		domain: z.string().describe('Keep only pages from one site, such as "irs.gov".').optional(),
	});

	defineTool(pi, {
		name: "firecrawl_gov_search",
		label: "Firecrawl gov search",
		description:
			"Search US federal, state, and local statutes, regulations, codes, court opinions, and government publications.\n" +
			'Narrow with jurisdiction ("us", "us-ca"), court (CourtListener id such as "scotus"), courtType, cites, or domain.\n' +
			"Use it for legal or regulatory questions that need primary text.\n" +
			"Returns ranked results with url, title, description, and position.",
		approval: "read",
		parameters: govSearchParameters,
		run: ({ query, ...rest }, signal) => {
			const options: GovSearchOptions = rest;
			return withAbort(api().govSearch(query, options), signal);
		},
	});

	const searchPapersParameters = z.object({
		query: z
			.string()
			.describe(
				'Natural-language search query, e.g. "CRISPR base editing off-target effects in primary human T cells".',
			),
		k: z.number().describe("Number of results to return (1–500, default 40).").optional(),
		authors: z
			.array(z.string())
			.describe("Author substring filter(s); ALL must match (case-insensitive).")
			.optional(),
		categories: z
			.array(z.string())
			.describe('Paper subject category filter(s) (e.g. "cs.LG", "q-bio.GN"); ALL must match. Unrelated to search() categories.')
			.optional(),
		from: z.string().describe("Inclusive lower bound on created/updated date (ISO `YYYY-MM-DD`).").optional(),
		to: z.string().describe("Inclusive upper bound on created/updated date (lexicographic).").optional(),
		sort: z
			.enum(["relevance", "date_desc"])
			.describe(
				"Ordering: relevance by default, or date_desc for the newest of the most relevant matches, newest first by created date.",
			)
			.optional(),
	});

	defineTool(pi, {
		name: "firecrawl_research_search_papers",
		label: "Firecrawl research search papers",
		description:
			"Search paper metadata and abstracts across PubMed, bioRxiv, medRxiv, and arXiv with semantic matching.\n" +
			"Use it for scientific literature; for web pages on academic domains use firecrawl_search.\n" +
			'Filters: k, authors, paper categories (e.g. "cs.LG"), from/to ISO dates, sort relevance or date_desc.\n' +
			"Returns ranked papers with title, abstract, authors, dates, and source ids.",
		approval: "read",
		parameters: searchPapersParameters,
		run: ({ query, ...rest }, signal) => {
			const options: SearchPapersOptions = rest;
			return withAbort(api().research.searchPapers(query, options), signal);
		},
	});

	const inspectPaperParameters = z.object({
		id: z
			.string()
			.describe(
				"Paper reference: a canonical `paperId`, or a namespaced id key such as `pmid:<id>`, `pmcid:<id>`, `doi:<doi>` or `arxiv:<id>`. Bare arXiv ids and arXiv URLs are also accepted.",
			),
	});

	defineTool(pi, {
		name: "firecrawl_research_inspect_paper",
		label: "Firecrawl research inspect paper",
		description:
			"Retrieve canonical metadata for one paper by paperId or a namespaced id (pmid:, pmcid:, doi:, arxiv:).\n" +
			"Use it after a search to inspect a candidate; for in-body passages use firecrawl_research_read_paper.\n" +
			"Returns title, abstract, authors, categories, source ids, and dates as markdown.",
		approval: "read",
		parameters: inspectPaperParameters,
		run: ({ id }, signal) => withAbort(api().research.getPaper(id), signal),
	});

	const readPaperParameters = z.object({
		id: z
			.string()
			.describe(
				"Paper reference: a canonical `paperId`, or a namespaced id key such as `pmid:<id>`, `pmcid:<id>`, `doi:<doi>` or `arxiv:<id>`. Bare arXiv ids and arXiv URLs are also accepted.",
			),
		query: z.string().describe("Question the passages must answer; switches the call to read mode.").optional(),
		k: z.number().describe("Passage count (read mode only; 1–50, default 4). Requires `query`.").optional(),
	});

	defineTool(pi, {
		name: "firecrawl_research_read_paper",
		label: "Firecrawl research read paper",
		description:
			"Retrieve in-body passages from one paper that are relevant to a specific question.\n" +
			"Use it when the abstract is not enough; full text is available only for indexed papers.\n" +
			"`k` controls the passage count and requires `query`.\n" +
			"Returns the paper metadata plus its top matching passages with similarity scores.",
		approval: "read",
		parameters: readPaperParameters,
		run: ({ id, query, k }, signal) => {
			if (k !== undefined && query === undefined) {
				throw new ToolError("firecrawl_research_read_paper: `k` is only valid together with `query` — set `query` or remove `k`");
			}
			return withAbort(
				query === undefined ? api().research.getPaper(id) : api().research.getPaper(id, { query, k }),
				signal,
			);
		},
	});

	const relatedPapersParameters = z.object({
		id: z
			.string()
			.describe(
				"Primary seed paper reference: a canonical `paperId`, or a namespaced id key such as `pmid:<id>`, `pmcid:<id>`, `doi:<doi>` or `arxiv:<id>`.",
			),
		intent: z
			.string()
			.describe("Natural-language intent used to semantically rerank candidates. Required."),
		mode: z
			.enum(["similar", "citers", "references"])
			.describe("Traversal mode (default `similar`).")
			.optional(),
		k: z.number().describe("Number of related papers to return (1–500, default 40).").optional(),
		rerank: z.boolean().describe("Apply an additional ZeroEntropy rerank over the fused candidates.").optional(),
		anchor: z
			.array(z.string())
			.describe("Additional seed paper reference(s), same format as `id`; first ID is the primary seed.")
			.optional(),
	});

	defineTool(pi, {
		name: "firecrawl_research_related_papers",
		label: "Firecrawl research related papers",
		description:
			"Find related papers through the citation graph of the `id` seed plus optional `anchor` seeds.\n" +
			"`mode` picks the traversal: `similar` (default, co-citation/coupling), `citers` (papers citing the seeds), `references` (their bibliographies).\n" +
			"`intent` is required and reranks candidates semantically.\n" +
			"Returns ranked candidates with `signals`, plus `poolSize` and `truncated`.",
		approval: "read",
		parameters: relatedPapersParameters,
		run: ({ id, intent, ...rest }, signal) => {
			if (!intent || !intent.trim()) {
				throw new ToolError(
					"firecrawl_research_related_papers: `intent` is required — describe in natural language what kind of related work you want; it reranks the candidates",
				);
			}
			const options: SimilarPapersOptions = { intent, ...rest };
			return withAbort(api().research.similarPapers(id, options), signal);
		},
	});
}
