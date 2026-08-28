# Agent Office 完成度终审报告

- **对象**:/Users/kyx/Documents/AgentOffice @ main `a9bca24`(0.4.0,工作树 clean)
- **输入**:Codex(gpt-5.6-sol high,NOT_READY / 72)、OpenCode + DeepSeek V4 Pro(READY / 82)、实施者(Claude Opus 5)实跑与静态复核清单
- **汇总人**:Claude Fable 5。本报告的分歧条目全部由汇总人**直接读仓库代码重新裁决**(只读),不是对两份报告的调和。裁决中新读并核对的关键文件:`src/workspaces.js`、`src/store.js`、`src/adapters/process.js`、`src/orchestrator.js`、`src/server.js`、`src/workflow-orchestrator.js`、`src/execution-runtimes.js`、`src/workspace.js`、`dashboard/app.js`、`examples/workflow.process-review.json`、README。

---

## 1. 最终结论:有条件可用(分场景判定,不取平均)

**可以投入真实使用的场景:**

- **串行协作模式**(多 agent 轮流在共享工作区实现/审查/返工,有人监督、发布前人工 `git diff`):可用。这一侧的锁、fencing、诊断、用量、基线 diff 都完整且被测试压实。
- **workflow v2 的只读/评审类 DAG**(无 write + publish 节点):可用。
- 离线 demo、dashboard 观察、消息/返工闭环:可用。

**不该用于的场景(X 说清楚):**

1. **无人值守的 workflow 自动发布**——正常退出路径不验证进程树停止(F-03),遗留后台进程构成无 fence 的第二写者。
2. **把 dashboard 审批页当作充分证据的任何审批流程**——workflow 的 gate 时刻,审批 UI 展示的是空 diff(F-01),审批人实际上在批一段文字摘要。
3. **在重要真实仓库上依赖「被审批内容 = 被发布内容」承诺的发布门**——Git index / file mode 对快照不可见,`git commit` 提交整个 index,可发布审查者从未见过的内容(F-02),且**纯意外即可触发**,不需要对抗性 agent。

过渡用法:懂内情的操作者在低风险仓库上,审批前手工进 writer worktree 跑 `git diff`、`git diff --cached`、`git status`,确认后再点批准,可以用;但这不是产品承诺的形态。

**判定归属**:Codex 的 NOT_READY 在「旗舰发布门尚未兑现承诺」这一点上方向正确;DeepSeek 的 READY 在「工程底盘和串行模式已达真实可用」这一点上正确。但 DeepSeek 宣称「三条核心不变量实测成立、0 个 P1」是**错的**——发布路径上存在两个其审计未触及的结构性 P1(F-01、F-02),均已被实施者静态复核和本次汇总人读码三方确认。同时 Codex 漏掉了 DeepSeek 发现的正常退出缺口(F-03),且其 7 条 P1 里有 4 条被本次裁决降级。

---

## 2. 最终评分:75 / 100

| 评审员 | 分数 | 汇总人态度 |
|---|---|---|
| Codex | 72 | **方向对、细节偏罚**。7 条 P1 降为 3 条框架下只剩 2 条成立(P1-01、P1-02);P1-03/04/05 降 P2,P1-07 是本机环境问题降 P3;「第一次使用 11/15」的扣分被实施者干净 prefix 的完整实跑(pack→install→init→doctor→workflow create 全通)部分推翻。这些合计值回约 +3。但它漏掉 F-03 这条真 P1,不再加。 |
| DeepSeek | 82 | **底盘评估对、安全结论错**。82 分建立在「发布门禁已实现且无 fail-open」的假设上;该假设被 F-01/F-02 直接否定,且两条都在其宣称逐行读过的模块(`server.js`、`workspaces.js`)内。对旗舰卖点的漏判,-7。其对 P2-1 的发现和「串行是更弱一侧」的分层判断则是全场质量最高的单条发现之一。 |

75 分的含义:**advanced beta**。可运行、可演示、测试文化扎实(198/198,含大量故障注入),串行模式接近产品级;v2 发布门的状态机完整,但「安全」这个卖点的三块承重墙(审批证据、内容权威、停止证明)各有一个结构性洞。

---

## 3. 合并问题清单(按汇总人严重度重排)

### P1(3 条)

