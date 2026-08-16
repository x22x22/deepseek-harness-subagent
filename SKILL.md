---
name: deepseek-harness-subagent
description: Run an independent task in a separate DeepSeek Harness (dsh) process through this skill's Node.js SDK. Use this skill when the task must be executed by dsh rather than by the host application's own subagent or delegation mechanism.
---

# DeepSeek Harness 子代理

本 skill 通过官方 Node.js SDK 启动独立 dsh runtime。这里的 subagent 是 dsh 子代理，不是 Codex、OpenCode 或其他宿主的原生 subagent。

## 硬性规则

- 必须实际运行本 skill 的脚本；默认入口：
  `node /Users/kdump/.codex/skills/deepseek-harness-subagent/scripts/session.mjs`
- 禁止使用宿主自身的 subagent、线程委托或协作工具代替上述脚本。
- 任务提示词保持自包含、简短、只做必要工作；只读任务明确禁止改文件。
- 超长或格式复杂的消息使用 `--task-file /绝对路径/message.md` 发送：脚本会先读取 Markdown 内容作为消息正文，再发送给 dsh；不要让 subagent 自己去读取该路径。
- `--task-file` 指向的是一次性临时文件。脚本无论发送成功、模型失败、runtime 失败还是配置失败，都会在结束路径自动删除它；调用方不要把需要长期保留的文档作为参数传入。
- 只有脚本返回 `status=completed` 且 `answer` 非空，才算收到 dsh 回复；保留 subagent 原文。
- 每次独立测试都必须新建调用会话并使用新的自动生成或显式 `--session-id`；只有明确要延续对话时才复用已有会话 ID。

## 标准流程

1. 运行健康检查：

   ```sh
   node /Users/kdump/.codex/skills/deepseek-harness-subagent/scripts/healthcheck.mjs
   ```

2. 若返回 `model-selection-required`，依据返回的 `models` 选择模型并运行 `configure.mjs`；不要猜测模型。
3. 短任务使用 `session.mjs`；脚本未传 `--session-id` 时会自动生成带时间和随机熵的友好 ID，并在结果顶层返回 `sessionId`、`sessionRoot` 和 `resumeHint`。
4. 需要同一会话多轮时，从上一次结果复制 `sessionId`、`sessionRoot` 和 `resumeHint`，在后续调用中原样传入；不要凭记忆重写 ID，也不要改变 cwd 后复用同一会话。
5. 读取 `status`、`cwd`、session、finish reason、notification 数量和 `answer`，再向用户报告；必须把本次实际使用的 session ID 回显出来。

示例：

```sh
node /Users/kdump/.codex/skills/deepseek-harness-subagent/scripts/session.mjs \
  --session-id dsh-task-$(date +%s) \
  --session-root "$PWD/.dsh-sessions" \
  --cwd "$PWD" \
  --task '查询今天上海天气，只返回天气、来源或查询时间。' \
  --request-timeout-ms 120000
```

长消息示例（文件内容会被读取后直接发送，文件随后自动删除）：

```sh
node /Users/kdump/.codex/skills/deepseek-harness-subagent/scripts/session.mjs \
  --cwd "$PWD" \
  --task-file "$PWD/tmp/subagent-message.md" \
  --request-timeout-ms 120000
```

## Runtime 与失败处理

- 脚本自动准备并复用 `~/.cache/deepseek-harness-subagent/runtime/`，并把本机 dsh home 传给 runtime；正常任务不需要在提示词中讨论凭据。
- 任何 runtime、provider、网关、cwd 或超时失败，都先阅读 `references/troubleshooting.md`，按其中流程做最小复测。
- 失败由脚本统一返回可执行的下一步；不要把底层错误原文、完整环境变量或凭据内容写入任务文本或报告。
- `idle-timeout` 不能直接判定任务失败，必须检查子进程、stderr、notifications、session JSONL 和工作目录状态。

## 能力边界

支持：官方 Node SDK、独立 runtime/cwd、持久 session、多轮任务、通知流、结果序列化和独立 Cordis。

不支持：宿主线程管理、per-turn cancel、turn steer、approval RPC 和稳定 usage API。不要在任务中声称执行这些能力。

详细参数见 `scripts/session.mjs --help`；故障排查见 `references/troubleshooting.md`。
