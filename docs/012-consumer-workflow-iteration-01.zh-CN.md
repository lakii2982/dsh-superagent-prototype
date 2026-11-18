# 消费级工作流 · 迭代 01 执行记录

本文记录[个人开发者版开发规格](011-consumer-workflow-development.zh-CN.md)的第一次迭代：范围、提交拆分、验证证据与遗留项。规格仍是唯一需求基线；本文只记录本轮做了什么、做到什么程度。

## 1. 基线

- 分支 `dsh-58d5b2e0-a6d8`，起点 `aa78913`（`feat/multi-repository` 最新提交）。
- 开工前把主工作区未提交改动同步进本工作区（`package.json` 的 DSH 版本、`docs/003`、`docs/006`、`src/executor/background.ts` 与其测试），不改变其语义。
- 依赖：Node 24.18.1、pnpm 11.7.0；`pnpm install` 后可直接 `pnpm check`。
- 基线期的两例 `GIT_CONFIG_GLOBAL` 失败并非代码缺陷：DSH 宿主进程启动过 dsh-superagent，`src/app/setup.ts` 已把 Worker 环境写入 `process.env`，而 `tests/runtime.spec.ts` 断言「宿主原本没有该变量」。已改为与测试开始时捕获的宿主值比较（`b103162`），干净环境与宿主继承环境都能通过。

## 2. 本轮范围

| 阶段 | 本轮目标 | 不在本轮 |
| --- | --- | --- |
| A · 固定路由与就绪 | 逐话题投递顺序、撤销每仓库队首阻塞、群停用隔离、就绪维度拆分、离线恢复投原仓 | 面板交互重做 |
| B · 托管 worktree | `worktree` 工作模式、准备/续接/清理、执行元数据、范围占用与同仓库排队 | 超范围申请审批流、跨工作区 diff 对账 |
| C · 本地 Agent | `orchestrator_agent` 委派工具、运行记录、续接与停止、失败分类与修复提示、真实差异回传 | 面板上切换执行者、按用量自动降级 |
| D · GitHub 交付与面板 | 回执四类事实拆分、统一列表的仓库/Agent/PR、运行详情（worktree、基准提交、改动概要、检查证据位、Agent 会话） | 面板内切换执行者、跨仓 PR 批量对账、推送前远端 head 的额外核对（沿用 `delivery.md` 的 `--force-with-lease` 与「被拒即停」） |
| E · 兼容与验收 | `pnpm check` 全绿、验收矩阵的自动化证据、升级与回退说明 | 真实双仓双群联调（需两组 GitHub 测试仓库与两个已授权飞书测试群，见 §8） |

## 3. 提交拆分

1. `chore: sync workspace baseline` — 主工作区在途改动 + 规格文档 + 本文。
2. `feat(manager): order delivery per topic and isolate paused groups` — 阶段 A。
3. `feat(executor): prepare managed git worktrees per ticket` — 阶段 B。
4. `docs: record module and test entries` — 架构表补新文件（`docs/007-architecture.md`）。
5. `feat(executor): delegate a ticket's work to the local codex and claude CLIs` — 阶段 C。
6. `feat(panel): show code, pull request and channel receipt as separate delivery facts` — 阶段 D 的回执事实。
7. `feat(panel): show the repository, agent, pull request and run details` — 阶段 D 的列表与运行详情。
8. `docs: record the delivery panel, the acceptance evidence and the upgrade notes` — 本文与部署文档。

每步以 `pnpm typecheck` + 相关测试文件通过为准；整机 `pnpm check` 在阶段 E 收口。

## 4. 兼容性约束

- 旧工单的 `Execution`、目录与分支不改写；`current` / `isolated` 行为保持。
- 设置切换只影响新工单；同仓库存在未交接的 `current` 工单时，新写入等待交接。
- 用户工作区未提交改动永不 stash / reset / clean。
- SQLite 变更必须对已有库可重复执行，旧行要能回填或按默认值读取。

## 5. 验证方式

