# Agent Office

Agent Office 是一个本地优先的多代理编排层。它让 Codex、Claude Code 或任意支持 stdin/stdout 的模型工具，围绕同一任务共享目标、工作区、消息和交接状态，像同事一样轮流实现、审查、返工并完成任务。

当前版本包含可运行的编排 MVP 和本地实时控制台，不需要安装第三方运行时依赖。

如果希望直接使用全局命令：

```bash
cd /path/to/agent-office
npm install -g .
agent-office --help
```

## 已实现

- 共享任务：目标、参与者、状态、轮次和产物统一持久化。
- 同事邮箱：支持发给团队、指定代理或用户的结构化消息。
- 返工闭环：已完成的代理收到同事的直接消息后自动重新进入工作状态。
- 四类适配器：Codex CLI、Claude Code CLI、通用命令和离线 mock。
- 能力自动发现：读取本机 CLI 版本、Codex 模型目录、Claude 模型别名、MCP、插件和配置工具。
- 能力感知路由：发布任务时识别实现、审查、研究、写作、视觉、复杂度和速度诉求，自动选择代理、模型与推理强度。
- 可审计分配：每个任务持久化任务画像、模型匹配分、工具缺口、选择原因和执行顺序。
- 安全进程调用：不经过 shell 插值，带超时和输出上限。
- 可恢复状态：任务以原子 JSON 文件保存，事件另存为 append-only JSONL。
- 人工介入：代理可将任务置为 `awaiting_input`，用户回复后继续运行。
- 单写者保证：运行租约让同一任务不会被两个进程同时推进。
- 实时进度：回合运行期间可见当前代理、已运行时间和逐条活动，不再是数分钟的空白等待。
- 用量与费用：每个回合记录 token 与费用；token 跨提供方可比，费用只在提供方报告时出现。
- 失败可诊断：退出码与 stderr 直接出现在 CLI 输出和控制台，不必去翻事件日志。
- 有界增长：提示词有字符预算，事件日志会轮转，原始输出按上限裁剪。
- 工作区改动：git 工作区可直接查看本次协作产生的 diff。
- 可中断：控制台“停止运行”和 CLI 的 Ctrl+C 都会结束当前回合并保留任务进度。
- 崩溃可恢复：进程被杀死后残留的 `running` 任务会被识别为过期运行，可直接恢复。
- 真实验证：包含协议、并发持久化、通用适配器、协作闭环、运行生命周期，以及以真实 CLI 输出为基准的能力探测测试。

## 30 秒离线体验

要求 Node.js 20 或更高版本：

```bash
cd /path/to/agent-office
npm run demo
```

这个演示不调用模型、不产生 API 费用。它会跑完：

```text
builder 实现
  → reviewer 审查
    → reviewer 发出直接返工消息
      → builder 自动恢复并修复
        → task completed
```

## 本地可视化控制台

在已经执行过 `agent-office init` 的项目中启动：

```bash
agent-office serve
```

