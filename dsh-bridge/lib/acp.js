// ACP protocol layer: implements the server half of the Agent Client Protocol
// (v1, JSON-RPC over stdio) on top of the BridgeSessionManager, and maps DSH
// session events to `session/update` notifications for Claudian.
//
// Wire contract (mirrors Claudian's client, src/providers/acp):
//  - client→server: initialize, authenticate, session/new, session/load,
//    session/prompt (long-running), session/cancel (notification),
//    session/set_model, session/set_mode, session/set_config_option
//  - server→client: session/update notifications; session/request_permission
//    requests when the safe mode needs a decision.

import { MODELS } from "./session-manager.js";

const EFFORTS = [
	{ name: "Default", value: "default" },
	{ name: "Off", value: "off" },
	{ name: "High", value: "high" },
	{ name: "Max", value: "max" },
];
const CONTEXT_SIZE = 1000000;
const MAX_OUTPUT_CHARS = 200000;

export function kindForTool(name) {
	if (name === "bash" || name === "pwsh" || /terminal|exec|process/i.test(name)) return "execute";
	if (name === "edit" || name === "write" || /write|patch|apply/i.test(name)) return "edit";
	if (name === "read" || /^glob$|^grep$|read_|_read/i.test(name)) return "read";
	if (/search|find|query/i.test(name)) return "search";
	if (/fetch|web_search|web_extract|http/i.test(name)) return "fetch";
	if (name === "todo_write") return "other";
	return "other";
}

function extractToolResultText(message) {
	const parts = [];
	for (const block of message?.content ?? []) {
		if (typeof block.text === "string" && block.text !== "") parts.push(block.text);
		else if (typeof block.content === "string" && block.content !== "") parts.push(block.content);
		else if (typeof block.result === "string" && block.result !== "") parts.push(block.result);
		else if (block && typeof block === "object") {
			try {
				parts.push(JSON.stringify(block));
			} catch {
				// not serializable: skip
			}
		}
	}
	const text = parts.join("\n").trim();
	if (text === "") return "(no output)";
	return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : text;
}

export class AcpSessionBridge {
	constructor({ transport, manager, log }) {
		this.transport = transport;
		this.manager = manager;
		this.log = log;
	}

	notify(entry, update) {
		this.transport.notify("session/update", {
			sessionId: String(entry.sessionId),
			update,
		});
	}

	configOptions(entry) {
		return [
			{
				id: "model",
				category: "model",
				type: "select",
				name: "Model",
				currentValue: entry.selection.current.model,
				options: MODELS.map((m) => ({ name: m.label, value: m.id })),
			},
			{
				id: "mode",
				category: "mode",
				type: "select",
				name: "Agent preset",
				currentValue: entry.preset,
				options: this.manager.presetEntries().map((p) => ({
					name: p.name,
					value: p.id,
				})),
			},
			{
				id: "effort",
				category: "thought_level",
				type: "select",
				name: "Thought level",
				currentValue: entry.selection.current.reasoningEffort ?? "default",
				options: EFFORTS.map((e) => ({ name: e.name, value: e.value })),
			},
			{
				id: "permission",
				category: "permission",
				type: "select",
				name: "Permission",
				currentValue: entry.mode,
				options: [
					{ name: "Yolo", value: "yolo", description: "Run without asking" },
					{ name: "Safe", value: "safe", description: "Ask before risky actions" },
					{ name: "Plan", value: "plan", description: "Plan only, no changes" },
				],
			},
		];
	}

	/** Mark one event as being processed; callers await manager.drain after turns. */
	onEvent(session, event) {
		const entry = this.manager.find(String(session.id));
		if (!entry) return;
		entry.pending += 1;
		Promise.resolve()
			.then(() => {
				this.handleEvent(entry, event);
			})
			.catch((error) => {
				this.log("event mapping failure", error);
			})
			.finally(() => {
				entry.pending -= 1;
			});
	}

