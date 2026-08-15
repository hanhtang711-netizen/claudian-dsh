// bridge-acp: the app plugin. Boots the JSON-RPC/stdio transport, loads the
// Claudian-written config (system prompt), and wires DSH sessions, events,
// and the approval answerer into the ACP protocol.
//
// stdout carries ONLY JSON-RPC frames; diagnostics go to stderr.

import { readFileSync } from "node:fs";
import { BRIDGE_STARTUP_SERVICE } from "./startup.js";
import { RpcTransport } from "./rpc.js";
import { BridgeSessionManager } from "./session-manager.js";
import { AcpSessionBridge, registerAcpMethods } from "./acp.js";

export const name = "bridge-acp";
export const inject = ["bridgeStartup"];

export function apply(ctx) {
	const startup = ctx[BRIDGE_STARTUP_SERVICE];
	const configPath = startup.configPath;

	const log = (...args) => {
		try {
			process.stderr.write(
				`[dsh-bridge] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
			);
		} catch {
			// stderr is best-effort
		}
	};

	let config = {};
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		log("config unreadable, continuing with defaults:", error.message);
	}

	let systemText = "";
	if (typeof config.systemPromptPath === "string" && config.systemPromptPath !== "") {
		try {
			systemText = readFileSync(config.systemPromptPath, "utf8");
		} catch (error) {
			log("system prompt unreadable:", error.message);
		}
	}

	const manager = new BridgeSessionManager(ctx, { systemText, log });
	const transport = new RpcTransport({
		input: process.stdin,
		output: process.stdout,
		log,
	});
	const bridge = new AcpSessionBridge({ transport, manager, log });
	registerAcpMethods({ transport, manager, bridge, log });

	// On stdin close (Claudian disposed the kernel) request a clean exit.
	transport.onClose = () => {
		log("stdin closed, exiting");
		manager.disposeAll();
		const exit = ctx.get("appExit");
		if (exit) exit(0);
	};

	// Approval answerer: yolo auto-allows, plan rejects, safe asks Claudian.
	const approval = ctx.get("approval");
	if (approval !== undefined) {
		ctx.on("approval/request", (req, next) => {
			const entry = manager.findEntryForAgent(req.agent);
			if (!entry) return next();
			if (entry.mode === "yolo") return Promise.resolve("allowed-once");
			if (entry.mode !== "safe") return Promise.resolve("rejected");
			return bridge.requestPermission(entry, req);
		});
	}

	// Stream every DSH session event into ACP session/update notifications.
	ctx.on("session/event", (session, event) => {
		bridge.onEvent(session, event);
	});

	log("bridge ready", configPath);
}
