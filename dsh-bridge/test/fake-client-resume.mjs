// Cross-process resume test: turn 1 in bridge process A, then kill A, spawn
// bridge process B and session/load the same id — the second turn must
// remember the first (persistence-backed agents.resume, ~/.dsh/sessions).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = process.env.DSH_BIN ?? "dsh";
const VAULT = process.env.VAULT ?? process.cwd();
const configPath = join(tmpdir(), `dsh-bridge-config-${Date.now()}.json`);
writeFileSync(configPath, JSON.stringify({ systemPromptPath: "", vaultPath: VAULT, version: 1 }));

function boot() {
	const child = spawn(BIN, ["--profile", "bridge", "--config", configPath], {
		cwd: VAULT,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.on("data", (d) => process.stderr.write(`[bridge-stderr] ${d}`));
	const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
	let nextId = 1;
	const pending = new Map();
	const text = [];
	rl.on("line", (line) => {
		const msg = JSON.parse(line);
		if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			const p = pending.get(msg.id);
			if (p) { pending.delete(msg.id); p.resolve(msg); }
		} else if (msg.method === "session/update" && msg.params.update.sessionUpdate === "agent_message_chunk") {
			text.push(msg.params.update.content?.text ?? "");
		}
	});
	const request = (method, params) => {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	};
	return { child, request, text };
}

const CODEWORD = `codeword-${Date.now()}`;
try {
	const a = boot();
	await a.request("initialize", { protocolVersion: 1 });
	const created = await a.request("session/new", { cwd: VAULT, mcpServers: [] });
	const sessionId = created.result.sessionId;
	await a.request("session/set_mode", { sessionId, modeId: "claudian-yolo" });
	await a.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: `记住这个暗号：${CODEWORD}。以后我问你暗号，你只回答暗号本身。` }],
	});
	console.log("turn1 text:", a.text.join("").slice(0, 120).replace(/\n/g, " "));
	a.child.stdin.end();
	a.child.kill();
	await new Promise((r) => setTimeout(r, 800));

	const b = boot();
	await b.request("initialize", { protocolVersion: 1 });
	const loaded = await b.request("session/load", { sessionId, cwd: VAULT, mcpServers: [] });
	console.log("load ok:", loaded.result.sessionId === sessionId);
	await b.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "暗号是什么？只回答暗号本身。" }],
	});
	const reply = b.text.join("").trim();
	console.log("turn2 text:", reply);
	b.child.stdin.end();
	b.child.kill();
	process.exit(reply.includes(CODEWORD) ? 0 : 1);
} catch (error) {
	console.error("resume test failed:", error);
	process.exit(1);
}