	handleEvent(entry, event) {
		const data = event.data ?? {};
		switch (event.type) {
			case "user/message": {
				if (data.source?.kind !== "user") return;
				const text = (data.content ?? [])
					.filter((block) => block && block.type === "text")
					.map((block) => block.text ?? "")
					.join("\n")
					.trim();
				if (text === "") return;
				this.notify(entry, {
					sessionUpdate: "user_message_chunk",
					messageId: `u-${event.seq}`,
					content: { type: "text", text },
				});
				return;
			}
			case "assistant/chunk": {
				const chunk = data.chunk ?? {};
				if (chunk.type === "text-delta" && chunk.text) {
					this.notify(entry, {
						sessionUpdate: "agent_message_chunk",
						messageId: `a-${data.turn}`,
						content: { type: "text", text: chunk.text },
					});
				} else if (chunk.type === "reasoning-delta" && chunk.text) {
					this.notify(entry, {
						sessionUpdate: "agent_thought_chunk",
						messageId: `a-${data.turn}`,
						content: { type: "text", text: chunk.text },
					});
				}
				return;
			}
			case "tool/call": {
				this.notify(entry, {
					sessionUpdate: "tool_call",
					toolCallId: data.callId,
					title: data.name,
					kind: kindForTool(data.name),
					status: "in_progress",
					rawInput: typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {}),
				});
				return;
			}
			case "tool/result": {
				this.notify(entry, {
					sessionUpdate: "tool_call_update",
					toolCallId: data.message?.source?.callId ?? "unknown",
					status: data.error ? "failed" : "completed",
					rawOutput: extractToolResultText(data.message),
				});
				return;
			}
			case "todo/write": {
				this.notify(entry, {
					sessionUpdate: "plan",
					entries: (data.todos ?? []).map((todo) => ({
						content: todo.content ?? "",
						priority: "medium",
						status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
					})),
				});
				return;
			}
			case "assistant/message": {
				if (data.usage) {
					this.notify(entry, {
						sessionUpdate: "usage_update",
						size: CONTEXT_SIZE,
						used: (data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0),
					});
				}
				return;
			}
			case "session/title": {
				if (data.title) {
					this.notify(entry, {
						sessionUpdate: "session_info_update",
						title: data.title,
						updatedAt: new Date().toISOString(),
					});
				}
				return;
			}
			case "turn/end": {
				if (data.reason?.kind === "aborted") entry.lastTurnReason = "cancelled";
				return;
			}
			default:
				return;
		}
	}

	/** Forward a safe-mode approval ask to Claudian and await its decision. */
	requestPermission(entry, req) {
		if (req.signal?.aborted === true) return Promise.resolve("cancelled");
		const id = String(req.callId ?? `approval-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
		return this.transport
			.request("session/request_permission", {
				sessionId: String(entry.sessionId),
				toolCall: {
					toolCallId: id,
					title: req.toolName,
					kind: kindForTool(req.toolName),
					status: "in_progress",
				},
				options: [
					{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
					{ optionId: "reject_once", name: "Reject once", kind: "reject_once" },
				],
			})
			.then((resp) => {
				const outcome = resp?.outcome?.outcome;
				if (outcome === "selected" && resp.outcome.optionId === "allow_once") return "allowed-once";
				if (outcome === "selected") return "rejected";
				return "cancelled";
			})
			.catch(() => "cancelled");
	}
}

export function registerAcpMethods({ transport, manager, bridge, log }) {
	transport.handle("initialize", async () => ({
		protocolVersion: 1,
		agentInfo: { name: "deepseek-harness", version: "0.1.0" },
		agentCapabilities: {
			loadSession: true,
			sessionCapabilities: { list: false, resume: false, close: false, fork: false },
			promptCapabilities: { image: false },
		},
		authMethods: [],
	}));

	transport.handle("authenticate", async () => ({}));

	transport.handle("session/new", async (params) => {
		const cwd = params.cwd;
		if (typeof cwd !== "string" || cwd === "") {
			throw Object.assign(new Error("cwd is required"), { code: -32602 });
		}
		await manager.ensurePresetList();
		const entry = await manager.createNew({ cwd });
		log("session/new ->", String(entry.sessionId));
		return {
			sessionId: String(entry.sessionId),
			configOptions: bridge.configOptions(entry),
		};
	});

	transport.handle("session/load", async (params) => {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string" || sessionId === "") {
			throw Object.assign(new Error("sessionId is required"), { code: -32602 });
		}
		await manager.ensurePresetList();
		const entry = await manager.resumeExisting({ sessionId, cwd: params.cwd });
		log("session/load ->", sessionId);
		return {
			sessionId,
			configOptions: bridge.configOptions(entry),
		};
	});

	transport.handle("session/list", async () => ({ sessions: [] }));

	transport.handle("session/prompt", async (params) => {
		const entry = manager.find(params.sessionId);
		if (!entry) {
			throw Object.assign(new Error("Session not found"), { code: -32001 });
		}
		const text = (params.prompt ?? [])
			.filter((block) => block && block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n\n")
			.trim();
		if (text === "") {
			return { stopReason: "end_turn", usage: null };
		}
		log("prompt ->", String(entry.sessionId), "(", text.length, "chars )");
		await manager.runTurn(entry, text);
		await manager.drain(entry);
		await manager.flush(entry);
		const cancelled = entry.lastTurnReason === "cancelled";
		log("prompt done, cancelled =", cancelled);
		return {
			stopReason: cancelled ? "cancelled" : "end_turn",
			usage: null,
			userMessageId: null,
		};
	});

	transport.handle("session/cancel", async (params) => {
		const entry = manager.find(params.sessionId);
		if (!entry) return;
		log("session/cancel ->", String(entry.sessionId));
		manager.cancel(entry);
	});

	transport.handle("session/set_model", async (params) => {
		const entry = manager.find(params.sessionId);
		if (!entry) {
			throw Object.assign(new Error("Session not found"), { code: -32001 });
		}
		const model = params.modelId ?? params.model ?? params.id;
		if (typeof model === "string") manager.setModel(entry, model);
		return { configOptions: bridge.configOptions(entry) };
	});

	transport.handle("session/set_mode", async (params) => {
		const entry = manager.find(params.sessionId);
		if (!entry) {
			throw Object.assign(new Error("Session not found"), { code: -32001 });
		}
		const modeId = params.modeId ?? params.mode ?? params.id;
		if (typeof modeId === "string") {
			manager.setMode(entry, modeId);
		}
		return { configOptions: bridge.configOptions(entry) };
	});

	transport.handle("session/set_config_option", async (params) => {
		const entry = manager.find(params.sessionId);
		if (!entry) {
			throw Object.assign(new Error("Session not found"), { code: -32001 });
		}
		const configId = String(params.configId ?? params.id ?? "").toLowerCase();
		const value = params.value;
		if (typeof value === "string") {
			if (configId === "model") manager.setModel(entry, value);
			else if (configId === "mode") manager.setPreset(entry, value);
			else if (configId === "permission") manager.setMode(entry, value);
			else if (configId === "effort" || configId === "thought_level") manager.setEffort(entry, value);
		}
		return { configOptions: bridge.configOptions(entry) };
	});
}
