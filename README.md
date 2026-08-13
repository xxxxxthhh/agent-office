# Agent Office

Agent Office 是一个本地优先的多工具工作流控制面。它让 Codex、Claude Code、Shell 和 Herdr 围绕同一任务共享目标、DAG、消息、审批和交接状态，像同事一样并行分析、隔离实现、审查、返工并完成任务。

0.4 版同时保留原有串行轮次，并加入 Herdr 持久运行时、ready-set 并行、join barrier、worktree 写入隔离、结构化 attempt result、人工 gate 和 `ff-only` 发布。核心仍只依赖 Node.js 内置模块；Herdr 是可选运行时。

这里的 “v2” 指 `mode: "workflow"` 的任务快照；配置文件和 workflow definition 当前仍使用 `version: 1`。

第一次使用请从 [Agent Office 开始工作手册](docs/getting-started.zh-CN.md) 开始。

跨工具并行工作流请直接看 [Agent Office v2：Herdr 工作流手册](docs/workflows.zh-CN.md)。

如果希望直接使用全局命令：

```bash
cd /path/to/agent-office
npm install -g .
agent-office --help
```

## 已实现

- 共享任务：目标、参与者、状态、轮次和产物统一持久化。
- DAG 调度：并行执行 ready-set，依赖自然形成 fan-out、fan-in 与 join barrier。
- Herdr Runtime：可选地接管 workflow agent 节点，使用专用命名 session 保留交互式进程，并校验 workspace、pane 和 agent session 身份。
- 安全写入：唯一 writer 使用隔离 worktree，完整快照校验 write scopes、ignored 文件、Git 元数据和外部符号链接。
- 发布门：含写入的工作流强制要求 writer 之后的人工 approval 与 Agent Office 独占的 `ff-only` integration；示例把独立 review/QA 明确放在 approval 之前。
- 可恢复执行：任务租约 heartbeat、attempt token、Herdr result drop、迟到结果拒绝，以及 retry/rework 后的下游重开。
- 同事邮箱：支持发给团队、指定代理或用户的结构化消息。
- 返工闭环：已完成的代理收到同事的直接消息后自动重新进入工作状态。
- 四类适配器：Codex CLI、Claude Code CLI、通用命令和离线 mock。
- 能力自动发现：读取本机 CLI 版本、Codex 模型目录、Claude 模型别名、MCP、插件和配置工具。
- 能力感知路由：发布任务时识别实现、审查、研究、写作、视觉、复杂度和速度诉求，自动选择代理、模型与推理强度。
- 可审计分配：每个任务持久化任务画像、模型匹配分、工具缺口、选择原因和执行顺序。
- 安全进程调用：不经过 shell 插值，带超时和输出上限。
- 可恢复状态：任务以原子 JSON 文件保存，事件另存为 append-only JSONL。
- 人工介入：代理可将任务置为 `awaiting_input`，用户回复后继续运行。
- 真实验证：包含协议、并发持久化、通用适配器和协作闭环测试。

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
- 最近任务事件、服务运行时间、工作区和状态目录；
- 从界面创建任务、启动/继续协作，以及向团队或指定代理发送消息；
- SSE 实时更新，连接中断后自动重连，并有定时刷新兜底；
- 桌面和移动端响应式布局。

控制台默认只绑定 `127.0.0.1`，服务端拒绝跨站写请求，也不提供远程绑定选项。
工作流视图可显示节点状态、批准 gate、重试失败/阻塞节点，以及显式重开成功的 agent/command 节点做返工；即使 attempt 配额已耗尽，符合条件的人工返工操作仍会显示。

零成本体验控制台：

```bash
agent-office serve --config ./examples/team.dashboard-demo.json
```

然后在页面里新建任务并点击“启动协作”，可以看到 mock builder/reviewer 的完整返工闭环。

## 本地控制 API 与手机访问

Dashboard 使用同一个 TaskStore 和调度器。当前固定接口包括：

