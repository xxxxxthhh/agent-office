# Turn Protocol

Turn Protocol 是 Agent Office 与代理之间的最小协作契约。

## 输入

代理从 stdin 收到纯文本提示，包含：

- 共享任务目标；
- 共享工作区绝对路径；
- 团队名单、角色和状态；
- 对当前代理可见的最近消息；
- 协作规则和输出字段。

代理可以使用自己的工具直接读取或修改共享工作区。

## 输出

代理向 stdout 返回一个 JSON 对象：

```json
{
  "summary": "实现了端点并运行 8 个相关测试，全部通过。",
  "status": "working",
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

正式 Schema 位于 [`schemas/turn.schema.json`](../schemas/turn.schema.json)。

## 字段语义

### `summary`

本轮已完成工作或发现的简明事实。调度器会自动把它发给团队，因此不要放隐藏推理、凭据或无关日志。

### `status`

- `working`：仍有职责内工作，需要未来轮次。
- `blocked`：当前代理无法继续；如果团队也无法解决，应同时向 `user` 发消息并设置 `needsUser=true`。
- `done`：当前角色没有剩余工作或待处理交接。

### `messages`

显式交接消息。`to` 可以是：

- `team`：所有代理；
- 一个已配置的代理 ID；
- `user`：请求用户决策。

发给已处于 `done` 的代理会将其重新激活为 `working`。

未知收件人会被调度器丢弃。

### `artifacts`

本轮产生或核验的工作区相对路径。该字段用于审计和后续 UI；它不是文件上传机制。

### `needsUser`

只有团队无法安全自行决定时才设为 `true`。调度器会把任务置为 `awaiting_input` 并停止本次运行。

## 通用命令适配器约定

通用程序必须：

1. 从 stdin 读取完整输入直到 EOF；
2. 在超时前退出；
3. 以退出码 0 表示成功；
4. 向 stdout 写一个协议对象；
5. 将诊断日志写到 stderr。

模型输出偶尔包含 Markdown fence 时，Agent Office 会尝试提取其中的 JSON。完全无法解析时，纯文本会作为 `summary` 保留，状态按 `working` 处理。
