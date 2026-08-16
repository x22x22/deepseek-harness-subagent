#!/usr/bin/env node
import process from 'node:process'

let IdleTimeoutError: typeof import('./run.ts').IdleTimeoutError
let MODEL_SELECTION_AGENT_INSTRUCTION: string
let ModelSelectionRequiredError: typeof import('./run.ts').ModelSelectionRequiredError
let parseArgs: typeof import('./run.ts').parseArgs
let run: typeof import('./run.ts').run

try {
  const { ensureRuntime } = await import('./bootstrap-runtime.mjs')
  const runtime = await ensureRuntime()
  process.env.DSH_RUNTIME_NODE_MODULES = runtime.nodeModules
  process.env.DSH_PACKAGED_RUNTIME_ROOT = runtime.root
  process.env.DSH_PACKAGED_RUNTIME_BIN = runtime.runtimeBin
  process.env.DSH_PACKAGED_CORDIS = String(runtime.cordis);
  ({ IdleTimeoutError, MODEL_SELECTION_AGENT_INSTRUCTION, ModelSelectionRequiredError, parseArgs, run } = await import('./run.ts'))
  const options = parseArgs(process.argv.slice(2))
  const result = await run(options)
  const { serializeResult } = await import('./serialize.ts')
  if (options.format === 'text') {
    process.stdout.write((result.turns as Array<Record<string, unknown>>).map((turn) => String(turn.finalResponse ?? '')).join('\n\n'))
  } else {
    process.stdout.write(await serializeResult(result, options.format))
  }
} catch (error) {
  const timeout = IdleTimeoutError !== undefined && error instanceof IdleTimeoutError
  const modelRequired = ModelSelectionRequiredError !== undefined && error instanceof ModelSelectionRequiredError
  const output = {
    status: timeout ? 'idle-timeout' : modelRequired ? 'model-selection-required' : 'error',
    errorType: error instanceof Error ? error.name : 'Error',
    error: String(error),
    configPath: modelRequired ? error.configPath : undefined,
    models: modelRequired ? error.models : undefined,
    agentInstruction: modelRequired ? MODEL_SELECTION_AGENT_INSTRUCTION : undefined,
    nextAction: timeout
      ? '检查 runtime、stderr、notifications、session JSONL、cwd 变更和测试后再判断是否重试'
      : modelRequired ? '先从 models 中选择模型并运行 scripts/configure.mjs --set-model MODEL' : undefined,
  }
  try {
    const { serializeResult } = await import('./serialize.ts')
    process.stdout.write(await serializeResult(output, 'toon'))
  } catch {
    process.stdout.write(`${JSON.stringify(output)}\n`)
  }
  process.exitCode = 1
}
