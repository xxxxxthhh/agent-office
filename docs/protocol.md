# Turn Protocol

Turn Protocol 是 Agent Office 与代理之间的最小语义协作契约。v1 串行任务与 v2 工作流复用同一组核心字段；传输方式和完成证明因 runtime 而异。

## 输入

代理会收到纯文本提示，其中包含：

- 共享任务目标；
- 当前任务或节点、角色和完成条件；
- v1 的团队名单/状态，或 v2 当前节点的已完成依赖摘要；
- 对当前代理可见的最近消息；
- 当前解析后的 workspace 绝对路径与访问模式；
- 协作规则和输出字段。

在 v1 串行任务中，workspace 是配置的共享工作区，代理可以按自身角色直接工作。

在 v2 工作流中，workspace 由节点解析：可能是共享工作区、唯一 writer 的隔离 worktree，或由 `workspaceFrom` 继承的 writer worktree。`access: "read_only"` 的 agent/command 节点不得修改任何项目文件；`access: "write"` 节点只能修改声明的 `writeScopes`，也不得 commit、切换分支、编辑本地 Git 配置或修改 `.git`。`integration` 是受控例外：它虽然使用默认 read-only access 标记，但由 Agent Office 自身准备提交并 fast-forward 目标工作区，不把写权限交给代理。

点对点消息按收件人过滤。一个节点只能看到发给 `team`、发给自己的消息，以及自己发出的消息，不会获得其他代理之间的私聊。

## 核心输出对象

代理产生一个 JSON 对象：

```json
{
  "summary": "实现了端点并运行 8 个相关测试，全部通过。",
  "status": "done",
  "messages": [
    {
      "to": "reviewer",
      "body": "请重点检查 src/health.js 的超时处理和 tests/health.test.js。"
    }
  ],
  "artifacts": [
    "src/health.js",
    "tests/health.test.js"
  ],
  "needsUser": false
}
```

正式核心 Schema 位于 [`schemas/turn.schema.json`](../schemas/turn.schema.json)。

### `summary`

本次 attempt 已完成工作或发现的简明事实。调度器会把它作为团队消息保存，因此不要放隐藏推理、凭据或无关日志。

### `status`

- `working`：本次 attempt 有有效进展，但节点职责尚未完成。
- `blocked`：当前代理无法安全继续，需要外部决策或条件变化。
- `done`：当前角色或节点的完成条件已经满足。

在 v1 串行模式中，`working` 表示该代理仍需要未来轮次。在 v2 中，`working` 只有在节点仍有 `maxAttempts` 配额时才会让节点再次进入 `ready`；配额耗尽会使节点失败。`blocked` 或 `needsUser=true` 会把 v2 节点置为 `blocked`，任务在没有其他 ready 节点时进入 `awaiting_input`。

`done` 是代理的语义声明，但不是唯一证据。v2 还会验证 result token、artifact、workspace 快照、write scopes 和 Git 边界；任何验证失败都会使节点失败。

### `messages`

显式交接消息。`to` 可以是：

- `team`：所有参与代理；
- 一个属于当前任务的代理 ID；
- `user`：请求用户决策。

未知收件人会被丢弃。v1 中发给已 `done` 的代理会将其重新激活；v2 中 rework 由节点状态和 `workflow retry` 显式控制。

### `artifacts`

本轮产生或核验的 workspace 相对路径。该字段不是文件上传机制。

v1 将 artifacts 用作审计信息。v2 会验证每条路径不能是绝对路径或逃出 workspace，目标必须存在且不能是符号链接。列出 artifact 不会放宽 `read_only` 或 `writeScopes` 限制。

### `needsUser`

只有团队无法安全自行决定时才设为 `true`，并同时通过 `messages` 向 `user` 说明需要什么决定。它会暂停任务，但不会自动消费或执行用户回复；用户发送消息、按需 retry 节点并再次 `run` 后继续。

## 三种传输方式

### v1 和 Process Runtime 的 agent 输出

Codex、Claude 和通用 command adapter 从提示或 stdin 接收完整输入，并通过 stdout/其结构化输出通道返回核心 Turn Protocol 对象。通用程序必须：

1. 从 stdin 读取完整输入直到 EOF；
2. 在超时前退出；
3. 以退出码 0 表示进程成功；
4. 向 stdout 写一个协议对象；
5. 将诊断日志写到 stderr。

模型输出偶尔包含 Markdown fence 时，adapter parser 会尝试提取其中的 JSON。完全无法解析时，纯文本会作为 `summary` 保留并归一化为 `status: "working"`。这个宽松 fallback 只适用于 adapter 输出解析，不适用于 Herdr result drop。

