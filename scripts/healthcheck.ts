#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { modelConfigPath, modelOptions, readModelConfig } from './model-config.ts'
import { DEFAULT_REPO, MODEL_SELECTION_AGENT_INSTRUCTION } from './run.ts'

const repo = resolve(process.argv[2] ?? DEFAULT_REPO)
const required = [
  'packages/sdk/client/src/index.ts',
  'packages/examples/jsonrpc-demo/src/bin.ts',
  'examples/jsonrpc-agent/cordis.yml',
  'tsconfig.json',
]
const missing = required.filter((item) => !existsSync(`${repo}/${item}`))
const probe = spawnSync('pnpm', ['--dir', repo, 'exec', 'tsx', '--version'], { encoding: 'utf8' })
const configPath = modelConfigPath()
const config = await readModelConfig(configPath)
const infrastructureReady = missing.length === 0 && probe.status === 0
const result = {
  status: !infrastructureReady ? 'error' : config ? 'ready' : 'model-selection-required',
  repo,
  missing,
  tsx: probe.status === 0 ? probe.stdout.trim() : probe.stderr.trim(),
  modelConfig: {
    path: configPath,
    configured: config ?? null,
    models: modelOptions(),
  },
  ...(infrastructureReady && !config ? { agentInstruction: MODEL_SELECTION_AGENT_INSTRUCTION } : {}),
}
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = result.status === 'ready' ? 0 : 1
