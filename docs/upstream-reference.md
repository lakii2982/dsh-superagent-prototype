# 上游说明与历史 README

以下保存本次界面重构前的完整 README 内容；相对链接已按文档位置调整。界面入口与操作流程以[当前产品说明](../README.md)为准。

---

# dsh-superagent

**桌面版入口**　打开侧边栏 **Superagent**，点击 **启用多仓管理**，进入 **接入配置**。管理员在同一页面登记团队仓库、连接飞书机器人并绑定群聊和接单人员。研发成员从获授权的 GitHub 或飞书入口提交工单。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](../docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](../SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](../docs/000-philosophy.md)
- [001 Domain model](../docs/001-domain.md)
- [002 Authorization](../docs/002-authorization.md)
- [003 Execution](../docs/003-execution.md)
- [004 Prompts](../docs/004-prompts.md)
- [005 Panel](../docs/005-panel.md)
- [006 Deployment](../docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](../docs/007-architecture.md)
- [008 Cookbook](../docs/008-cookbook.md): adding a Source

## Multi-repository management

See [Multi-repository management and Feishu bindings](../docs/multi-repository.md) for the optional unified manager. Single-repository mode remains the default.

For a single manager that serves multiple teams, see the [enterprise deployment package](../ops/enterprise/README.md), the [development workflow and acceptance plan](../docs/014-enterprise-development-pilot.zh-CN.md), and the [manager profile example](../examples/enterprise-pilot.cordis.patch.yml).

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](../LICENSE)