- 自动化：`pnpm check`（类型检查 + 全量测试 + 构建）。本迭代收尾时 66 个测试文件 / 1269 例全部通过，其中新增或重写的用例覆盖逐话题顺序、群停用隔离、就绪维度、worktree 并行与排队、准备续接与现场保留、委派生命周期、回执四类事实与运行详情。
- 定向回归：`pnpm vitest run tests/manager-*.spec.ts tests/worktree.spec.ts tests/runtime-concurrency.spec.ts tests/repository.spec.ts tests/migration.spec.ts tests/settings.spec.ts`。
- 回归：`pnpm test`（宿主继承环境下同样全绿；`pnpm check` 在 DSH 进程内也可直接运行）。
- 真实 CLI 实测（阶段 C，手工一次性执行，不在自动化里跑网络）：临时 git 仓库内用委派器起 `claude`（写权限）与 `codex`（只读）。`claude` 返回 `session_id` 与 `DONE`，`changes.status` 为 `?? agent-proof.txt`，注记投递给当前 Assignment；`codex` 经系统代理（`scutil --proxy` → `127.0.0.1:10902`）返回 `pong` 并记录 `thread_id`。两者均 `done`，说明命令拼装、输出解析、改动采集与代理透传在真实二进制上成立。
- 真实验收（阶段 E）：两个独立测试仓库、两个测试群，保存工单、PR、重叠运行时间与恢复证据。

## 6. 状态

| 项 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| 基线同步与依赖安装 | 完成 | `444b876` | 依赖安装成功，`pnpm check` 通过 |
| 测试环境修正 | 完成 | `b103162` | `tests/runtime.spec.ts` 不再假设宿主没有 `GIT_CONFIG_GLOBAL` |
| 阶段 A · 固定路由与就绪 | 完成 | `be834b3` | 4 个 manager 测试文件 32 例；全量 `pnpm check` 通过 |
| 阶段 B · 托管 worktree | 完成 | `bf7432a` | `tests/worktree.spec.ts` 6 例 + 4 个相关文件扩展；全量 `pnpm check` 通过 |
| 架构表补录 | 完成 | `f1095b3` | `tests/docs.spec.ts` 校验每个模块与测试都在表中 |
| 阶段 C · 本地 Agent | 完成 | `0c97e9b` | `tests/agents.spec.ts` 15 例（假 CLI 子进程）；真实 `claude`/`codex` 各一次端到端实测；全量 `pnpm check` 通过 |
| 阶段 D · GitHub 交付与面板 | 完成（面板部分） | `9bcf8a6`、`dca1055` | `tests/views.spec.ts` 8 例与 `tests/panel-execution.spec.tsx` 3 例新增；回执四类事实、列表仓库/Agent/PR、运行详情；全量 `pnpm check` 通过 |
| 阶段 E · 兼容与验收 | 进行中 | — | 全量检查已绿（66 文件 / 1269 例）；验收矩阵自动化证据见 §7；真实双仓双群联调待凭据（§8） |

更新本表时同时写明对应提交 SHA 与测试汇总行，避免只有结论没有证据。

## 7. 验收矩阵的自动化证据

