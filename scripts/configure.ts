#!/usr/bin/env node
import process from 'node:process'
import { CURRENT_MODELS, findModel, modelConfigPath, readModelConfig, writeModelConfig } from './model-config.ts'

function help(): void {
  process.stdout.write(`DeepSeek Harness 默认模型配置\n\n--list-models       列出当前 dsh 官方可选模型\n--show              显示当前已保存配置\n--set-model MODEL   保存默认模型\n--config PATH       覆盖配置文件路径\n`)
}

function printModels(): void {
  process.stdout.write(`${JSON.stringify({
    provider: 'deepseek-official',
    models: CURRENT_MODELS,
    source: 'packages/llm/llm-deepseek/src/index.ts',
    agentInstruction: '请选择一个 model，并使用 --set-model MODEL 保存默认配置；未配置前，session/delegate/healthcheck 会拒绝继续调用 subagent。',
  }, null, 2)}\n`)
}

const argv = process.argv.slice(2)
let list = false
let show = false
let selected: string | undefined
let configPath = modelConfigPath()
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--list-models') list = true
  else if (arg === '--show') show = true
  else if (arg === '--set-model') selected = argv[++index]
  else if (arg === '--config') configPath = argv[++index] ?? ''
  else if (arg === '--help') { help(); process.exit(0) }
  else throw new Error(`unknown argument: ${arg}`)
}

try {
  if (list) printModels()
  if (show) process.stdout.write(`${JSON.stringify({ configPath, config: await readModelConfig(configPath) ?? null }, null, 2)}\n`)
  if (selected !== undefined) {
    const model = findModel(selected)
    if (!model) throw new Error(`unknown model ${JSON.stringify(selected)}; use --list-models`)
    const config = await writeModelConfig(model.id, 'deepseek-official', configPath)
    process.stdout.write(`${JSON.stringify({ status: 'configured', configPath, config, nextAction: '可重新执行 scripts/healthcheck.ts，然后再运行 session.ts 或 delegate.ts' }, null, 2)}\n`)
  }
  if (!list && !show && selected === undefined) help()
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'error', error: String(error), configPath })}\n`)
  process.exitCode = 1
}
