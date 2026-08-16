#!/usr/bin/env node
/** Ensure a local dsh profile is running, preferring global dsh and falling back to npx. */
import { mkdir } from 'node:fs/promises'
import { accessSync, closeSync, constants, openSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'

export interface StartOptions {
  profile: string
  host?: string
  port?: number
  waitMs: number
  checkOnly: boolean
  logFile?: string
}

export function parseArgs(argv: string[]): StartOptions {
  let profile = 'web'
  let host: string | undefined
  let port: number | undefined
  let waitMs = 3000
  let checkOnly = false
  let logFile: string | undefined
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    return next
  }
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--profile': profile = value(index++, '--profile'); break
      case '--host': host = value(index++, '--host'); break
      case '--port': port = Number(value(index++, '--port')); break
      case '--wait-ms': waitMs = Number(value(index++, '--wait-ms')); break
      case '--log-file': logFile = resolve(value(index++, '--log-file')); break
      case '--check': checkOnly = true; break
      case '--help':
        process.stdout.write('start-dsh.ts [--profile web] [--host HOST] [--port PORT] [--wait-ms MS] [--log-file PATH] [--check]\n')
        process.exit(0)
      default: throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  if (!profile.trim()) throw new Error('--profile must not be blank')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port must be 0..65535')
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait-ms must be non-negative')
  return { profile, ...(host === undefined ? {} : { host }), ...(port === undefined ? {} : { port }), waitMs, checkOnly, ...(logFile === undefined ? {} : { logFile }) }
}

export function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string | undefined {
  for (const directory of pathValue.split(':')) {
    if (!directory) continue
    const candidate = join(directory, name)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* keep looking */ }
  }
  return undefined
}

export function processMatches(command: string, profile: string): boolean {
  if (!/(^|[\s/])dsh(?:\s|$)|@deepseek-ai[\/]dsh/.test(command)) return false
  return new RegExp(`(?:^|\\s)(?:web|--profile\\s+${profile})(?:\\s|$)`).test(command)
}

export function existingDshProcess(profile: string): { pid: number; command: string } | undefined {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match || Number(match[1]) === process.pid) continue
    if (processMatches(match[2], profile)) return { pid: Number(match[1]), command: match[2] }
  }
  return undefined
}

function commandFor(options: StartOptions): { command: string; args: string[]; method: 'global-dsh' | 'npx' } {
  const global = findExecutable('dsh')
  const args = [options.profile]
  if (options.host !== undefined) args.push('--host', options.host)
  if (options.port !== undefined) args.push('--port', String(options.port))
  if (global) return { command: global, args, method: 'global-dsh' }
  const npx = findExecutable('npx')
  if (!npx) throw new Error('找不到全局 dsh，也找不到 npx；请安装 Node.js 或 @deepseek-ai/dsh')
  return { command: npx, args: ['--yes', '@deepseek-ai/dsh', ...args], method: 'npx' }
}

export async function startDsh(options: StartOptions): Promise<Record<string, unknown>> {
  const existing = existingDshProcess(options.profile)
  if (existing) return { status: 'already-running', profile: options.profile, pid: existing.pid, command: existing.command }
  if (options.checkOnly) return { status: 'not-running', profile: options.profile }
  const launch = commandFor(options)
  const logFile = options.logFile ?? join(process.env.DSH_HOME?.trim() || join(process.env.HOME || '.', '.dsh'), 'logs', `start-${options.profile}.log`)
  await mkdir(resolve(logFile, '..'), { recursive: true })
  const logFd = openSync(logFile, 'a')
  const child = spawn(launch.command, launch.args, { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
  // The detached child owns the inherited descriptor after spawn.
  try { closeSync(logFd) } catch { /* best effort */ }
  child.unref()
  if (options.waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, options.waitMs))
  const after = existingDshProcess(options.profile)
  if (!after) return { status: 'start-failed', profile: options.profile, method: launch.method, logFile, error: '启动后未发现 dsh 进程' }
  return { status: 'started', profile: options.profile, pid: after.pid, method: launch.method, logFile, command: after.command }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(await startDsh(parseArgs(process.argv.slice(2))))}\n`) }
  catch (error) { process.stdout.write(`${JSON.stringify({ status: 'error', error: String(error) })}\n`); process.exitCode = 1 }
}
