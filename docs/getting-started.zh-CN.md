# Agent Office 开始工作手册

这份手册帮助你从零开始，把 Codex 和 Claude Code 作为同事放进同一个任务，并且能在本地看板或终端中观察、启动、干预和继续协作。

## 1. 先理解它如何工作

本手册主要介绍兼容保留的串行轮次模式。要使用 Herdr 持久 session、DAG 并行、worktree、审批和发布门，请看 [Agent Office v2：Herdr 工作流手册](workflows.zh-CN.md)。

Agent Office 是 Codex CLI、Claude Code CLI 与其他工具之间的本地编排层：

```text
你发布一个共享任务
  → 系统检查本机代理、模型和工具
  → 根据目标选择代理、模型和推理强度
  → Codex 与 Claude 按顺序在同一工作区执行
  → 每轮输出、消息、交接和状态写入本地任务记录
  → 你可以随时查看，并在下一轮前补充要求
```

当前采用串行轮次。同一时刻只有一位代理修改共享目录，后一位能看到前一位留下的真实文件和测试结果。这可以避免两个编码代理同时覆盖同一个文件。

## 2. 安装要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 20 或更高版本 |
| Codex CLI | 已安装并完成登录 |
| Claude Code | 已安装并完成登录 |
| Git | 仅在目标项目本身使用 Git 时需要 |

先检查：

```bash
node --version
codex --version
claude --version
```

模型发现不调用模型，也不消耗模型额度。Claude 模型被标记为 `advertised`，表示本机 CLI 公布了该模型；只有真正发起任务后，Claude 自身才能最终确认当前账号、套餐和组织策略是否允许调用。

## 3. 为当前终端设置入口

打开终端，执行：

```bash
export AGENT_OFFICE_ROOT="/absolute/path/to/agent-office"
export AGENT_OFFICE_CLI="$AGENT_OFFICE_ROOT/bin/agent-office.js"
```

验证源码入口：

```bash
node "$AGENT_OFFICE_CLI" --help
```

这两个变量只在当前终端窗口有效。关闭终端后需要重新执行，不会修改系统配置。

如果以后希望安装全局命令，可以在 Agent Office 源码目录执行：

```bash
cd "$AGENT_OFFICE_ROOT"
npm install -g .
agent-office --help
```

全局安装不是开始工作的必要条件。本手册后续统一使用更明确的：

```bash
node "$AGENT_OFFICE_CLI"
```

## 4. 先做一次零成本演练

在接入真实项目之前运行离线演示：

```bash
cd "$AGENT_OFFICE_ROOT"
npm run demo
```

演示使用本地 mock 代理，不调用 Codex 或 Claude，不消耗额度，也不会修改你的真实项目。正常流程应当包括：

```text
builder 实现
  → reviewer 审查
    → reviewer 发出返工消息
      → builder 被重新激活
        → builder 修复
          → task completed
```

## 5. 在一个真实项目中初始化

进入你希望两位代理共同工作的项目。下面用占位路径表示：

```bash
cd "/absolute/path/to/your-project"
node "$AGENT_OFFICE_CLI" init .
```

初始化会创建：

```text
agent-office.json
.agent-office/       # 第一次创建或运行任务后出现
```

如果 `agent-office.json` 已存在，命令会拒绝覆盖。请编辑现有配置，不要删除后重新初始化，除非你已经确认其中没有需要保留的自定义角色和权限。

默认团队是：

- `codex`：主要实现者，使用 `workspace-write`。
- `claude`：同事审查者和协作者，使用 `acceptEdits`。

两者都在当前项目目录内工作。真实任务可能修改文件并产生模型用量。

## 6. 启动前进行健康检查

仍然位于目标项目目录时运行：

```bash
node "$AGENT_OFFICE_CLI" doctor
```

你需要确认：

- Codex 和 Claude 前面都是 `✓`；
- Codex 显示当前模型目录；
- Claude 显示 `2.1.220`；
- Claude 模型中出现 `Fable` 或 `Claude-fable-5`；
- 没有认证失败、命令不可用或工作区不存在的警告。

这台机器有两份 Claude Code，因此看见下面这类提示是预期行为：

```text
Claude command: selected newer ~/.local/bin/claude (...) over PATH (...).
```

它表示 Agent Office 已避免使用 PATH 中较旧的 Homebrew 版本。

如果只想检查 Agent Office 自带的示例配置：

```bash
node "$AGENT_OFFICE_CLI" doctor \
  --config "$AGENT_OFFICE_ROOT/examples/team.codex-claude.json"
```