**F-01 [P1] workflow 审批界面展示的是 target 工作区的空 diff,不是 writer worktree 的待发布内容**
`src/server.js:128-138`、`src/orchestrator.js:93-101`、`dashboard/app.js:934`、`examples/workflow.process-review.json:37`
发现:Codex(P1-02)。确认:实施者静态复核 + 汇总人读码。
汇总人补充的实锤:`#ensureWorkspaceBaseline` 只在串行分支调用,workflow 任务的 `workspaceBaseline` 永远是 undefined;`diffSince(workspace, null)` 回落到对 target 工作区「相对 HEAD」的 diff(`src/workspace.js:106-110`);gate 时刻 target 干净 ⇒ 审批人点「工作区 diff」看到「(没有可显示的补丁)」。而示例 gate 的 prompt 明确写着 "Read the diff … before publishing"。另:`approveWorkflowNode`(`src/store.js:239-247`)只翻状态,**不绑定任何树哈希**。
裁决:**这是三条 P1 里对产品卖点杀伤最大的一条**。「人工审批」不是证据不足,而是给出错误证据(空 diff)——人工审批实质退化为「批 writer 的自述摘要」。判给 Codex,维持 P1。
修复方向:新增 workflow source diff API,以 integration source 的 `baseHead..worktree` 为权威;gate 页面必须展示它;approval 记录当时的树哈希,publish 前重验,变化即失效。

**F-02 [P1] 快照对 Git index / file mode 盲视;`git commit` 提交整个 index,可发布无人审过的内容**
`src/workspaces.js:111-116`(snapshot 只记 `file:<sha256>`,无 mode)、`:522-534`(git metadata 只有 head/branch/config)、`:288-303`(`git add --all -- <projectChanges>` 后普通 commit)、`:311-314`(只按路径校验 writeScopes)
发现:Codex(P1-01)。确认:实施者 + 汇总人端到端追了一遍状态位。
攻击者模型裁决(用户点名的问题):代码自身的设计——禁 agent commit、禁改 branch/local config、writeScopes、worktree 隔离——已经把 writer 当**半可信对手**对待,所以「writer 会做坏事」在这个项目的威胁模型之内,不能以「agent 是自己人」为由降级。同时要诚实:完全恶意的 agent 拥有同用户任意代码执行,可以直接写 target 仓库,任何门禁都挡不住;门禁的**有效**威胁模型是「犯迷糊 / 被 prompt 注入的 agent 在 worktree 内的常规 git 操作」。而 F-02 恰好落在这个模型内,且**可纯意外触发**:writer 中途 `git add -A`(agent 极常见的习惯动作),之后把某文件改回 baseline 内容、未再 add——该文件不进 projectChanges(快照看不出变化)、但在 dirtyFiles 里(MM 状态,不触发 invisible 检查),commit 时 index 里的中间版本被原样发布,审查者与审批人都没见过它。裁决:**维持 P1,且因意外可触发而加重**。
修复方向(比 Codex 的方案更便宜,代码里已有先例):返工路径在 `:267-275` 已经做了 `git reset --mixed baseHead` 重建 index,**首次 prepare 路径补上同一步**;snapshot 编入 file mode;commit 后断言 `git status --porcelain` 为空(worktree==index==commit tree,即提交树与快照所见一致);approval/publish 绑定树哈希(与 F-01 合修)。

**F-03 [P1] 正常退出路径从不验证进程树消失,遗留后台进程构成无 fence 的第二写者;串行侧没有任何事后校验**
`src/adapters/process.js:198-220`(`close` 无 termination 在途时直接 settle;`settleWhenTreeExits` 只挂在 termination 路径)
发现:**DeepSeek(P2-1),Codex 完全没提**。确认:实施者静态复核 + 汇总人读码。
裁决:**升级为 P1**。理由:(a)触发是常见非对抗行为——agent 为验证改动起一个 dev server(`npm run dev &`)后正常退出,进程组仍活,编排器释放锁进入下一轮,直接击穿 README:22 的单写者承诺且不走任何 fence;(b)串行侧零事后校验(DeepSeek 自己指出的分层判断,正确);(c)workflow 侧的 `postWriterChanges` 兜底只覆盖快照时点**之前**的改动——后台进程在快照之后、`git add` 之前写入 projectChanges 路径内的内容,会被 `git add --all` 收进发布提交,又构成一条「未审内容进发布」路径,与 F-02 汇流;(d)它还是 F-06(crash 窗内替换 commit)唯一现实的本地行动者。DeepSeek 给的修复方向正确:`close` 后无 termination 时也轮询 `isTreeAlive` 一小段(1–2s),仍存活则按 unproven stop 处理(串行 fence、workflow 走既有 unproven 路径)。

### P2(7 条)

