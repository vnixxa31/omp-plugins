/**
 * Firecrawl tools for omp — extension entry point.
 *
 * Scaffolding stage: this module is the load target declared in package.json
 * (`omp.extensions`) so the plugin can be linked/installed and verified end to
 * end before tool development starts. Tool modules (src/tools/*.ts) will be
 * registered here as they are implemented:
 *
 *   export default function (pi: ExtensionAPI) {
 *     registerScrapeTool(pi);
 *     registerSearchTool(pi);
 *     ...
 *   }
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function firecrawlExtension(pi: ExtensionAPI) {
	pi.setLabel("Firecrawl Tools");

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("Firecrawl plugin loaded (scaffold — no tools registered yet)", "info");
	});
}
