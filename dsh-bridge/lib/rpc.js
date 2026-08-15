// Minimal JSON-RPC 2.0 transport over newline-delimited JSON on stdio.
// stdout carries ONLY protocol frames; every diagnostic goes to stderr.

import { createInterface } from "node:readline";

export class RpcTransport {
	constructor({ input, output, log }) {
		this.output = output;
		this.log = log;
		this.nextId = 1;
		this.pending = new Map();
		this.methods = new Map();
		this.closed = false;
		this.onClose = null;
		this.rl = createInterface({ input, crlfDelay: Infinity });
		this.rl.on("line", (line) => {
			this.handleLine(line);
		});
		input.on("close", () => {
			this.closed = true;
			for (const entry of this.pending.values()) {
				entry.reject(new Error("transport closed"));
			}
			this.pending.clear();
			if (this.onClose) this.onClose();
		});
	}

	/** Register a client→server method handler. */
	handle(method, fn) {
		this.methods.set(method, fn);
	}

	handleLine(line) {
		const text = line.trim();
		if (text === "") return;
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			this.log("ignoring non-JSON stdin line");
			return;
		}
		this.dispatch(msg).catch((error) => {
			this.log("dispatch failure", error);
		});
	}

	async dispatch(msg) {
		if (typeof msg.method === "string" && msg.id !== undefined) {
			const fn = this.methods.get(msg.method);
			if (!fn) {
				this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
				return;
			}
			try {
				const result = await fn(msg.params ?? {});
				this.send({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result });
			} catch (error) {
				this.send({
					jsonrpc: "2.0",
					id: msg.id,
					error: {
						code: typeof error.code === "number" ? error.code : -32000,
						message: error && error.message ? error.message : String(error),
					},
				});
			}
		} else if (typeof msg.method === "string" && msg.id === undefined) {
			const fn = this.methods.get(msg.method);
			if (fn) {
				try {
					await fn(msg.params ?? {});
				} catch (error) {
					this.log("notification handler failure", error);
				}
			}
			// Unknown notifications are dropped per JSON-RPC semantics.
		} else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			this.pending.delete(msg.id);
			if (msg.error !== undefined) {
				entry.reject(Object.assign(new Error(msg.error.message ?? "rpc error"), { code: msg.error.code }));
			} else {
				entry.resolve(msg.result);
			}
		}
	}

	send(obj) {
		if (this.closed) return;
		this.output.write(`${JSON.stringify(obj)}\n`);
	}

	notify(method, params = {}) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** Server→client request; resolves with the client's `result`. */
	request(method, params = {}, timeoutMs = 0) {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			if (timeoutMs > 0) {
				setTimeout(() => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						reject(new Error(`rpc request timeout: ${method}`));
					}
				}, timeoutMs);
			}
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}
}