**F-04 [P2·高] workflow 失败丢 exit code / stderr / trace,与「失败可诊断」承诺相反**
`src/execution-runtimes.js:97`(trace 只在 `runProcess` 成功后写)、`src/workflow-orchestrator.js:488`(`#failNode` 只存 `error.message`)、README.md:25
发现:Codex(P1-06)。裁决:事实完全成立,但不破坏安全不变量,是运维必修项而非门禁缺陷 → 降 P2(高优)。真实 workflow 的第一次失败大概率是诊断死路,修不掉这条就谈不上日常使用。
修复:失败路径也先落 trace;node/event 保存结构化 failure(code/signal/timedOut/stderr 摘要/tracePath);CLI/dashboard 复用串行的失败渲染。

**F-05 [P2] ff-only 发布对 target branch 存在 check→merge TOCTOU**
`src/workspaces.js:363-426`(branch 读取与 merge 之间约百毫秒级的多个 git 子进程窗口;merge 后只验 HEAD==sourceHead,不复验 symbolic ref)
发现:Codex(P1-04)。裁决:**事实对、级别高估,降 P2**。唯一有意义的行动者是外部并发(人 / 其他工具在发布瞬间切分支到一个同 base 分支)——能在 target 仓库跑 checkout 的恶意 agent 早就能直接写 target,门禁本来管不住。这是可靠性 bug 不是门禁绕过。修复便宜且值得:`git update-ref refs/heads/<target> <source> <expected-base>` 做 CAS + merge 前后复验 symbolic-ref。

**F-06 [P2] 首次 prepare 的 commit→intent 崩溃窗用可预测 subject 当 provenance**
`src/workspaces.js:220-255`(count==1 + subject 匹配即接受;`invalidatedPreparedHead` 为 null 时无 exact OID 校验)、`src/workflow-orchestrator.js:238-250`(intent 在 commit 之后另一次 updateTask 才持久化)
发现:Codex(P1-03)。裁决:**结构成立,但独立可利用性被高估,降 P2**。汇总人推演:替换的 commit 要活过 `postWriterChanges`(与 verifiedSnapshot 比对)和 dirtyFiles-empty 两道检查,意味着其树必须与已验证内容在**快照可见维度**完全一致——可利用窗口收敛到 F-02 的快照盲区(mode/index)。按树哈希方式修好 F-02 后,本条的利用面基本闭合;剩余的是 provenance 卫生:intent 应在 commit 前(或用 plumbing 预计算 OID 后原子地)持久化。作为独立缺陷不够 P1。

**F-07 [P2] takeover mutex 与 state lock 按年龄无条件回收,可清掉活着但冻结的持有者**
`src/store.js:686-689`(mutex 目录无 owner 身份,>staleLeaseMs 即 rmdir)、`:1154-1157`(state lock 同样按 mtime 回收)、默认阈值 30s(`:40-44`)
发现:Codex(P1-05)。裁决:**结构成立、级别高估,降 P2**。触发需要:存在死 PID 的 stale lock、接管者 A 在亚秒级临界区内冻结 >30 秒、竞争者 B 恰好同时到达;同机场景下锁本身的 stale 判定要求持有者 PID 已死(SIGSTOP 的进程 `kill -0` 仍活,不会被判 stale),进一步收窄;heartbeat 把双写窗口压到秒级并触发 abort+fence。真正的协议缺陷是 **mutex 没有 owner 身份**——修复便宜:mutex 内写 owner identity + 存活探测,owner-only release;state lock 同理。「无条件单写者」的文档措辞在修复前应加注。

**F-08 [P2] README 的实时进度与用量承诺只对串行成立,workflow 未接通**
`src/execution-runtimes.js:74-81`(`runTurn` 不传 onProgress)、`src/workflow-orchestrator.js:874-890`(`recordWorkflowTurn` 不写 usage/model/effort)、README.md:23-24 为无条件表述
发现:Codex(P2-01)。裁决:成立,维持 P2。文档承诺的功能在主推的 v2 一侧缺席。

**F-09 [P2] doctor 绿色 ≠ 真能跑;workflow 不可用只警告且 exit 0;README 与手册口径不一**
`src/capabilities.js:132-139`、README.md:112 vs docs/user-manual.md:7
发现:双方共识(Codex P2-05 / DeepSeek 一致性核查第 1 条)。裁决:成立。手册已诚实披露,README 表格过强。修复:统一文案为「CLI 可探测,回合兼容未验证」;提供显式计费的 `doctor --smoke-turn`;workflow 不可用时对 `--mode workflow` 的调用应非零退出。

**F-10 [P2] starter workflow 的 writeScopes 很窄,首用者在真实模型花费之后才撞越界**
`examples/workflow.process-review.json:21`(仅 `src/**`、`tests/**`、`README.md`)、docs/workflows.zh-CN.md:61
发现:Codex(P2-04)。裁决:成立。创建时打印 writeScopes 并要求确认,或提供 `--write-scope`。

