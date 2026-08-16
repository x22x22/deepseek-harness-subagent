#!/usr/bin/env node
import process from 'node:process'
import { IdleTimeoutError, parseArgs, run } from './run.ts'

try {
  const options = parseArgs(process.argv.slice(2))
  const result = await run(options)
  if (options.format === 'text') {
    process.stdout.write((result.turns as Array<Record<string, unknown>>).map((turn) => String(turn.finalResponse ?? '')).join('\n\n'))
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
} catch (error) {
  const timeout = error instanceof IdleTimeoutError
  process.stdout.write(`${JSON.stringify({
    status: timeout ? 'idle-timeout' : 'error',
    errorType: error instanceof Error ? error.name : 'Error',
    error: String(error),
    nextAction: timeout ? '检查 runtime、stderr、notifications、session JSONL、cwd 变更和测试后再判断是否重试' : undefined,
  })}\n`)
  process.exitCode = 1
}
