# 将 `feature/herdr-runtime-dag` 合入 `main` 的清单

状态：**集成完成并已推送 `integrate/herdr-runtime-dag`**（`origin/main` 是其祖先，可 fast-forward）。
验收：`npm run check` 全绿。经过 0.4 的多轮评审后，本清单第 3 节的集成步骤全部完成；剩下的只有对外合并动作本身。

日期：2026-08-13 立；集成状态最后核对于 2026-08-16。

这份清单记录的是一次**语义集成**，不是点 GitHub Merge。Feature 建在另一棵初始历史上，当前 `main` 已经是 reviewed 的 0.3 运行时。共享文件两边都改过；自动合并后的 `store.js` / `orchestrator.js` 尤其不能当正确结果。

## 1. 合并时的固定点

核对时若这些值变了，先重跑对比，再改清单。

| 引用 | 提交 | 含义 |
|---|---|---|
| 本地 `main`（当时 HEAD） | `c7be59d` | 比 `origin/main` 超前 2 个提交 |
| `origin/main` | `a247e15` | GitHub 默认分支 |
| `origin/feature/herdr-runtime-dag` | `cb70eb0` | 已推送，工作树干净 |
| 共同祖先 | `d6f1e45` | `Initial Agent Office release` |
| 本地 feature 分支 | 无 | 只有远端 |
| 已有 PR | 无 | |

本地 `main` 尚未推送的 2 个提交：

- `bed9245` Add one-command launcher with system proxy support
- `c7be59d` Clear stale failure state after successful retry

这两笔也改了 `README.md`、`src/cli.js`、`src/orchestrator.js`。先推它们再集成，可以少解一轮冲突。

## 2. 原则（先定，再改文件）

1. **权威在当前 `main`。** 租约、workspace lock、fence、测试监督器、`start`、archive/delete、system proxy 以 `main` 为准。
2. **Feature 按能力迁入，不按整文件覆盖共享模块。** 新文件可以整份拿来；`store` / `cli` / `server` / `config` / `process` / dashboard 只补 API。
3. **两套工作区实现都留。** `src/workspace.js` 服务串行任务的 baseline / diff；`src/workspaces.js` 服务 workflow 的 worktree。不要改名合并成一个模块，除非单独开重构。
4. **测试继续走 `tools/run-tests.mjs`。** 不要改回裸 `node --test`。Feature 测试本身已是 `node:test`，应能挂在现有监督器下。
5. **配置两个顶层键都留。** `retention`（main）和 `execution`（feature）不是二选一。
6. **不要用 GitHub 绿按钮结束。** 没有现成 PR；有了也会在第 4 节的文件上失败。冲突消掉不等于能跑。

推荐做法：在最新 `main` 上开集成分支，拷新文件，再把 workflow 补进 main 的共享实现。Git merge / rebase 可以作为对照，但不要把 auto-merge 的共享文件直接提交。

## 3. 建议顺序

- [x] 从最新本地 `main`（含未推送的 `bed9245`、`c7be59d`）切 `integrate/herdr-runtime-dag`
- [x] 拷贝第 5 节的新文件
- [x] 按第 4 节把能力补进共享文件；`main` 已有行为全部保留
- [x] 按第 6 节改测试脚本和文档
- [x] 跑第 7 节验收（`npm test` 与 `npm run check`；随后的评审轮次又补了回归用例，计数以当前分支为准）
- [x] `bed9245`、`c7be59d` 已随集成分支进入历史，不再需要单独推 `origin/main`
- [ ] 需要对外合入时再开 PR 或直接 fast-forward：`integrate/herdr-runtime-dag` → `main`

## 4. 共享文件：冲突 + 怎么留

`git merge-tree` 对本地 `main` 和 `origin/main` 给出同一组冲突。数字是当时用三方 `merge-file` 数出来的冲突块。

| 文件 | 冲突 | 留 main | 从 feature 补 |
|---|---|---|---|
| `src/store.js` | 1（只是 import；类体自动拼会 silently 错） | `acquireRunLease`、workspace lock、heartbeat、fence、`setArchived` / `deleteTask`、`listLeases`、`pruneRunFiles` | `createWorkflow`、`submitWorkflowTurn`、`approveWorkflowNode`、`retryWorkflowNode`、`assertWorkflowControlIdle` |
| `src/adapters/process.js` | 6 | `killTree`、进程树存活检查、现有超时/输出上限 | Herdr / workflow 需要的调用约定；不要换掉 main 的杀树逻辑 |
| `src/cli.js` | 3 | `start`、`doctor`、`task archive/unarchive/delete`、system proxy | `workflow create \| approve \| retry` 及 workflow 输出格式 |
| `src/server.js` | 3 | archive / cancel / delete / trace / diff | `POST /api/tasks/<id>/nodes/<node-id>/approve`、`.../retry` |
| `src/config.js` | 2 | `retention`、现有默认 `stateDir` 行为 | `execution`（`runtime`、`maxConcurrency`、`leaseTimeoutMs`、`snapshotMaxFiles`、herdr 相关字段） |
| `package.json` | 2 | `files`、`tools/run-tests.mjs` 作为 `test` / `check` 入口 | 版本是否升 `0.4.0` 另定；`check` 里加上新源文件的 `node --check` |
| `dashboard/app.js` | 2 | 现有串行任务控制台 | workflow 节点状态、approve / retry / rework |
| `README.md` | 5 | 现有 0.3 能力、lease、start、安全边界 | DAG / Herdr / worktree 发布门；命令列表两边拼接 |
| `docs/architecture.md` | 3 | 当前组件图和 reviewed 语义 | workflow / Herdr / worktree 作为附加组件，不要写回旧串行-only 描述 |
| `docs/getting-started.zh-CN.md` | modify/delete | **main 已删**，用户手册是 `docs/user-manual.md` | 不要恢复旧 getting-started 当主入口。workflow 操作写进 user-manual，或保留 `docs/workflows.zh-CN.md` 并改链接 |