### P3(6 条)

- **F-11 [P3]** 快照与事件日志非事务(`src/store.js:402-412`)。双方共识(Codex P2-02 / DeepSeek P2-3)。**处置判给 DeepSeek**:快照仍是一致的事实源,不丢数据,只缺审计一条;文档明示该窗口即可。Codex 的 WAL 方案对该产品阶段是过度工程。
- **F-12 [P3]** 损坏的隔离标记锁读不出时降级为通用锁超时,丢失 fencing 指引(`src/store.js:984-993` 对解析失败返回 null,与 `#unreadableFence` 的 fail-closed 语义不对齐)。发现:DeepSeek(P2-2)。仍是 fail-closed,但误导操作者按「删锁」路径处理有二次风险 → P3 偏高,修复一行分支(ENOENT 与解析失败分开)。
- **F-13 [P3]** 本机 PATH 遮蔽:`~/.hermes/node/bin` 的旧 agent-office 遮住新装入口(README.md:36-40)。发现:Codex(P1-07)。裁决:**降 P3——机器环境问题,不是仓库缺陷**。实施者在干净 prefix 实跑证明安装链完整可用,且发现 Codex 自己的证据有出入(实施者 `npm prefix -g` 读到 `~/.hermes/node`,Codex 报告写 `/opt/homebrew`,两者读的是不同 npm 配置)。留下的合理动作:README 安装段加 `command -v` / `hash -r` 核对,doctor 增加 shadowed-binary 检测。
- **F-14 [P3]** stateDir 文档自相矛盾(README.md:90 与 434-447 冲突;examples/team.codex-claude.json 仍是旧式 workspace 内状态)。发现:Codex(P2-03)。成立,改文档 + 给旧示例标注 serial-only。
- **F-15 [P3]** 代码质量项打包:重复的 `parsePositiveInteger`、`server.js:195` 中文错误串混英文界面、`workspace.js`/`workspaces.js` 一字之差命名、消息构造平行实现。发现:DeepSeek(P3-1~P3-5)。成立,顺手修。
- **F-16 [P3]** worktree / Herdr session 无 list/gc/retain,默认永久保留。发现:Codex(运维清单)。成立,长期运维需要。

---

## 4. 分歧点逐条裁决表

| 条目 | Codex | DeepSeek | 汇总人裁决 | 一句话理由 |
|---|---|---|---|---|
| 总判定 | NOT_READY | READY | **有条件可用**(见 §1) | 旗舰发布门未兑现(Codex 对);串行与底盘已可用(DeepSeek 对);不能取平均,按场景切开 |
| index/mode 绕过审批 | P1 | 未发现 | **P1,判 Codex** | 三方读码确认;可纯意外触发(agent 中途 git add);首次 prepare 缺 index 重建而返工路径已有,修法现成 |
| 审批 UI 看错 diff | P1 | 未发现 | **P1,判 Codex,且是最重一条** | workflow 任务无 baseline ⇒ gate 时刻 UI 展示空 diff;审批实为批摘要;approval 不绑哈希。直接否定「人工审批」卖点在 v2 的成色 |
| 正常退出不验进程树 | 未发现 | P2 | **P1,判 DeepSeek 但升级** | 常见行为触发、击穿单写者且无 fence、串行零兜底、并为 F-06 提供唯一现实行动者;Codex 漏检 |
| prepare→intent 崩溃窗 | P1 | 未发现 | **P2,部分判 Codex** | 结构成立;但替换树须同时骗过 postWriterChanges 与 dirty 检查,可利用性收敛到 F-02 盲区;修好 F-02 即基本闭合 |
| ff-only check→merge TOCTOU | P1 | 未发现 | **P2,部分判 Codex** | 真 TOCTOU,但仅外部并发可达,恶意 agent 场景下门禁本就失效;CAS 修复便宜 |
| live stale mutex 回收 | P1 | 未发现 | **P2,部分判 Codex** | mutex 无 owner 身份是真缺陷;但需 30s 级冻结叠加多重巧合,heartbeat 兜底;「理论洁癖」偏多但值得修 |
| workflow 失败丢 stderr | P1 | 未提 | **P2 高优** | 完全属实,是可用性/运维必修,非安全门缺陷 |
| PATH 遮蔽 | P1 | 未提 | **P3** | 环境问题;实施者干净环境实跑推翻「首用链失败」的普适性;且 Codex 证据本身有出入 |
| doctor 绿≠能跑 | P2 | 已标注边界 | **P2,双方各对一半** | 手册诚实(DeepSeek 对),README 过强且 exit 0 会骗自动化(Codex 对) |
| snapshot/event 非事务 | P2(建议 WAL) | P2/P3(建议文档明示) | **P3,处置判 DeepSeek** | 不丢数据只缺审计;WAL 过度工程 |
| 损坏隔离锁降级报错 | 未提 | P2 | **P3,判 DeepSeek 但降半级** | 仍 fail-closed;损失的是指引不是防线 |

