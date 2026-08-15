# Agent Office v2：Herdr 工作流手册

Agent Office v2 是控制面，Herdr 是持久运行时：

- Agent Office 决定任务依赖、何时并行、谁能写、何时等待审批、什么才算完成；
- Herdr 保存 Codex/Claude Code 的交互式进程、session、pane 和可观察状态；
- Turn Protocol result drop 保存语义结果。Herdr 的 `idle` 或 `done` 只说明进程状态，不能单独证明节点完成。

旧的串行 `task create` + `run --rounds` 仍然可用。v2 工作流使用同一个 TaskStore、事件流、消息系统和 dashboard。

## 1. 准备配置

先在 Git 项目中初始化：

```bash
agent-office init .
```

`init` 生成的 `stateDir` 已经在工作区之外（`$XDG_STATE_HOME` 或 `~/.local/state/agent-office/<项目名>-<摘要>`），因此工作流开箱即可创建。`agent-office doctor` 最后一行会确认这一点。

v2 会拒绝把 `stateDir` 放进执行代理可写的项目目录（会解析 symlink），避免代理篡改任务、attempt token 或审批记录。如果你手工把它改回项目内（例如老配置里的 `.agent-office`），`workflow create` 会被拒绝，`doctor` 也会提示 `workflows unavailable`。

随包发布了两个 definition：`examples/workflow.process-review.json` 走本地 Process Runtime，不需要 Herdr、也不假设项目里有 `npm test`；`examples/workflow.herdr-feature.json` 走 Herdr 常驻 session，并在 QA 节点里跑 `npm test`，适合 Node 项目。先跑通前者再换后者最省事。

Herdr 推荐使用专用命名 session：

```json
{
  "execution": {
    "runtime": "herdr",
    "maxConcurrency": 2,
    "leaseTimeoutMs": 60000,
    "snapshotMaxFiles": 50000,
    "herdrCommand": "/Users/you/.local/bin/herdr",
    "herdrSession": "agent-office",
    "herdrServerMode": "external"
  }
}
```

`external` 是安全默认值：Agent Office 只连接，不会启动或停止 Herdr。单独启动长期 session：

```bash
herdr --session agent-office server
```

也可使用 `"herdrServerMode": "managed"`。Agent Office 会以独立进程启动这个专用 session、记录 PID 和日志，但不会停止默认 Herdr session，也不会在工作流结束后杀掉代理。

每个 Herdr 控制调用都带 `--session agent-office`，不会接管日常使用的默认 session。

## 2. 定义 DAG

工作流是 JSON。随包发布的 definition 可以直接用：`--example process-review`（本地 Process Runtime，任何仓库都能跑）或 `--example herdr-feature`（Herdr 常驻 session + `npm test`）。想改的话，复制 [workflow.process-review.json](../examples/workflow.process-review.json) 或 [workflow.herdr-feature.json](../examples/workflow.herdr-feature.json) 再传 `--file`。核心节点：

- `agent`：由配置中的 Codex、Claude Code 或其他代理执行；
- `command`：以参数数组直接启动命令，不经过 shell 插值；
- `approval`：明确停在 `awaiting_input`，等待人批准；
- `integration`：由 Agent Office 唯一负责提交隔离 worktree，并 `git merge --ff-only` 到目标分支。

`dependsOn` 同时表达 fan-out、fan-in 和 join barrier。所有依赖成功后，节点才进入 ready-set；ready-set 最多并行 `maxConcurrency` 个节点。

v1 写入策略刻意保守：

- 任意数量的只读节点可以并行；
- 只允许一个 `access: "write"` 节点；
- 写节点必须使用 `workspace: "worktree"` 并声明 `writeScopes`；
- review 和 shell QA 可通过 `workspaceFrom` 只读复用该 worktree；
- 审批必须发生在写入之后；
- 每个含写节点的工作流必须有且只有一个 integration；
- 执行代理不得 commit、切分支或修改本地 Git 配置；integration 是唯一提交者；
- integration 只做 fast-forward，不自动 rebase、不解决冲突。

## 3. 创建与运行

```bash
TASK_ID=$(agent-office workflow create \
  --objective "实现一个边界安全的功能，补齐测试并通过独立审查" \
  --example process-review)

agent-office run "$TASK_ID"
agent-office task show "$TASK_ID"
```

运行到 gate 后状态是 `awaiting_input`：

```bash
agent-office workflow approve "$TASK_ID" release-gate
agent-office run "$TASK_ID"
```

