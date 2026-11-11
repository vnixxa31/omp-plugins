/**
 * Firecrawl tools for omp — extension entry point.
 *
 * One registration call per tool family; no tool logic lives here. Families
 * land over successive sessions (AGENTS.md §4), so `src/index.ts` grows one
 * import per shipped module and contains nothing else.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerAgentTools } from "./tools/agent";
import { registerAlexandriaTools } from "./tools/alexandria";
import { registerContentTools } from "./tools/content";
import { registerDeveloperTools } from "./tools/developer";
import { registerInteractTools } from "./tools/interact";
import { registerMonitorTools } from "./tools/monitor";
import { registerOpsTools } from "./tools/ops";
import { registerResearchTools } from "./tools/research";

export default function firecrawlExtension(pi: ExtensionAPI) {
	pi.setLabel("Firecrawl Tools");

	registerContentTools(pi);
	registerDeveloperTools(pi);
	registerAlexandriaTools(pi);
	registerMonitorTools(pi);
	registerResearchTools(pi);
	registerAgentTools(pi);
	registerInteractTools(pi);
	registerOpsTools(pi);
}
