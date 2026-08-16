# deepseek-harness-subagent

通过 DeepSeek Harness（dsh）官方 Node.js SDK，在独立 runtime 中执行一个编码、分析或查询任务。

## 用户安装

需要 Node.js 20+。安装时不要求本机有 dsh 源码仓库，也不需要手动安装本 skill 的 Node 依赖；首次运行脚本会自动准备官方 runtime 到用户缓存目录。

```sh
npx --yes skills add x22x22/deepseek-harness-subagent
```

安装后验证：

```sh
node ~/.codex/skills/deepseek-harness-subagent/scripts/healthcheck.mjs
```

首次运行如果返回 `status=model-selection-required`，把返回的完整 `models` 列表展示给用户，让用户选择 `provider/model` 和思考程度 `off`、`high` 或 `max`，然后保存默认配置：

```sh
node ~/.codex/skills/deepseek-harness-subagent/scripts/configure.mjs \
  --set-model deepseek-official/deepseek-v4-flash \
  --reasoning-effort high
```

保存后，后续用户不重新指定模型时会自动使用该配置。可用下面的命令查看模型目录和当前配置：

```sh
node ~/.codex/skills/deepseek-harness-subagent/scripts/configure.mjs --list-models
node ~/.codex/skills/deepseek-harness-subagent/scripts/configure.mjs --show
```

## 给 agent 的安装提示词

将下面这段直接发给 agent 即可：

```text
请安装并使用 deepseek-harness-subagent：先运行 `npx --yes skills add x22x22/deepseek-harness-subagent`，再运行已安装 skill 的 `scripts/healthcheck.mjs`。如果返回 model-selection-required，必须把返回的完整 models 列表告知我，让我选择 provider/model 以及 off、high 或 max 思考程度，然后用 scripts/configure.mjs 保存默认配置；不要猜测模型。之后必须实际运行 skill 的 session.mjs/delegate.mjs 调用 dsh，不要使用宿主自己的 subagent。每次独立测试使用新的 session-id；需要连续对话时复用结果中的 sessionId、sessionRoot 和 resumeHint。长消息使用 --task-file 发送 Markdown 内容，文件是一次性临时文件，脚本会自动删除。
```

## 基本调用

```sh
node ~/.codex/skills/deepseek-harness-subagent/scripts/session.mjs \
  --cwd "$PWD" \
  --task '检查当前项目并运行最小相关测试。'
```

默认结果是 TOON 格式；需要 JSON 时显式加 `--format json`。不传 `--session-id` 时脚本会生成友好且不易冲突的会话 ID，并在结果中返回 `sessionId`、`sessionRoot` 和 `resumeHint`。

超长或格式复杂的消息可以写入一次性 Markdown 文件：

```sh
node ~/.codex/skills/deepseek-harness-subagent/scripts/session.mjs \
  --cwd "$PWD" \
  --task-file "$PWD/tmp/subagent-message.md"
```

脚本会读取文件内容作为消息正文，并在成功或失败后自动删除该文件；不要把需要长期保留的文档传给 `--task-file`。

更多委托规则和故障排查见 [SKILL.md](SKILL.md) 与 [references/troubleshooting.md](references/troubleshooting.md)。
