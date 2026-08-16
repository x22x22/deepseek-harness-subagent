#!/usr/bin/env node
import process from 'node:process'
import { findModel, modelConfigPath, modelOptions, readModelConfig, writeModelConfig } from './model-config.ts'

function help(): void {
  process.stdout.write(`DeepSeek Harness 默认模型配置\n\n--list-models       列出当前 dsh 可选模型\n--show              显示当前已保存配置\n--set-model MODEL   保存默认模型\n--reasoning-effort off|high|max  保存思考程度（默认 high）\n--config PATH       覆盖配置文件路径\n`)
}

function printModels(): void {
  process.stdout.write(`${JSON.stringify({
    models: modelOptions(),
    source: '本机 dsh settings.yaml + 官方适配器 + 已安装 vision 插件',
    agentInstruction: '优先选择 Flash 组合，并选择思考程度 off/high/max；使用 --set-model MODEL --reasoning-effort LEVEL 保存默认配置。',
  }, null, 2)}\n`)
}

const argv = process.argv.slice(2)
let list = false
let show = false
let selected: string | undefined
let configPath = modelConfigPath()
let reasoningEffort: 'off' | 'high' | 'max' = 'high'
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--list-models') list = true
  else if (arg === '--show') show = true
  else if (arg === '--set-model') selected = argv[++index]
  else if (arg === '--reasoning-effort') reasoningEffort = argv[++index] as typeof reasoningEffort
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
    if (!['off', 'high', 'max'].includes(reasoningEffort)) throw new Error('--reasoning-effort must be off, high, or max')
    const config = await writeModelConfig(model.id, model.provider, configPath, reasoningEffort)
    process.stdout.write(`${JSON.stringify({ status: 'configured', configPath, config, nextAction: '可重新执行 scripts/healthcheck.ts，然后再运行 session.ts 或 delegate.ts' }, null, 2)}\n`)
  }
  if (!list && !show && selected === undefined) help()
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'error', error: String(error), configPath })}\n`)
  process.exitCode = 1
}
