# Agent Office 用户手册

适用版本：0.4.0

本手册描述 Agent Office 当前**实际实现**的行为。文末的[明确不包含的能力](#15-明确不包含的能力)列出了已知边界，请一并阅读。

> **已验证环境**：本手册描述的行为在 macOS 上针对 **Codex CLI 0.146.0-alpha.9.2** 与 **Claude Code 2.1.220** 实际执行过完整回合（真实调用模型、真实写入工作区文件），能力探测的解析结果以这两个版本的真实输出为基准。其他版本的 CLI 若改变命令行接口或输出格式，可能需要相应调整——`agent-office doctor` 会报告探测阶段的问题，但**它只验证 CLI 可用性，不验证回合级协议兼容性**。

---

## 目录

1. [Agent Office 是什么](#1-agent-office-是什么)
2. [先决条件与安装](#2-先决条件与安装)
3. [五分钟上手](#3-五分钟上手)
4. [在真实项目里运行](#4-在真实项目里运行)
5. [配置参考](#5-配置参考)
6. [CLI 参考](#6-cli-参考)
7. [控制台使用指南](#7-控制台使用指南)
8. [能力发现与自动路由](#8-能力发现与自动路由)
9. [运行生命周期](#9-运行生命周期)
10. [中断、恢复与并发](#10-中断恢复与并发)
11. [接入自定义代理](#11-接入自定义代理)
12. [HTTP API 参考](#12-http-api-参考)
13. [状态目录与审计](#13-状态目录与审计)
14. [安全模型](#14-安全模型)
15. [明确不包含的能力](#15-明确不包含的能力)
16. [故障排查](#16-故障排查)
17. [工作流（v2 / Herdr DAG）](#17-工作流v2--herdr-dag)

---

## 1. Agent Office 是什么

Agent Office 是一个**本地优先的多代理编排层**。它让 Codex CLI、Claude Code CLI 或任意读写 stdin/stdout 的程序，围绕**同一个任务**共享目标、工作区、消息和交接状态，像同事一样轮流实现、审查、返工。

它解决的核心问题不是“同时启动多个模型”，而是让多个代理对同一件事有**一致且可恢复的事实来源**：

- 所有参与者知道同一个目标；
- 每位代理知道自己的角色和同事的状态；
- 实现 → 审查 → 返工形成可观察的交接；
- 用户可以在需要决策时介入；
- 进程中断不会丢失任务和对话。

### 适合的场景

- 让一个代理实现、另一个代理独立审查并把问题打回去；
- 需要留下完整审计记录（谁在什么时候改了什么、为什么）的改动；
- 想比较/组合不同厂商 CLI 的能力，而不想自己写胶水代码。

### 不适合的场景

- 需要多个代理**同时写入同一工作区目录**（串行任务仍刻意单写者；v2 工作流把唯一 writer 放到隔离 worktree，见 [17](#17-工作流v2--herdr-dag)）；
- 需要跨机器调度、团队共享服务或组织级审批；
- 把它当作无人值守的自动化流水线——它会执行真实的文件修改，需要人在场。

---

## 2. 先决条件与安装

### 必需

- **Node.js 20 或更高版本**。项目只使用 Node.js 内置模块，**不需要 `npm install`**。

### 可选（按你要用的代理）

| 代理 | 需要 | 认证 |
| --- | --- | --- |
| `codex` | 已安装并登录的 Codex CLI | 由 Codex 自己管理 |
| `claude` | 已安装并登录的 Claude Code CLI | 由 Claude Code 自己管理 |
| `command` | 任意可执行程序 | 由该程序自己管理 |
| `mock` | 无 | 无 |

Agent Office **不保存也不代管任何凭据**。不要把 API key 写进 `agent-office.json`；如确有需要，通过启动 Agent Office 的进程环境传入。

### 安装

全局安装：

```bash
cd /path/to/agent-office
npm install -g .
agent-office --help
```

或直接用仓库里的入口，不安装：

```bash
node /path/to/agent-office/bin/agent-office.js --help
```

本手册后续统一写作 `agent-office`。

---

## 3. 五分钟上手

### 3.1 离线演示（不调用模型、不产生费用）

```bash
npm run demo
```

它在临时目录里用两个 `mock` 代理跑完一个完整闭环：

```text
builder 实现
  → reviewer 审查
    → reviewer 发出直接返工消息
      → builder 自动恢复并修复
        → task completed
```

命令退出码：任务达到 `completed` 为 `0`，否则为 `1`。

### 3.2 零成本体验控制台

```bash
agent-office serve --config ./examples/team.dashboard-demo.json
```

浏览器打开 <http://127.0.0.1:4177>，新建一个任务并点击“启动协作”，即可看到 mock builder/reviewer 的完整返工闭环、路由计划和产物列表。

### 3.3 真实项目的一条命令入口

进入目标项目后运行：

```bash
agent-office start
```

这条命令把真实项目所需的准备步骤串起来：

1. 检查当前目录的 `agent-office.json`；
2. 配置不存在时请求确认，确认后生成默认 Codex + Claude 配置；
3. 运行 `doctor` 检查配置中的代理和本机 CLI；
4. 体检通过后在 `127.0.0.1:4177` 启动服务；
5. 服务监听成功后自动打开浏览器。

如果用户取消初始化，不会写入文件；如果 `doctor` 发现不可用代理，服务不会启动。macOS 上，`start`、`serve` 和 `run` 会在进程尚未显式设置 `HTTP_PROXY` / `HTTPS_PROXY` 时读取系统代理，并把它传给代理 CLI；项目配置中的 `agents[].env` 最后合并，仍具有最高优先级。这解决了部分原生 CLI 能打开交互界面、却不读取 macOS 系统代理而在无头模式报 `ENOTFOUND` 的情况。当前终端保持为服务的进程宿主，按 `Ctrl+C` 安全停止。

---

## 4. 在真实项目里运行

> **注意**：真实运行会调用本机已登录的 Codex / Claude Code，**可能产生模型用量并修改目标工作区的文件**。建议先在干净的 git 工作树上运行，便于回退。

### 4.1 初始化

进入你希望代理共同工作的代码库：

```bash
cd /path/to/your-project
agent-office init
```

这会生成 `agent-office.json`。如果文件已存在，命令会**拒绝覆盖**并报错。

### 4.2 体检

```bash
agent-office doctor
```

输出每个代理是否可用、CLI 版本、安全模式、发现的模型和工具，以及探测过程中的告警。

退出码：全部代理可用为 `0`，否则为 `1`（适合放进 CI 或启动前检查）。

### 4.3 创建任务

```bash
agent-office task create \
  --objective "实现健康检查端点，补齐测试，并由另一位代理审查"
```

命令输出任务 ID，形如 `task-20260731-1a2b3c4d`。

目标写得越具体，自动路由越准（见[第 8 节](#8-能力发现与自动路由)）。建议写清**最终结果、边界和验收方式**。

### 4.4 启动协作

```bash
agent-office run task-20260731-1a2b3c4d --rounds 4
```

运行过程中会打印每一轮的代理、摘要和状态。按 `Ctrl+C` 可以安全中断（见[第 10 节](#10-中断恢复与并发)）。

### 4.5 查看结果

```bash
agent-office task show task-20260731-1a2b3c4d
```

或加 `--json` 获取完整快照。

### 4.6 回应等待中的代理

当代理把任务置为 `awaiting_input`：

```bash
agent-office message send task-20260731-1a2b3c4d \
  --to codex \
  --body "兼容范围确定为 Node.js 20+，继续实现"

agent-office run task-20260731-1a2b3c4d
```

用户消息会把收件人从 `blocked` / `done` / `failed` 唤醒为 `working`，并把任务状态改回 `ready`。

### 4.7 默认安全姿态

默认配置**不使用任何绕过权限或沙箱的选项**：

- Codex 使用 `workspace-write` 沙箱；
- Claude Code 使用 `acceptEdits` 权限模式；
- 两者按轮次**串行**执行，避免同时写同一文件。

---

## 5. 配置参考

`agent-office init` 生成的起始配置：

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

### 5.1 顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | 整数 | 必填 | 目前必须是 `1`。 |
| `workspace` | 字符串 | `"."` | 共享工作区。相对路径按配置文件所在目录解析。 |
| `stateDir` | 字符串 | `".agent-office"` | 状态目录。相对路径按 `workspace` 解析。 |
| `collaboration` | 对象 | 见下 | 轮次、超时与提示词预算。 |
| `routing` | 对象 | 见下 | 能力路由。 |
| `retention` | 对象 | 见下 | 事件日志与原始输出的保留上限。 |
| `agents` | 数组 | 必填 | 至少一个代理。 |

### 5.2 `collaboration`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxRounds` | `4` | 单次 `run` 最多推进的轮数。可被 `--rounds` 覆盖。 |
| `transcriptMessages` | `40` | 注入提示词的最近可见消息条数。 |
| `turnTimeoutMs` | `600000` | 单个代理回合的超时（毫秒）。超时会向**整个进程组**先发 `SIGTERM`，0.5 秒后 `SIGKILL`。 |
| `promptBudgetChars` | `120000` | 拼装后的对话记录字符上限。 |

四者都必须是**正整数**。

> **为什么需要 `promptBudgetChars`**：`transcriptMessages` 只限制条数，不限制长度。任务每推进一轮消息就增长，长任务的提示词会持续膨胀直到超出模型上下文——而那时任务已经投入了大量真实工作。超出预算时，**最旧的消息先被丢弃**，并在提示词里标注被省略的条数；最新一条消息即使单独超预算也一定保留。

### 5.3 `routing`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后按配置顺序使用**全部**代理，不做能力打分。 |
| `maxAgents` | `min(2, 代理数)` | 单个任务最多选用几个代理。 |
| `probeTimeoutMs` | `10000` | 每次能力探测子进程的超时。 |
| `cacheTtlMs` | `300000` | 能力清单缓存有效期。 |

### 5.4 `retention`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxEventFileBytes` | `5242880`（5 MiB） | `events.jsonl` 超过该大小时轮转为 `events.jsonl.1`（只保留一代）。 |
| `maxRunFiles` | `500` | `runs/` 保留的原始输出文件数，超出时按修改时间删除最旧的。每次运行结束后清理一次。 |

### 5.5 代理通用字段

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `id` | 全部 | 必填。只能是字母数字开头，后续可含 `_` `-`。同一配置内唯一。 |
| `adapter` | 全部 | `codex` / `claude` / `command` / `mock`。 |
| `role` | 全部 | 自然语言角色描述。**会影响路由的角色亲和度打分**，也会注入提示词。 |
| `command` | 全部 | 覆盖默认可执行文件名。`command` 适配器必填。 |
| `commandArgs` | `codex`、`claude` | 追加在所有内置参数**之前**的参数数组，也用于能力探测。`command` 适配器请改用 `args`。 |
| `env` | `codex`、`claude`、`command` | 附加环境变量对象，与 `process.env` 合并。 |
| `model` | `codex`、`claude` | 显式指定模型，覆盖自动路由结果。对 `command` 适配器只影响能力清单与路由展示，**不会**传给该程序。 |
| `effort` | `codex`、`claude` | 显式指定推理强度。同上，不会传给 `command` 适配器。 |
| `models` | 全部 | 自定义模型清单与能力评分，见 [8.4](#84-为私有模型或网关补充能力评分)。 |
| `tools` | 全部 | 补充工具清单（字符串或 `{id,label,kind,available}`）。 |
| `timeoutMs` | 全部 | 覆盖该代理的回合超时。 |

### 5.6 适配器专属字段

**`codex`**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sandbox` | `"workspace-write"` | 传给 `codex exec --sandbox`。 |
| `ephemeral` | `true` | 为 `false` 时不加 `--ephemeral`。 |

**`claude`**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `permissionMode` | `"acceptEdits"` | 传给 `--permission-mode`。 |
| `noSessionPersistence` | `true` | 为 `false` 时不加 `--no-session-persistence`。 |
| `maxBudgetUsd` | 无 | 传给 `--max-budget-usd`，为该代理设置美元上限。 |

**`command`**

| 字段 | 说明 |
| --- | --- |
| `command` | 必填，可执行程序路径或名称。 |
| `args` | 参数数组，支持占位符（见[第 11 节](#11-接入自定义代理)）。 |

**`mock`**

| 字段 | 说明 |
| --- | --- |
| `replies` | Turn Protocol 对象数组，按轮次依次返回；用尽后重复最后一个。 |

---

## 6. CLI 参考

```text
agent-office init [directory]
agent-office start
agent-office doctor [--config path]
agent-office capabilities [--refresh] [--objective "..."] [--json] [--config path]
agent-office task create --objective "..." [--config path]
agent-office task list [--all] [--config path]
agent-office task show <task-id> [--json] [--config path]
agent-office task archive <task-id> [--config path]
agent-office task unarchive <task-id> [--config path]
agent-office task delete <task-id> --yes [--config path]
agent-office workflow create --objective "..." --file workflow.json [--config path]
agent-office workflow approve <task-id> <node-id> [--config path]
agent-office workflow retry <task-id> <node-id> [--config path]
agent-office message send <task-id> --body "..." [--to agent|team] [--config path]
agent-office run <task-id> [--rounds N] [--config path]
agent-office serve [--host 127.0.0.1] [--port 4177] [--open] [--config path]
agent-office demo
```

`--config` 默认为当前目录的 `agent-office.json`。

### 6.1 各命令说明

**`init [directory]`** — 在目标目录写入起始配置。目录不存在会自动创建。**不会覆盖已存在的配置。**

**`start`** — 面向真实项目的一条命令入口。以当前目录为项目，必要时确认初始化，运行 `doctor`，启动控制台并自动打开浏览器。环境检查失败时不会启动服务。

**`doctor`** — 强制刷新能力探测并打印每个代理的可用性、版本、安全模式、模型、可用工具和告警。

**`capabilities`** — 打印能力清单。
- `--refresh`：忽略缓存重新探测。
- `--objective "..."`：额外打印该目标的路由计划（任务画像、每个代理选中的模型/强度/匹配分）。
- `--json`：输出 `{ inventory, plan }` 完整 JSON。

**`task create --objective "..."`** — 创建任务并输出任务 ID。创建时即完成路由并持久化分配快照。

**`task list`** — 按更新时间倒序列出 `ID / 状态 / 更新时间 / 目标摘要`。默认**隐藏已归档任务**；加 `--all` 一并列出。

**`task show <task-id>`** — 打印任务详情；`--json` 输出完整快照。若有用量数据，会额外打印一行 `Usage:`（见 [8.6](#86-用量与费用)）。

**`task archive` / `task unarchive <task-id>`** — 把任务移出/移回默认列表。归档**不会**删除任何数据，随时可逆，是清理工作队列的推荐方式。

**`task delete <task-id> --yes`** — **永久删除**任务快照。没有 `--yes` 会直接报错拒绝执行。正在运行的任务无法删除（需先停止）。删除只移除 `tasks/<id>.json` 与其租约；`events.jsonl` 中的历史事件保留，并追加一条 `task.deleted`。

**`message send <task-id> --body "..." [--to ...]`** — 以 `user` 身份发消息。`--to` 默认 `team`，也可以是任务名单内的代理 ID。收件人不在名单内会报错并列出可选值。

**`workflow create --objective "..." --file workflow.json`** — 从 JSON definition 创建 `mode: "workflow"` 任务。控制状态必须在 executor workspace 之外（把 `stateDir` 设成绝对路径）。当前没有 HTTP 上传 definition 的接口。

**`workflow approve <task-id> <node-id>`** / **`workflow retry <task-id> <node-id>`** — 批准 gate，或把失败/受阻/可返工节点重新标为可调度。它们不立刻执行节点，之后仍要 `run`。

**`run <task-id> [--rounds N]`** — 推进任务。`--rounds` 必须是正整数，覆盖 `collaboration.maxRounds`。对工作流任务会进入 DAG 调度，忽略 `--rounds`。

**`serve [--host] [--port] [--open]`** — 启动本地控制台。`--host` 只接受 `127.0.0.1`、`localhost`、`::1`；`--port` 为 1–65535；`--open` 在服务监听成功后打开浏览器。

**`demo`** — 在临时目录跑离线闭环演示。

### 6.2 退出码

| 命令 | 0 | 1 | 130 |
| --- | --- | --- | --- |
| `doctor` | 全部代理可用 | 有代理不可用 | — |
| `run` | 运行结束且任务未 `failed` | 任务 `failed`，或运行租约被其他进程持有 | 被 Ctrl+C 中断 |
| `demo` | 任务 `completed` | 其他 | — |
| 其他 | 成功 | 抛出错误 | — |

---

## 7. 控制台使用指南

```bash
agent-office serve
```

默认地址 <http://127.0.0.1:4177>。

### 7.1 页面结构

| 区域 | 内容 |
| --- | --- |
| **顶部指标条** | 任务总数、活跃任务（`ready`/`running`）、需要关注（`awaiting_input`/`failed`）、累计代理回合、累计用量（token 与费用）。 |
| **左栏 · 任务队列** | 任务列表，支持搜索（目标或 ID）与筛选（全部/活跃/关注/完成/归档）。 |
| **中栏 · 任务舞台** | 任务目标、状态、运行控制、实时活动、路由计划、同事状态、产物、协作记录、消息输入框。 |
| **右栏 · 运行时** | 服务运行时长、代理数、运行中任务数、工作区与状态目录路径。 |
| **右栏 · 模型与工具** | 能力清单摘要与每个代理的模型/工具标签，可点击 ↻ 重新探测。 |
| **右栏 · 最近事件** | 最近的任务事件流，按类型着色。 |

### 7.2 运行控制

任务标题右侧是运行控制区：

- **轮次**输入框：本次运行推进的最大轮数（1–100）。
- **启动协作 / 恢复运行**：
  - 任务为 `ready` 时显示“启动协作”；
  - 任务为 `running` 但**没有活跃运行**（进程已退出）时显示“恢复运行”，并在下方给出黄色提示；
  - 任务为 `completed` / `awaiting_input` / `failed` 时按钮禁用并说明原因。
- **停止运行**：仅在有活跃运行时出现。
  - 由本控制台启动的运行可以直接停止；
  - 由其他进程（例如另一个终端的 `agent-office run`）启动的运行**无法在此停止**，按钮会禁用并在悬停提示中给出持有它的进程号和主机名。

停止会结束当前回合的子进程，任务回到 `ready`，**已完成的回合和消息全部保留**。

同一行还有：

- **工作区改动**：当工作区是 git 仓库时，展示相对 `HEAD` 的改动统计、变更条目和补丁（见 [7.7](#77-工作区改动)）。
- **归档 / 取消归档**：把任务移出/移回默认列表，不删除任何数据。
- **删除**：永久删除任务快照，弹出确认框，并在确认文案里提示改用归档。

### 7.3 实时活动

一个回合在完成前不返回摘要，真实回合往往要跑数分钟，因此运行期间任务标题下方会出现**实时活动面板**：

- 当前代理、第几轮、以及**逐秒递增的已运行时间**；
- 代理正在做什么的滚动列表：`思考` / `工具` / `输出` / `提示`。

这些进度来自各 CLI 的事件流（Claude Code 的 `stream-json`、Codex 的 `--json` JSONL），**只用于实时观察，不写入任务快照或事件日志**。`command` 适配器没有已知事件格式，它的每一行 stdout 都会原样作为 `stdout` 进度显示。

> **进度不会补历史**：因为不落盘，在一次运行**已经开始之后**才打开控制台，活动列表会是空的——此时仍能从任务标题下方的提示看到“运行中 · 进程 X@主机 · 开始于 …”，并且可以正常停止它。这是设计如此，不是故障。回合结束后，完整结果仍可在协作记录和“查看原始输出”里看到。

CLI 端同样会打印进度，但只打印**工具调用和提示**两类——思考与增量输出过于频繁，不适合逐行刷屏。

### 7.4 产物

“产物”区域列出代理在本任务中报告过的工作区文件、报告者和最近一次报告时间。

产物是代理自报的**相对路径字符串**，用于审计和导航，**不是文件上传或内容快照**。Agent Office 不会校验这些路径是否真实存在。

协作记录里每条代理摘要下方还有**“查看原始输出”**，展示该回合提供方返回的原始内容（`runs/` 里的 trace 文件）。当一个回合的结果可疑时，这里是唯一的原始证据。

### 7.5 消息

底部输入框可以向“全体团队”或某个具体代理发消息。发送后：

- 处于 `blocked` / `done` / `failed` 的收件人会被唤醒为 `working`；
- 任务若处于 `awaiting_input` 会回到 `ready`；
- 之后需要再次点击“启动协作”才会继续推进。

### 7.6 快捷键

| 键 | 作用 |
| --- | --- |
| `⌘K` / `Ctrl+K` | 聚焦任务列表（无任务时聚焦搜索框） |
| `/` | 聚焦任务搜索框 |
| `↑` `↓` | 在任务列表中上下移动并选中 |
| `Home` / `End` | 跳到任务列表首/末项 |
| `N` | 新建任务 |
| `R` | 刷新 |

（除 `⌘K` 外，其余快捷键在输入框聚焦时不生效。）

任务列表使用 `listbox`/`option` 语义与 roving tabindex：只有当前选中项在 Tab 顺序里，方向键在项之间移动。所有可交互元素都有可见的焦点圈；深色与浅色主题的正文与次要文字对比度均达到 WCAG AA（≥ 4.5:1）。

### 7.7 工作区改动

任务**第一次运行前**会记录一份工作区基线：当时的 `HEAD` 提交，以及当时已经改动/未跟踪的每个文件的内容哈希。

点击“工作区改动”会基于这份基线区分：

- **本任务期间变化的文件**——基线中不存在、内容与基线时不同，或**在任务期间被提交**（`git log` 中基线 HEAD 之后的改动同样计入——工作树干净不代表任务没改东西）；
- **任务开始前就已修改、至今未被改动**——明确排除在任务成果之外。

文件列表与补丁描述**同一组文件**，保持一致：

- 补丁按任务文件列表生成，任务开始前就脏、任务没碰过的文件**不会**混入任务补丁；
- **任务开始前就脏、任务又改了它**的文件：基线时会保存该文件的内容快照（≤ 1 MiB，存入 `<stateDir>/baselines/`，按内容寻址），补丁对着快照生成——只显示任务的增量，用户任务前的改动不会泄漏进来。快照缺失（旧任务或超大文件）时退回相对 HEAD 的 diff，并在统计里**明确标注**该补丁可能含任务前改动；
- 重命名（`git mv`，无论是否已提交）按新旧两个真实路径报告，补丁包含旧路径的删除；
- 任务**恢复**了用户任务前删除的文件、或**删除**了任务前的未跟踪文件，补丁同样完整呈现（后者需要基线快照；快照缺失时在统计里明确说明，而不是给出空补丁）；
- 任务新建的未跟踪文件也出现在补丁里（通过 `--no-index` 合成）；
- 补丁超过 512 KiB 会截断。

如果任务还没运行过（没有基线），视图会标注为**全局**当前改动，而不是伪装成任务范围。

**这依赖工作区是 git 仓库。** Agent Office 本身不要求 git（Codex 调用带 `--skip-git-repo-check`），所以在非 git 工作区里这个视图会明确告诉你无法生成，而不是报错。没有任何提交的新仓库同样无法生成（没有 `HEAD` 可比）。

这是运行后回答“它到底改了什么”最直接的方式；产物列表只是代理的自述，diff 才是事实。

注意基线是按**任务**记录的，不是按回合：多次运行同一任务，diff 覆盖的是这个任务从第一次运行至今的全部变化。

### 7.8 主题

右上角按钮在 **跟随系统 → 深色 → 浅色** 之间循环，选择保存在 `localStorage`。“跟随系统”使用 `prefers-color-scheme`。

### 7.9 实时更新

控制台通过 SSE (`/api/stream`) 接收编排事件和文件变化，连接中断会自动重连，并有 30 秒定时刷新兜底。右上角的连接指示器显示当前状态。

---

## 8. 能力发现与自动路由

### 8.1 无费用探测

Agent Office **不会为了探测能力而发起付费模型请求**。具体做法：

| 代理 | 探测方式 |
| --- | --- |
| Codex | `codex --version`；优先读 `$CODEX_HOME/models_cache.json`，缺失时读 `codex debug models --bundled`；`codex mcp list --json` 枚举 MCP。 |
| Claude Code | `claude --version`、`claude --help`；`claude mcp list`、`claude plugin list --json` 枚举 MCP 与插件；另读取 `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`。 |

> **重要实现细节**：Claude Code 会把**无法识别的子命令当作提示词执行**——这会产生真实的模型调用。因此所有子命令探测都先用 `--help` 输出的命令清单校验；如果帮助文本读不到，就**完全不做**子命令探测，并在告警中说明。

### 8.2 模型可用性标记

| 标记 | 含义 | 是否参与自动路由 |
| --- | --- | --- |
| `catalog` | 来自本机或内置模型目录 | 是 |
| `advertised` | 已安装 CLI 的帮助文本公布的别名 | 是 |
| `unverified` | 已知别名，但当前 CLI 版本不公布 | **否**（清单可见，不会被自动选中） |
| `configured` | 配置里显式声明 | 是 |
| `assumed` | 交给厂商默认 | 是 |

Claude Code 目前**没有无费用枚举账号可用模型的命令**，因此“公布过”不等于“你的账号一定有权调用”。系统区分这几种来源，而不是伪装成已验证访问。

如果一个代理没有任何可路由模型，系统会退回到“让厂商选择默认模型”，而不是冒险路由到未验证的别名。

### 8.3 任务画像与打分

创建任务时，目标文本会被分类为若干**任务类型**（中英文关键词均支持）：

| 类型 | 触发词示例 | 影响 |
| --- | --- | --- |
| `implementation` | implement / build / fix / 实现 / 修复 | 提高 coding、reasoning 权重；要求 `workspace.write`、`shell` |
| `review` | review / audit / security / 审查 / 安全 | 提高 review 权重；要求 `shell` |
| `research` | research / latest / 调研 / 最新 | 提高 research 权重；要求 `web.search` |
| `writing` | document / report / 文档 / 报告 | 提高 writing 权重 |
| `vision` | image / screenshot / 截图 / 界面 | 提高 vision 权重；要求 `image.input` |
| `complex` | architecture / migration / 架构 / 复杂 | reasoning 拉满，speed/cost 降低 |
| `repeatable` | extract / batch / 批量 / 简单 | speed/cost 拉满，reasoning 压低 |

每个「代理 × 模型」组合按加权能力打分（0–100），再做两项修正：

- **工具缺口**：每缺一项必需工具扣 12 分；
- **角色亲和**：`role` 描述与任务类型匹配时加 6–8 分。

得分最高的前 `routing.maxAgents` 个被选中，并按**阶段**排序：实现类角色先行，审查类角色在后。

### 8.4 为私有模型或网关补充能力评分

自动发现的结果会与配置合并，配置优先：

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

八个维度均为 **1–5 的整数**：`coding`、`review`、`reasoning`、`research`、`writing`、`vision`、`speed`、`costEfficiency`。

内置的能力评分是**启发式先验**（按模型系列名推断），不是厂商发布的基准数据。如果与你的实测不符，用上面的方式覆盖它。

### 8.5 路由快照是任务事实的一部分

路由在**创建任务时**计算一次并持久化。之后每一轮严格按快照执行。这样模型目录变化不会让进行中的任务中途换人；新任务才会使用刷新后的能力事实。

关闭自动路由：

```json
{ "routing": { "enabled": false } }
```

此时按配置顺序使用**全部**代理，模型与强度取各代理的 `model` / `effort`。

### 8.6 用量与费用

每个回合结束后，适配器上报的用量会写进该回合记录（`turns[].usage`）：

| 字段 | 含义 |
| --- | --- |
| `inputTokens` / `outputTokens` | 输入/输出 token |
| `cachedInputTokens` | 命中缓存的输入 token |
| `reasoningOutputTokens` | 推理 token（仅 Codex 上报） |
| `costUsd` | 该回合的美元费用，**可能为 `null`** |

**两家提供方报告的东西不一样**：

| 提供方 | token | 美元费用 |
| --- | --- | --- |
| Claude Code | ✓ | ✓（`total_cost_usd`） |
| Codex | ✓ | ✗（不提供） |
| `command` / `mock` | ✗ | ✗ |

因此：

- **token 是跨提供方可比的指标**，控制台的“累计用量”和 `task show` 都以它为主；
- `costUsd` 为 `null` 表示**该提供方不报告费用**，绝不能当作 0；
- 一个任务里既有 Claude 又有 Codex 时，美元合计会被标注为**部分**（`部分回合不报告费用`），因为它只覆盖了能报告费用的那些回合。

---

## 9. 运行生命周期

### 9.1 状态机

任务状态：

```text
ready ──→ running ──→ completed
             ├──→ awaiting_input ──(用户消息)──→ ready
             ├──→ failed
             └──→ ready   (达到轮次上限 / 被中断，可继续 run)
```

代理状态：

```text
idle ──→ working ──→ done
            ├──→ blocked
            └──→ failed

done ──(收到同事直接消息)──→ working
```

结算规则：

- 全部代理 `done` → 任务 `completed`；
- 全部代理处于 `blocked` / `failed` / `done` 且含 `blocked` → `awaiting_input`；
- 全部 `failed`（无 `blocked`）→ `failed`；
- 任一代理设置 `needsUser=true` 或给 `user` 发消息 → 立即 `awaiting_input`；
- 一轮内没有任何代理可执行 → `awaiting_input`。

### 9.2 为什么是串行轮次

同一工作区内的**串行任务**仍然一轮一个代理，这样后一位能看到前一位的真实文件状态，也避免并发覆盖。v2 工作流不再走这条路径：只读节点可以并行，唯一 writer 使用隔离 worktree，发布必须经过 approval 和 `ff-only` integration。详见 [17](#17-工作流v2--herdr-dag)。

### 9.3 单轮的提示词内容

每轮传给代理的 stdin 包含：任务目标、共享工作区绝对路径、团队名单（含状态与模型）、该代理的角色、能力分配说明（模型/强度/匹配分/路由原因）、**对该代理可见的**最近消息、协作规则和输出字段要求。

“可见消息”指 `to` 为 `team`、为该代理本人，或 `from` 为该代理本人的消息，取最近 `transcriptMessages` 条，每条正文截断到 3000 字符。

### 9.4 任务名单锁定

任务创建后，其参与者名单会被固定。如果之后修改了配置（增删代理、改 `adapter`），再对旧任务执行 `run` 会**直接报错**而不是悄悄换人：

```text
Task task-... was created for [codex, claude], but the current configuration
defines [codex]. Restore the original roster or create a new task.
```

---

## 10. 中断、恢复与并发

### 10.1 运行租约

每次运行会写入**两把锁**，都记录持有者的进程号、主机名、运行 ID、开始时间和心跳时间（每 5 秒更新）：

| 锁 | 位置 | 保证 |
| --- | --- | --- |
| 任务级 | `<stateDir>/leases/<task-id>.json` | 同一任务同时只有一个运行者 |
| 工作区级 | `<workspace>/.agent-office.lock` | **同一工作区同时只运行一个代理**（跨任务、跨配置） |

工作区锁**放在工作区自身的根目录**，而不是 `stateDir` 里——这是关键：`stateDir` 是每份配置各自的，放在那里的锁对使用不同 `stateDir` 的另一份配置不可见，两边就都能"成功"取锁。工作区根是所有指向该工作区的配置都能看到的唯一位置。路径先经 `realpath` 规范化，因此符号链接别名也会正确互斥；获取通过原子的独占创建（`O_EXCL`）完成，谁赢谁持有。

这份锁文件是临时的：运行结束即删除，崩溃残留的过期锁会被下一次运行接管。它已加入本仓库的 `.gitignore`，也被排除在任务 diff 之外；在你自己的项目里，运行期间 `git status` 可能短暂看到它，属正常现象。

**过期锁的接管是原子的**。接管从不使用"删除再创建"——两个进程同时看到过期锁时，那种做法会让第二个进程删掉第一个进程刚创建的新锁，重新打穿单写者保证。实际协议：

1. 抢占接管互斥（原子 `mkdir` 一个临时目录 `.agent-office.lock.takeover`，只有一个进程能进入）；
2. 互斥内重新评估锁——若已被别人接管则退出并报冲突；
3. 用临时文件 + `rename` **原地替换**过期锁（路径上永远没有空窗）；
4. 回读校验自己确实是持有者，才算接管成功；
5. 释放互斥。

心跳同样先校验所有权：锁文件已属于别人时**不会**覆盖。接管互斥目录同样是临时的，崩溃残留超过 30 秒会被清理。

第二个进程尝试运行同一任务会立即失败：

```text
Task task-20260731-905f3554 is already being run by pid 27573 on Mac.lan
(started 2026-07-31T09:36:03.315Z). Stop that run before starting another.
```

另一个任务占用同一工作区时，报错指出占用者：

```text
Workspace /path/to/project is already in use by task task-20260731-1a2b3c4d
(pid 27573 on Mac.lan, started 2026-07-31T09:36:03.315Z).
Agents run one at a time per workspace; stop that run first.
```

两种情况下 CLI 退出码均为 `1`，控制台均返回 HTTP `409`。

如果确实需要并行推进多个任务，给它们**各自独立的工作区**（不同的 `workspace`），而不是共享一个目录。

### 10.2 过期租约的判定

- **同一主机**：**只看进程是否存活**。进程还在（哪怕被 `SIGSTOP` 暂停、心跳早已停更）就绝不自动接管——被暂停的进程随时会恢复并继续写工作区，接管它的锁等于制造两个写者。只有进程号确实消失（崩溃、`kill -9`）才可接管，无需手工清理。
- **其他主机**：无法探测进程，心跳超过 30 秒未更新即视为过期。

**第二道防线（fence）**：即使锁被以任何方式夺走（跨主机接管、手工删锁后他人抢占），原持有者的心跳会在下一个周期发现锁已易主，立即**中止自己正在运行的代理进程树**（等同一次取消：任务回到 `ready`，记录 `run.lost` 事件，代理不标记为失败）。心跳只刷新确认仍属于自己的锁，绝不覆盖他人的。

**代价与边界**：

- 一个被永久暂停/卡死但存活的进程会一直占住工作区。这是设计选择——严格单写者优先于可用性。确认该进程不会恢复后，`kill` 它（锁随 PID 消失变为可接管），或手动删除 `<workspace>/.agent-office.lock`——**锁文件消失本身就是失租信号**：原持有者的心跳发现文件不在（或内容已属于别人）即触发 fence 自停，绝不会把删掉的锁重新创建出来。fence 的中止动作先于任何事件通知执行，观察者代码抛错也无法阻止它。
- 极端的 PID 复用场景（崩溃残留的锁记录的 PID 恰被无关进程复用）会让锁看似有主，同样用手动删锁解决。

### 10.3 中断一次运行

**CLI**：按 `Ctrl+C`。当前回合的**整个进程树**会被终止，租约释放，任务回到 `ready`，退出码 `130`。再按一次 `Ctrl+C` 强制退出。

终止过程：向进程组发 `SIGTERM` → 0.5 秒后发 `SIGKILL` → **轮询确认整个进程组已消失**后才释放租约并返回。"等待"的对象是进程组而非直接子进程——直接子进程的退出不代表树已退出：父进程响应 `SIGTERM` 立即退出、而孙进程忽略它时，只看子进程会提前放锁，孙进程仍在写工作区。忽略 `SIGTERM` 的后代最长能存活约 0.5 秒（到 `SIGKILL` 为止），这段时间内锁一直持有，因此不存在与下一次运行并发写入的窗口。极端卡死（不可中断 I/O）时在约 2.5 秒后放弃等待并在错误里标注 `treeUnresponsive`。

> **Windows 注意**：Windows 没有进程组信号，改用 `taskkill /T`（终止进程树）与 `/F`（强制）。但没有等价的"进程组是否仍存在"探测，因此**等待树退出的保证在 Windows 上是尽力而为**。本项目仅在 macOS 上完整验证过。

**控制台**：点击“停止运行”。

**其他进程启动的运行**：只能在启动它的地方停止。控制台会显示持有它的进程号与主机名。

中断**不会**把代理标记为 `failed`——中断是用户决定，不是代理的错误。已完成的回合、消息和产物全部保留，可以直接继续。

### 10.4 从崩溃中恢复

如果运行进程被强制杀死或机器断电，任务会停留在 `running`，但租约已过期。此时：

- `agent-office run <task-id>` 会直接接管并继续；
- 控制台会把该任务标记为“上一次运行没有正常结束”，按钮变为**恢复运行**。

### 10.5 手工清除租约（极少需要）

如果某个租约由一个**确实还活着但已卡死**的进程持有，而你无法访问那个进程：

```bash
rm <workspace>/<stateDir>/leases/<task-id>.json
```

**只在确认该进程不会再写入这个任务时这样做**——否则两个运行者会同时修改同一任务和同一工作区。

---

## 11. 接入自定义代理

任何满足以下约定的程序都可以通过 `command` 适配器接入：

1. 从 stdin 读取完整提示直到 EOF；
2. 在超时前退出；
3. 以退出码 `0` 表示成功；
4. 向 stdout 写一个 Turn Protocol JSON 对象；
5. 诊断日志写到 stderr。

### 11.1 配置

```json
{
  "id": "local-model",
  "adapter": "command",
  "role": "分析当前实现并给出可执行交接。",
  "command": "./my-agent",
  "args": ["--workspace", "{{workspace}}", "--schema", "{{schema}}"]
}
```

支持的占位符：

| 占位符 | 替换为 |
| --- | --- |
| `{{workspace}}` | 共享工作区绝对路径 |
| `{{agentId}}` | 当前代理 ID |
| `{{schema}}` | Turn Protocol JSON Schema 文件路径 |

进程启动**不经过 shell**，配置里的参数不会被当作命令替换或管道执行。

### 11.2 输出格式

```json
{
  "summary": "实现了端点并运行 8 个相关测试，全部通过。",
  "status": "working",
  "messages": [
    { "to": "reviewer", "body": "请重点检查 src/health.js 的超时处理。" }
  ],
  "artifacts": ["src/health.js", "tests/health.test.js"],
  "needsUser": false
}
```

| 字段 | 说明 |
| --- | --- |
| `summary` | 必填非空。本轮事实性摘要，**会被自动转发给全体团队**。不要放隐藏推理、凭据或无关日志。 |
| `status` | `working` / `blocked` / `done`。非法值按 `working` 处理。 |
| `messages[].to` | `team`、任务名单内的代理 ID，或 `user`。**未知收件人会被静默丢弃。** |
| `artifacts` | 本轮产生或核验的工作区相对路径。仅用于审计与展示。 |
| `needsUser` | `true` 时任务立即置为 `awaiting_input` 并停止本次运行。 |

正式 Schema 见 [`schemas/turn.schema.json`](../schemas/turn.schema.json)。

### 11.3 内置适配器的调用方式

| 适配器 | 调用 | 最终结果来自 | 进度来自 |
| --- | --- | --- | --- |
| `claude` | `claude -p --output-format stream-json --verbose --json-schema …` | 事件流里的 `result` 事件（`structured_output`） | `assistant` 事件中的文本/工具/思考块 |
| `codex` | `codex exec --json --output-schema … --output-last-message …` | `--output-last-message` 写出的文件 | `item.completed` / `turn.completed` 事件 |

Codex 的 trace 保存的是**完整 JSONL 事件流**（`*.codex.jsonl`），而不只是最终消息——工具调用、提示等证据只存在于事件流里。最终消息另存为 `*.codex.json`。
| `command` | 直接执行配置的程序 | stdout 全文 | 每一行 stdout |

> `claude` 的 `--json-schema` 会拒绝无法按 URL 解析的 `$schema`，因此适配器在传参前会把它剥掉；`schemas/turn.schema.json` 本身保留该声明供 Codex 和文档使用。

### 11.4 解析容错

Agent Office 依次尝试：直接解析 → 提取 Markdown 代码围栏中的 JSON → 提取首尾花括号之间的内容。全部失败时，**保留纯文本作为 `summary`，状态按 `working` 处理**，避免直接丢弃工作成果。

注意：这意味着一个持续输出非 JSON 的程序会一直是 `working`，消耗完全部轮次后任务回到 `ready`。

---

## 12. HTTP API 参考

所有接口只在 loopback 上提供，无认证（见[第 14 节](#14-安全模型)）。

### 读接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 运行时快照：指标、代理定义、能力总计、活跃运行、过期运行。 |
| `GET` | `/api/capabilities` | 能力清单（带缓存）。 |
| `GET` | `/api/tasks` | 任务摘要列表（含 `usage` 合计与 `archived`）。默认不含已归档；加 `?includeArchived=1` 一并返回。 |
| `GET` | `/api/tasks/:id` | 单个任务完整快照。 |
| `GET` | `/api/events?limit=N` | 最近事件，`limit` 取值 1–500，默认 100。 |
| `GET` | `/api/stream` | SSE 事件流（`ready` / `state` / `orchestrator`）。 |
| `GET` | `/api/tasks/:id/turns/:turnId/trace` | 该回合的原始提供方输出（上限 512 KiB，超出截断）。 |
| `GET` | `/api/tasks/:id/diff` | 工作区相对 `HEAD` 的改动；非 git 工作区返回 `{ available: false, reason }`。 |

`/api/health` 中与运行控制相关的字段：

| 字段 | 说明 |
| --- | --- |
| `metrics.usage` | 全部任务的 token 与费用合计，语义见 [8.6](#86-用量与费用)。 |
| `runningTaskIds` | 本进程内正在运行的任务 ID。 |
| `activeRuns` | 以任务 ID 为键的活跃租约，含 `pid`、`host`、`startedAt` 和 `cancellable`。 |
| `staleRunTaskIds` | 状态为 `running` 但没有活跃租约的任务（可恢复）。 |

### 写接口

写请求要求 `Content-Type: application/json`，正文上限 **64 KiB**，并做同源校验。

| 方法 | 路径 | 正文 | 成功码 |
| --- | --- | --- | --- |
| `POST` | `/api/tasks` | `{ objective }` | `201` |
| `POST` | `/api/tasks/:id/messages` | `{ body, to? }` | `201` |
| `POST` | `/api/tasks/:id/run` | `{ maxRounds? }` | `202` |
| `POST` | `/api/tasks/:id/nodes/:nodeId/approve` | `{}` | `200` |
| `POST` | `/api/tasks/:id/nodes/:nodeId/retry` | `{}` | `200` |
| `POST` | `/api/tasks/:id/cancel` | `{}` | `202` |
| `POST` | `/api/tasks/:id/archive` | `{ archived? }` | `200` |
| `POST` | `/api/capabilities/refresh` | `{}` | `200` |
| `DELETE` | `/api/tasks/:id` | — | `200` |

`DELETE` 同样要求同源。正在运行的任务无法删除，返回 `409`。

常见错误码：`400` 参数非法、`403` 跨站、非 loopback，或 trace 路径越界、`404` 任务不存在、`409` 运行冲突或任务未运行、`413` 正文过大、`415` Content-Type 不对。

**trace 接口的路径安全**：客户端只提供**回合 ID**，从不提供路径。服务端从任务快照取出 `tracePath`，再解析并校验它确实位于 `runs/` 目录内，否则返回 `403`。`tracePath` 是适配器写入的数据，因此即使来自自家状态也不被信任。

---

## 13. 状态目录与审计

```text
<workspace>/.agent-office.lock   # 运行期间的工作区锁（临时，运行结束删除）

<workspace>/<stateDir>/
├── .write-lock         # 跨进程写锁（目录锁）
├── events.jsonl        # append-only 事件记录
├── events.jsonl.1      # 轮转后的上一代事件（超过 retention.maxEventFileBytes 时产生）
├── leases/             # 运行租约
│   └── task-....json
├── runs/               # 每次调用的原始输出（Codex 另存 *.codex.jsonl 事件流）
└── tasks/
    └── task-....json   # 可恢复任务快照
```

### 13.1 写入保证

每次状态变更：获取跨进程目录锁 → 写临时文件 → 原子 `rename` → 追加事件 → 释放锁。这让多个 CLI 进程发消息时不会互相覆盖。锁等待有上限（5 秒），超时抛 `LockTimeoutError`，不会无限挂起。

### 13.2 事件类型

**持久化到 `events.jsonl` 的事件**：`task.created`、`run.started`、`round.completed`、`turn.completed`、`turn.failed`、`run.stalled`、`run.paused`、`run.cancelled`、`run.lost`（工作区锁被他人夺走、本方已自行停止）、`workspace.baseline`、`task.status_changed`、`message.sent`。

`run.paused`（达到轮次上限）与 `run.cancelled`（用户中断）是**不同**的事件类型，便于区分。

**仅通过 SSE 推送、不落盘的实时事件**：`round.started`、`turn.started`、`turn.cancelled`、`run.finished`，以及控制台状态提示 `run.failed`、`run.rejected`、`run.cancelling`、`run.settled`。它们用于界面即时反馈，不属于审计记录。

### 13.3 数据管理

- 项目默认把 `.agent-office/` 加入 `.gitignore`。
- `events.jsonl` 超过 `retention.maxEventFileBytes` 会轮转为 `events.jsonl.1`，**只保留一代**；读取事件时会跨越这个边界。需要更长的历史请自行外部归档。
- `runs/` 在每次运行结束后裁剪到 `retention.maxRunFiles` 个文件，按修改时间删除最旧的。**这会让旧回合的“查看原始输出”失效**，任务快照里的 `tracePath` 仍在但文件已不存在（界面会提示文件不可用）。
- 归档（`task archive`）只是隐藏，删除（`task delete --yes`）才会移除快照，且不可撤销。
- 任务状态如需跨机器共享，应由上层系统明确选择加密存储或可信数据库，**不建议直接提交模型原始输出**。

---

## 14. 安全模型

### 14.1 进程调用

所有子进程都以参数数组启动，`shell: false`。配置里的参数**不会**被当作命令替换、管道或通配符展开。每次调用有超时和 10 MiB 输出上限。

### 14.2 控制台边界

- 只绑定 loopback，CLI **拒绝**非 loopback 的 `--host`；
- 校验 `Host` 头，拒绝非 loopback 主机名（防 DNS 重绑定）；
- 写请求做同源校验；
- 严格 CSP（`default-src 'self'`，禁止内联脚本与外部资源）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`frame-ancestors 'none'`。

**没有认证机制**。任何能访问该机器 loopback 的本地进程或用户都可以创建任务、发消息和启动运行——而运行会真实修改工作区文件。不要在多用户共享的机器上以他人可访问的方式长期开着 `serve`。

### 14.3 提示词注入（重要）

**一个代理的 `summary` 和 `messages[].body` 会被逐字注入到其他代理的提示词中。** 同理，代理读取的工作区文件内容也可能包含指令性文本。

这意味着：

- 一个被诱导或行为异常的代理，可以通过消息影响同一任务中的其他代理；
- 工作区里的文件（例如从外部拉取的代码、依赖、issue 文本）如果包含针对模型的指令，可能被代理当作输入。

对于「本机两个受信任 CLI + 人在场」的定位，这是可接受的设计取舍；但它是**真实存在的风险面**，你应该知道：

- 只在你信任的代码库上运行；
- 不要让代理处理来源不明的内容，除非你准备好审查其行为；
- 运行前后用 `git diff` 检查实际改动；
- 默认沙箱/权限模式不要放宽（不要改成 `danger-full-access` 或 `bypassPermissions`）。

Agent Office **不做**提示词内容过滤、不做代理行为审计，也不限制代理在其自身权限内能做什么。

### 14.4 凭据

Agent Office 不保存、不读取、不转发任何 Codex / Claude 凭据。认证、模型访问权限和组织策略完全由各 CLI 自己管理。不要把 API key 写进配置文件。

### 14.5 产物路径

`artifacts` 是代理自报的字符串，Agent Office **不校验、不解析、不打开**这些路径。控制台只把它们当文本显示。

---

## 15. 明确不包含的能力

以下为已知边界，当前版本**不提供**：

| 能力 | 现状 |
| --- | --- |
| 同一目录上的并行写入 | 串行任务仍单写者。v2 工作流把 writer 隔离到 worktree，见 [17](#17-工作流v2--herdr-dag)。 |
| 跨机器调度、中心服务、多用户 | 无。本地优先，无认证。 |
| 预算上限与速率限制 | 仅 `claude` 适配器支持 `maxBudgetUsd`。用量会被记录和展示，但**不会**在超阈值时自动停止。 |
| 组织级审批策略 | 无。 |
| Codex 的美元费用 | Codex CLI 只上报 token，不上报金额，因此混合任务的费用合计是部分值，见 [8.6](#86-用量与费用)。 |
| Claude 账号模型权限的无费用强验证 | 无。CLI 没有稳定的枚举命令，系统区分 `advertised` / `unverified` / `configured`。 |
| 事件日志的多代归档 | 只保留一代（`events.jsonl.1`）。更久的历史需自行外部归档。 |
| 非 git 工作区的改动视图 | 无。diff 依赖 git，见 [7.7](#77-工作区改动)。 |
| 长期知识库 / 向量检索 / 上下文压缩 | 无。超出预算的旧消息是被**丢弃**，不是被摘要压缩，见 [5.2](#52-collaboration)。 |
| 实时进度的持久化 | 回合内进度只经 SSE 推送，不写入快照或事件日志。 |
| 界面多语言 | 控制台为简体中文。 |
| Windows 上的强终止保证 | `taskkill /T` 终止进程树，但无进程组探测，"等待树退出"为尽力而为；仅在 macOS 完整验证。 |

这些都可以在现有任务、事件和适配器接口之上增加，不需要改写代理协议。

---

## 16. 故障排查

### `Configuration not found: .../agent-office.json`

当前目录没有配置。运行 `agent-office init`，或用 `--config` 指定路径。

### `Refusing to overwrite existing configuration`

`init` 不覆盖已有配置。手工删除或改名后重试。

### `doctor` 显示某个代理 `✗ ... unavailable`

该 CLI 不在 `PATH` 中，或无法执行。用 `command` 字段指定绝对路径，或先安装/登录对应 CLI。

### Claude 代理只显示 "Provider default" 一个模型

说明 `claude --help` 没能读到（探测失败）或其中不含模型别名。检查 `doctor` 输出的告警行。系统此时会退回厂商默认模型，仍可正常运行。

### 能力清单里看到 `unverified` 模型且不被选中

这是预期行为：该别名是已知的，但当前 CLI 版本没有公布它，因此不会被自动路由选中。若确认你的账号可用，在配置里显式声明即可：

```json
{ "id": "claude", "adapter": "claude", "model": "haiku" }
```

### MCP 服务器显示为不可用

`claude mcp list` 报告了 `Needs authentication`、`Failed to connect` 等状态。先在对应 CLI 里完成授权，再点击控制台的 ↻ 或运行 `agent-office capabilities --refresh`。

### `Task ... is already being run by pid ... on ...`

另一个进程正持有该任务的运行租约。停止那个进程，或等它结束。确认该进程已死但租约仍在时，见 [10.5](#105-手工清除租约极少需要)。

### 任务卡在 `running`，按钮显示“恢复运行”

上一次运行的进程非正常退出。任务进度完好，直接点击“恢复运行”或执行 `agent-office run <task-id>`。

### `Task ... was created for [...], but the current configuration defines [...]`

配置里的代理名单或适配器与任务创建时不一致。恢复原配置，或新建任务。

### `Workspace ... is already in use by task ...`，但那个任务看起来没在动

锁持有者的进程仍存活（可能被暂停或卡住）。同机存活进程不会被自动接管（见 [10.2](#102-过期租约的判定)）。确认它不会恢复后：`kill <pid>`（之后锁自动可接管），或删除 `<workspace>/.agent-office.lock`（原运行会在下个心跳周期因 fence 自行停止）。

### `Workspace ... is fenced after an unproven stop`

上一次运行结束时无法证明代理进程已经停止（取消或失败后 `interrupt` 没有返回"已停止"），工作区被隔离，任何新运行都会被拒绝。错误信息里直接给出**要删除的那个文件**——隔离标记按可写性依次落在三处：`<workspace>/.agent-office.fence`、被转成隔离标记的 `<workspace>/.agent-office.lock`（此时它不再随运行结束删除，也不会被过期接管）、以及工作区不可写时的 `<stateDir>/containments/<digest>.json`。控制台"运行时"面板与 `/api/health` 的 `containment` 字段也会显示同一路径。

先确认那个代理确实已经停止（`ps`、Herdr 面板、`kill` 残留进程），再删除该文件。三处都无法写入时，运行不会返回：进程会持续重试并保持租约——活着的持有者本身就是隔离——磁盘恢复可写后自动落盘收尾。

### `Timed out waiting for state lock`

有进程长时间持有写锁（通常是异常残留）。等待 30 秒后锁会被判定为过期并自动清理；若持续出现，检查是否有卡死的 Agent Office 进程。

### Claude 回合报错 `--json-schema is not a valid JSON Schema`

Claude Code 会用自带的元 schema 校验 `--json-schema`，并拒绝无法按 URL 解析的 `$schema` 声明。Agent Office 的 `claude` 适配器已经在传参前剥离 `$schema`（`schemas/turn.schema.json` 本身保留该声明，供 Codex 的 `--output-schema` 和文档使用）。

如果你换用了自定义 schema 并遇到同样的错误，请从传给 Claude 的那份里去掉 `$schema`。

### 回合失败了，但看不出原因

不会再出现这种情况：CLI 会在 `✗` 行下方缩进打印退出码提示和最多 5 行 stderr；控制台的代理卡片会显示失败原因和 stderr 首行。完整信息还在：

- 任务快照的 `participants[agentId].lastFailure`；
- `events.jsonl` 的 `turn.failed` 事件；
- `runs/` 下该回合的原始输出（控制台“查看原始输出”）。

### 提示词里出现“omitted to stay within the prompt budget”

正常现象：对话已超过 `collaboration.promptBudgetChars`，最旧的消息被丢弃。如果代理明显丢失了早期上下文，调高该值，或把关键约束重新发一条消息（新消息一定会保留）。

### “查看原始输出”提示文件不可用

`runs/` 已按 `retention.maxRunFiles` 裁剪掉了这个旧文件。调高该值可以保留更久。

### 控制台显示费用但标注“部分回合不报告费用”

任务里混合了会报告费用的提供方（Claude Code）和不报告的（Codex）。金额只覆盖前者，token 合计才是完整可比的，见 [8.6](#86-用量与费用)。

### 代理一直 `working`、轮次耗尽但没有进展

通常是该程序没有输出合法的 Turn Protocol JSON——纯文本会被当作 `working` 摘要保留。检查 `<stateDir>/runs/` 下的原始输出，确认程序是否按 [11.2](#112-输出格式) 输出。

### 一个回合迟迟不结束

单回合默认超时 10 分钟（`collaboration.turnTimeoutMs`）。不想等就点击“停止运行”或按 `Ctrl+C`——任务进度会保留。

---

## 17. 工作流（v2 / Herdr DAG）

0.4 保留原来的串行轮次，并增加 `mode: "workflow"` 任务。工作流用 JSON definition 描述节点、依赖、workspace 模式和发布门。详细操作、安全边界和示例见 [v2 工作流手册](workflows.zh-CN.md) 与 `examples/workflow.herdr-feature.json`。

最小路径：

1. 把 `stateDir` 设到工作区外面（workflow create 会拒绝工作区内的控制状态）；
2. `agent-office workflow create --objective "..." --file workflow.json`；
3. `agent-office run <task-id>`；
4. 节点停在 `awaiting_approval` 时 `workflow approve`，失败或返工时 `workflow retry`，然后再 `run`。

`execution.runtime` 默认为 `process`。`runtime: "herdr"` 只影响 `agent` 节点；`command` 和 `integration` 始终走本地 Process Runtime。控制台会显示节点状态，并提供批准 / 重试按钮。

---

## 附录：相关文档

- [README](../README.md) — 项目概览与快速开始
- [架构文档](architecture.md) — 组件、决策与扩展路线
- [协作协议](protocol.md) — Turn Protocol 详细说明
- [v2 工作流手册](workflows.zh-CN.md) — Herdr DAG、worktree 与发布门
- [一键启动器与桌面壳实施计划](future-launcher-plan.md) — 未来的一键初始化、环境检查和控制台启动流程
- [`schemas/turn.schema.json`](../schemas/turn.schema.json) — 正式 Schema
