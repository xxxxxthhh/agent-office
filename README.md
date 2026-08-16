# Agent Office

Agent Office 是一个本地优先的多代理编排层。它让 Codex、Claude Code 或任意支持 stdin/stdout 的模型工具，围绕同一任务共享目标、工作区、消息和交接状态，像同事一样轮流实现、审查、返工并完成任务。

当前版本包含可运行的编排 MVP 和本地实时控制台，不需要安装第三方运行时依赖。

## 已实现

- 共享任务：目标、参与者、状态、轮次和产物统一持久化。
- DAG 工作流：`mode: "workflow"` 的任务按 ready-set 并行调度，依赖形成 fan-out / join。
- 隔离写入：唯一 writer 使用 git worktree；含写入的工作流在发布前需要人工 approval 和 `ff-only` integration。
- 可选 Herdr 运行时：`execution.runtime` 可为 `process` 或 `herdr`；Herdr 只接管 `agent` 节点。
- 同事邮箱：支持发给团队、指定代理或用户的结构化消息。
- 返工闭环：已完成的代理收到同事的直接消息后自动重新进入工作状态。
- 四类适配器：Codex CLI、Claude Code CLI、通用命令和离线 mock。
- 能力自动发现：读取本机 CLI 版本、Codex 模型目录、Claude 模型别名、MCP、插件和配置工具。
- 能力感知路由：发布任务时识别实现、审查、研究、写作、视觉、复杂度和速度诉求，自动选择代理、模型与推理强度。
- 可审计分配：每个任务持久化任务画像、模型匹配分、工具缺口、选择原因和执行顺序。
- 安全进程调用：不经过 shell 插值，带超时和输出上限。
- 可恢复状态：任务以原子 JSON 文件保存，事件另存为 append-only JSONL。
- 人工介入：代理可将任务置为 `awaiting_input`，用户回复后继续运行。
- 单写者保证：任务级租约加上工作区根目录的原子锁；同机存活进程永不被自动接管，锁被夺走时原运行自我中止（fence），跨任务、跨配置、跨符号链接别名都只允许一个写者。
- 实时进度：回合运行期间可见当前代理、已运行时间和逐条活动，不再是数分钟的空白等待。
- 用量与费用：每个回合记录 token 与费用；token 跨提供方可比，费用只在提供方报告时出现。
- 失败可诊断：退出码与 stderr 直接出现在 CLI 输出和控制台，不必去翻事件日志。
- 有界增长：提示词有字符预算，事件日志会轮转，原始输出按上限裁剪。
- 工作区改动：按任务基线区分“本任务改的”与“任务开始前就已修改的”；任务前的脏文件被任务再次修改时，补丁对着基线内容快照生成，不泄漏任务前的改动。
- 可中断：控制台“停止运行”和 CLI 的 Ctrl+C 终止整个进程树，轮询确认进程组消失后才释放锁，并保留任务进度。
- 崩溃可恢复：进程被杀死后残留的 `running` 任务会被识别为过期运行，可直接恢复。
- 真实验证：包含协议、并发持久化、通用适配器、协作闭环、运行生命周期，以及以真实 CLI 输出为基准的能力探测测试。

## 安装

要求 Node.js 20 或更高版本。项目只用 Node 内置模块，不需要 `npm install`。

```bash
git clone https://github.com/xxxxxthhh/agent-office.git
cd agent-office
npm install -g .
agent-office --version
```