## 7. 查看模型、工具和自动分配方案

刷新本机能力库存：

```bash
node "$AGENT_OFFICE_CLI" capabilities --refresh
```

在正式发布任务前，可以先预演路由，不会调用模型：

```bash
node "$AGENT_OFFICE_CLI" capabilities \
  --refresh \
  --objective "实现复杂架构迁移，补齐测试，并进行严格代码审查"
```

输出会说明：

- 任务被识别为实现、审查、研究、写作或视觉等哪类工作；
- 任务复杂度；
- 每位代理使用哪个模型；
- 推理强度；
- 匹配分；
- 缺少哪些必要工具。

对于上面的复杂任务，当前机器应优先得到类似分配：

```text
codex  → GPT-5.6-Sol
claude → Fable
```

能力来源含义：

- `catalog`：已进入本机 Codex 模型目录。
- `advertised`：Claude CLI 公布了该别名或模型名，但没有发起付费请求验证账号权限。
- `configured`：由 `agent-office.json` 明确配置。
- `assumed`：无法枚举模型时使用 provider 默认值。

模型和能力快照在创建任务时固定。已经创建的任务不会因为之后刷新模型目录而中途换模型；刷新只影响之后创建的新任务。

## 8. 启动本地可视化控制台

在目标项目目录启动：

```bash
node "$AGENT_OFFICE_CLI" serve
```

保持这个终端窗口运行，然后在浏览器打开：

