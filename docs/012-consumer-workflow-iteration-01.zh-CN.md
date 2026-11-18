# 消费级工作流 · 迭代 01 执行记录

本文记录[个人开发者版开发规格](011-consumer-workflow-development.zh-CN.md)的第一次迭代：范围、提交拆分、验证证据与遗留项。规格仍是唯一需求基线；本文只记录本轮做了什么、做到什么程度。

## 1. 基线

- 分支 `dsh-58d5b2e0-a6d8`，起点 `aa78913`（`feat/multi-repository` 最新提交）。
- 开工前把主工作区未提交改动同步进本工作区（`package.json` 的 DSH 版本、`docs/003`、`docs/006`、`src/executor/background.ts` 与其测试），不改变其语义。
- 依赖：Node 24.18.1、pnpm 11.7.0；`pnpm install` 后可直接 `pnpm check`。
- 已知基线问题：`tests/runtime.spec.ts` 有两个 `GIT_CONFIG_GLOBAL` 未恢复断言失败（1217 passed / 2 failed）。与本迭代功能无关，单独处理。

## 2. 本轮范围

| 阶段 | 本轮目标 | 不在本轮 |
| --- | --- | --- |
| A · 固定路由与就绪 | 逐话题投递顺序、撤销每仓库队首阻塞、群停用隔离、就绪维度拆分、离线恢复投原仓 | 面板交互重做 |
| B · 托管 worktree | `worktree` 工作模式、准备/续接/清理、执行元数据、范围占用与同仓库排队 | 超范围申请审批流、跨工作区 diff 对账 |
| C · 本地 Agent | 委派工具与生命周期（下一迭代） | — |
| D · GitHub 交付与面板 | PR 对账、回执状态拆分（下一迭代） | — |
| E · 兼容与验收 | `pnpm check` 全绿、双仓联调（下一迭代收口） | 真实飞书/真实 GitHub 试单 |

## 3. 提交拆分

1. `chore: sync workspace baseline` — 主工作区在途改动 + 规格文档 + 本文。
2. `feat(manager): order delivery per topic and isolate paused groups` — 阶段 A。
3. `feat(executor): prepare managed git worktrees per ticket` — 阶段 B。
4. `docs: record module and test entries` — 架构表补新文件（`docs/007-architecture.md`）。
5. 后续阶段各自成提交。

每步以 `pnpm typecheck` + 相关测试文件通过为准；整机 `pnpm check` 在阶段 E 收口。

## 4. 兼容性约束

- 旧工单的 `Execution`、目录与分支不改写；`current` / `isolated` 行为保持。
- 设置切换只影响新工单；同仓库存在未交接的 `current` 工单时，新写入等待交接。
- 用户工作区未提交改动永不 stash / reset / clean。
- SQLite 变更必须对已有库可重复执行，旧行要能回填或按默认值读取。

## 5. 验证方式

- 自动化：`pnpm typecheck`、`pnpm vitest run tests/manager-*.spec.ts tests/worktree.spec.ts tests/runtime-concurrency.spec.ts tests/repository.spec.ts tests/migration.spec.ts`。
- 回归：`pnpm test`（基线两例失败除外）。
- 真实验收（阶段 E）：两个独立测试仓库、两个测试群，保存工单、PR、重叠运行时间与恢复证据。

## 6. 状态

| 项 | 状态 |
| --- | --- |
| 基线同步与依赖安装 | 完成 |
| 阶段 A | 进行中 |
| 阶段 B | 进行中 |
| 阶段 C | 未开始 |
| 阶段 D | 未开始 |
| 阶段 E | 未开始 |

更新本表时同时写明对应提交 SHA 与测试汇总行，避免只有结论没有证据。
