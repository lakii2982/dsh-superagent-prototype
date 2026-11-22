# DSH 企业研发上线包

全公司部署一个 DSH 管理服务、打开一个管理页面。5 个团队和 12 条产品线共用这套底座，管理页面按团队筛选队列和仓库。每个仓库单独绑定接单身份、工单目录、模型配置和 GitHub 执行账号。开发者在现有 GitHub 或飞书入口发单，DSH 交付草稿 PR，代码负责人审批和合并。

已有 Desktop 插件的运维人员可在本机侧栏打开 **Superagent**，点击 **启用多仓管理**，用接入配置登记仓库、连接机器人并绑定群。更新后若入口尚未出现，在当前工作结束后退出并重新打开 DSH，让应用加载新代码。原单仓记录存放在原目录。准备正式共享服务时，使用以下专用主机安装流程。

## 1. 准备部署主机

使用公司分配的专用 VM 和非管理员服务身份。目标机器需要 DSH `0.2.2-rc.5`、Node.js `24.9.0` 或更新版本、Git、`curl` 和访问已批准 GitHub、模型以及可选飞书服务的权限。仓库应位于 `github.com`。准备管理器身份下的 GitHub SSH 已知主机与专用只读拉取凭据，用 `git ls-remote git@github.com:<owner>/<repo>.git HEAD` 验证镜像拉取权限。插件安装依赖已随包提供，安装无需访问 npm 注册表。

Node.js 要求来自 [DSH `0.2.2-rc.5` 官方 CLI 的 `engines.node`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/cli/package.json)。插件自身的 `package.json` 兼容范围不代表 DSH 宿主的部署要求；Node.js 22.x 和 24.0–24.8 无法通过本安装器。

专用 VM 是运行隔离边界。五个团队接入同一已批准的信任域，服务身份只持有这些仓库的工作目录和批准的工具凭据，不持有生产发布权限。公司如果要求团队之间满足操作系统级强隔离，需要在部署架构上另设执行边界并单独验收。

GitHub 目标分支启用 Active ruleset，至少要求人工审批和指定 CI 检查，并禁止强推和删除。执行账号不得绕过规则或执行受保护分支上的合并。自动分支检查按 active ruleset 放行，运维再用执行账号和代码负责人的独立身份实测合并权限。参见 [GitHub 分支规则说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)。

## 2. 安装并启动统一服务

在解压目录运行一次。地址默认只监听本机，其他 DSH profile 保留独立。核对 `BUILD-INFO.json` 记录的包版本与 SHA-256 后安装。

```bash
./install.sh --home "$HOME/dsh-enterprise" --port 3082 --capacity 12
"$HOME/dsh-enterprise/dsh-enterprise" status
```

部署目录包含专用 DSH profile、状态数据库、仓库工作目录、安装版本和权限受限的运维凭据。使用 `dsh-enterprise logs` 中的启动地址打开 DSH，再点击 **Superagent**。页面要求输入同一部署目录里 `operator.token` 文件中的运维凭据。该凭据用于同一页面的所有团队管理操作。

远程主机使用受控 SSH 转发，两端使用相同端口。例如 `ssh -L 3082:127.0.0.1:3082 <负责运维的主机>`。在运维电脑打开 DSH 启动地址。开发者通过批准的 GitHub 或飞书身份接入，管理页面仅供运维使用。

## 3. 导入 5 个团队和 12 条产品线

复制 `company.example.json` 为 `company.json`，用公司实际团队、产品线、用户身份、仓库地址、本地 checkout、账号 CLI 和可选机器人群替换示例。每个仓库在其所属团队下列产品线和允许发单的成员。清单只写身份与文件路径，凭据由公司配置。可为多个仓库在清单中设置 `modelCredentialsFile`，引用公司批准的 DSH 凭据文件。文件由部署身份持有，权限为 `0600`。

```bash
node configure.mjs validate company.json
node configure.mjs plan company.json --manager http://127.0.0.1:3082 \
  --operator-token-file "$HOME/dsh-enterprise/operator.token"
node configure.mjs apply company.json --manager http://127.0.0.1:3082 \
  --operator-token-file "$HOME/dsh-enterprise/operator.token" \
  --state-dir "$HOME/dsh-enterprise/manager"
node configure.mjs status company.json --manager http://127.0.0.1:3082 \
  --operator-token-file "$HOME/dsh-enterprise/operator.token"
```

`apply` 先校验并登记，不启动执行器。设置 `modelCredentialsFile` 时，它将凭据从私有源文件批量复制到认证后的仓库状态目录，全程不打印凭据，也不会覆盖已有不同凭据。首次用管理面板启动两条产品线的仓库。每个仓库通过模型和渠道试单后，`apply --start` 可用同一份清单启动其余登记仓库。试单至少验证授权用户的新单、未授权追问的拒绝、实际模型请求、草稿 PR、CI、人工合并和原渠道回执。

## 4. 运维、备份与恢复

所有命令以安装服务的同一系统身份运行。`status` 通过带认证的管理接口核对进程、状态目录、企业配置和容量；它不以“端口能访问”代替健康检查。

```bash
"$HOME/dsh-enterprise/dsh-enterprise" status
"$HOME/dsh-enterprise/dsh-enterprise" logs
"$HOME/dsh-enterprise/dsh-enterprise" logs --follow
"$HOME/dsh-enterprise/dsh-enterprise" logs <仓库ID>
"$HOME/dsh-enterprise/dsh-enterprise" stop
```