---

## 5. 修复优先级路线图

### 只做 3 件事,把判定翻成「可用」(含监督式真实仓库发布)

1. **审批看得见真 diff(F-01)**:新增 workflow source diff API(integration source worktree 的 `baseHead..worktree`),gate UI 指向它;approval 记录树哈希。工作量最小、可信度收益最大。
2. **被审批 = 被发布(F-02,顺带闭合 F-06 大半)**:首次 prepare 前 `git reset --mixed baseHead`(返工路径 `workspaces.js:267-275` 已有此逻辑,搬过来);snapshot 记 file mode;commit 后断言工作树 clean;publish 前比对树哈希与 approval 所绑哈希。
3. **一切退出都证明停止(F-03)**:`close` 后无 termination 在途时轮询 `isTreeAlive` 1–2s,仍存活按 unproven stop 走既有 fence/unproven 路径(串行与 workflow 都接)。

三件都配上对应的故障注入回归测试(staged-then-restored、chmod-only、gate 页 diff 断言、后台进程遗留)。**这三件合计工作量不大——两件的修法在代码库里已有先例或现成路径。**

### 要达到「可安全用于真实仓库的无人值守自动发布」,还需

4. F-05:target ref 用 `update-ref` CAS 原子前进,merge 前后复验 symbolic-ref。
5. F-06 余量:intent 在 commit 前(或 plumbing 预计算 OID 后原子)持久化,彻底废除 subject provenance。
6. F-04:workflow 失败保留结构化 code/stderr/trace——无人值守场景的诊断生命线。
7. F-07:takeover mutex / state lock 写入 owner 身份 + 存活探测,owner-only release。
8. F-09:`doctor --smoke-turn`(显式计费)验证 auth/模型/Turn Protocol;workflow 不可用非零退出。
9. F-08:workflow 接通 onProgress 与 usage(无人值守时费用可见性是硬需求)。
10. 若走 Herdr 运行时:补真实 Herdr 端到端验证(目前只有 mock 契约测试,双方共识)。
11. 运维件:worktree/session gc、workspace inspect/unfence 命令(替代「让用户手动 rm 权威文件」)。

---

## 6. 可信度分界

**有实跑证据(≥2 方独立复现):**
- 198/198 测试通过(三方);离线 demo 完整返工闭环(Codex、DeepSeek);
- doctor 真实探测到 codex-cli 0.149.0-alpha.4.3 / Claude Code 2.1.246,workflow 警告下仍 exit 0(Codex、实施者);
- 本机 PATH 遮蔽存在、旧 binary 不识 `--version`(Codex、实施者;二者 npm prefix 读数不一致,已在 F-13 注明)。

**有实跑证据(单方,实施者):**
- 干净 prefix 的完整首用链:pack → install → init → doctor → `workflow create` → `task list` → `capabilities --json` 全通。这是推翻 Codex「首次使用链失败」普适性的关键证据。

**静态结论但三名独立读码者在行号级一致(置信度接近实跑):**
- F-01(Codex 提出,实施者复核,汇总人本次追到 `diffSince` null-baseline 的空 diff 行为与 approval 不绑哈希);
- F-02(Codex 提出,实施者复核,汇总人端到端追完 MM 状态位 / invisible 检查 / 整 index commit 的序列);
- F-03(DeepSeek 提出,实施者复核,汇总人确认 `settleWhenTreeExits` 只挂 termination 路径)。

**单方代码推演,未动态复现(代码序列确凿,概率评估是判断不是测量):**
- F-05 / F-06 / F-07 的并发与崩溃交错;F-11 的快照/事件崩溃缺口。

**全体未验证:**
- 真实付费 provider 回合(登录态、Turn Protocol 与当前 CLI 版本的兼容);真实 Herdr 端到端;Windows `taskkill /T` 行为;dashboard 浏览器人工 QA。

---

*终审判定:75/100,有条件可用。串行与只读 workflow 今天就能用;写入-审批-发布这条旗舰链路,在 F-01/F-02/F-03 修复并回归覆盖之前,不应承载「被审批内容 = 被发布内容」的承诺,也不应无人值守。*
