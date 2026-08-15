// Startup plugin: parse `--config <path>` from the launcher's inner argv and
// publish it as the `bridgeStartup` service (mirrors @deepseek-ai/dsh-headless/startup).
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

export const name = "bridge-startup";
export const inject = ["cmdlineArgs"];
export const BRIDGE_STARTUP_SERVICE = "bridgeStartup";

export function apply(ctx) {
	const program = new Command()
		.name("dsh --profile bridge")
		.description("DeepSeek Harness ACP server for Claudian (JSON-RPC over stdio)")
		.requiredOption("--config <path>", "path to the Claudian-written bridge config.json")
		.helpOption("-h, --help", "show this help");
	program.action(() => {
		const options = program.opts();
		if (!options.config) program.error("error: --config <path> is required");
		ctx.provide(BRIDGE_STARTUP_SERVICE, { configPath: options.config });
	});
	parseCmdline(ctx, program);
}