若节点真实阻塞，先发送决策，再重试：

```bash
agent-office message send "$TASK_ID" \
  --to claude \
  --body "输出格式确定为 JSON；继续。"

agent-office workflow retry "$TASK_ID" build
agent-office run "$TASK_ID"
```

重试上游失败节点时，受影响的 `skipped` 后代会重新变为 `pending`。每次显式 `workflow retry` 都可以给失败或已成功但尚未发布的 agent/command 节点授权一次新的人工 attempt，即使历史 `attempts` 已达到 `maxAttempts`；原计数不会回退，自动 `status: "working"` 续跑仍受 `maxAttempts` 限制。审查阻塞时，对已成功 writer 使用同一命令会保留原 worktree 和审查消息，并重置下游审查、审批和发布节点。发布成功后不能再重开；活动节点、活动后代 attempt 或有效租约存在时也不能 retry。单任务租约和 attempt token 继续拒绝双调度器、旧回合与迟到结果。

## 4. 完成条件

Agent 节点只有同时满足以下条件才会成功：

1. 运行时已回到 settled 状态；
2. 代理写入了当前 attempt token 对应的 Turn Protocol JSON；
3. 声明的 artifacts 存在且位于工作区内；
4. 完整项目快照没有发现越权写入、ignored 输出、Git 元数据变化或外部符号链接；
5. 写节点的变化全部位于 `writeScopes`。

含写节点的 v1 工作流必须经过写节点之后的审批、Agent Office 准备提交和 `ff-only` 发布。建议像示例一样显式建模发布前、发布后的 shell QA；只有工作流定义中存在的节点才会成为 `completed` 的必要条件。

重开已成功的 writer 会作废那次准备好的提交：下游 integration 的 intent 被清掉，同时记下那个提交的 id。重新准备时，worktree 的 HEAD 必须正是那个提交——writer 重跑产生的改动以未提交的形式叠在它上面，Agent Office 会把它重置回 base 再重新提交一次，从而发布**返工后**的内容。若 HEAD 变成了别的提交（例如有人用相同 subject 换掉了它），发布会拒绝并给出恢复命令：这是 fail-closed 的取舍，宁可停下也不发布来源不明的提交。运行被杀在"准备提交"与"记录提交"之间是唯一良性的触发场景，按错误信息里的 `git -C <worktree> reset --mixed <id>` 恢复即可。

如果目标分支已经分叉，integration 会失败并保留自己准备的单一提交和已持久化的 publication intent。Agent Office 不会擅自 rebase 或覆盖用户提交。人工恢复目标分支关系后，可以对失败的 integration 执行 `workflow retry` 再次 `run`；恢复会复用精确 source HEAD，不重复提交。已经成功发布的 integration 不能重开。

## 5. 中断与恢复

任务快照使用原子写入，事件使用 append-only JSONL，任务级租约有 heartbeat。重启后：

- 先检查 result drop，避免重复执行已经完成的回合；
- 再按 Herdr 名称、kind、workspace、pane 和 agent session 验证绑定；
- 若原进程仍在 working，只等待，不重复 prompt；
- Herdr server 重启后允许 terminal generation 更新，但 agent session 不得悄悄换人；
- 无法证明已停止的旧 attempt 会失败；若它继承 writer worktree，该 worktree 会被标记为 tainted 并禁止 integration，避免后台 agent 晚写入被后续步骤吸收。

## 6. 手机远程控制

Dashboard 始终只监听 loopback，并拒绝非 loopback Host 和跨站写请求：

```bash
agent-office serve --host 127.0.0.1 --port 4177
```

手机推荐通过 Tailscale SSH 或普通 SSH 做本地端口转发，而不是把 dashboard 绑定到 `0.0.0.0`：

```bash
ssh -N -L 4177:127.0.0.1:4177 your-mac
```

然后在手机浏览器打开 `http://127.0.0.1:4177`。界面能看 DAG、发送决策、批准 gate、重试节点和继续运行；它不暴露任意命令编辑接口。

## 已知边界

- v1 只支持一个写 worktree；多个写分支的受审合并留给后续版本；
- workspace snapshot 默认最多 50,000 个文件，可通过 `snapshotMaxFiles` 调整；
- 文件快照不能替代 Codex sandbox、Claude permission mode 或操作系统隔离；网络、外部服务和工作区外副作用仍由底层工具权限约束；
- worktree 和持久 Herdr session 默认保留，便于审计与恢复，不会自动删除用户数据。