Git 会自动合并、但仍是双方都改过、提交前必须人工看的文件：

| 文件 | 注意 |
|---|---|
| `src/orchestrator.js` | main 有 lease / 可中断 run；feature 只加了少量挂钩。以 main 为底再接 workflow |
| `src/runtime.js` | 装配 `WorkflowOrchestrator` / runtime 时不要拆掉现有 store / capability 装配 |
| `dashboard/styles.css` | 只收 workflow 视图需要的样式 |
| `tests/cli.test.js` | 保留 main 的 start / archive 用例，再加 workflow 子命令 |
| `tests/server.test.js` | 保留 cancel / archive / delete，再加 node approve / retry |
| `tests/store.test.js` | 保留 lease / archive 用例，再加 workflow 快照方法 |

## 5. Feature 独有文件：整份拿来

这些文件在 `main` 上不存在，git 不会对它们报内容冲突。拿来之后检查 import 是否指向**集成后的** `store` / `config` / `process`，而不是 feature 旧实现。

运行时：

- [x] `src/execution-runtimes.js`
- [x] `src/workflow-definition.js`
- [x] `src/workflow-orchestrator.js`
- [x] `src/workspaces.js`

测试与夹具：

- [x] `tests/execution-runtimes.test.js`
- [x] `tests/workflow-definition.test.js`
- [x] `tests/workflow-orchestrator.test.js`
- [x] `tests/workspaces.test.js`
- [x] `tests/fixtures/fake-herdr.js`
- [x] `tests/process.test.js`（feature 新增；和 main 已有 process 测试合并，不要盖掉监督器相关用例）

文档与示例：

- [x] `docs/workflows.zh-CN.md`
- [x] `docs/protocol.md` 里 feature 多出来的 workflow / Herdr 段落
- [x] `examples/workflow.herdr-feature.json`

## 6. 集成时不要漏的语义点

- [x] `TaskStore` 构造和 `#withLock` 保持 main 的 leases 目录与 workspace lock；workflow 节点 lease 是任务快照里的字段，不是替换磁盘租约
- [x] `listTasks({ includeArchived })` 保留；feature 的无参 `listTasks()` 不要倒退
- [x] `normalizeConfig()` 同时校验 `retention` 和 `execution`
- [x] 默认 `stateDir`：main 仍兼容项目内 `.agent-office`；feature 文档写的是 `~/.local/state/agent-office/<hash>`。集成时明确哪一种是 init 默认，哪一种只是 workflow 的约束
- [x] Workflow 创建时拒绝「控制状态落在 executor workspace 内」如果那是 feature 的不变量，要在 main 的 init / store 路径上显式执行，不要只写在文档里
- [x] Dashboard 与 CLI 在任务 `mode === "workflow"` 和串行模式之间都能工作
- [x] `package.json` 的 `check` 继续跑监督器，并 `node --check` 新源文件

## 7. 验收

下列各项已在 2026-08-16 于集成分支核对：`npm run check` 全绿；`init` / `doctor` / `task create|run|archive|unarchive|delete` / `workflow create|approve|retry` / worktree writer 与 ff-only 发布均在临时工作区实跑通过；`start`、`serve`、system proxy、fake-herdr 身份校验由对应测试覆盖。仅未勾选项是合并动作本身。

现有回归（合入后必须仍过）：

- [x] `npm test`（即 `node tools/run-tests.mjs`）
- [x] `npm run check`
- [x] `agent-office start` / `serve` / `doctor`
- [x] 任务租约、workspace lock、Ctrl+C / 停止运行后锁释放
- [x] `task archive` / `unarchive` / `delete`
- [x] system proxy / 一键启动相关测试

Feature 能力：

- [x] `tests/workflow-orchestrator.test.js` 及同批新测试在监督器下通过
- [x] `agent-office workflow create --objective "..." --file examples/workflow.herdr-feature.json`
- [x] `workflow approve` / `workflow retry` 后再 `run`
- [x] 只读节点可并行；唯一 writer 走隔离 worktree
- [x] HTTP approve / retry 与 dashboard 节点操作一致
- [x] 无 Herdr 时 `runtime: "process"` 仍能跑 workflow；有 Herdr 时 fake-herdr 夹具覆盖身份校验

文档：

- [x] README 同时描述串行 0.3 能力和 workflow / Herdr
- [x] `docs/user-manual.md` 或 `docs/workflows.zh-CN.md` 可独立走通 v2 操作
- [x] 不再把已删除的 `docs/getting-started.zh-CN.md` 当作主入口

## 8. 当时的命令（只读对照）

```bash
git fetch origin
git log --oneline origin/main..main
git log --oneline origin/main..origin/feature/herdr-runtime-dag
git merge-tree --write-tree --name-only main origin/feature/herdr-runtime-dag
```

不要用这些命令的成功输出当集成完成。`merge-tree` 只能列出 git 冲突；第 6、7 节才是完成条件。
