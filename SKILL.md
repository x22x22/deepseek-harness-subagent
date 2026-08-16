---
name: deepseek-harness-subagent
description: Delegate an independent coding or analysis task to the local DeepSeek Harness runtime through the official Node.js/TypeScript SDK. Use when a Codex subagent should work in a separate dsh process with its configured model, tools, workspace, and session boundary.
---

# DeepSeek Harness Node 子代理

这个 skill 使用 dsh 官方 `@deepseek-ai/dsh-sdk-client` TypeScript SDK，不使用 Python SDK。Node SDK 与 dsh 内部协议和测试保持同仓库一致。运行脚本通过 `tsx` 加载 dsh 源码 runtime，默认使用 `examples/jsonrpc-agent/cordis.yml`。

## 默认模型配置

dsh 当前官方 DeepSeek provider 可选模型为：

- `deepseek-v4-flash`（DeepSeek-V4-Flash，1,000,000 token 上下文，默认快速模型）
- `deepseek-v4-pro`（DeepSeek-V4-Pro，1,000,000 token 上下文，复杂推理优先）

以上是 dsh 官方 adapter 的默认 catalog；自定义 Cordis/settings 可以替换或增加模型。自定义模型不要写入默认选择器时，可直接用显式 `--model` 或 `DSH_MODEL`。

首次使用且没有显式 `--model`、`DSH_MODEL` 或持久配置时，脚本会返回 `status=model-selection-required` 和模型列表。主 agent 必须把这两个选项告知用户，请用户选择后执行：

```sh
pnpm --dir /Users/kdump/llm/project/official/deepseek-harness exec tsx \
  /Users/kdump/llm/skills/deepseek-harness-subagent/scripts/configure.ts \
  --set-model deepseek-v4-flash
```

配置默认写入 `~/.config/deepseek-harness-subagent/config.json`（可用 `DSH_SUBAGENT_CONFIG` 或 `--config` 覆盖），只保存 provider/model，不保存密钥。之后用户不提模型时，自动使用该配置，不再询问；显式 `--model` 和 `DSH_MODEL` 优先级更高。查看模型和当前配置：

```sh
.../scripts/configure.ts --list-models
.../scripts/configure.ts --show
```

## 委托流程

1. 先确认任务边界、工作目录和是否允许修改文件。不要把密钥、Cookie 或完整环境变量写入任务文本。
2. 首次使用先按“默认模型配置”完成选择；之后执行 `scripts/healthcheck.ts`。短任务使用 `scripts/delegate.ts`，需要持久 session、多轮和事件观察时使用 `scripts/session.ts`。
3. 任务必须自包含，明确目标、输入路径、验证命令、禁止事项和期望输出。不要依赖父会话未传递的对话历史。
4. 读取 JSON 结果并检查 `status`、`cwd`、`sessionId`、每个 turn 的 `finalResponse`、notification 数量和验证证据。只有 `status=completed` 才能把结果当作完成；超时、非零退出和空答案都必须报告为失败。
5. `session.ts` 默认启用 1 小时 idle timeout：它限制连续没有 dsh notification 的时间，不是任务总时长；收到任意 notification 会刷新计时。长任务可以超过 1 小时，只要 dsh 持续有事件。
6. 若发生 `status=idle-timeout`，不能直接断言 subagent 或任务失败。主 agent 必须先检查子 agent 进程/退出状态、stderr、最近的 notifications、session JSONL、工作目录变更和相关测试，判断是模型/网关卡住、runtime 崩溃、工具调用阻塞还是任务仍在执行；确认确有问题后先修复问题，再重新执行推荐任务或从同一 session 恢复。完成这些检查后才能向用户报告失败。

## 常用命令

```sh
# 检查 Node SDK、runtime 源码、Cordis 配置和 tsx
pnpm --dir /Users/kdump/llm/project/official/deepseek-harness exec tsx \
  /Users/kdump/llm/project/official/deepseek-harness/.agents/skills/deepseek-harness-subagent/scripts/healthcheck.ts

# 一次性任务（仍然使用 Node SDK）
pnpm --dir /Users/kdump/llm/project/official/deepseek-harness exec tsx \
  /Users/kdump/llm/project/official/deepseek-harness/.agents/skills/deepseek-harness-subagent/scripts/delegate.ts \
  --cwd "$PWD" --task '检查 src/ 下的回归并修复，运行最小相关测试。'

# 同一 session 多轮，默认 1 小时 idle timeout
pnpm --dir /Users/kdump/llm/project/official/deepseek-harness exec tsx \
  /Users/kdump/llm/project/official/deepseek-harness/.agents/skills/deepseek-harness-subagent/scripts/session.ts \
  --session-id review-42 --session-root "$PWD/.dsh-sessions" --cwd "$PWD" \
  --stream-events --task '先检查实现' --task '再运行最小测试并汇报结果'

# 禁用 idle timeout；只有确认外部 watchdog 存在时才使用
.../session.ts --idle-timeout 0 --task '明确需要无限等待的任务'

# 指定独立 Cordis 组合，相当于选择固定 agent/persona
.../session.ts --cordis /absolute/path/to/agent-composition.cordis.yml --task '...'
```

