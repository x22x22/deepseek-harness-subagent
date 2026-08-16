# DeepSeek Harness 子代理故障排查

遇到 `session.mjs`、`delegate.mjs`、`healthcheck.mjs` 或模型调用失败时，主 agent 必须先按本指南检查和修复，再决定是否向用户报告失败。不要因为一次非零退出、空答案或 idle timeout 就直接判定子 agent 不可用。

## 1. 先收集最小证据

先执行健康检查；它会自动准备或复用缓存 runtime：

```sh
node <skill-dir>/scripts/healthcheck.mjs
```

记录 JSON 中的 `status`、`repo`、`missing`、`tsx`、`modelConfig` 和 `models`。不要把 API key、完整环境变量或凭据文件内容写入任务文本或报告。

然后用短任务做最小复测，使用唯一 session ID，避免复用旧日志：

```sh
node <skill-dir>/scripts/session.mjs \
  --session-id dsh-diagnostic-$(date +%s) \
  --cwd "$PWD" \
  --task '只回复：dsh-diagnostic-ok' \
  --request-timeout-ms 30000 \
  --idle-timeout 60
```

只有短任务成功后，才恢复用户原任务。

默认结果是紧凑 JSON 摘要，不包含完整事件数组。不要让主 agent 为了确认成功而重复要求完整日志；只有需要定位协议、工具或子 agent 事件时，才加 `--include-events` 或 `--stream-events`。如果 stdout 为空，先检查进程退出码和 stderr，再用唯一 session ID 重试短任务；不要把空 stdout 当作 dsh 已完成。

## 2. 自动 runtime 安装失败

典型错误包括：

- `无法自动准备 dsh Node runtime`
- `npm exited with ...`
- `ECONNRESET`、`ETIMEDOUT`、`EAI_AGAIN`
- `No matching version found`

处理顺序：

1. 检查基础工具：

   ```sh
   command -v node && node --version
   command -v npm && npm --version
   ```

2. 检查默认缓存目录是否可写：

   ```sh
   node -e "const os=require('os'),p=require('path'); console.log(p.join(process.env.XDG_CACHE_HOME||p.join(os.homedir(),'.cache'),'deepseek-harness-subagent','runtime'))"
   ```

3. 如果是临时网络错误，重新运行 `healthcheck.mjs` 一次；脚本会复用已下载内容并补齐缺失包。
4. 如果是 registry 或版本错误，读取 npm 错误中的包名和版本，确认官方包仍可见；不要擅自切换到不可信镜像或未验证的第三方包。
5. 如果缓存目录中只有部分安装结果，删除缓存目录下的 `node_modules`、`package-lock.json` 和 `.ready.json` 后重新运行。只处理本 skill 创建的默认 runtime 缓存，不删除用户其它目录。

## 3. Node/npm 版本或权限问题

如果出现 `tsx` 无法启动、ESM/Node 语法错误或目录权限错误：

1. 确认 Node 为受支持的现代版本（优先 Node 20+）。
2. 不要在 skill 目录执行全局安装，也不要修改用户的全局 npm prefix。
3. 检查默认缓存目录及其父目录的写权限；必要时让 bootstrap 使用当前用户可写的默认缓存位置。
4. 修复后重新运行 `healthcheck.mjs`，不要直接跳过健康检查调用业务任务。

## 4. 未配置默认模型

错误状态为 `model-selection-required` 时：

1. 把返回 JSON 中完整的 `models` 列表告知用户。
2. 有视觉路由时优先推荐 Flash + 视觉组合；没有视觉路由时推荐官方 Flash。
3. 同时让用户选择 `off`、`high` 或 `max` 思考程度。
4. 用户选择后执行：

   ```sh
   node <skill-dir>/scripts/configure.mjs \
     --set-model PROVIDER/MODEL \
     --reasoning-effort high
   ```

5. 再运行 `healthcheck.mjs`，确认配置已保存后重试原任务。

不要猜测模型，不要把 API key 写进配置文件；配置只保存 provider、model 和 reasoning effort。

## 5. `no adapter registered for provider`

这通常表示选择了派生 provider，但当前 Cordis 没有加载对应插件。

处理顺序：

1. 先用官方模型验证基础 runtime：`deepseek-official/deepseek-v4-flash`。
2. 如果官方模型成功，说明 SDK/runtime 正常，问题局限在派生 provider。
3. 检查本机 profile 是否实际安装了对应插件；模型列表只应展示已检测到的插件。
4. 派生调用必须传入包含对应插件的 Cordis 组合；仅启动 `dsh web` 不会让 Node SDK 自动附着到 Web 进程。
5. 插件缺失时不要让整个 skill 失败，应隐藏该派生模型并回退到官方 Flash，同时向用户说明视觉能力不可用。

## 6. Cordis/import 错误

典型错误包括：

- `Cannot find module ...`
- `failed to import loader entry`
- `TransportClosedError` 且 stderr 指向 Cordis 插件
- `cordis.yml` 不存在或不是文件

先运行 `healthcheck.mjs`。如果官方 runtime 的 Cordis 文件或 SDK 包缺失，让 bootstrap 自动修复；不要手工编辑缓存中的生成文件。只有在确认插件包本身损坏时，才清理本 skill 的 runtime 缓存并重新 bootstrap。

## 7. cwd/workspace 不一致

结果中的 `cwd`、任务开头的父 agent 执行上下文、`DSH_CWD` 和子进程 cwd 必须一致。

若不一致：

1. 显式传入 `--cwd "$PWD"`。
2. 不要复用来自其它工作目录的 session ID。
3. 用新 session ID 做短任务复测。
4. 检查结果中的 `cwd`、`repo`、`cordis` 和 `runtimeBin`，确认没有误用了旧 runtime。

## 8. idle timeout

`--idle-timeout` 是 notification 无活动超时，不是任务总时长。收到任意 dsh notification 都会刷新计时。

发生 `status=idle-timeout` 时必须依次检查：

1. 子进程是否仍存在、是否已经退出；
2. stderr 尾部是否有网关、模型、Cordis 或工具错误；
3. 最近一条 notification 和 session JSONL；
4. cwd 中是否已经产生用户要求的修改；
5. 相关测试是否正在运行或已经完成。

如果只是任务很慢，使用更长的 `--idle-timeout` 或恢复同一 session；如果确认 runtime 崩溃、网关卡死或工具调用失败，先修复原因，再重试推荐任务。不得把 idle timeout 直接当成任务失败。

## 9. Web 启动失败

基础 SDK 调用不需要 `dsh web`。只有需要 Web UI 或检查 Web profile 时才启动：

```sh
node <skill-dir>/scripts/start-dsh.mjs --profile web --check
node <skill-dir>/scripts/start-dsh.mjs --profile web
```

如果 Web 启动失败，先区分：

- Web 前端构建缺失：不影响 Node SDK 基础调用；
- profile 插件缺失：只能影响对应派生模型；
- dsh runtime/import 错误：运行 bootstrap 和官方模型短任务复测。

不要因为 Web UI 启动失败就判定 SDK 子代理不可用。

## 10. 最终报告要求

修复并复测后，报告以下事实：

- 使用的 runtime 缓存路径和版本；
- provider/model/reasoning effort；
- repo、cwd、Cordis 路径；
- session ID、notification 数量和 finish reason；
- 实际执行的验证命令；
- 若仍失败，给出错误类型、stderr 尾部摘要和下一步可执行动作。

不要把“进程启动”“HTTP 200”“healthcheck 通过”单独当作用户任务完成证据；必须有对应任务的 `status=completed`、有效答案或实际文件/测试验证。
