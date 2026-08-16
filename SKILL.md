---
name: deepseek-harness-subagent
description: Delegate an independent coding or analysis task to the local DeepSeek Harness runtime through the official Node.js/TypeScript SDK. Use when an agent should work in a separate dsh process with its configured model, tools, workspace, and session boundary.
---

# DeepSeek Harness Node 子代理

这个 skill 使用 dsh 官方 `@deepseek-ai/dsh-sdk-client` TypeScript SDK，不使用 Python SDK。首次调用时脚本会自动把固定版本的官方 Node runtime 和必要插件安装到 `~/.cache/deepseek-harness-subagent/runtime/`，后续复用缓存；不要求用户拥有 dsh 源码仓库，也不要求手动执行 npm/pnpm 安装。

SDK 直接调用 JSON-RPC runtime，不要求先启动 `dsh web`。使用本机 Web profile 中的 `modlens`、`vision-router`、`llm-pi-ai` 等动态 provider 时，也不要求 Web 进程保持运行；只要插件已经安装/构建，并通过包含这些插件的独立 Cordis 组合加载即可。统一使用底层脚本检查/启动 Web（仅在确实需要 Web UI 或确认 profile 安装状态时使用）：

```sh
.../scripts/start-dsh.ts --profile web --check
.../scripts/start-dsh.ts --profile web
```

启动前脚本会检查已有的同 profile dsh 进程；已运行时直接返回 `already-running`。未运行时优先使用 PATH 中的全局 `dsh`，找不到则回退到 `npx --yes @deepseek-ai/dsh`，并以 detached 子进程启动。日志写入 `$DSH_HOME/logs/start-web.log`。

注意：启动 Web profile 不会让 Node SDK 自动附着到 Web 进程。SDK 委托仍由 `DeepSeekHarness` 启动自己的 JSON-RPC runtime；若要使用 Web profile 才有的第三方 provider，应提供包含相同 provider/settings 插件的独立 Cordis 组合（`--cordis`），不能仅依赖 `start-dsh.ts` 启动 Web。关闭 Web 后仍可调用派生模型；若插件未构建或 Cordis 未加载对应 adapter，则会返回明确的 adapter/import 错误。

## 默认模型配置

dsh 当前官方 DeepSeek provider 的基础模型为：

- `deepseek-v4-flash`（DeepSeek-V4-Flash，1,000,000 token 上下文，默认快速模型）
- `deepseek-v4-pro`（DeepSeek-V4-Pro，1,000,000 token 上下文，复杂推理优先）

本机 Web profile 如果安装了 `@liustack/modlens`、`dsh-vision-router`，或在
`~/.dsh/settings.yaml` 中配置了 `llm-pi-ai`，模型目录还会动态包含视觉桥接、
“+ 自动识图”路由、`vision-http` 内置/自定义视觉模型以及第三方 provider（例如
`zai-gw/qwen3.7-plus`）。必须以脚本输出的 `models` 列表为准，不要只依据本节基础示例。

以上是 dsh 官方 adapter 的默认 catalog；自定义 Cordis/settings 可以替换或增加模型。自定义模型不要写入默认选择器时，可直接用显式 `--model` 或 `DSH_MODEL`。

首次使用且没有显式 `--model`、`DSH_MODEL` 或持久配置时，脚本会返回 `status=model-selection-required` 和模型列表。主 agent 必须在存在视觉路由时优先推荐 Flash + 视觉组合（modlens vision、自动识图或 modlens vision + 自动识图），只有没有视觉组合时才推荐官方 Flash，并让用户选择思考程度：

- `off`：关闭思考，响应更快
- `high`：默认平衡档
- `max`：复杂任务优先

用户选择后执行：

```sh
node <skill-dir>/scripts/configure.mjs \
  --set-model deepseek-official/deepseek-v4-flash --reasoning-effort high
```

配置默认写入 `~/.config/deepseek-harness-subagent/config.json`（可用 `DSH_SUBAGENT_CONFIG` 或 `--config` 覆盖），保存 provider/model/reasoningEffort，不保存密钥。之后用户不提模型或思考程度时，自动使用该配置，不再询问；显式 `--model`、`DSH_MODEL`、`--reasoning-effort` 和 `DSH_REASONING_EFFORT` 优先级更高。查看模型和当前配置：

```sh
.../scripts/configure.ts --list-models
.../scripts/configure.ts --show
```

对于重复模型 ID，使用脚本输出的 `provider/model` 形式选择，例如
`zai-gw/qwen3.7-plus`；直接写 `deepseek-v4-flash` 时选择官方 `deepseek-official` 路由。

## 委托流程

