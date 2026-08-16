#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { DEFAULT_REPO } from './run.ts'

const repo = resolve(process.argv[2] ?? DEFAULT_REPO)
const required = [
  'packages/sdk/client/src/index.ts',
  'packages/examples/jsonrpc-demo/src/bin.ts',
  'examples/jsonrpc-agent/cordis.yml',
  'tsconfig.json',
]
const missing = required.filter((item) => !existsSync(`${repo}/${item}`))
const probe = spawnSync('pnpm', ['--dir', repo, 'exec', 'tsx', '--version'], { encoding: 'utf8' })
const result = {
  status: missing.length === 0 && probe.status === 0 ? 'ready' : 'error',
  repo,
  missing,
  tsx: probe.status === 0 ? probe.stdout.trim() : probe.stderr.trim(),
}
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = result.status === 'ready' ? 0 : 1
