// DSH agent/session lifecycle behind the ACP server: one bridge process owns
// any number of sessions; each session is a DSH Agent whose log persists to
// ~/.dsh/sessions (session-persistence-jsonl in dsh-base), so a later bridge
// process can resume it via `agents.resume`.
//
// New sessions are created LAZILY: `session/new` only records the requested
// configuration, and the Agent is built at the first prompt — after Claudian
// has applied model/effort/permission/preset selects — so the DSH agent
// preset (standard/minimal/code/cordis) is fixed correctly at creation.

import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

export const PROVIDER = "deepseek-official";

export const MODELS = [
	{ id: "deepseek-flash", label: "DeepSeek V41 Flash" },
	{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

const EFFORTS = ["default", "off", "high", "max"];
const DEFAULT_MODEL = "deepseek-flash";
/** Raster formats the harness attachment store admits for prompt images. */
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Fallback preset catalog when the agentPresets service is unavailable. */
export const PRESET_FALLBACKS = [
	{ id: "standard", name: "标准模式" },
	{ id: "minimal", name: "极简模式" },
	{ id: "code", name: "PTC 模式" },
	{ id: "cordis", name: "创造模式" },
];
export const DEFAULT_PRESET = "standard";

/** Bridge-side note mapping Claudian's Claude-Code-flavored prompt to DSH tools. */
const TOOL_MAP_SECTION = `## Tool Mapping

You are running on DeepSeek Harness, not Claude Code. The system prompt above
may mention Claude Code tool names; use your actual tools instead:

- \`Read file_path=...\` -> read tool
- \`Write\` / \`Edit\` (apply_patch style) -> write / edit tools
- \`Bash\` / bash blocks -> bash tool
- \`Glob\` / \`Grep\` -> glob / grep tools
- \`TodoWrite\` -> todo_write tool
- \`WebFetch\` -> web_search / web_extract

Vault files live under the session working directory; always use relative paths
inside the vault.`;

export class BridgeSessionManager {
	constructor(ctx, { systemText, log }) {
		this.ctx = ctx;
		this.systemText = systemText;
		this.log = log;
		this.sessions = new Map();
		this.presetList = null;
		this.models = null;
		this.modelsReady = null;
	}

	/** Live model catalog from the llm service; static list until it resolves. */
	modelEntries() {
		return this.models ?? MODELS;
	}

	/** Refresh the model catalog once; safe to await from any async path. */
	ensureModels() {
		if (!this.modelsReady) this.modelsReady = this.refreshModels();
		return this.modelsReady;
	}

	async refreshModels() {
		const llm = this.ctx.get("llm");
		if (!llm || typeof llm.listModels !== "function") return;
		try {
			const listed = await llm.listModels(PROVIDER);
			if (Array.isArray(listed) && listed.length > 0) {
				this.models = listed.map((m) => ({
					id: String(m.id),
					label: String(m.name ?? m.id),
				}));
				this.log("model catalog:", this.models.map((m) => m.id).join(", "));
			}
		} catch (error) {
			this.log("model catalog unavailable, keeping static list:", error?.message ?? error);
		}
	}

	/** True when one exact model route declares image input. */
	async supportsImageForModel(modelId) {
		const attachments = this.ctx.get("attachments");
		if (!attachments) return false;
		const limits = attachments.imageLimits;
		if (!limits || !Array.isArray(limits.mediaTypes)) return false;
		if (!limits.mediaTypes.some((mediaType) => IMAGE_MEDIA_TYPES.includes(mediaType))) return false;
		const llm = this.ctx.get("llm");
		if (!llm || typeof llm.resolveModelInfo !== "function") return false;
		try {
			const info = await llm.resolveModelInfo(PROVIDER, modelId);
			return info?.inputModalities?.includes("image") === true;
		} catch (error) {
			this.log("image capability check failed for", modelId, ":", error?.message ?? error);
			return false;
		}
	}

	/** True when this deployment can truthfully advertise inline image prompts. */
	async supportsImagePrompts() {
		return this.supportsImageForModel(this.modelEntries()[0]?.id ?? DEFAULT_MODEL);
	}

	/** Validate one ACP image block into a save-ready attachment. */
	decodeImage(block) {
		const mediaType = String(block.mimeType ?? "").trim().toLowerCase();
		if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
			throw Object.assign(new Error(`image mimeType must be one of ${IMAGE_MEDIA_TYPES.join(", ")}`), { code: -32602 });
		}
		const data = String(block.data ?? "").trim();
		if (data === "") {
			throw Object.assign(new Error("image data is required"), { code: -32602 });
		}
		const bytes = Buffer.from(data, "base64");
		if (bytes.length === 0 || bytes.toString("base64") !== data) {
			throw Object.assign(new Error("image data must be canonical base64"), { code: -32602 });
		}
		const name = typeof block.name === "string" && block.name.trim() !== "" ? block.name.trim() : undefined;
		return name === undefined ? { data: bytes, mediaType } : { data: bytes, mediaType, name };
	}

	find(rawId) {
		return this.sessions.get(rawId);
	}

	findEntryForAgent(agent) {
		for (const entry of this.sessions.values()) {
			if (entry.agent === agent) return entry;
		}
		return undefined;
	}

	async ensurePresetList() {
		if (this.presetList) return this.presetList;
		const presets = this.ctx.get("agentPresets");
		if (presets && typeof presets.list === "function") {
			try {
				const listed = await presets.list();
				if (Array.isArray(listed) && listed.length > 0) {
					this.presetList = listed.map((p) => ({
						id: String(p.id ?? p.name ?? ""),
						name: String(p.name ?? p.id ?? ""),
					})).filter((p) => p.id !== "");
					return this.presetList;
				}
			} catch (error) {
				this.log("preset list failed, using fallbacks:", error);
			}
		}
		this.presetList = PRESET_FALLBACKS;
		return this.presetList;
	}

	presetEntries() {
		return this.presetList ?? PRESET_FALLBACKS;
	}

	isValidPreset(id) {
		return this.presetEntries().some((p) => p.id === id);
	}

	makeSelection(model, effort) {
		const entries = this.modelEntries();
		const fallback = entries.some((m) => m.id === DEFAULT_MODEL)
			? DEFAULT_MODEL
			: entries[0]?.id ?? DEFAULT_MODEL;
		const current = { provider: PROVIDER, model: model ?? fallback };
		if (effort && effort !== "default") current.reasoningEffort = effort;
		return { current, assembled: undefined };
	}

	setupFor(agentCtx, selection) {
		if (this.systemText) {
			agentCtx.systemPrompt.section({
				name: "deployment:persona",
				order: 0,
				text: this.systemText,
			});
		}
		agentCtx.systemPrompt.section({
			name: "claudian:tool-map",
			order: 10,
			text: TOOL_MAP_SECTION,
		});
		return installModelSelection(agentCtx, selection);
	}

	/** Mount the DSH agent preset (the session's tool/prompt composition). */
	async mountPreset(agentCtx, presetId) {
		const presets = this.ctx.get("agentPresets");
		if (!presets || typeof presets.mount !== "function") {
			this.log("agentPresets service unavailable; preset not mounted");
			return;
		}
		await presets.mount(agentCtx, presetId);
	}

	async createNew({ cwd, model, effort }) {
		const selection = this.makeSelection(model, effort);
		const sessionId = SessionId(`session-${randomUUID()}`);
		const entry = {
			sessionId,
			cwd,
			preset: DEFAULT_PRESET,
			selection,
			mode: "safe",
			agent: null,
			dispose: null,
			pending: 0,
			lastTurnReason: undefined,
		};
		this.sessions.set(String(sessionId), entry);
		return entry;
	}

	/** Build the DSH Agent for a lazily-created session (first prompt). */
	async ensureAgent(entry) {
		if (entry.agent) return;
		const agents = this.ctx.get("agents");
		if (!agents) throw new Error("agents service unavailable");
		const preset = entry.preset;
		const { agent, dispose } = await agents.create({
			sessionId: entry.sessionId,
			meta: { cwd: entry.cwd, agentPreset: preset },
			agentOptions: {
				provider: entry.selection.current.provider,
				model: entry.selection.current.model,
			},
			setup: async (agentCtx) => {
				await this.mountPreset(agentCtx, preset);
				this.setupFor(agentCtx, entry.selection);
			},
		});
		await agent.whenIdle();
		entry.agent = agent;
		entry.dispose = dispose;
		this.applyPlanMode(entry);
	}

	async resumeExisting({ sessionId, cwd, model, effort }) {
		const agents = this.ctx.get("agents");
		if (!agents) throw new Error("agents service unavailable");
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const selection = this.makeSelection(model, effort);
		// Read the persisted header to rejoin the session's own preset.
		let preset = DEFAULT_PRESET;
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence && typeof persistence.load === "function") {
			try {
				const inspection = await persistence.load(SessionId(sessionId));
				if (
					typeof inspection.meta.agentPreset === "string"
					&& inspection.meta.agentPreset !== ""
				) {
					preset = inspection.meta.agentPreset;
				}
			} catch (error) {
				this.log("preset inspection failed, resuming with default:", error);
			}
		}
		let handle;
		try {
			handle = await agents.resume({
				resumeSessionId: SessionId(sessionId),
				agentOptions: {
					provider: selection.current.provider,
					model: selection.current.model,
				},
				setup: async (agentCtx) => {
					// Resume joins the session's recorded preset composition.
					await this.mountPreset(agentCtx, preset);
					this.setupFor(agentCtx, selection);
				},
			});
		} catch (error) {
			this.log("resume failed", error);
			throw Object.assign(new Error("Session not found"), { code: -32001 });
		}
		await handle.agent.whenIdle();
		const entry = {
			sessionId: SessionId(sessionId),
			cwd: cwd ?? handle.agent.session.header.cwd,
			preset,
			selection,
			mode: "safe",
			agent: handle.agent,
			dispose: handle.dispose,
			pending: 0,
			lastTurnReason: undefined,
		};
		this.sessions.set(sessionId, entry);
		return entry;
	}

	async runTurn(entry, text, images = []) {
		entry.lastTurnReason = undefined;
		await this.ensureAgent(entry);
		const content = [];
		if (text !== "") content.push({ type: "text", text });
		if (images.length > 0) {
			const attachments = this.ctx.get("attachments");
			if (!attachments || typeof attachments.saveImages !== "function") {
				throw Object.assign(new Error("no attachment store is mounted"), { code: -32602 });
			}
			const refs = await attachments.saveImages(images);
			for (const ref of refs) content.push({ type: "image", attachment: ref });
		}
		entry.agent.followup(createUserMessage({
			content,
			source: { kind: "user" },
		}));
		await entry.agent.whenIdle();
	}

	cancel(entry) {
		entry.agent?.cancel({ kind: "user" });
	}

	setMode(entry, modeId) {
		let mode = modeId;
		if (modeId === "claudian-yolo") mode = "yolo";
		else if (modeId === "claudian-safe" || modeId === "normal") mode = "safe";
		else if (modeId === "claudian-plan") mode = "plan";
		if (mode !== "yolo" && mode !== "safe" && mode !== "plan") return;
		entry.mode = mode;
		this.applyPlanMode(entry);
	}

	applyPlanMode(entry) {
		if (!entry.agent) return;
		// Resolve from the agent's own scoped world (preset-mounted service)
		// with a host-plane fallback for presets that carry no plan row.
		const planMode = entry.agent.ctx?.get("planMode")
			?? this.ctx.get("planMode");
		if (planMode) planMode.set(entry.agent, entry.mode === "plan");
	}

	setPreset(entry, presetId) {
		if (!this.isValidPreset(presetId)) return;
		if (entry.agent && presetId !== entry.preset) {
			// The preset decides the agent composition and is fixed per
			// session; ignore switches once the agent exists.
			this.log("preset switch ignored: session already created with", entry.preset);
			return;
		}
		entry.preset = presetId;
	}

	setModel(entry, model) {
		if (this.modelEntries().some((m) => m.id === model)) {
			entry.selection.current = { ...entry.selection.current, model };
		}
	}

	setEffort(entry, effort) {
		if (!EFFORTS.includes(effort)) return;
		const next = { ...entry.selection.current };
		if (effort === "default") {
			delete next.reasoningEffort;
		} else {
			next.reasoningEffort = effort;
		}
		entry.selection.current = next;
	}

	/** Wait until every queued event notification has been written out. */
	async drain(entry) {
		while (entry.pending > 0) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	async flush(entry) {
		if (!entry.agent) return;
		const sessions = this.ctx.get("sessions");
		if (sessions) await sessions.flush(entry.agent.session);
	}

	disposeAll() {
		for (const entry of this.sessions.values()) {
			try {
				entry.dispose?.();
			} catch (error) {
				this.log("dispose failed", error);
			}
		}
		this.sessions.clear();
	}
}