1. 先确认任务边界、工作目录和是否允许修改文件。不要把密钥、Cookie 或完整环境变量写入任务文本。
2. 首次使用先按“默认模型配置”完成选择；之后执行 `scripts/healthcheck.ts`。短任务使用 `scripts/delegate.ts`，需要持久 session、多轮和事件观察时使用 `scripts/session.ts`。
3. 任务必须自包含，明确目标、输入路径、验证命令、禁止事项和期望输出。不要依赖父会话未传递的对话历史。
4. 读取 JSON 结果并检查 `status`、`cwd`、`sessionId`、每个 turn 的 `finalResponse`、notification 数量和验证证据。只有 `status=completed` 才能把结果当作完成；超时、非零退出和空答案都必须报告为失败。
5. `session.ts` 默认启用 1 小时 idle timeout：它限制连续没有 dsh notification 的时间，不是任务总时长；收到任意 notification 会刷新计时。长任务可以超过 1 小时，只要 dsh 持续有事件。
6. 若发生 `status=idle-timeout`，不能直接断言 subagent 或任务失败。主 agent 必须先检查子 agent 进程/退出状态、stderr、最近的 notifications、session JSONL、工作目录变更和相关测试，判断是模型/网关卡住、runtime 崩溃、工具调用阻塞还是任务仍在执行；确认确有问题后先修复问题，再重新执行推荐任务或从同一 session 恢复。完成这些检查后才能向用户报告失败。

## 常用命令

```sh
# 检查并自动准备 Node SDK、runtime、Cordis 配置和 tsx
node <skill-dir>/scripts/healthcheck.mjs

# 一次性任务（仍然使用 Node SDK）
node <skill-dir>/scripts/session.mjs \
  --cwd "$PWD" --task '检查 src/ 下的回归并修复，运行最小相关测试。'

# 同一 session 多轮，默认 1 小时 idle timeout
node <skill-dir>/scripts/session.mjs \
  --session-id review-42 --session-root "$PWD/.dsh-sessions" --cwd "$PWD" \
  --stream-events --task '先检查实现' --task '再运行最小测试并汇报结果'

# 禁用 idle timeout；只有确认外部 watchdog 存在时才使用
.../session.ts --idle-timeout 0 --task '明确需要无限等待的任务'

# 指定独立 Cordis 组合，相当于选择固定 agent/persona
.../session.ts --cordis /absolute/path/to/agent-composition.cordis.yml --task '...'
```

脚本通过 Node SDK 的 `DeepSeekHarness`/`HarnessClient` 启动缓存中的 dsh runtime；子进程 cwd、`DSH_CWD`、父 agent cwd 和任务上下文使用同一个绝对路径。API key 只通过清理后的子进程环境传递，不写入结果。

## 参数和失败处理

遇到任何执行失败、runtime/import 错误、模型 adapter 错误、cwd 不一致或 idle timeout，必须先阅读并执行 `references/troubleshooting.md` 中的对应排查流程，完成自动修复和最小短任务复测后，再恢复原任务或向用户报告。不要把一次超时或非零退出直接判定为子 agent 失败。

- `--task` 可重复；也可用 `--input-json` 传 SDK 原生 content blocks，或用 `--stdin` 读取长任务；三者不能混用。
- 默认 JSON 结果只返回最终答案、finish reason、cwd、session 和 notification/event 数量，不返回完整事件数组，以避免长任务消耗大量上下文；只有排查协议或工具链问题时才加 `--include-events`，需要实时观察时再加 `--stream-events`。
- `--cwd` 默认继承调用方当前 cwd；不要把生产目录作为默认工作目录。
- `--session-id` 与 `--session-root` 用于多轮恢复；不要把不同 cwd 复用到同一个 session ID。
- `--base-url`、`--api-key` 是 Python 版同等的显式模型配置入口；敏感值只进入子进程环境，不会写入结果。也可用重复的 `--env KEY=VALUE`。
- `--no-announce-cwd` 只关闭任务文本中的 cwd 声明，进程 cwd、`DSH_CWD` 和父 agent cwd 仍然保留。
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
| 宿主线程 archive/fork/name、usage API | 不支持 | dsh SDK 没有对应管理 RPC |

不得把当前不支持的能力写进委托任务并声称已经执行。需要这些能力时，应使用宿主 agent 自身的线程能力，或先扩展 dsh Node SDK/协议并补测试。

详细参数见 `scripts/session.ts --help` 和 `scripts/configure.ts --help`；脚本行为由 `tests/run.test.ts` 覆盖，官方 SDK 行为由 `packages/sdk/client/tests` 覆盖。
