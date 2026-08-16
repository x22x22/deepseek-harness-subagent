#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureRuntime } from './bootstrap-runtime.mjs'
const runtime = await ensureRuntime()
const child = spawn(`${runtime.nodeModules}/.bin/tsx`, [fileURLToPath(new URL('./healthcheck.ts', import.meta.url))], { stdio: 'inherit', env: { ...process.env, DSH_RUNTIME_NODE_MODULES: runtime.nodeModules, DSH_PACKAGED_RUNTIME_ROOT: runtime.root, DSH_PACKAGED_RUNTIME_BIN: runtime.runtimeBin, DSH_PACKAGED_CORDIS: runtime.cordis } })
child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