对照[验收矩阵](011-consumer-workflow-development.zh-CN.md#8-验收矩阵)逐行给出本迭代已自动化的证据与仍需真实环境的部分。测试替身、CLI 帮助和进程退出码只证明对应层次；真实交付仍以 GitHub 与原飞书话题为准。

| 验收场景 | 自动化证据（本迭代） | 仍需真实环境 |
| --- | --- | --- |
| 两群两仓同时发单 | `tests/manager-runtime.spec.ts`「keeps two groups on two repositories on their own routes without cross delivery」；`tests/manager-store.spec.ts`「routes each group to its repository and persists an unacknowledged delivery across restart」 | 两仓并发时间重叠、各自 PR、回执只回原话题 |
| 重复、停用、离线与换绑 | `tests/manager-store.spec.ts`（重复只存一次、换绑后旧话题续原仓、停用群说明等待原因）；`tests/manager-runtime.spec.ts`（一组停用另一组继续、实例离线后投原仓、重启后重新发现实例） | 真实事件重复投递与断线重连 |
| 同仓库两个独立改动 | `tests/worktree.spec.ts`「prepares independent worktrees for two tickets of one repository, side by side」「never touches the person's …」 | 两个分支与 PR 在真实 GitHub 上独立审查 |
| 范围重叠与扩大 | `tests/worktree.spec.ts`「queues overlapping write scopes of one repository while different files run in their own worktrees」；`tests/agents.spec.ts`「refuses a write run while another ticket writes the repository and allows it once the slot is free」 | 实际超范围差异与远端冲突转人工（依赖 `prompts/team/delivery.md` 的指令，未自动化） |
| Codex 与 Claude Code | `tests/agents.spec.ts` 15 例（命令拼装、输出解析、幂等、续接、停止、失败分类）；§5 的真实 CLI 各一次实测 | 两种 Agent 各自推送并发 PR；一种实现、另一种只读审阅同一工单 |
| 能力、权限和上下文 | `tests/agents.spec.ts`（登录失败与修复提示、代理优先级、停止后进程已退出）；`tests/environment.spec.ts`（子进程环境剔除凭据与 `DSH_*`） | 未安装/未登录在真实二进制上的提示文案；读权限未做隔离，见 §8 已知限制 |
| 停止、崩溃、恢复 | `tests/agents.spec.ts`（停止后标记 stopped 且进程已退出、重启把运行标 interrupted 并保留会话、先收束再释放写入名额）；`tests/worktree.spec.ts`（准备中断后复用现场）；`tests/manager-store.spec.ts`（确认丢失仍只存一次、重启后队列仍在） | GitHub 成功后回执丢失、飞书发送失败的端到端演练 |
| 旧部署和首次使用 | `tests/migration.spec.ts`（schema 10 的写入与旧形状读取）；`tests/manager-instances.spec.ts`（保留旧工单）；`tests/panel-*.spec.tsx`（首次配置与检查结果） | 新用户按页面完成仓库、Agent、GitHub 与群绑定并独立试单 |

## 8. 真实双仓双群联调、升级与限制

需要准备：两个独立 GitHub 测试仓库（一个空仓、一个带保护规则或 CI）、交付账号 PAT（`contents`、`pull_requests` 权限）、两组已授权飞书测试群（机器人在群内）、本机 `claude` 与 `codex` 已登录且 CLI 能出网（QuickQ 等系统代理需要导出 `HTTPS_PROXY`/`ALL_PROXY`，见 `docs/006-deployment.md` 的 Upgrade 一节）。

联调步骤与要留的证据：

1. 两个仓库分别绑定两个群，各发一单，记录两单重叠的运行窗口、各自分支、PR 链接与回执落点（只应回各自原话题）。
2. 同一仓库再发两单改同一文件：记录第二单在写入前等待的范围占用，以及前一单结束后的放行时间。
3. 停用其中一组群后再发单：另一组继续，恢复后仍投原仓。
4. 运行中停止一单，再重启进程：确认外部进程与子进程先收束、名额随后释放，恢复后现场仍在（worktree 与未提交改动保留）。
5. 模拟 GitHub 成功但回执未送达（停掉出站）与飞书发送失败：确认恢复后无重复 PR、无重复回执。

证据按「工单号 / PR 链接 / 时间戳 / 截图」存到 `.artifacts/acceptance/`，并在本表补一行记录。

升级先备份管理库（`outbox`、`tickets`、`triggers`）、仓库状态与 DSH 会话，停止共享同一机器人事件流的旧消费者后再切换。回退时保留已确认接收的事件、未送达回执与已创建的 PR；旧数据仍按原工单语义读取（`tests/migration.spec.ts` 覆盖 schema 10 的写入与旧形状读取）。

已知限制（本轮有意保留，均不影响验收矩阵的自动化部分）：

- `stopAll` 在 10 秒内未确认退出时也把运行标为 stopped 并释放写入名额，比方案「收束未确认时保留名额」放宽；风险是极慢退出的进程可能与下一工单短暂并存。
- 未提供 `settings.executor.agent` 默认执行者设置项：切换执行者仍需在工单内显式选择，避免破坏既有设置的精确断言与表单。
- 外部 Agent 的工作目录是工单 worktree，写入受 `codex -s workspace-write` 与 `claude` 权限模式约束，但**读**没有额外隔离；`Assignment.report` 只有 `state/summary/at`，因此运行详情不显示「检查证据」字段。