浏览器打开 [http://127.0.0.1:4177](http://127.0.0.1:4177)。控制台提供：

- 任务总数、活跃任务、需要人工关注的任务和累计代理回合；
- 每位代理的实时状态、角色、最新输出、回合数和更新时间；
- 当前可用的模型、工具/MCP/插件，以及每个任务的自动路由计划；
- 完整团队/点对点消息流与返工交接；
- 每个任务已产出的工作区文件（产物）及其报告者和时间；
- 每个回合的原始提供方输出（trace）与工作区 diff；
- 最近任务事件、服务运行时间、工作区和状态目录；
- 从界面创建任务、启动/停止/恢复协作，以及向团队或指定代理发送消息；
- 归档与删除任务、深色/浅色/跟随系统主题、任务列表键盘导航；
- SSE 实时更新，连接中断后自动重连，并有定时刷新兜底；
- 桌面和移动端响应式布局，正文对比度满足 WCAG AA。

控制台默认只绑定 `127.0.0.1`，服务端拒绝跨站写请求，也不提供远程绑定选项。

零成本体验控制台：

```bash
agent-office serve --config ./examples/team.dashboard-demo.json
```

然后在页面里新建任务并点击“启动协作”，可以看到 mock builder/reviewer 的完整返工闭环。

## 在真实项目里运行 Codex + Claude Code

先进入希望两位代理共同工作的代码库，然后初始化：

```bash
cd /path/to/your-project
/path/to/agent-office/bin/agent-office.js init
/path/to/agent-office/bin/agent-office.js doctor
```

创建任务：

```bash
/path/to/agent-office/bin/agent-office.js task create \
  --objective "实现健康检查端点，补齐测试，并由另一位代理审查"
```

命令会输出任务 ID。用它启动协作：

```bash
/path/to/agent-office/bin/agent-office.js run task-YYYYMMDD-xxxxxxxx --rounds 4
```

查看任务、对话和参与者状态：

```bash
/path/to/agent-office/bin/agent-office.js task show task-YYYYMMDD-xxxxxxxx
```

当代理等待决策时，回复整个团队或指定代理：

```bash
/path/to/agent-office/bin/agent-office.js message send task-YYYYMMDD-xxxxxxxx \
  --to codex \
  --body "兼容范围确定为 Node.js 20+，继续实现"

/path/to/agent-office/bin/agent-office.js run task-YYYYMMDD-xxxxxxxx
```

真实运行会调用本机已经登录的 Codex 和 Claude Code，可能产生模型用量并修改目标工作区。默认配置不会使用任何绕过权限或沙箱的危险选项：

- Codex 使用 `workspace-write` 沙箱。
- Claude Code 使用 `acceptEdits` 权限模式。
- 两者按轮次串行执行，避免同时写同一文件。

## 配置

`agent-office init` 在目标代码库生成 `agent-office.json`：

```json
{
  "version": 1,
  "workspace": ".",
  "stateDir": ".agent-office",
  "collaboration": {
    "maxRounds": 4,
    "transcriptMessages": 40,
    "turnTimeoutMs": 600000,
    "promptBudgetChars": 120000
  },
  "routing": {
    "enabled": true,
    "maxAgents": 2,
    "probeTimeoutMs": 10000,
    "cacheTtlMs": 300000
  },
  "retention": {
    "maxEventFileBytes": 5242880,
    "maxRunFiles": 500
  },
  "agents": [
    {
      "id": "codex",
      "adapter": "codex",
      "role": "Primary implementer. Make small, verified changes and report concrete evidence.",
      "sandbox": "workspace-write",
      "ephemeral": true
    },
    {
      "id": "claude",
      "adapter": "claude",
      "role": "Peer reviewer and collaborator. Inspect current work, fix valid issues, and communicate actionable findings.",
      "permissionMode": "acceptEdits",
      "noSessionPersistence": true
    }
  ]
}
```

`routing.enabled` 默认开启。Agent Office 不会为了“探测模型”发起付费模型请求：

- Codex 优先读取本机模型目录缓存，缺失时读取 CLI 自带目录；
- Claude Code 读取已安装 CLI 公布的滚动别名、显式 `model`、`models` 配置和模型环境变量；
- MCP、插件和工具只做只读枚举；
- Claude Code 会把无法识别的子命令当作提示词执行，因此所有子命令探测都先用 `--help` 的命令清单校验；读不到帮助文本时不做任何子命令探测；
- 无法确认账号是否真正有权调用某个 Claude 别名时，会标记为 `advertised`，不会伪装成已验证访问；
- 已知但当前 CLI 不公布的别名标记为 `unverified`：它们在能力清单里可见，但不会被自动路由选中，除非在配置里显式声明。

可以为私有模型、网关或组织策略补充能力评分（1–5），自动发现结果会与配置合并：

```json
{
  "id": "claude",
  "adapter": "claude",
  "models": [
    {
      "id": "company-sonnet",
      "label": "Company Sonnet",
      "capabilities": {
        "coding": 5,
        "review": 4,
        "reasoning": 4,
        "research": 3,
        "writing": 4,
        "vision": 5,
        "speed": 4,
        "costEfficiency": 3
      }
    }
  ]
}
```

认证仍由各工具自己管理。不要把 API key 写进配置文件；如有需要，通过启动 Agent Office 的进程环境传入。

## 接入其他工具或模型

任何可以从 stdin 读取完整协作提示、并向 stdout 输出 [Turn Protocol](docs/protocol.md) JSON 的程序，都能通过 `command` 适配器接入：

```json
{
  "id": "local-model",
  "adapter": "command",
  "role": "分析当前实现并给出可执行交接。",
  "command": "./my-agent",
  "args": [
    "--workspace",
    "{{workspace}}",
    "--schema",
    "{{schema}}"
  ]
}
```

支持的参数占位符：

- `{{workspace}}`：共享工作区绝对路径。
- `{{agentId}}`：当前代理 ID。
- `{{schema}}`：Turn Protocol JSON Schema 路径。

进程启动不经过 shell；配置里的参数不会被当作命令替换或管道执行。

## CLI

```text
agent-office init [directory]
agent-office doctor [--config path]
agent-office capabilities [--refresh] [--objective "..."] [--json] [--config path]
agent-office task create --objective "..." [--config path]
agent-office task list [--all] [--config path]
agent-office task show <task-id> [--json] [--config path]
agent-office task archive <task-id> [--config path]
agent-office task unarchive <task-id> [--config path]
agent-office task delete <task-id> --yes [--config path]
agent-office message send <task-id> --body "..." [--to agent|team] [--config path]
agent-office run <task-id> [--rounds N] [--config path]
agent-office serve [--host 127.0.0.1] [--port 4177] [--config path]
agent-office demo
```

## 状态与审计

目标工作区下的 `.agent-office/` 包含：

```text
.agent-office/
├── events.jsonl        # append-only 事件记录（超限轮转为 events.jsonl.1）
├── leases/             # 正在进行的运行的持有者（进程、主机、开始时间）
├── runs/               # 每次模型/命令调用的原始输出
└── tasks/
    └── task-....json   # 可恢复任务快照
```

项目默认将该目录加入 `.gitignore`。如果任务状态需要跨机器共享，应由上层系统明确选择加密存储或可信数据库，不建议直接提交模型原始输出。

## 设计边界

MVP 有意采用确定性的串行轮次，而不是让多个编码代理同时修改相同目录。它已经解决“共同目标、同事消息、交接、返工、恢复和审计”，暂未包含：

- 跨机器调度或中心服务；
- 并行 worktree 隔离与自动合并；
- 超出预算时自动停止（用量只记录和展示，不强制执行）、速率限制和组织级审批策略；
- Codex 的美元费用（该 CLI 只上报 token，因此混合任务的费用合计是部分值）；
- 对 Claude 账号模型权限做无费用的强验证（CLI 当前没有稳定的模型目录枚举命令，系统会区分 `advertised`、`unverified` 与 `configured`）；
- 长期知识库、向量检索或上下文压缩（超预算的旧消息是被丢弃，不是被摘要）。

这些能力可以在现有任务、事件和适配器接口之上增加，不需要改写代理协议。

完整的使用说明、状态机、API 参考、安全模型和故障排查见[用户手册](docs/user-manual.md)。

## 开发与验证

```bash
npm run check
```

项目只使用 Node.js 内置模块，因此不需要 `npm install`。

更多设计说明见 [架构文档](docs/architecture.md) 和 [协作协议](docs/protocol.md)。