真实协作还需要至少一个已登录的代理 CLI（[Codex CLI](https://github.com/openai/codex) 或 [Claude Code](https://claude.com/claude-code)）。两个都没有也能跑离线演示和控制台。

## 30 秒离线体验

不调用模型、不产生费用：

```bash
agent-office demo
```

它会完整跑一遍协作闭环：

```text
builder 实现
  → reviewer 审查
    → reviewer 发出直接返工消息
      → builder 自动恢复并修复
        → task completed
```

想在界面里看同一个闭环：

```bash
agent-office demo --dashboard
```

这会用随包发布的 mock 团队起一个控制台（临时目录，退出即清理），在页面里新建任务并点"启动协作"即可。

## 5 分钟上手

### 1. 初始化

```bash
cd /path/to/your-project
agent-office init
```

`init` 生成 `agent-office.json`，并打印它写入了哪些代理：

```text
Created /path/to/your-project/agent-office.json
Agents: codex, claude
Next: agent-office doctor
```

- 代理按 **PATH 上实际存在的 CLI** 选择。只装了一个就只写一个；两个都没有则两个都写作模板，并提示先装一个。
- `--agents codex` / `--agents codex,claude` 可显式指定。
- `stateDir` 写在**工作区之外**（`$XDG_STATE_HOME` 或 `~/.local/state/agent-office/<项目名>-<摘要>`）。这是 v2 工作流的硬性要求：控制状态不能落在执行代理可写的目录里，否则代理可以篡改任务、attempt token 和审批记录。

### 2. 体检

```bash
agent-office doctor
```

```text
Workspace: /path/to/your-project
State: /Users/you/.local/state/agent-office/your-project-1a2b3c4d
✓ codex (Codex CLI) — codex-cli 0.4x — sandbox=workspace-write
  Models (8): …
  Tools (6): …
✓ claude (Claude Code CLI) — 2.x — permissionMode=acceptEdits
✓ workflows: control state is outside the workspace
```

怎么读：

| 行 | 含义 |
| --- | --- |
| `✓ <id>` | 该代理的 CLI 找得到、版本读得出，可以参与任务 |
| `✗ <id>` | CLI 不可用；`doctor` 以 1 退出，`start` 不会启动控制台 |
| `! command not found …` | `command` 适配器指向的可执行文件不存在（同样以 1 退出） |
| `✓ / ✗ herdr runtime` | 仅当 `execution.runtime` 为 `herdr` 时出现 |
| `✓ workflows` / `! workflows unavailable` | 控制状态是否在工作区之外。不影响退出码：串行任务在哪都能跑 |

### 3. 第一个任务

```bash
agent-office task create --objective "实现健康检查端点，补齐测试，并由另一位代理审查"
```

命令输出任务 ID（`task-YYYYMMDD-xxxxxxxx`）。如果本机没有任何可用代理 CLI，这里会额外打印一条路由回退警告——继续 `run` 会以 `spawn … ENOENT` 失败。

```bash
agent-office run task-20260815-1a2b3c4d --rounds 4
```

运行期间可以看到当前代理、已运行时长和逐条活动。`Ctrl+C` 会终止整个进程树，确认进程组消失后才释放锁，任务进度保留。

## 串行任务

串行任务按轮次推进：每一轮里，每个还没完成的代理依次拿到目标、可见消息和工作区，产出一个 [Turn Protocol](docs/protocol.md) 结果。

```bash
agent-office task list                 # 未归档任务
agent-office task list --all           # 含归档
agent-office task show <task-id>       # 目标、参与者、消息、产物
agent-office task show <task-id> --json
agent-office task archive <task-id>
agent-office task unarchive <task-id>
agent-office task delete <task-id> --yes
```

任务状态：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `ready` | 可以运行 | `agent-office run <id>` |
| `running` | 正在运行；有进程持有租约 | 等待，或 `Ctrl+C` / 控制台"停止运行" |
| `awaiting_input` | 代理要人做决定 | `message send` 后再 `run` |
| `completed` | 全部代理完成 | — |
| `failed` | 失败并给出原因 | 按 CLI 打印的恢复命令处理 |

代理停下来问问题时，回复团队或指定代理，然后继续：

```bash
agent-office message send <task-id> --to codex --body "兼容范围确定为 Node.js 20+，继续实现"
agent-office run <task-id>
```

`--to` 可以是代理 ID 或 `team`（默认）。已完成的代理收到发给它的直接消息会自动重新进入工作状态——这就是返工闭环。

## v2 工作流（DAG）

工作流把任务拆成有依赖关系的节点：只读节点并行跑，写入集中在**唯一一个隔离 worktree**，发布前必须有人工审批，最后以 `ff-only` 合回目标分支。适合"两个模型交叉审查后再落盘"这种场景。

前提：工作区是 Git 仓库，**且至少有一个提交**（写入节点要从 HEAD 开一个 worktree）。

### 最短路径

```bash
agent-office workflow create \
  --objective "实现一个边界安全的功能，补齐测试并通过独立审查" \
  --example process-review

agent-office run <task-id>                       # 跑到审批门停下
agent-office workflow approve <task-id> gate     # 人工审批
agent-office run <task-id>                       # 发布
```

`--example` 用随包发布的 definition，全局安装也能用：

- `process-review`：本地 Process Runtime，不需要 Herdr，也不假设项目里有 `npm test`；
- `herdr-feature`：Herdr 常驻 session，QA 节点跑 `npm test`，适合 Node 项目。

自己写的 definition 用 `--file workflow.json`（两者不能同时给）。

只装了一个代理 CLI 时，随包 definition 里的另一个 owner 会报错并告诉你怎么办；显式改派即可：

```bash
agent-office workflow create --objective "..." --example process-review --owner codex
```

`--owner` 把 definition 里所有 `agent` 节点改派给同一个代理（审查因此变成自审）。Agent Office 不会自动做这件事——改派是你的选择。

### 节点类型

| 类型 | 做什么 | 关键字段 |
| --- | --- | --- |
| `agent` | 由配置里的代理执行一个回合 | `owner`、`access`、`prompt` |
| `command` | 直接启动命令（不经 shell），退出码决定成败 | `command`、`args`、`env` |
| `approval` | 停下来等人批准 | `prompt` |
| `integration` | 把 writer 的 worktree 以 `ff-only` 发布到目标分支 | `source` |

节点字段：

- `dependsOn`：依赖的节点 ID，形成 DAG；没有依赖关系的节点并行调度（受 `execution.maxConcurrency` 限制）。
- `access`：`read_only`（默认）或 `write`。v1 工作流最多一个 integration 节点；一旦有 integration，就必须恰好有一个 `write` 节点，且它必须是 integration 的 `source`。
- `workspace: "worktree"`：写入节点必须用隔离 worktree。
- `workspaceFrom: "<node-id>"`：在另一个节点的 worktree 里只读地跑（审查节点看的就是 writer 改出来的树）。
- `writeScopes`：写入节点必须声明可写路径（glob）。越界改动会让节点失败并污染该 worktree。
- `maxAttempts`：自动重试上限。

### 审批、返工与重试

```bash
agent-office workflow approve <task-id> <node-id>   # 放行 approval 节点
agent-office workflow retry   <task-id> <node-id>   # 重开失败节点，或让已成功的 writer 返工
```

- 重开已成功的 writer 会保留它的 worktree，并重置下游的审查、审批和发布节点：返工后的内容才是发布出去的内容。
- 发布成功后不能再重开。
- 运行失败时 CLI 会直接列出可执行的恢复命令，不用自己去翻是哪个节点挂了。

### Herdr（可选）

`execution.runtime: "herdr"` 让 `agent` 节点跑在 Herdr 常驻 session 里（`command` 和 `integration` 始终走本地 Process Runtime）。跨工具并行、持久 session 与发布门的完整操作见 [v2 工作流手册](docs/workflows.zh-CN.md)。

## 本地可视化控制台

最短入口：

```bash
cd /path/to/your-project
agent-office start
```

`start` 检查当前目录是否已有 `agent-office.json`；没有时先在终端请求确认，确认后按 PATH 上实际找到的代理 CLI 生成配置（`--agents` 可显式指定）。随后运行体检，只有配置中的代理都可用才启动控制台，并在监听成功后自动打开浏览器。`--host` / `--port` 可改绑定（4177 被占用时不必放弃这条路径）。

macOS 上，如果当前进程没有显式的 `HTTP_PROXY` / `HTTPS_PROXY`，启动器会继承系统网络设置中的代理（例如 Clash Verge），供不直接读取 macOS 系统代理的无头 CLI 使用；`agents[].env` 仍可覆盖它。当前终端是服务的进程宿主，`Ctrl+C` 会安全停止控制台和它启动的运行。

已经 `init` 过的项目也可以只起服务：

```bash
agent-office serve [--host 127.0.0.1] [--port 4177] [--open]
```

浏览器打开 [http://127.0.0.1:4177](http://127.0.0.1:4177)。控制台提供：

- 任务总数、活跃任务、需要人工关注的任务和累计代理回合；
- 每位代理的实时状态、角色、最新输出、回合数和更新时间；
- 当前可用的模型、工具/MCP/插件，以及每个任务的自动路由计划；
- 完整团队/点对点消息流与返工交接；
- 每个任务的上报产物、每个回合的原始提供方输出（trace）与工作区 diff；
- 最近任务事件、服务运行时间、工作区、状态目录，以及工作区是否处于隔离状态；
- 从界面创建任务、启动/停止/恢复协作、发送消息、审批与重试工作流节点；
- 归档与删除任务、深色/浅色/跟随系统主题、任务列表键盘导航；
- SSE 实时更新，断线自动重连，并有定时刷新兜底；
- 桌面和移动端响应式布局，正文对比度满足 WCAG AA。

控制台默认只绑定 `127.0.0.1`，服务端拒绝跨站写请求，也不提供远程绑定选项。

## 真实运行的安全边界

真实运行会调用本机已登录的 Codex 和 Claude Code，可能产生模型用量并修改目标工作区。默认配置不使用任何绕过权限或沙箱的选项：

- Codex 使用 `workspace-write` 沙箱；
- Claude Code 使用 `acceptEdits` 权限模式；
- 串行任务按轮次执行；v2 工作流只读节点可并行，写入只发生在唯一隔离 worktree，且发布前必须人工审批。

**单写者保证**：任务级租约 + 工作区根目录的原子锁，跨任务、跨配置、跨符号链接别名都只允许一个写者。同机存活进程永不被自动接管；锁被夺走时原运行自我中止。若一次运行结束时**无法证明**代理进程已经停止，工作区会被隔离（fenced），任何新运行都会被拒绝，直到人确认代理已停止并删除错误信息里指名的那个文件。

## 常见问题

| 错误信息 | 含义与处理 |
| --- | --- |
| `Workspace ... is fenced after an unproven stop` | 上次运行无法证明代理已停止。确认进程确实没了（`ps`、Herdr 面板），再删除信息里指名的文件 |
| `Workspace ... is already in use by task ...` | 另一个运行持有工作区锁。停掉那个运行；确认进程已死后可删除信息里指名的 `.agent-office.lock` |
| `... has no commits yet` | 写入节点要从 HEAD 开 worktree。先在仓库里做一个初始提交 |
| `Node "x" references unknown agent "y"` | definition 里的 owner 不在配置里。用 `--owner <agent-id>` 改派，或改 definition |
| `doctor` 打印 `! workflows unavailable` | `stateDir` 在工作区内（通常是老配置）。改成工作区之外的绝对路径 |
| `Integration target must be clean before ff-only publication` | 目标工作区有未提交改动。提交或 stash 后重试发布节点 |
| `Integration target diverged from prepared base` | 发布过程中目标分支前进了。恢复目标分支关系后重试，Agent Office 不会自动 rebase 你的提交 |
| 任务 `failed` 后直接重跑没反应 | 串行任务先 `message send`，工作流先 `workflow retry <task-id> <node-id>`；CLI 会把具体命令打出来 |

更完整的状态机、API 参考、安全模型和故障排查见[用户手册](docs/user-manual.md)。

## 配置

`agent-office init` 在目标代码库生成 `agent-office.json`：

```json
{
  "version": 1,
  "workspace": ".",
  "stateDir": "/Users/you/.local/state/agent-office/my-project-1a2b3c4d",
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
  "execution": {
    "runtime": "process",
    "maxConcurrency": 4,
    "leaseTimeoutMs": 60000,
    "snapshotMaxFiles": 50000,
    "herdrCommand": "herdr",
    "herdrSession": "agent-office",
    "herdrServerMode": "external",
    "herdrPathPrefixes": []
  },
  "agents": [
    {
      "id": "codex",
      "adapter": "codex",
      "role": "Primary implementer. Make small, verified changes and report concrete evidence.",
      "sandbox": "workspace-write",
      "ephemeral": true,
      "herdrArgs": ["--sandbox", "workspace-write", "--ask-for-approval", "never"]
    },
    {
      "id": "claude",
      "adapter": "claude",
      "role": "Peer reviewer and collaborator. Inspect current work, fix valid issues, and communicate actionable findings.",
      "permissionMode": "acceptEdits",
      "noSessionPersistence": true,
      "herdrArgs": ["--permission-mode", "acceptEdits"]
    }
  ]
}
```

`agent-office init` 把 `stateDir` 写在工作区之外（`$XDG_STATE_HOME` 或 `~/.local/state/agent-office/<项目名>-<摘要>`），v2 工作流因此开箱可用；省略该字段的旧配置仍按项目内 `.agent-office` 解析，那种配置会被 `workflow create` 拒绝。`execution.runtime` 默认为 `process`；`runtime: "herdr"` 只影响 `agent` 节点。

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
agent-office init [directory] [--agents codex,claude]
agent-office start [--host 127.0.0.1] [--port 4177] [--agents codex,claude]
agent-office doctor [--config path]
agent-office capabilities [--refresh] [--objective "..."] [--json] [--config path]
agent-office task create --objective "..." [--config path]
agent-office task list [--all] [--config path]
agent-office task show <task-id> [--json] [--config path]
agent-office task archive <task-id> [--config path]
agent-office task unarchive <task-id> [--config path]
agent-office task delete <task-id> --yes [--config path]
agent-office workflow create --objective "..." (--example NAME | --file workflow.json) [--owner agent-id] [--config path]
agent-office workflow approve <task-id> <node-id> [--config path]
agent-office workflow retry <task-id> <node-id> [--config path]
agent-office message send <task-id> --body "..." [--to agent|team] [--config path]
agent-office run <task-id> [--rounds N] [--config path]
agent-office serve [--host 127.0.0.1] [--port 4177] [--open] [--config path]
agent-office demo [--dashboard] [--host 127.0.0.1] [--port 4177]
agent-office --version
```

## 状态与审计

目标工作区下的 `.agent-office/` 包含：

```text
.agent-office/
├── events.jsonl        # append-only 事件记录（超限轮转为 events.jsonl.1）
├── leases/             # 任务级运行租约（进程、主机、开始时间）
├── runs/               # 每次调用的原始输出（Codex 另存 *.codex.jsonl 事件流）
└── tasks/
    └── task-....json   # 可恢复任务快照
```

`agent-office init` 生成的配置把这个目录放在工作区之外（`$XDG_STATE_HOME` 或 `~/.local/state/agent-office/<项目名>-<摘要>`）：控制状态因此不落在执行代理可写的目录里，v2 工作流也才允许运行。若你手工把 `stateDir` 指回项目内，记得自行加进 `.gitignore`。如果任务状态需要跨机器共享，应由上层系统明确选择加密存储或可信数据库，不建议直接提交模型原始输出。

## 设计边界

串行任务仍使用确定性轮次；v2 工作流允许只读并行，并把唯一 writer 隔离到 worktree。当前明确不包含：

- 跨机器调度或中心服务；
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

测试有两层挂起防护：每个测试文件内置句柄看门狗（worker 存活超过 120 秒即打印持有句柄并失败退出），整个 `node --test` 运行由 `tools/run-tests.mjs` 从外部监督（默认 240 秒死线，`AGENT_OFFICE_TEST_DEADLINE_MS` 可调）。supervisor 为每次运行注入唯一 PID ledger：Node 后代会按进程实例自登记，Node（含 Worker thread）发起的直接子进程也会在 spawn 时登记，所以清理不依赖 `ps`，launcher 退出、后代被重新挂到 PID 1 或另建进程组后仍可定位；正常完成同样会清理登记进程。超时打印 ledger 中的存活进程、强制清理并以 124 退出；`SIGINT`/`SIGTERM` 会先转发、再升级清理，连续信号也不会绕过 supervisor。Windows 使用登记 PID 强制终止再辅以 `taskkill /T`，但本项目只在 macOS 验证过该轮回归。进程实例 ID 可防止延迟 stop 误删新记录；若进程异常消失后 OS 在同一次短测试内立刻复用其 PID，缺少 job object/pidfd 的平台仍无法从 PID 本身证明代际。另一条已知逃逸链：若某个 Node 中间进程被显式剥离 `NODE_OPTIONS` 启动（它本身仍会被父进程在 spawn 现场登记），它再派生的 detached 后代既不在 ledger 也不在 runner 进程组内，清理无法覆盖——第一方测试不使用该模式，彻底关闭同样需要 pidfd/job object 一类的 OS 级句柄。发布包包含这套测试，并通过真实打包安装回归确认 `npm test` 至少执行一个测试，不会以零测试假绿。任何防护触发都是确定性失败，而不是静默等待。

更多设计说明见 [架构文档](docs/architecture.md)、[协作协议](docs/protocol.md) 和[一键启动器与桌面壳实施计划](docs/future-launcher-plan.md)。
