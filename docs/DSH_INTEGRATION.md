# DeepSeek Harness (DSH) × Claudian — 集成说明

本 fork 在 Claudian（v2.1.3，base `e707f1c`）上新增 **DeepSeek Harness（DSH）** 聊天引擎，并在过程中修复了两个通用 ACP 集成缺口。已在 macOS + Obsidian 上实跑验证。

## 架构

```
Obsidian (Claudian 插件, 本 fork + dsh provider)
  └─ spawn: dsh --profile bridge --config <vault>/.claudian/dsh/execution/<id>/config.json
       └─ DSH 桥接进程 (dsh-bridge/, ACP v1, JSON-RPC over stdio)
            └─ DSH Agent/Session 核心 (dsh-base: deepseek-official 模型、
               bash/read/write/glob/grep 工具、plan mode、会话持久化 ~/.dsh/sessions)
```

- **Claudian 侧**：`src/providers/dsh/`（以 opencode provider 为模板的移植，16 文件），复用 `src/providers/acp/` 的现成 ACP 客户端，**ACP 层零改动**。
- **DSH 侧**：`dsh-bridge/`，一个 dsh profile bundle（ACP v1 服务端：`session/new|load|prompt|cancel|set_model|set_mode|set_config_option` + `session/update` 通知流 + `session/request_permission` 审批转发）。

## 能力映射

| 维度 | 实现 |
|:----|:----|
| 模型 | `deepseek-v4-pro` / `deepseek-v4-flash`（provider `deepseek-official`，凭据走 `~/.dsh/.credentials.yaml`） |
| 模式 | **DSH Agent 预设**（标准/极简/PTC/创造）→ ACP mode 选择器（新增下拉支持）；权限维度（yolo/safe/plan）独立走 `permission` 配置项，与预设正交 |
| 思考等级 | `default` / `off` / `high` / `max`（DeepSeek 适配器只认这三档 + 不设） |
| 待办 | DSH `todo/write` → ACP `plan` 通知 → 合成 TodoWrite 投影（见通用修复 1） |
| 审批 | safe 模式沙箱越权 → `session/request_permission` → Claudian UI；yolo 自动放行；plan 进 DSH plan mode |
| 会话 | DSH Session 持久化于 `~/.dsh/sessions`，跨进程/跨 Obsidian 重启可恢复；重开对话由 `DshHistoryStore`（fzstd 纯 JS 解压）水合历史 |

## 通用修复（不限于 dsh，任何 ACP provider 受益）

1. **ACP `plan` 通知无人消费**（`src/providers/acp/AcpExecutionEventNormalizer.ts`）：把 `plan.entries` 投影为合成 TodoWrite 工具事件（`{content, status, activeForm: content}`——`activeForm` 是 todo 解析器的必填项），复用现有 todo 状态机，对话卡片与输入栏上方的状态面板同时点亮。合成 toolCallId 每次 run 稳定，后续快照走输入合并路径刷新。
2. **ModeSelector 只支持二选一开关**（`src/features/chat/ui/InputToolbar.ts`）：`options > 2` 时渲染原生下拉框（`claudian-mode-select`），二选一场景行为不变。

## 安装（Mac）

前置：Node 20+、pnpm、Obsidian + Claudian 插件、DeepSeek 凭据（`~/.dsh/.credentials.yaml`）。

```bash
# 1. DSH CLI + 桥接 profile
npm i -g @deepseek-ai/dsh@0.1.0-rc.6
dsh plugin --profile bridge add "file:<本仓库>/dsh-bridge"
# 确认 ~/.dsh/profiles/bridge/package.json 的 dsh.profile.bundles 含 "dsh-claudian-bridge"

# 2. 构建插件
npm ci && npm run build

# 3. 安装到 vault（备份 + node --check + 拷贝）
bash dsh-bridge/install-claudian-plugin.sh
# 在 Obsidian 中禁用再启用 Claudian 插件
```

- 改桥接源码后需重跑 `dsh plugin --profile bridge add`（pnpm `file:` 依赖为副本，非软链）。
- Windows：DSH CLI 与 profile 同样可装，settings 的 cliPathsByHost 可指定路径；未实测。

## 验证

- `npm run typecheck` / `npm run build` 零错误
- 单测：`tests/unit/providers/acp/AcpPlanTodo.test.ts`（plan→TodoWrite 投影 + 合成 id 稳定性）
- 桥接包伪 ACP 客户端冒烟测试（`dsh-bridge/test/*.mjs`）：全流程事件流、safe 模式审批转发、跨进程会话恢复、预设工具集隔离（minimal 仅 bash + str_replace_editor）

## 已知限制（MVP）

- safe 语义：DSH 审批只挂在沙箱越权升级上（vault 内读写不打扰，越界写才问），比 Claude Code 的 safe 宽松
- plan 模式：经模式切换器进/出；DSH 的 `exit_plan_mode` 在桥接环境无评审通道
- 图片附件未启用；标题生成可能回落到 settings provider
- 预设创建后固定（与 DSH 语义一致），切换预设请开新对话
- 会话历史水合默认读 `$DSH_HOME/sessions`（DSH_HOME 未设时 `~/.dsh/sessions`）

## 致谢

感谢 [YishenTu](https://github.com/YishenTu) 的 Claudian 及其干净可复用的 ACP 客户端抽象；感谢 DeepSeek Harness 团队的可编程核心（dsh-base / dsh-headless / agent-presets）。
