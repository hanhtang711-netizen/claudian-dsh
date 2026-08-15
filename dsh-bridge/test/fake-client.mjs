// Standalone ACP client used to smoke-test the bridge without Claudian.
// Usage: node test/fake-client.mjs [--config <bridge-config.json>]
// Spawns `dsh --profile bridge --config ...`, then drives one turn.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.env.DSH_BIN ?? "dsh";
const VAULT = process.env.VAULT ?? process.cwd();
const TASK = process.env.TASK ?? "用 bash 运行 `pwd` 并打印结果，不要做别的事。";

const configPath = join(tmpdir(), `dsh-bridge-config-${Date.now()}.json`);
writeFileSync(configPath, JSON.stringify({
	systemPromptPath: "",
	vaultPath: VAULT,
	version: 1,
}));

const child = spawn(BIN, ["--profile", "bridge", "--config", configPath], {
	cwd: VAULT,
	stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[bridge-stderr] ${d}`));

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
let nextId = 1;
const pending = new Map();
const seen = {};

rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
		const p = pending.get(msg.id);
		if (p) { pending.delete(msg.id); p.resolve(msg); }
	} else if (msg.method === "session/update") {
		const kind = msg.params.update.sessionUpdate;
		seen[kind] = (seen[kind] ?? 0) + 1;
		if (kind === "agent_message_chunk") {
			process.stdout.write(msg.params.update.content?.text ?? "");
		} else if (kind === "tool_call") {
			process.stdout.write(`\n[tool: ${msg.params.update.title}]\n`);
		}
	}
});

function request(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
}

try {
	const init = await request("initialize", { protocolVersion: 1, clientInfo: { name: "fake-client", version: "0" } });
	console.log("initialize:", JSON.stringify(init.result));

	const created = await request("session/new", { cwd: VAULT, mcpServers: [] });
	console.log("session/new:", JSON.stringify(created.result));
	const sessionId = created.result.sessionId;

	await request("session/set_mode", { sessionId, modeId: "claudian-yolo" });
	await request("session/set_model", { sessionId, modelId: "deepseek-v4-flash" });

	console.log("--- prompt stream ---");
	const prompt = await request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: TASK }],
	});
	console.log("\n--- prompt response ---");
	console.log(JSON.stringify(prompt.result));
	console.log("--- update kinds seen ---");
	console.log(JSON.stringify(seen));

	const loaded = await request("session/load", { sessionId, cwd: VAULT, mcpServers: [] });
	console.log("session/load ok:", loaded.result.sessionId === sessionId);

	child.stdin.end();
	setTimeout(() => { child.kill(); process.exit(0); }, 500);
} catch (error) {
	console.error("fake-client failed:", error);
	child.kill();
	process.exit(1);
}
