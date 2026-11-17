/*
 * Shared mock data for the three panel concepts. Content mirrors the real
 * Superagent domain (Threads, Triggers, Decisions, Tickets, Assignments) so the
 * prototypes can be judged as product surfaces rather than lorem ipsum.
 * All names, links and numbers are mock data.
 */
(function () {
  const repo = {
    owner: 'deepseek-ai',
    name: 'dsh-superagent-prototype',
    short: 'dsh-superagent',
    branch: 'feat/multi-repository',
    head: 'a028a6b',
    health: 'ok',
    synced: '16:32',
  }

  const user = { name: '林舟', short: '林', handle: 'lakii2982' }

  const needs = [
    {
      id: 't-1042',
      title: '修复飞书追问在重启后丢失上下文',
      stage: 'waiting',
      stageLabel: '等待你回复',
      source: 'feishu',
      requester: '林舟',
      age: '12 分钟',
      why: '执行会话在等你确认处理方式',
      question: '历史工单是否补发回复？补发会向 3 个群发送 5 条消息。',
      summary:
        '重启后，追问落到了新的执行会话，原会话的上下文没有接上。修复已提交，需要你决定是否给 3 个历史工单补发回复。',
      branch: 'agent/feishu-followup-9f2c',
      pr: 61,
      model: 'claude-sonnet-4.5',
      started: '15:58',
      thread: '线上群里的追问重启后没有回到原工单',
      scope: '修复飞书追问在 Gateway 重启后丢失会话上下文；回补历史工单的回复。',
      policy: 'v12 · 允许成员 + 点名',
    },
    {
      id: 't-1039',
      title: '为 Manager 增加仓库健康检查',
      stage: 'blocked',
      stageLabel: '验证未通过',
      source: 'github',
      requester: 'lakii2982',
      age: '38 分钟',
      why: '自动验证连续 2 次失败',
      question: 'pnpm test 有 2 个用例未通过，需要确认是修复实现还是调整断言。',
      summary:
        '新增的启动探针在仓库切换时偶发超时。实现已完成，但 tests/manager.test.ts 的两个用例仍然失败。',
      branch: 'agent/manager-health-probe-71ad',
      pr: null,
      model: 'claude-sonnet-4.5',
      started: '15:31',
      thread: '#59 Manager health probe times out during repository switch',
      scope: '为多仓库管理器增加启动探针，并在仓库切换时复用连接。',
      policy: 'v12 · 允许成员',
    },
  ]

  const problems = [
    {
      id: 'p-feishu',
      severity: 'warn',
      title: '飞书机器人连接中断',
      detail: '15:42 起无法接收群消息，GitHub 来源正常；已自动重试 3 次。',
      action: '检查设置',
      route: 'settings',
    },
  ]

  const flow = { received: 18, filtered: 6, judged: 12, accepted: 3, dropped: 0 }

  const executor = { running: 2, max: 3, queued: 1, idle: 1, model: 'claude-sonnet-4.5' }

  const running = [
    {
      id: 't-1043',
      title: '为执行器增加工作目录就绪检查',
      stage: 'working',
      stageLabel: '执行中',
      source: 'feishu',
      requester: '林舟',
      elapsed: '32 分钟',
      progress: '运行 pnpm check',
      branch: 'agent/executor-readiness-4b2',
      model: 'claude-sonnet-4.5',
      agent: 'Claude Code',
    },
    {
      id: 't-1040',
      title: '修复 CI 中 GitHub 评论去重测试',
      stage: 'working',
      stageLabel: '执行中',
      source: 'github',
      requester: 'lakii2982',
      elapsed: '8 分钟',
      progress: '运行 pnpm check',
      branch: 'agent/comment-dedupe-3f81',
      model: 'claude-sonnet-4.5',
      agent: 'Codex',
    },
  ]

  const recent = [
    {
      id: 't-1038',
      title: '支持多仓库管理与飞书群路由',
      outcome: '已合并',
      outcomeKind: 'merged',
      at: '今天 11:20',
      pr: 58,
      source: 'github',
    },
    {
      id: 't-1035',
      title: '接入飞书群绑定与成员同步',
      outcome: '已结束',
      outcomeKind: 'ended',
      at: '昨天 18:04',
      pr: 54,
      source: 'feishu',
    },
    {
      id: 't-1031',
      title: '隔离仓库会话存储并验证实例就绪',
      outcome: '已合并',
      outcomeKind: 'merged',
      at: '昨天 15:42',
      pr: 51,
      source: 'github',
    },
  ]

  const tickets = {
    't-1042': {
      id: 't-1042',
      number: 42,
      title: '修复飞书追问在重启后丢失上下文',
      stage: 'waiting',
      stageLabel: '等待你回复',
      source: 'feishu',
      requester: '林舟',
      opened: '今天 14:06',
      updated: '12 分钟前',
      scope: '修复飞书追问在 Gateway 重启后丢失会话上下文；回补历史工单的回复。',
      policy: 'v12 · 允许成员 + 点名',
      branch: 'agent/feishu-followup-9f2c',
      pr: 61,
      model: 'claude-sonnet-4.5',
      session: '修复飞书追问上下文',
      directory: '~/项目/DSH-SUPERAGENT/.worktrees/t-1042',
      thread: '线上群里的追问重启后没有回到原工单',
      question: '历史工单是否补发回复？补发会向 3 个群发送 5 条消息。',
      events: [
        {
          at: '14:06',
          actor: '林舟',
          kind: 'trigger',
          text: '@助手 线上群里的追问重启后没有回到原工单，帮我看下。',
        },
        {
          at: '14:07',
          actor: 'Eval',
          kind: 'decision',
          text: '接受：飞书允许成员，且消息点名了助手。',
          meta: '规则 Feishu · 允许成员 + @助手',
        },
        {
          at: '14:08',
          actor: 'Executor',
          kind: 'assignment',
          text: '创建工单 t-1042，在独立 worktree 中启动执行会话。',
        },
        {
          at: '15:58',
          actor: 'Claude Code',
          kind: 'report',
          text: '根因是 Gateway 重启后 topic 路由落到了新会话。已提交修复，相关测试通过。',
        },
        {
          at: '16:02',
          actor: 'Superagent',
          kind: 'question',
          text: '历史工单是否补发回复？补发会向 3 个群发送 5 条消息。',
        },
      ],
    },
    't-1043': {
      id: 't-1043',
      number: 43,
      title: '为执行器增加工作目录就绪检查',
      stage: 'working',
      stageLabel: '执行中',
      source: 'feishu',
      requester: '林舟',
      opened: '今天 16:06',
      updated: '刚刚',
      scope: '目录已存在但准备失败时会留下脏目录；下一次重试把存在当成已就绪。为空目录补上就绪探针，并在准备失败时清理。',
      policy: 'v12 · 允许成员 + 点名',
      branch: 'agent/executor-readiness-4b2',
      pr: null,
      model: 'claude-sonnet-4.5',
      session: '执行器目录就绪检查',
      directory: '~/项目/DSH-SUPERAGENT',
      thread: '执行目录就绪检查误判',
      events: [
        {
          at: '16:06',
          actor: '林舟',
          kind: 'trigger',
          text: '@助手 执行目录存在但准备失败时，后续重试会误以为已就绪，帮我看下。',
        },
        {
          at: '16:06',
          actor: 'Eval',
          kind: 'decision',
          text: '接受：飞书允许成员，且消息点名了助手。',
        },
        {
          at: '16:07',
          actor: 'Executor',
          kind: 'assignment',
          text: '创建工单 t-1043，启动执行会话。',
        },
        {
          at: '16:32',
          actor: 'Claude Code',
          kind: 'progress',
          text: '正在补就绪探针，完成后运行 pnpm check。',
        },
      ],
    },
    't-1039': {
      id: 't-1039',
      number: 39,
      title: '为 Manager 增加仓库健康检查',
      stage: 'blocked',
      stageLabel: '验证未通过',
      source: 'github',
      requester: 'lakii2982',
      opened: '今天 15:31',
      updated: '38 分钟前',
      scope: '为多仓库管理器增加启动探针，并在仓库切换时复用连接。',
      policy: 'v12 · 允许成员',
      branch: 'agent/manager-health-probe-71ad',
      pr: null,
      model: 'claude-sonnet-4.5',
      session: 'Manager 健康检查',
      directory: '~/项目/DSH-SUPERAGENT/.worktrees/t-1039',
      thread: '#59 Manager health probe times out during repository switch',
      question: 'pnpm test 有 2 个用例未通过，需要确认是修复实现还是调整断言。',
      events: [
        {
          at: '15:31',
          actor: 'lakii2982',
          kind: 'trigger',
          text: 'Opened issue #59: health probe times out when switching repositories.',
        },
        {
          at: '15:32',
          actor: 'Eval',
          kind: 'decision',
          text: '接受：Issue 来自允许成员，且属于本仓库。',
        },
        {
          at: '15:33',
          actor: 'Executor',
          kind: 'assignment',
          text: '创建工单 t-1039，启动执行会话。',
        },
        {
          at: '16:00',
          actor: 'Codex',
          kind: 'report',
          text: '探针实现完成；tests/manager.test.ts 中 2 个用例仍失败。',
        },
      ],
    },
  }

  const threads = [
    {
      key: 'feishu:demo:001',
      title: '执行目录就绪检查误判',
      source: 'feishu',
      state: 'accepted',
      stateLabel: '已接单',
      updated: '16:24',
      triggers: 1,
      unread: true,
      ticket: 't-1043',
      actor: '林舟',
    },
    {
      key: 'github:59',
      title: '#59 Manager health probe times out during repository switch',
      source: 'github',
      state: 'accepted',
      stateLabel: '已接单',
      updated: '16:00',
      triggers: 2,
      unread: false,
      ticket: 't-1039',
      actor: 'lakii2982',
    },
    {
      key: 'feishu:demo:002',
      title: '这个群的消息需要我处理吗',
      source: 'feishu',
      state: 'filtered',
      stateLabel: '已过滤',
      updated: '昨天 22:10',
      triggers: 1,
      unread: false,
      ticket: null,
      actor: '沈迟',
      reason: '消息没有点名助手，且发送者不在允许成员中',
    },
    {
      key: 'feishu:demo:004',
      title: '线上群里的追问重启后没有回到原工单',
      source: 'feishu',
      state: 'accepted',
      stateLabel: '已接单',
      updated: '16:02',
      triggers: 3,
      unread: false,
      ticket: 't-1042',
      actor: '林舟',
    },
    {
      key: 'feishu:demo:003',
      title: '明天的评审改到下午三点',
      source: 'feishu',
      state: 'evaluating',
      stateLabel: '评估中',
      updated: '16:18',
      triggers: 1,
      unread: true,
      ticket: null,
      actor: '林舟',
    },
  ]

  const decisions = [
    {
      at: '16:06',
      actor: '林舟',
      thread: '执行目录就绪检查误判',
      verdict: 'accept',
      reason: '飞书允许成员，且消息点名了助手',
      rule: 'Feishu · 允许成员 + @助手',
    },
    {
      at: '16:00',
      actor: 'lakii2982',
      thread: '#59 Manager health probe…',
      verdict: 'accept',
      reason: 'Issue 来自允许成员，且属于本仓库',
      rule: 'GitHub · 允许成员',
    },
    {
      at: '昨天 22:10',
      actor: '沈迟',
      thread: '这个群的消息需要我处理吗',
      verdict: 'filter',
      reason: '消息没有点名助手，且发送者不在允许成员中',
      rule: 'Feishu · 点名或允许成员',
    },
    {
      at: '昨天 21:44',
      actor: 'GitHub bot',
      thread: '#58 支持多仓库管理与飞书群路由',
      verdict: 'accept',
      reason: '默认分支 CI 失败，自动创建工单',
      rule: 'GitHub · 默认分支 CI',
    },
  ]

  const dropped = [
    {
      source: 'feishu',
      preview: '「林舟」撤回了一条消息',
      reason: '原消息已撤回，无法读取内容',
      at: '昨天 22:12',
    },
    {
      source: 'github',
      preview: 'Comment on #57 by dependabot[bot]',
      reason: '发送者是机器人，不在允许列表',
      at: '昨天 19:30',
    },
  ]

  const sources = [
    {
      id: 'github',
      name: 'GitHub',
      account: 'lakii2982',
      detail: 'deepseek-ai/dsh-superagent-prototype · 每 30 秒轮询',
      state: 'ok',
      stateLabel: '正常',
      last: '16:32',
    },
    {
      id: 'feishu',
      name: '飞书',
      account: '助手',
      detail: '群聊 demo… · 事件订阅',
      state: 'warn',
      stateLabel: '连接中断',
      last: '15:42',
    },
  ]

  const settings = {
    policy: {
      version: 'v12',
      mode: '允许成员 + 点名',
      timeout: '15 分钟',
      model: 'claude-sonnet-4.5',
    },
    executor: {
      model: 'claude-sonnet-4.5',
      concurrency: 3,
      directory: '~/项目/DSH-SUPERAGENT',
      prepare: 'pnpm install --frozen-lockfile',
      paused: false,
    },
    deployment: {
      state: '~/.dsh/state/superagent',
      node: 'v24.18.1',
      dsh: '0.2.1-alpha.2',
      limits: '3 个仓库 · 3 并发',
    },
    setup: [
      {
        title: '连接 GitHub 账号',
        state: 'done',
        detail: 'lakii2982 · 已授权 contents、issues、pull requests',
      },
      {
        title: '选择本地仓库',
        state: 'done',
        detail: 'deepseek-ai/dsh-superagent-prototype · feat/multi-repository',
      },
      {
        title: '连接飞书机器人',
        state: 'warn',
        detail: '助手 · 15:42 连接中断，最后一条消息 15:41',
      },
      {
        title: '确定谁能接单',
        state: 'done',
        detail: '2 名成员 · 林舟、沈迟',
      },
    ],
  }

  /* 24px stroke icons, same visual family as the DSH icon set. */
  const icons = {
    inbox:
      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    board:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    settings:
      '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    search:
      '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    command:
      '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z"/>',
    alert:
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5L16 9"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    dot: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    play: '<path d="m6 3 15 9-15 9z"/>',
    pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
    refresh:
      '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m18 15-6-6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    branch:
      '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    message:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    github:
      '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    external:
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    folder:
      '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    bell:
      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    paperclip:
      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    stop: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    rotate: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    sparkles:
      '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M21 5h-4M5 17v3M6.5 18.5h-3"/>',
    server:
      '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    wifiOff:
      '<path d="m2 2 20 20"/><path d="M8.5 8.5A10.9 10.9 0 0 1 12 8c4 0 7 2 9 4"/><path d="M5 12a14.2 14.2 0 0 1 3.5-2.5"/><path d="M8.5 15.5a6.5 6.5 0 0 1 7 0"/><path d="M12 19h.01"/>',
    panelRight:
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    sliders:
      '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    gitMerge:
      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    pullRequest:
      '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M13 18h3a2 2 0 0 0 2-2v-1"/><path d="m4 15-2 3 2 3"/>',
    corner:
      '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    copy:
      '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
    dotGrid:
      '<circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="19" r="1" fill="currentColor" stroke="none"/>',
  }

  /** Escape text that is interpolated into an HTML template. */
  const esc = (value) =>
    String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  /** Return an inline icon. `cls` adds size or colour classes. */
  const icon = (name, cls) =>
    '<svg class="icon ' +
    (cls || '') +
    '" viewBox="0 0 24 24" aria-hidden="true">' +
    (icons[name] || icons.circle) +
    '</svg>'

  const sourceMeta = {
    feishu: { label: '飞书', icon: 'message', cls: 'source-feishu' },
    github: { label: 'GitHub', icon: 'github', cls: 'source-github' },
  }

  const stateMeta = {
    waiting: { label: '等待你', dot: 'dot-amber', badge: 'badge-amber' },
    blocked: { label: '受阻', dot: 'dot-red', badge: 'badge-red' },
    working: { label: '执行中', dot: 'dot-blue', badge: 'badge-blue' },
    queued: { label: '排队中', dot: 'dot', badge: 'badge' },
    merged: { label: '已合并', dot: 'dot-violet', badge: 'badge-violet' },
    ended: { label: '已结束', dot: 'dot', badge: 'badge' },
  }

  window.SA = {
    repo,
    user,
    needs,
    problems,
    flow,
    executor,
    running,
    recent,
    tickets,
    threads,
    decisions,
    dropped,
    sources,
    settings,
    icons,
    icon,
    esc,
    sourceMeta,
    stateMeta,
  }
})()
