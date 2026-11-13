/**
 * colgrep tools for omp — extension entry point.
 *
 * Two essential tools, no hooks, no settings overrides (`AGENTS.md` §2): the
 * rule in `rules/colgrep.md` carries the guidance, and bash grep stays
 * available for what colgrep does not cover.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCodeAgent } from "./tools/agent";
import { registerCodeSearch } from "./tools/search";

export default function colgrepExtension(pi: ExtensionAPI) {
	pi.setLabel("Colgrep Code Search");

	registerCodeSearch(pi);
	registerCodeAgent(pi);
}