[http://127.0.0.1:4177](http://127.0.0.1:4177)

看板可以显示：

- 任务列表以及 `ready`、`running`、`awaiting_input`、`failed`、`completed` 状态；
- Codex 和 Claude 的当前状态、模型、推理强度、匹配分和最新摘要；
- 自动路由计划及其原因；
- 团队消息和点对点交接；
- 最新任务事件；
- 可用模型、MCP、插件和内置工具；
- 服务运行时间、工作区和状态目录。

看板右侧“能力库存”区域的刷新按钮会重新探测模型和工具。升级 CLI 或新增 MCP/插件后，应先点击它，再创建新任务。

如果 4177 端口被占用：

```bash
node "$AGENT_OFFICE_CLI" serve --port 4178
```

然后打开 `http://127.0.0.1:4178`。

服务只允许绑定本机 loopback 地址，不是远程团队服务器。按 `Ctrl+C` 可以关闭看板服务；任务文件不会丢失。

## 9. 从看板发布第一个真实任务

在页面点击“新建任务”，建议按下面模板描述：

```text
最终结果：
实现一个 /health 端点，并返回版本、运行时间和依赖状态。

范围：
只修改 src/health.js、src/server.js 和对应测试。

边界：
不要升级依赖，不要修改部署配置，不要提交或推送 Git。

验收标准：
相关测试通过；Claude 审查错误处理、超时和信息泄露风险；
最终列出改动文件、测试命令和剩余风险。
```

高质量目标至少包含：

1. 最终要交付什么；
2. 可以修改哪些范围；
3. 明确禁止什么；
4. 如何判断完成；
5. 哪些决策必须回来问你。

创建任务后，先检查路由卡片：

- 模型是否符合任务强度；
- 是否包含期望的两位代理；
- 工具是否满足；
- 执行顺序是否合理。

确认后点击“启动协作”。默认最多运行配置中的轮次数，也可以在界面调整本次轮数。

## 10. 使用 CLI 完成同一套流程

创建任务：

```bash
node "$AGENT_OFFICE_CLI" task create \
  --objective "实现健康检查端点，补齐测试，并由另一位代理严格审查"
```

命令会输出类似：

```text
task-20260731-1a2b3c4d
```

把实际输出复制到变量：

```bash
export AGENT_OFFICE_TASK_ID="task-20260731-1a2b3c4d"
```

查看任务：

```bash
node "$AGENT_OFFICE_CLI" task show "$AGENT_OFFICE_TASK_ID"
```

启动最多四轮协作：

```bash
node "$AGENT_OFFICE_CLI" run "$AGENT_OFFICE_TASK_ID" --rounds 4
```

列出所有任务：

```bash
node "$AGENT_OFFICE_CLI" task list
```

获取完整 JSON，便于脚本或审计工具读取：

```bash
node "$AGENT_OFFICE_CLI" task show "$AGENT_OFFICE_TASK_ID" --json
```

CLI 与看板使用配置中的同一个 `stateDir`。新配置默认把它放在项目之外；你可以在终端创建任务，再到看板查看和继续，也可以反过来操作。

## 11. 如何在任务中间进行干预

### 发给整个团队

适合改变共同约束、补充验收标准或回答团队都需要知道的问题：

```bash
node "$AGENT_OFFICE_CLI" message send "$AGENT_OFFICE_TASK_ID" \
  --to team \
  --body "新增约束：保持 Node.js 20 兼容，不允许增加生产依赖。"
```

### 只发给 Codex

适合要求实现者修改方案：

```bash
node "$AGENT_OFFICE_CLI" message send "$AGENT_OFFICE_TASK_ID" \
  --to codex \
  --body "先修复超时处理，再补测试；不要扩大重构范围。"
```

### 只发给 Claude

适合指定审查重点：

```bash
node "$AGENT_OFFICE_CLI" message send "$AGENT_OFFICE_TASK_ID" \
  --to claude \
  --body "请重点验证错误路径、权限边界和测试是否真的覆盖失败场景。"
```

点对点消息只会进入目标代理可见的上下文；团队消息对所有参与者可见。

如果目标代理已经是 `done`、`failed` 或 `blocked`，用户消息会重新激活它。任务处于 `awaiting_input` 时，发送用户回复会把任务恢复为 `ready`，之后需要再次点击“启动协作”或执行：

```bash
node "$AGENT_OFFICE_CLI" run "$AGENT_OFFICE_TASK_ID"
```

当前版本的消息干预发生在轮次边界：它不会中断已经启动的单次模型调用，代理会在后续轮次读取新消息。当前也没有单独的“强制取消当前模型调用”按钮。

## 12. 如何理解任务状态

| 状态 | 含义 | 你的动作 |
| --- | --- | --- |
| `ready` | 已创建或可以继续 | 点击“启动协作”或执行 `run` |
| `running` | 当前正在运行 | 观察输出；新消息通常在下一轮生效 |
| `awaiting_input` | 团队需要用户决策 | 阅读消息，回复团队或指定代理，再运行 |
| `completed` | 所有已分配代理完成职责 | 检查文件、测试证据和剩余风险 |
| `failed` | 某个代理调用失败 | 查看错误，修复认证、配置或任务边界，发送消息后重试 |

代理状态：

- `idle`：尚未开始。
- `working`：仍有职责内工作。
- `blocked`：无法安全继续。
- `done`：当前职责完成；收到直接返工消息后可以恢复。
- `failed`：本轮调用或协议处理失败。

## 13. 自动模式与手动固定模式

### 默认：能力自适应

保持：

```json
"routing": {
  "enabled": true,
  "maxAgents": 2
}
```

系统会根据任务描述，在速度、成本、编码、审查、推理、研究、写作和视觉能力之间权衡。当前自动推理档位主要使用 `low`、`medium`、`high`。

任务措辞会影响路由。例如：

- “批量、简单、快速、格式化”更偏向速度和成本效率；
- “架构、迁移、复杂、深入、彻底”更偏向高推理能力；
- “审查、安全、验证、风险”提高审查权重；
- “最新、研究、比较、来源”要求网络研究工具；
- “截图、界面、设计、图表”要求图像输入能力。

### 手动固定到 Fable

只有在你明确希望牺牲成本和速度、固定使用最高能力 Claude 时，才建议关闭自适应路由并配置：

```json
{
  "routing": {
    "enabled": false,
    "maxAgents": 2
  },
  "agents": [
    {
      "id": "codex",
      "adapter": "codex",
      "role": "Primary implementer.",
      "model": "gpt-5.6-sol",
      "effort": "max",
      "sandbox": "workspace-write",
      "ephemeral": true
    },
    {
      "id": "claude",
      "adapter": "claude",
      "role": "Peer reviewer and collaborator.",
      "model": "fable",
      "effort": "max",
      "permissionMode": "acceptEdits",
      "noSessionPersistence": true
    }
  ]
}
```

关闭路由后，模型、推理强度和顺序完全由配置决定。修改团队配置后，不要继续运行使用旧团队名单创建的任务；请创建新任务，避免任务事实与当前配置不一致。

## 14. 在哪里查看原始证据

目标项目中的状态目录：

```text
.agent-office/
├── events.jsonl
├── runs/
└── tasks/
```

- `tasks/task-....json`：任务目标、参与者、路由快照、消息、轮次和最终状态。
- `runs/`：每次 Codex、Claude 或命令代理的原始输出。
- `events.jsonl`：只追加事件记录，适合审计和监控。

最终验收不要只看“completed”。还应检查：

1. 工作区真实 diff；
2. 当前代码对应的测试输出；
3. Claude 是否审查了指定风险；
4. 是否仍有未处理的消息；
5. 产物路径是否真实存在；
6. 是否发生了未授权的外部操作。

## 15. 常见问题

### `Configuration not found`

你没有位于初始化过的目标项目，或者配置在其他位置。

```bash
pwd
ls agent-office.json
```

也可以显式指定：

```bash
node "$AGENT_OFFICE_CLI" doctor --config "/绝对路径/agent-office.json"
```

### 看不到 Fable

先刷新：

```bash
node "$AGENT_OFFICE_CLI" capabilities --refresh
```

再检查 PATH 和原生安装位置中的 Claude：

```bash
type -a claude
claude --version
~/.local/bin/claude --version
~/.local/bin/claude --help
```

Agent Office 会比较 PATH 中的 Claude 与原生安装位置 `~/.local/bin/claude`，并选择版本较新的一份。如果你在配置中显式设置了旧的 `command`，显式配置优先，需要改成正确的新版路径：

```json
"command": "/absolute/path/to/newer/claude"
```

### Fable 被发现，但真实任务拒绝访问

`advertised` 不等于账号权限已验证。请在 Claude 自身检查登录状态、套餐、usage credits 和组织策略。Agent Office 不保存或绕过 Claude 认证。

### 看板打不开

确认启动命令仍在运行，并检查终端是否提示端口占用。换一个端口：

```bash
node "$AGENT_OFFICE_CLI" serve --port 4178
```

### 任务达到轮数后仍未完成

有限轮次结束后任务可以回到 `ready`。先查看输出和消息，必要时补充方向，然后继续：

```bash
node "$AGENT_OFFICE_CLI" run "$AGENT_OFFICE_TASK_ID" --rounds 2
```

### 任务失败

依次检查：

1. `doctor` 是否仍然通过；
2. Codex/Claude 是否已登录；
3. 指定模型是否有权限；
4. 工作区是否存在；
5. 代理是否缺少文件或命令权限；
6. `.agent-office/runs/` 中的原始错误。

修复后发送一条明确的用户消息，再重新运行。

### 状态目录出现写锁

Agent Office 会等待写锁，并自动回收超过阈值的废弃锁。不要在任务运行时手工删除 `.agent-office/.write-lock`。只有确认没有 Agent Office 进程运行且自动恢复失败时，才应进一步诊断。

## 16. 安全边界

- 不要把 API key 写入 `agent-office.json`。
- Agent Office 复用 Codex 和 Claude 自己的登录与组织策略。
- 看板只监听本机，不等于具备远程认证。
- 默认允许两位代理修改目标工作区，但不会自动提交、推送或发布，除非任务明确授权且代理自身权限允许。
- 当前同一工作区采用串行写入；不要绕过编排器同时启动第二套代理修改相同文件。
- `.agent-office/runs/` 可能包含项目上下文和模型输出，不建议直接提交到 Git。

## 17. 推荐的日常工作流程

每次开始：

```text
1. 进入目标项目
2. doctor
3. capabilities --refresh
4. 用完整目标创建任务
5. 检查代理、模型、推理强度、工具缺口和顺序
6. 启动 2–4 轮
7. 观察真实文件、测试和消息
8. 必要时向 team、codex 或 claude 发送具体干预
9. 继续运行
10. 用 diff、测试和审查证据验收
```

最小命令清单：

```bash
node "$AGENT_OFFICE_CLI" doctor
node "$AGENT_OFFICE_CLI" capabilities --refresh
node "$AGENT_OFFICE_CLI" task create --objective "..."
node "$AGENT_OFFICE_CLI" task list
node "$AGENT_OFFICE_CLI" task show "$AGENT_OFFICE_TASK_ID"
node "$AGENT_OFFICE_CLI" run "$AGENT_OFFICE_TASK_ID" --rounds 4
node "$AGENT_OFFICE_CLI" message send "$AGENT_OFFICE_TASK_ID" --to team --body "..."
node "$AGENT_OFFICE_CLI" serve
```

## 18. 当前版本还没有什么

开始使用前需要知道这些边界：

- 没有跨机器中心调度；
- 没有多 worktree 并行执行和自动合并；
- 没有真实 provider 成本统计；
- 没有无费用验证 Claude 模型账号权限的方法；
- 没有运行中单次模型调用的强制取消控制；
- 没有组织级审批和远程多人认证。

这些功能可以在现有任务、事件、能力目录和适配器协议上继续增加，但不应把当前本地 MVP 当成已经具备远程生产控制面的系统。