### Herdr Runtime 的 result drop

`runtime: "herdr"` 工作流中的 `agent` 节点使用严格的文件交接。Agent Office 为每次 attempt 创建权限为 `0600` 的空文件：

```text
<os.tmpdir()>/agent-office-turns/<task-id>/<node-id>/<attemptToken>.json
```

提示会给出精确路径和 attempt token。代理必须在结束当前交互前，向这个文件写入一个 JSON 对象，包含核心字段和额外的 `attemptToken`：

```json
{
  "attemptToken": "token-from-the-current-prompt",
  "summary": "审查完成；没有阻塞性问题。",
  "status": "done",
  "messages": [],
  "artifacts": [],
  "needsUser": false
}
```

这里的 `attemptToken` 是 v2 result-drop envelope 元数据，不是 `schemas/turn.schema.json` 的字段。校验 token 后，TaskStore 只保存归一化的核心 Turn Protocol 对象。

Herdr 的终端状态和聊天输出不能替代这个文件。Agent Office 会在 runtime settle 后读取 result drop；文件缺失、JSON 无效、token 过期/不匹配或节点已经接受过结果时都会 fail closed。迟到的旧 attempt 也不能覆盖新 attempt。

每个 agent 只获知并获准访问当前节点自己的 result-drop 目录。其他节点的 drop 是私有控制数据，协作内容必须通过经过可见性过滤的 `messages` 和依赖摘要传递，不能直接读取兄弟节点文件绕过收件人边界。

### v2 `command` 节点

`command` 节点不是通用 command adapter，也不要求命令自行产生 Turn Protocol JSON。Process Runtime 以参数数组和 `shell=false` 执行定义中的 `command`/`args`，成功退出后把 stdout 或 stderr 摘要包装成 `status: "done"` 的协议结果。

命令环境默认只包含 `PATH`，以及节点 `env` 数组显式列出的变量名；workflow definition 保存名称，不保存秘密值。命令失败、超时或产生工作区越权变化都会使节点失败。

## Attempt、重试与 rework

每次 v2 节点从 ready-set 被领取时：

1. `attempts` 加一；
2. 生成新的随机 `attemptToken`；
3. 清除旧 result/error；
4. 只有状态仍为 `working` 且 token 匹配时才接受一次 result。

自动重试只发生在代理返回 `status: "working"` 且尚未达到 `maxAttempts` 时。进程错误、校验失败或在配额耗尽时仍返回 `working` 都会使节点 `failed`，需要显式 `workflow retry`。

手动 retry 的语义：

- `blocked`：清除阻塞结果；当已提交结果的 `status` 明确为 `blocked` 时，退还该 attempt 的一次配额；
- `failed agent/command`：每次显式 retry 授权一次新的人工 attempt，即使 `attempts >= maxAttempts`，并将其 `skipped` 后代恢复为 `pending`；
- `succeeded agent/command`：在尚未成功发布时，每次显式 retry 授权一次 rework attempt，并重置全部下游节点；
- `failed integration`：修复目标分支关系后可重开，已持久化的精确 intent 会被复用；
- `approval`、成功的 `integration` 或已经有成功 integration 后的上游节点：拒绝 retry。

手动 retry 不会递减 `failed`、`succeeded` 或 `failed integration` 的历史 attempt 计数；只有上述明确的 `blocked` 结果会退还一次。超出 `maxAttempts` 后获批的人工 attempt 如果仍返回 `working`，不会自动再跑。成功 writer 的 rework 会重置 review、QA、approval 和 integration 等全部下游，但保留首次写入前的 integration baseline，使最终发布包含相对该基线的最终净变化，而不只比较最后一次 attempt。存在活动节点、有效工作流租约或活动后代 attempt 时，控制操作同样会被拒绝。

retry 只准备状态；必须再次执行 `agent-office run <task-id>` 才会调度。

## Artifact 与 workspace 完成证明

一个 v2 agent 节点要成功，需要同时满足：

1. Process/Herdr runtime 已 settle；
2. 当前 attempt 已提交有效 Turn Protocol 结果；
3. 声明的 artifacts 通过 workspace 边界检查；
4. before/after 完整快照满足 `read_only` 或 `writeScopes`；
5. 若是 writer，后续 integration 仍需验证 Git 元数据、可发布文件和唯一提交策略；
6. 若 runtime 在失败后无法证明执行器已停止，继承 writer worktree 的节点会 taint 该 worktree，禁止发布可能发生的晚写入。

因此“进程结束”“Herdr 显示 idle”“stdout 打印 JSON”或“artifact 字符串看起来正确”都不能单独证明节点完成。