`stop` 先逐个收束运行中的仓库实例，再终止管理器；停机验证失败时不会直接杀掉管理器。撤权时暂停调度、停掉受影响仓库、同步授权名单并对账，再恢复。不要在一个飞书事件流上同时启动两套消费者。

使用 Linux 用户级 systemd 时，首次安装加 `--no-start`。以部署身份把包内 `dsh-enterprise.service` 放到 `~/.config/systemd/user/`，确认 `node` 在服务进程的 PATH 上，再运行 `systemctl --user enable --now dsh-enterprise.service`。若设了自定义部署目录，同步修改 unit 里的路径。维护前先用 `systemctl --user stop dsh-enterprise.service` 停止 supervisor，避免它在维护中自动拉起服务。计划停机时已收束的仓库，由运维复核后以同一份清单重新启动。

### 停机备份

```bash
"$HOME/dsh-enterprise/dsh-enterprise" stop
mkdir -p "$HOME/dsh-backups"
chmod 700 "$HOME/dsh-backups"
"$HOME/dsh-enterprise/dsh-enterprise" backup "$HOME/dsh-backups/before-change-20261122"
"$HOME/dsh-enterprise/dsh-enterprise" verify-backup "$HOME/dsh-backups/before-change-20261122"
```

备份目标必须是部署目录之外的新目录。工具同时检查管理器 PID、所有已登记实例端口和运行状态锁，拒绝对活动服务做文件复制。快照复制整个部署目录，包括管理数据库及 WAL、持久队列、每仓库数据库、会话、模型凭据、worktree、DSH profile、当前 release 和日志。`manager.pid` 与本次维护锁不进入快照。复制后逐文件记录 SHA-256，再校验一次，只有校验成功才返回 `verified: true`。

备份目录权限为 `0700`，普通文件为 `0600`，可执行文件保留所有者执行权限。快照包含运维令牌与模型凭据，应存入公司批准的加密存储并限制访问。符号链接只保存链接本身；部署目录之外的 DSH、Git、GitHub/飞书 CLI、SSH、系统钥匙串和其他外部凭据不在快照中，需要随主机恢复方案单独准备。不要把备份目录提交到代码仓库。

每次升级或授权规则大改前做一次停机备份；定期在隔离环境演练读取校验与恢复。恢复点是备份时间，不包含快照之后接收的新事件。公司按允许的数据损失窗口确定备份频率；当前版本没有在线备份。

### 同版本、同路径恢复

```bash
"$HOME/dsh-enterprise/dsh-enterprise" stop
"$HOME/dsh-enterprise/dsh-enterprise" verify-backup "$HOME/dsh-backups/before-change-20261122"
"$HOME/dsh-enterprise/dsh-enterprise" restore "$HOME/dsh-backups/before-change-20261122"
```

恢复只接受原绝对部署路径、同 profile、相同 release SHA-256 的完整快照，并要求当前 `service.json`、`operator.token`、运行器与安装版本仍完整可读取。它拒绝跨版本和数据库降级，不能用旧 release 强行读取升级后的状态。迁移主机时需保留同一绝对路径、服务身份及外部依赖，并单独验收。整机丢失或安装配置已损坏时，先从受控备份恢复安装环境后再执行恢复核验，不在损坏目录里反复安装新版本覆盖状态。

恢复先校验快照，然后自动把当前完整状态备份到部署目录旁的 `*.before-restore-*` 目录，再复制并校验待恢复内容，通过目录切换生效。预留至少两份完整部署大小的额外磁盘空间，并保留原始备份。任何恢复都不自动启动服务。返回的 `preservedCurrentState` 是恢复前副本的位置，其中保留快照之后接收的事件和工作记录。

启动前人工对账备份时点之后的已接收需求、已发送回复和已创建 PR，明确哪些应续做、哪些已完成。数据库恢复不会撤回 GitHub 或飞书中的外部结果；未经对账直接重放旧队列可能重复处理。核对机器人身份、模型凭据和仓库连接后显式运行 `start`，再按清单逐仓库恢复并检查任务记录。切换过程意外断电时保留 `*.restore-stage-*`、`*.restore-previous-*` 与恢复前快照，由运维选择完整版本并校验后恢复原路径，禁止把两套目录同时启动。

### 日志保留

```bash
"$HOME/dsh-enterprise/dsh-enterprise" stop
"$HOME/dsh-enterprise/dsh-enterprise" rotate-logs
"$HOME/dsh-enterprise/dsh-enterprise" start
```

管理器日志位于 `manager.log`，仓库日志位于 `manager/logs/<仓库ID>.log`。`logs [--follow] [仓库ID]` 读取指定实例的最后 100 行或持续跟踪。`rotate-logs` 在全部实例停机后，对达到 20 MiB 的日志执行重命名轮转，保留 `.1` 至 `.5` 五代，并创建权限为 `0600` 的新日志。不使用会丢失写入窗口内容的在线截断。当前没有运行时自动轮转，长时间运行的主机需监控日志体积和磁盘余量，将轮转纳入维护窗口；重启后重新登记需要运行的仓库。日志可能含 DSH 启动链接和渠道上下文，按部署凭据同级控制访问。

## 5. 验收每条产品线的 50%

用 `enterprise-measure.example.json` 映射 12 条产品线和 5 个团队，把同口径的历史与上线后工单、生产发布时间和未发布项导入后运行 `node enterprise-measure.mjs company-cycle.json`。每条线独立比较需求就绪到生产的中位时长、P90 和发布完成比例。示例不会产生业务达标结论。