脚本通过 Node SDK 的 `DeepSeekHarness`/`HarnessClient` 启动 dsh runtime；子进程 cwd、`DSH_CWD`、`CODEX_PARENT_CWD` 和任务上下文使用同一个绝对路径。默认 runtime 为 `packages/examples/jsonrpc-demo/src/bin.ts`，通过 `TSX_TSCONFIG_PATH` 解析同仓库 TypeScript 包；`.ts` runtime 使用 tsx，`.js/.mjs/.cjs` 使用 Node，其他扩展名按可执行文件直接启动；可用 `--runtime-bin` 替换。API key 只通过清理后的子进程环境传递，不写入结果。

## 参数和失败处理

- `--task` 可重复；也可用 `--input-json` 传 SDK 原生 content blocks，或用 `--stdin` 读取长任务；三者不能混用。
- `--cwd` 默认继承调用方当前 cwd；不要把生产目录作为默认工作目录。
- `--session-id` 与 `--session-root` 用于多轮恢复；不要把不同 cwd 复用到同一个 session ID。
- `--base-url`、`--api-key` 是 Python 版同等的显式模型配置入口；敏感值只进入子进程环境，不会写入结果。也可用重复的 `--env KEY=VALUE`。
- `--no-announce-cwd` 只关闭任务文本中的 cwd 声明，进程 cwd、`DSH_CWD` 和 `CODEX_PARENT_CWD` 仍然保留。
- `--idle-timeout` 单位为秒，默认 `3600`；每次 dsh notification 刷新计时，`0` 禁用。`--request-timeout-ms` 是底层 JSON-RPC 请求硬超时，不能替代 idle timeout。
- idle timeout 会关闭当前 Node SDK runtime，结果状态为 `idle-timeout`，并附带检查/恢复提示；不得把它直接当作任务失败。
- 最终回答应保留子代理原文，同时附上运行状态、退出码或错误类型、repo/cwd/session/profile、notification 和验证命令。不要把 stderr 当成成功答案。

## dsh 能力边界

| 能力 | 当前 skill | 说明 |
|---|---|---|
| 官方 Node/TypeScript SDK | 支持 | `@deepseek-ai/dsh-sdk-client`，与 dsh 同仓库协议 |
| 独立进程、模型和 cwd | 支持 | Node SDK launch + cwd/env/initialize |
| 持久 session、多轮、后续恢复 | 支持 | session ID + JSONL persistence |
| notification 流和 root/descendant 观察 | 支持 | `onNotification`、`--stream-events` |
| finish reason | 支持 | 从 root `turn/end.data.reason.kind` 派生，并输出 `finish_reason` |
| 默认 1 小时 idle timeout | 支持 | notification 活动刷新；不是总时长 |
| provider/model/max tokens、Cordis | 支持 | 显式传给 Node SDK/runtime |
| Host/Web API 的 `agentPreset` | dsh 原生支持，本 skill 未接入 | 当前 SDK initialize wire 没有 `agentPreset` |
| 固定 agent/persona | 间接支持 | 通过独立 `--cordis` 组合文件 |
| per-turn cancel、turn steer、approval | 不支持 | 当前 SDK wire 没有对应 RPC；关闭 runtime 是放弃路径 |
| Codex thread archive/fork/name、usage API | 不支持 | dsh SDK 没有对应管理 RPC |

不得把当前不支持的能力写进委托任务并声称已经执行。需要这些能力时，应使用原生 Codex subagent，或先扩展 dsh Node SDK/协议并补测试。

详细参数见 `scripts/session.ts --help` 和 `scripts/configure.ts --help`；脚本行为由 `tests/run.test.ts` 覆盖，官方 SDK 行为由 `packages/sdk/client/tests` 覆盖。