```text
GET  /api/health
GET  /api/capabilities
GET  /api/tasks
GET  /api/tasks/<task-id>
GET  /api/events?limit=<n>
GET  /api/stream
POST /api/capabilities/refresh
POST /api/tasks
POST /api/tasks/<task-id>/messages
POST /api/tasks/<task-id>/run
POST /api/tasks/<task-id>/nodes/<node-id>/approve
POST /api/tasks/<task-id>/nodes/<node-id>/retry
```

`POST /api/tasks` 创建兼容的串行任务；当前没有通过 HTTP 上传 workflow definition 的接口，v2 仍使用 `agent-office workflow create --file ...`。控制 API 不提供任意命令编辑入口。

服务只接受 loopback Host，并拒绝带有不同 Origin 的跨站写请求。手机应通过 SSH 或 Tailscale SSH 在手机端建立本地端口转发，不要把服务绑定到 `0.0.0.0`：

```bash
ssh -N -L 4177:127.0.0.1:4177 user@your-mac
```

然后在建立转发的设备打开 `http://127.0.0.1:4177`。更多操作与安全边界见 [v2 工作流手册](docs/workflows.zh-CN.md)。

## 在真实项目里运行 Codex + Claude Code

下面是兼容保留的串行轮次模式。若要跨工具并行、Herdr 持久 session 和 worktree 发布门，请使用 [v2 工作流](docs/workflows.zh-CN.md)。

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
- 串行模式仍按轮次执行。v2 允许只读任务并行，但写入只发生在唯一隔离 worktree。

## 配置

`agent-office init` 在目标代码库生成 `agent-office.json`：

