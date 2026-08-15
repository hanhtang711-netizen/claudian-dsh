// Safe-mode test: drives one turn that must escalate the file sandbox, and
// auto-answers the bridge's session/request_permission with allow_once.
// Expectation: the escalation is approved, the out-of-workspace write runs,
// and the turn completes with a tool_call that shows an approved result.

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.env.DSH_BIN ?? "dsh";
const VAULT = process.env.VAULT ?? process.cwd();
const TARGET = join(tmpdir(), `dsh-bridge-safe-${Date.now()}.txt`);

const configPath = join(tmpdir(), `dsh-bridge-config-${Date.now()}.json`);
writeFileSync(configPath, JSON.stringify({ systemPromptPath: "", vaultPath: VAULT, version: 1 }));

const child = spawn(BIN, ["--profile", "bridge", "--config", configPath], {
	cwd: VAULT,
	stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[bridge-stderr] ${d}`));

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
let nextId = 1;
const pending = new Map();
let permissionAsks = 0;

rl.on("line", (line) => {
	const msg = JSON.parse(line);
	if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
		const p = pending.get(msg.id);
		if (p) { pending.delete(msg.id); p.resolve(msg); }
		return;
	}
	if (msg.method === "session/update") {
		const kind = msg.params.update.sessionUpdate;
		if (kind === "agent_message_chunk") process.stdout.write(msg.params.update.content?.text ?? "");
		if (kind === "tool_call") process.stdout.write(`\n[tool: ${msg.params.update.title}]\n`);
		return;
	}
	if (msg.id !== undefined && msg.method === "session/request_permission") {
		permissionAsks += 1;
		console.log(`\n[permission asked: ${msg.params.toolCall.title}]`);
		child.stdin.write(JSON.stringify({
			jsonrpc: "2.0",
			id: msg.id,
			result: { outcome: { outcome: "selected", optionId: "allow_once" } },
		}) + "\n");
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
	await request("initialize", { protocolVersion: 1 });
	const created = await request("session/new", { cwd: VAULT, mcpServers: [] });
	const sessionId = created.result.sessionId;
	// leave mode at default (safe)

	const prompt = await request("session/prompt", {
		sessionId,
		prompt: [{
			type: "text",
			text: `用 bash 执行: echo "safe-mode-ok" > "${TARGET}"。命令会被沙箱拦截，请按提示用 sandbox_permissions=danger-full-access 重试。完成后用一句话确认。`,
		}],
	});
	console.log("\n--- response ---");
	console.log(JSON.stringify(prompt.result));
	console.log(`permission asks: ${permissionAsks}`);
	console.log(`target exists: ${existsSync(TARGET)}`);
	if (existsSync(TARGET)) console.log(`target content: ${readFileSync(TARGET, "utf8").trim()}`);

	child.stdin.end();
	setTimeout(() => { child.kill(); process.exit(permissionAsks > 0 && existsSync(TARGET) ? 0 : 1); }, 500);
} catch (error) {
	console.error("fake-client-safe failed:", error);
	child.kill();
	process.exit(1);
}
