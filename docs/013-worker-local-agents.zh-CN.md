# Worker 执行器接入本地子代理插件

本文记录 Worker 层执行器使用本机子代理插件的一轮迭代。目标：与指挥模式（`fleet-orchestrator`）使用同一批 DSH 子代理后端——`claude-code`、`codex`、`kimi`、`opencode`——让 Worker 能把一项可独立完成的工作交给外部 Agent，并把外部 Agent 当作能自己完成工作的同事。

## 1. 机制

DSH 的子代理插件在加载时注册全局工具，与预设无关：

| 插件 | 工具 |
| --- | --- |
| `@deepseek-ai/dsh-subagent-claude-code` | `subagent_claude_code` |
| `@deepseek-ai/dsh-subagent-codex` | `subagent_codex` |
| `@local/dsh-subagent-kimi` | `subagent_kimi` |
| `@local/dsh-subagent-opencode` | `subagent_opencode` |
| `@local/dsh-fleet` | `fleet`、`fleet_status` |

`src/app/sessions.ts` 的 `WORK_TOOLS` 现在包含这些工具名。Worker 的 `workOnly` 仍按“实际已注册”过滤，因此：

- 装载了对应插件的 profile 里，Worker 直接获得这些工具；
- 没装载的 profile 里，工具名找不到，自动省略，`dsh-superagent` 不需要依赖这些本地插件；
- 工具在 Worker 启动后才被插件管理器装载时，要新开一张工单或重启实例才可见。

`fleet` 与指挥模式一致，用于带 `dependsOn` 的跨后端步骤图；`subagent_*` 是单次委派，调用立即返回，完成通知唤醒 Worker。外部 Agent 每次调用都是一个一次性进程，看不到 Worker 的会话历史，也不能追问续聊。

## 2. Worker 行为

`prompts/work.md` 增加了委派约定：

- 把外部 Agent 当作能独立完成一项工作的同事，允许直接改代码；prompt 必须自包含：目标、确切路径、约束、验收条件、要跑的检查。
- 按分工选择：`claude-code`/`kimi` 做实现，`codex`/`opencode` 做独立评审，`kimi` 做研究与写作。
- 独立任务一次发出，等完成通知；`fleet` 是同步的，会占住 Worker 回合，长任务优先用直接工具。
- 外部 Agent 的报告只是声明，不是证据。结束后 Worker 要读真实 diff、跑相关检查、确认改动仍在工单范围内；提交、推送、PR 和最终报告仍由 Worker 负责。
- 外部 Agent 不得自行 commit/push、开/合 PR、关 issue 或访问其他工作区；不得把飞书私聊内容、凭据、其他仓库放进它的 prompt。
- 需要宿主记录运行、占用仓库写名额、检查超范围路径，或续接 codex/claude 会话时，用原有的 `orchestrator_agent`；插件工具不产生 `AgentRun` 记录，也不做超范围审批。

## 3. 权限与边界

插件工具使用各自插件的配置：本机 profile 里 claude-code 为 `bypassPermissions`，Kimi/OpenCode 的 ACP 后端为 `permission: allow`。它们以当前工单目录为 `cwd`，能在工作区读写并运行命令；文件访问边界由插件与 CLI 自身承担，不是 dsh-superagent 的 OS 沙箱。

插件工具不经过宿主交付链路，因此不会像 `orchestrator_agent` 那样记录运行、检查超范围写或持有写名额。共享 checkout 模式下，`workOnly` 的通用 `workRefusal` 仍会在另一张工单占用该 checkout 时拒绝所有工作工具，包括这些插件工具；worktree 模式下每张工单有自己的目录。工单范围的最终把关仍在 Worker 的 diff 复核和 `orchestrator_delivery`。

## 4. 配置

部署 profile 需要装载对应的子代理 bundle（`@deepseek-ai/dsh-subagent-claude-code`、`@deepseek-ai/dsh-subagent-codex`、`@local/dsh-subagent-kimi`、`@local/dsh-subagent-opencode`，以及可选的 `@local/dsh-fleet`）。本机 `desktop` profile 已经装载。CLI 的登录、额度、模型和代理仍由各插件/CLI 自己配置；某个后端不可用时，调用会返回插件自身的错误，Worker 应改用其他 route 或自己做。

## 5. 验证

- `tests/runtime.spec.ts` 断言 Worker 的工具白名单会透传插件工具，并在工单结束后拒绝调用。
- `tests/model-surface.spec.ts` 的 Worker 字符预算已按新增委派段调整并说明原因。
- 真实插件调用依赖运行中的 profile 装载插件；本轮不改变插件的安装与登录方式。