```json
{
  "version": 1,
  "workspace": ".",
  "stateDir": "/Users/you/.local/state/agent-office/project-hash",
  "collaboration": {
    "maxRounds": 4,
    "transcriptMessages": 40,
    "turnTimeoutMs": 600000
  },
  "routing": {
    "enabled": true,
    "maxAgents": 2,
    "probeTimeoutMs": 10000,
    "cacheTtlMs": 300000
  },
  "execution": {
    "runtime": "process",
    "maxConcurrency": 4,
    "leaseTimeoutMs": 60000,
    "snapshotMaxFiles": 50000,
    "herdrCommand": "herdr",
    "herdrSession": "agent-office",
    "herdrServerMode": "external",
    "herdrPathPrefixes": [],
    "keepAgents": true
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

`agent-office init` 会为当前项目生成带哈希的外部 `stateDir`，默认位于 `~/.local/state/agent-office/`。v2 在创建工作流时会拒绝位于 executor workspace 内的控制状态；旧串行任务仍兼容显式配置的 `.agent-office`。

`execution.runtime` 默认为 `process`，也可以由单个 workflow 的 `runtime` 覆盖。`runtime: "herdr"` 只影响 `agent` 节点；`command` 和 `integration` 始终由本地 Process Runtime 执行。`herdrServerMode: "external"` 只连接专用 session，不替用户启动或停止它；`managed` 会启动并记录独立 server。`herdrPathPrefixes` 只会把绝对目录前置到 Agent Office 启动的 managed server 进程所继承的 `PATH`。后续 login shell 或 agent launcher 仍可能重排 `PATH`；部署后应在实际 agent 执行上下文中分别运行 `command -v codex` 和 `command -v codex-code-mode-host`（或对应的相邻 helper），核验它们来自预期安装。0.4 会保留 Herdr agent、server 和 worktree，便于审计与恢复，不做自动清理。

`routing.enabled` 默认开启。Agent Office 不会为了“探测模型”发起付费模型请求：

- Codex 优先读取本机模型目录缓存，缺失时读取 CLI 自带目录；
- Claude Code 读取已安装 CLI 公布的滚动别名（包括 `fable`）、完整模型名、显式 `model`、`models` 配置和模型环境变量；
- 未显式配置 `command` 时，会比较 PATH 中的 Claude Code 与官方原生安装位置 `~/.local/bin/claude`，使用版本较新的一份；显式 `command` 始终优先；
- MCP、插件和工具只做只读枚举；
- 无法确认账号是否真正有权调用某个 Claude 别名时，会标记为 `advertised`，不会伪装成已验证访问。

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

- `{{workspace}}`：当前解析后的工作区绝对路径；串行任务是共享工作区，v2 可能是隔离 worktree。
- `{{agentId}}`：当前代理 ID。
- `{{schema}}`：Turn Protocol JSON Schema 路径。

进程启动不经过 shell；配置里的参数不会被当作命令替换或管道执行。

## CLI

```text
agent-office init [directory]
agent-office doctor [--config path]
agent-office capabilities [--refresh] [--objective "..."] [--json] [--config path]
agent-office task create --objective "..." [--config path]
agent-office task list [--config path]
agent-office task show <task-id> [--json] [--config path]
agent-office workflow create --objective "..." --file workflow.json [--config path]
agent-office workflow approve <task-id> <node-id> [--config path]
agent-office workflow retry <task-id> <node-id> [--config path]
agent-office message send <task-id> --body "..." [--to agent|team] [--config path]
agent-office run <task-id> [--rounds N] [--config path]
agent-office serve [--host 127.0.0.1] [--port 4177] [--config path]
agent-office demo
```

`workflow retry` 不会立即执行节点，只把它恢复为可调度状态，之后仍需再次 `run`。对 `failed` 或尚未发布的 `succeeded` agent/command 节点，每次显式 retry 都会授权一次新的人工 attempt，即使历史 `attempts` 已达到或超过 `maxAttempts`；原 attempt 计数不会回退。`maxAttempts` 仍只约束 `status: "working"` 触发的自动续跑，因此超额的人工 attempt 若仍返回 `working`，会再次失败并等待下一次显式 retry。成功节点 rework 会重置 review、QA、approval 和 integration 等全部下游。只有明确返回 `blocked` 的 attempt 在 retry 时退还一次配额。`approval`、成功的 integration、已经成功发布后的上游节点，以及存在活动节点或有效租约时仍拒绝 retry；失败的 integration 可在修复目标分支关系后 retry，并复用已持久化的精确发布意图。

## 状态与审计

配置的 `stateDir` 包含：

```text
<stateDir>/
├── .write-lock/                  # 仅持锁时存在
├── events.jsonl                  # append-only 事件记录
├── runs/                         # 模型、命令和 Herdr trace
├── tasks/task-....json           # 原子写入的可恢复任务快照
├── herdr-server.log              # managed Herdr 模式按需产生
└── herdr-server-owner.json       # managed Herdr owner 记录
```

Herdr attempt result drop 位于操作系统临时目录的 `<task-id>/<node-id>/<attemptToken>.json`，不在 `stateDir`；只有 token 匹配的当前 attempt 才会进入任务快照。如果任务状态需要跨机器共享，应由上层系统明确选择加密存储或可信数据库，不建议直接提交模型原始输出。

## 设计边界

串行任务仍使用确定性轮次；v2 工作流允许只读并行，并把唯一 writer 隔离到 worktree。当前明确不包含：

- 跨机器调度或中心服务；
- 多个写 worktree 的自动合并、rebase 或冲突解决；
- 自动清理 worktree、Herdr agent 或 managed server；
- 预算、速率限制和组织级审批策略；
- 对 Claude 账号模型权限做无费用的强验证（CLI 当前没有稳定的模型目录枚举命令，系统会区分 `advertised` 与 `configured`）；
- 长期知识库或向量检索。

这些能力可以在现有任务、事件和适配器接口之上增加，不需要改写代理协议。

## 开发与验证

```bash
npm run check
```

项目只使用 Node.js 内置模块，因此不需要 `npm install`。

更多设计说明见 [架构文档](docs/architecture.md) 和 [协作协议](docs/protocol.md)。
