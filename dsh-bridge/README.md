# dsh-claudian-bridge

DeepSeek Harness 的 ACP 桥：把 DSH 的核心 Agent/Session 以 **Agent Client Protocol v1**（JSON-RPC over stdio）暴露出来，让 Claudian（Obsidian 插件）像驱动 claude / codex / opencode 一样驱动 DSH。

- DSH 侧：本包是一个 dsh profile bundle（`cordis.patch.yml` + 两个插件），由 `dsh --profile bridge --config <path>` 启动。
- Claudian 侧：配套的 `dsh` provider 源码（fork 上游 YishenTu/claudian）负责 spawn 本桥、写会话配置、渲染事件流。

## 安装（本机一次）

```bash
# 1. 全局 dsh CLI（Claudian spawn 需要稳定入口）
npm i -g @deepseek-ai/dsh@0.1.0-rc.6

# 2. 建 profile 并装本包
dsh plugin --profile bridge add "file:<本目录绝对路径>"
# 把 dsh-claudian-bridge 加进 profile package.json 的 dsh.profile.bundles
# 初始 bundles: ["@deepseek-ai/dsh-base"] -> ["@deepseek-ai/dsh-base", "dsh-claudian-bridge"]
```

## 协议要点

- 会话即 DSH Session：`session/new` → `agents.create`，`session/load` → `agents.resume`（持久化在 `~/.dsh/sessions`，跨进程可恢复）。
- 模式映射：`claudian-yolo`→自动放行审批；`claudian-safe`→审批问询经 `session/request_permission` 转发给 Claudian UI；`plan`→DSH plan mode。
- 事件流：`turn/*`、`assistant/chunk`（text→`agent_message_chunk`，reasoning→`agent_thought_chunk`）、`tool/call`+`tool/result`→`tool_call`/`tool_call_update`、`todo/write`→`plan`、`session/title`→`session_info_update`。
- 模型：`deepseek-official` / `deepseek-v4-pro` / `deepseek-v4-flash`（凭据走 `~/.dsh/.credentials.yaml`）。
- stdout 只承载 JSON-RPC 帧；所有日志走 stderr。
