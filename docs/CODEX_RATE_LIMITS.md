# Codex 账户额度面板 × Claudian — 行为与排障说明

本 fork 在 Claudian 上新增 **Codex 账户额度（rate-limit）面板**：输入区下方实时显示当前 Codex 账号各限流窗口的用量（5 小时 / 本周 / 本月），账户级信息，与当前激活的 provider 无关。已在 macOS + Obsidian 上实跑验证。

相关源码：`src/providers/codex/runtime/CodexRateLimit{Reader,Service,Store,..}.ts`（读取与状态）+ `src/features/chat/ClaudianView.ts`（面板装配与渲染）。

## 架构

```
Obsidian (Claudian 插件, 本 fork)
  ├─ 60s setInterval 轮询 ──┐
  ├─ 手动刷新按钮 ──────────┤→ CodexRateLimitService.refresh()
  │                          └→ CodexRateLimitReader.read()
  │                              ├─ spawn 临时进程: codex app-server --listen stdio://
  │                              ├─ JSON-RPC: initialize → account/rateLimits/read
  │                              └─ shutdown（finally，单次读取生命周期 <2s）
  ├─ 活跃 codex 会话的 account/rateLimits/updated 通知 → mergeFromPayload（实时合并）
  └─ CodexRateLimitStore（单例）→ 面板 subscribe 渲染
```

每次读取都从后端**实时**取数（不是缓存）：临时 app-server 进程通过 codex 账号登录态访问 `https://chatgpt.com/backend-api/wham/usage`。

## 刷新途径

| 途径 | 频率 | 说明 |
|:----|:----|:----|
| 自动轮询 | 每 60 秒 | `ClaudianView.startCodexRateLimitDashboard` 中 `setInterval(..., 60_000)` |
| 手动刷新 | 点击按钮 | 立即读一次；会 abort 在途轮询（由 revision + AbortController 保证不并发） |
| 会话通知 | 实时 | codex 会话每个 turn 后推送 `account/rateLimits/updated`，携带最新快照，即时合并 |

## UI 语义

- **ready**：每窗口渲染 `标签 剩 X%`（如 `5小时 剩 7%`）；severity 按剩余量分 normal/warning/critical 着色
- **已满**：剩余 0% 且带 `resetsAt` 时显示 `标签 已满 · HH:MM 重置`（避免裸 "0% 剩余" 被误读）
- **悬浮标题**：`已用 X% · 预计重置：<本地时间>`
- **暂不可读取**：仅当**连续 2 次轮询失败**后显示（`UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES = 2`）。单次瞬时失败保留最后一次已知数据，不闪烁；一次成功即清零计数

## 语义边界（不是 bug 的现象）

- **显示 100% / 已满**：后端实时整数百分比原样呈现。5 小时滚动窗口被填满、或子限流 429 时后端确实报 100%——是真实状态，非显示层换算错误（曾排查确认：官方 codex-rs 的 `account/rateLimits/read` 每次实时调用后端 `get_rate_limits_with_reset_credits()`，`used_percent` 无客户端换算）。
- **读到的数字滞后 ≤60s**（轮询粒度）；跑会话时通知会补上实时性。

## 已修复的历史缺陷（本 fork）

| 缺陷 | 现象 | 修复 |
|:----|:----|:----|
| credits-only 通知清窗 | 会话中面板闪"暂不可读取" | `mergeCodexRateLimitPayload`：通知快照无窗口数据（`primary: null`）时保留上次已知 windows |
| 瞬态失败即置不可用 | 单次轮询 hiccup（冷启动/竞争/后端超时）→ 抹掉好数据闪烁 60s+ | service 侧连续失败计数，≥2 次才置 unavailable |
| abort 竞态清数据 | 手动刷新覆盖在途轮询 / 视图关闭时，被 abort 的读取走静默 early-return，把 store 打成 unavailable | `refresh()` 对 `signal.aborted` 的读取一律不改 store |

## 网络前提（重要，macOS 实测）

`account/rateLimits/read` 实时访问 **`https://chatgpt.com/backend-api/wham/usage`**，网络不可达时读不到（codex 错误：`failed to fetch codex rate limits: error sending request for url ...`）。

关键坑：**Obsidian 是 GUI 应用**，从 Dock/Launchpad 启动时不继承 shell（`~/.zshrc`）里的 `HTTPS_PROXY` 等环境变量 → 插件拉起的 codex 进程裸连。若代理客户端未开系统级接管（TUN），直连 `chatgpt.com` 会超时 → 面板"暂不可读取"（表现为间歇性——取决于代理客户端状态）。

解法（择一）：

1. **代理客户端开 TUN / 增强模式（推荐）**：系统路由层接管流量，GUI 应用无需任何代理配置，所有 app 受益。
2. **provider 环境变量**：Claudian 设置 → Codex → 环境变量加入 `HTTPS_PROXY=http://127.0.0.1:<port>`（含 `NO_PROXY` 排除本地），只作用于 codex 流量。

诊断速查：

```bash
# 连通性（401 = 通，只是没带 token，属正常；超时 = 网络问题）
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" --connect-timeout 5 https://chatgpt.com/backend-api/wham/usage
# 无代理 env 的 shell 里测试（模拟 GUI 环境）
env -i HOME=$HOME PATH=$PATH curl -s -o /dev/null -w "%{http_code}\n" --connect-timeout 5 https://chatgpt.com/backend-api/wham/usage
```

## 已知事项

- codex 0.144+ 的 `~/.codex/config.toml` 中 `[agents] default_subagent_model` 若写成裸字符串会报 `configWarning: invalid type: string "...", expected struct AgentRoleToml`，codex 整体退回 "using defaults"。**不影响额度读取**，但 subagent 模型配置不生效（需 struct 格式）。
- 额度读取依赖 codex 登录态（`~/.codex/auth.json`），登录过期时同样表现为读取失败。
