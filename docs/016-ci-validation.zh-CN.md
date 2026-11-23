# 自动化发布验证

`.github/workflows/release-validation.yml` 在 GitHub 托管运行器中执行完整发布验证。推送任何分支（包括 `agent/**`）、创建或更新 PR、手动运行均可触发。同一分支的新提交取消尚未结束的旧任务。

## 检查范围

| 环境 | 检查 |
| --- | --- |
| Ubuntu 24.04 / Node 22.19.0 | 锁文件安装、类型检查、完整 Vitest、构建、全部运维测试 |
| Ubuntu 24.04 / Node 24.18.1 | 同上 |
| macOS 15 / Node 24.18.1 | 同上 |
| 全部环境通过后的 Ubuntu 24.04 / Node 24.18.1 | 重新执行严格打包脚本，安装真实 DSH 并验证安装/恢复，通过后上传 ZIP、SHA-256 与来源记录 |

包管理器固定为 `pnpm@11.7.0`，依赖安装使用 `--frozen-lockfile`。工作流不排除 HTTP 集成测试、不设置跳过开关、不修改测试断言。`pnpm check` 任一步失败都会阻止打包；运维测试仍单独运行以保留故障证据。发布候选包的打包脚本再独立执行一次所有必需检查。

运行器需要 Node、Python 3、Git、Bash、tar、zip 和 unzip。GitHub 托管的所选系统镜像提供后五类工具；Python 在环境记录步骤核对。DSH、飞书、GitHub 和模型行为的多数自动化测试使用测试替身，不需要客户凭据，不会向生产仓库或群聊提交任务。

多机器人回归覆盖一个机器人绑定多个群、同群不同机器人分别路由、不同机器人的成员授权和回复身份隔离、停用后的队列保留、旧单机器人记录迁移、并发连接、CLI 身份变更拒绝，以及同一 CLI 的多个固定 profile。真实飞书租户中的权限、入群和事件投递仍需使用目标应用验收。

## 真实宿主安装与恢复

打包成功后，在运行器临时目录安装 npm 官方包 `@deepseek-ai/dsh@0.2.2-rc.5`，通过专用 PATH 使用该版本。此宿主要求 Node 24.9.0 以上，因此真实安装验证只在 Node 24.18.1 执行；Node 22 的单元测试不代表宿主支持 Node 22。

`ops/enterprise/smoke-release.mjs` 解压候选包，使用隔离的 `DSH_HOME` 和空 npm 配置执行实际 `install.sh --no-start`。脚本依次核对：管理器启动、专用凭据认证、匿名及错误凭据拒绝、停机、完整备份校验、恢复后文件/SQLite 一致、恢复前安全副本、恢复后重启。只在所有步骤成功后上传发布候选包。任何失败使工作流失败，并留下脱敏日志和 JSON 报告。

部署目录、profile、原始宿主日志和自动生成的凭据均位于临时目录，不上传为产物。验证不接入客户仓库、飞书群或模型，不验证需求交付和目标人数负载；客户主机的权限、服务托管和外部连接仍需实际验收。

## 权限和产物

工作流只声明 `contents: read`，不保留 Git checkout 凭据，不读取客户秘密，不发布 npm 包、不创建 GitHub Release、不部署客户服务。三个外部 Action 均来自 GitHub 官方 `actions` 组织，并固定为实际查验的提交 SHA；更新时需重新核验来源和回归。

每个验证环境保留工具版本、实际 checkout 的提交 SHA、完整检查日志和运维日志。全部通过后上传发布候选 ZIP、`SHA256SUMS`、`SOURCE.json` 与 `SMOKE-REPORT.json`；产物保留 14 天，供验收和下载。PR 运行验证的是 GitHub 的合并测试提交，实际来源以 `SOURCE.json` 中的 `sourceCommit` 为准。分支推送运行可直接验证待交付源提交。

这些产物证明对应提交通过了自动化检查，不替代客户主机安装、真实需求到草稿 PR 的闭环、恢复演练和目标负载验证。完成范围见[交付验收记录](015-release-acceptance.zh-CN.md)。

官方参考：[checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[upload-artifact](https://github.com/actions/upload-artifact)。
