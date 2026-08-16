#!/usr/bin/env node
/** Node/TypeScript SDK runner used by the DeepSeek Harness subagent skill. */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import type { ContentBlock, HarnessNotification, RunResult } from '@deepseek-ai/dsh-sdk-client'
import type { OutputFormat } from './serialize.ts'
import { findModel, modelConfigPath, modelOptions, readModelConfig, type StoredModelConfig } from './model-config.ts'

export const DEFAULT_REPO = '/Users/kdump/llm/project/official/deepseek-harness'
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 3600
export const MODEL_SELECTION_AGENT_INSTRUCTION = '必须先把 models 列表告知用户；如果存在视觉路由，优先推荐 Flash + 视觉组合（modlens vision、自动识图或 modlens vision + 自动识图），只有没有视觉组合时才推荐官方 Flash；同时请求用户选择思考程度 off/high/max。用户选择后运行 scripts/configure.mjs --set-model MODEL --reasoning-effort LEVEL 保存配置，再重新执行原任务。未完成选择前不得猜测模型或继续调用 subagent。'
type DeepSeekHarness = import('@deepseek-ai/dsh-sdk-client').DeepSeekHarness

export class IdleTimeoutError extends Error {
  constructor(public readonly idleTimeoutSeconds: number) {
    super(`DeepSeek Harness idle timeout after ${idleTimeoutSeconds} seconds without notification`)
    this.name = 'IdleTimeoutError'
  }
}

export class ModelSelectionRequiredError extends Error {
  public readonly models = modelOptions()

  constructor(public readonly configPath: string) {
    super(`default model is not configured; choose one and save it with scripts/configure.ts --set-model MODEL (config: ${configPath})`)
    this.name = 'ModelSelectionRequiredError'
  }
}

export function resolveModelRoute(requestedModel: string, requestedProvider = 'deepseek-official'): { provider: string; model: string } {
  if (!requestedModel.includes('/')) return { provider: requestedProvider, model: requestedModel }
  const selected = findModel(requestedModel)
  if (!selected) throw new Error(`unknown model ${JSON.stringify(requestedModel)}; run configure.mjs --list-models first`)
  if (requestedProvider !== 'deepseek-official' && requestedProvider !== selected.provider) {
    throw new Error(`provider ${JSON.stringify(requestedProvider)} conflicts with model ${JSON.stringify(requestedModel)}`)
  }
  return { provider: selected.provider, model: selected.id }
}

export interface CliOptions {
  tasks: Array<string | ContentBlock[]>
  cwd: string
  repo: string
  cordis: string
  sessionId: string
  sessionRoot?: string
  provider: string
  model?: string
  reasoningEffort?: StoredModelConfig['reasoningEffort']
  maxTokens?: number
  requestTimeoutMs?: number
  idleTimeoutSeconds: number
  runtimeBin?: string
  baseUrl?: string
  apiKey?: string
  env: Record<string, string>
  streamEvents: boolean
  includeEvents: boolean
  announceCwd: boolean
  format: OutputFormat
}

export function scrubEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const credential = /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/i
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && !credential.test(entry[0])),
  )
}

export function parseEnv(values: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const value of values) {
    const separator = value.indexOf('=')
    if (separator <= 0 || value.includes('\0')) throw new Error(`invalid --env value: ${JSON.stringify(value)}; expected KEY=VALUE`)
    result[value.slice(0, separator)] = value.slice(separator + 1)
  }
  return result
}

export function announceCwd(task: string | ContentBlock[], cwd: string): string | ContentBlock[] {
  const context = `[Parent agent execution context]\nCurrent working directory (cwd): ${cwd}\n`
  return typeof task === 'string'
    ? `${context}\nTask:\n${task}`
    : [{ type: 'text', text: context }, ...task]
}

export function finishReason(events: unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || typeof event !== 'object') continue
    const data = (event as Record<string, unknown>).data
    const reason = data && typeof data === 'object' ? (data as Record<string, unknown>).reason : undefined
    const kind = reason && typeof reason === 'object' ? (reason as Record<string, unknown>).kind : undefined
    if ((event as Record<string, unknown>).type === 'turn/end' && typeof kind === 'string') return kind
  }
  return undefined
}

export function capabilityMatrix(idleTimeoutSeconds: number): Record<string, Record<string, unknown>> {
  return {
    supported: {
      official_node_sdk: '@deepseek-ai/dsh-sdk-client',
      persistent_session: 'session ID + JSONL persistence',
      multi_turn: 'multiple --task values in one process',
      resume: 'reuse session ID in a later invocation',
      structured_input: '--input-json content blocks',
      streaming_notifications: '--stream-events',
      descendant_observation: 'root and discovered subagent notifications',
      finish_reason: 'derived from root turn/end events',
      provider_model_max_tokens: true,
      workspace_and_cordis: true,
      parent_cwd_alignment: 'cwd + DSH_CWD + parent-agent cwd + task context',
      idle_timeout: `notification inactivity; ${idleTimeoutSeconds === 0 ? 'disabled' : `${idleTimeoutSeconds} seconds`}`,
      specified_agent: 'indirect: dedicated --cordis composition',
    },
    unsupported_by_current_sdk_wire: {
      agent_name_or_preset_selector: 'initialize has no agentPreset field',
      per_prompt_cancel: 'close runtime is the abandonment path',
      turn_steer: 'no wire method',
      approval_requests: 'server-to-client requests are not implemented',
      thread_archive_fork_name: 'SDK has session IDs but no management RPCs',
      usage_api: 'no stable result field',
    },
  }
}

function value(args: string[], index: number, flag: string): string {
  const item = args[index + 1]
  if (item === undefined || item.startsWith('--')) throw new Error(`${flag} requires a value`)
  return item
}

export function parseArgs(argv: string[]): CliOptions {
  const tasks: Array<string | ContentBlock[]> = []
  const envValues: string[] = []
  let cwd = process.cwd()
  let repo = process.env.DSH_PACKAGED_RUNTIME_ROOT ?? DEFAULT_REPO
  let cordis: string | undefined = process.env.DSH_PACKAGED_CORDIS
  let sessionId = 'dsh-subagent'
  let sessionRoot: string | undefined
  let provider = 'deepseek-official'
  let model = process.env.DSH_MODEL
  let reasoningEffort = process.env.DSH_REASONING_EFFORT as CliOptions['reasoningEffort']
  let maxTokens: number | undefined
  let requestTimeoutMs: number | undefined
  let idleTimeoutSeconds = DEFAULT_IDLE_TIMEOUT_SECONDS
  let runtimeBin: string | undefined = process.env.DSH_PACKAGED_RUNTIME_BIN
  let baseUrl: string | undefined
  let apiKey: string | undefined
  let stdin = false
  let streamEvents = false
  let includeEvents = false
  let announceCwdFlag = true
  let format: OutputFormat = 'toon'

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--task': tasks.push(value(argv, index++, arg)); break
      case '--input-json': tasks.push(JSON.parse(value(argv, index++, arg)) as ContentBlock[]); break
      case '--stdin': stdin = true; break
      case '--cwd': cwd = value(argv, index++, arg); break
      case '--repo': repo = value(argv, index++, arg); break
      case '--cordis': cordis = value(argv, index++, arg); break
      case '--session-id': sessionId = value(argv, index++, arg); break
      case '--session-root': sessionRoot = value(argv, index++, arg); break
      case '--provider': provider = value(argv, index++, arg); break
      case '--model': model = value(argv, index++, arg); break
      case '--reasoning-effort': reasoningEffort = value(argv, index++, arg) as CliOptions['reasoningEffort']; break
      case '--max-tokens': maxTokens = Number(value(argv, index++, arg)); break
      case '--request-timeout-ms': requestTimeoutMs = Number(value(argv, index++, arg)); break
      case '--request-timeout': requestTimeoutMs = Number(value(argv, index++, arg)) * 1000; break
      case '--idle-timeout': idleTimeoutSeconds = Number(value(argv, index++, arg)); break
      case '--runtime-bin': runtimeBin = value(argv, index++, arg); break
      case '--base-url': baseUrl = value(argv, index++, arg); break
      case '--api-key': apiKey = value(argv, index++, arg); break
      case '--env': envValues.push(value(argv, index++, arg)); break
      case '--stream-events': streamEvents = true; break
      case '--include-events': includeEvents = true; break
      case '--no-announce-cwd': announceCwdFlag = false; break
      case '--format': format = value(argv, index++, arg) as OutputFormat; break
      case '--no-idle-timeout': idleTimeoutSeconds = 0; break
      case '--help': printHelp(); process.exit(0)
      default: throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (stdin && tasks.length > 0) throw new Error('--stdin cannot be combined with --task or --input-json')
  if (!stdin && tasks.length === 0) throw new Error('one of --task, --input-json, or --stdin is required')
  if (!sessionId.trim()) throw new Error('--session-id must not be blank')
  if (!Number.isFinite(idleTimeoutSeconds) || idleTimeoutSeconds < 0) throw new Error('--idle-timeout must be non-negative')
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error('--max-tokens must be positive')
  if (requestTimeoutMs !== undefined && (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)) throw new Error('--request-timeout-ms must be positive')
  if (format !== 'toon' && format !== 'json' && format !== 'text') throw new Error('--format must be toon, json, or text')
  if (reasoningEffort !== undefined && !['off', 'high', 'max'].includes(reasoningEffort)) throw new Error('--reasoning-effort must be off, high, or max')
  if (stdin) tasks.push('')
  return {
    tasks,
    cwd: resolve(cwd),
    repo: resolve(repo),
    cordis: resolve(cordis ?? `${repo}/examples/jsonrpc-agent/cordis.yml`),
    sessionId,
    ...(sessionRoot === undefined ? {} : { sessionRoot: resolve(sessionRoot) }),
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    idleTimeoutSeconds,
    ...(runtimeBin === undefined ? {} : { runtimeBin: resolve(runtimeBin) }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    env: parseEnv(envValues),
    streamEvents,
    includeEvents,
    announceCwd: announceCwdFlag,
    format,
  }
}

function printHelp(): void {
  process.stdout.write(`Node SDK DeepSeek Harness runner\n\n--task TEXT (repeatable) | --input-json JSON | --stdin\n--cwd PATH --repo PATH --cordis PATH --session-id ID --session-root PATH\n--provider NAME --model NAME --reasoning-effort off|high|max --max-tokens N --request-timeout SECONDS\n--request-timeout-ms MS --idle-timeout SECONDS (default 3600; 0 disables)\n--runtime-bin PATH --base-url URL --api-key KEY --env KEY=VALUE\n--no-announce-cwd --stream-events --include-events --format toon|json|text (default toon)\n`)
}

function runtimePath(options: CliOptions): string {
  return options.runtimeBin ?? `${options.repo}/packages/examples/jsonrpc-demo/src/bin.ts`
}

export function runtimeLaunch(options: CliOptions): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const runtime = runtimePath(options)
  // The packaged runtime must see the user's dsh credential/settings store.
  // Do not require callers to copy DEEPSEEK_API_KEY into the environment.
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const env = {
    ...scrubEnvironment(process.env),
    ...options.env,
    DSH_HOME: dshHome,
    TSX_TSCONFIG_PATH: `${options.repo}/tsconfig.json`,
    DSH_CORDIS_CONFIG: options.cordis,
    DSH_CWD: options.cwd,
    CODEX_PARENT_CWD: options.cwd,
    ...(options.baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: options.baseUrl }),
    ...(options.apiKey === undefined ? {} : { DEEPSEEK_API_KEY: options.apiKey }),
    ...(options.sessionRoot === undefined ? {} : { DSH_SESSION_ROOT: options.sessionRoot }),
  }
  if (extname(runtime) === '.ts') {
    // Resolve tsx from the dsh repository, not from the installed skill's directory.
    // The skill itself lives outside the workspace node_modules tree.
    return { command: 'pnpm', args: ['--dir', options.repo, 'exec', 'tsx', runtime], cwd: options.cwd, env }
  }
  if (extname(runtime) === '.js' || extname(runtime) === '.mjs' || extname(runtime) === '.cjs') {
    return { command: process.execPath, args: [runtime], cwd: options.cwd, env }
  }
  return { command: runtime, args: [], cwd: options.cwd, env }
}

async function runWithIdleTimeout(
  harness: DeepSeekHarness,
  task: string | ContentBlock[],
  sessionId: string,
  idleTimeoutSeconds: number,
  onNotification?: (notification: HarnessNotification) => void,
): Promise<RunResult> {
  if (idleTimeoutSeconds === 0) return harness.run(task, { sessionId, onNotification })
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  let rejectTimeout!: (error: Error) => void
  const timeout = new Promise<RunResult>((_resolve, reject) => { rejectTimeout = reject })
  const reset = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      rejectTimeout(new IdleTimeoutError(idleTimeoutSeconds))
      void harness.close()
    }, idleTimeoutSeconds * 1000)
  }
  reset()
  try {
    return await Promise.race([
      harness.run(task, {
        sessionId,
        onNotification: (notification) => {
          if (!timedOut) reset()
          onNotification?.(notification)
        },
      }),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function run(options: CliOptions): Promise<Record<string, unknown>> {
  const tasks = options.tasks[0] === '' ? [await readFile(0, 'utf8')] : options.tasks
  if (tasks.length === 0 || tasks.some((task) => typeof task === 'string' && !task.trim())) throw new Error('task must not be blank')
  const storedConfig = await readModelConfig()
  const requestedModel = options.model ?? storedConfig?.model
  if (!requestedModel) throw new ModelSelectionRequiredError(modelConfigPath())
  const reasoningEffort = options.reasoningEffort ?? storedConfig?.reasoningEffort ?? 'high'
  const route = resolveModelRoute(requestedModel, options.provider !== 'deepseek-official' ? options.provider : (storedConfig?.provider ?? options.provider))
  const provider = route.provider
  const model = route.model
  const sdkEntry = process.env.DSH_RUNTIME_NODE_MODULES
    ? pathToFileURL(join(process.env.DSH_RUNTIME_NODE_MODULES, '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')).href
    : '@deepseek-ai/dsh-sdk-client'
  const { DeepSeekHarness } = await import(sdkEntry)
  const [cwdInfo, repoInfo, cordisInfo, runtimeInfo] = await Promise.all([
    stat(options.cwd),
    stat(options.repo),
    stat(options.cordis),
    stat(runtimePath(options)),
  ])
  if (!cwdInfo.isDirectory()) throw new Error(`cwd is not a directory: ${options.cwd}`)
  if (!repoInfo.isDirectory()) throw new Error(`repo is not a directory: ${options.repo}`)
  if (!cordisInfo.isFile()) throw new Error(`cordis is not a file: ${options.cordis}`)
  if (!runtimeInfo.isFile()) throw new Error(`runtime-bin is not a file: ${runtimePath(options)}`)
  const launch = runtimeLaunch(options)
  const harness = new DeepSeekHarness({
    launch: {
      ...launch,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    },
    cwd: options.cwd,
    provider,
    model,
    reasoningEffort,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  })
  const turns: Array<Record<string, unknown>> = []
  try {
    for (const input of tasks) {
      const task = options.announceCwd ? announceCwd(input, options.cwd) : input
      const result = await runWithIdleTimeout(harness, task, options.sessionId, options.idleTimeoutSeconds, options.streamEvents
        ? (notification) => process.stderr.write(`${JSON.stringify(notification)}\n`)
        : undefined)
      const turn: Record<string, unknown> = {
        sessionId: result.sessionId,
        finalResponse: result.finalResponse,
        answer: result.finalResponse,
        finish_reason: finishReason(result.events),
        answer_empty: !result.finalResponse?.trim(),
        cwd: options.cwd,
        event_count: result.events.length,
        notification_count: result.notifications.length,
        notificationCount: result.notifications.length,
        session_id: result.sessionId,
        session_root: options.sessionRoot ?? null,
      }
      if (options.includeEvents) {
        turn.events = result.events
        turn.notifications = result.notifications
      }
      turns.push(turn)
    }
  } finally {
    await harness.close()
  }
  return {
    status: 'completed',
    sessionId: options.sessionId,
    session_id: options.sessionId,
    turns,
    cwd: options.cwd,
    repo: options.repo,
    cordis: options.cordis,
    runtimeBin: runtimePath(options),
    provider,
    model,
    reasoningEffort,
    capabilities: capabilityMatrix(options.idleTimeoutSeconds),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await run(options)
    if (options.format === 'text') process.stdout.write(options.tasks.map(() => String((result.turns as Array<Record<string, unknown>>).at(-1)?.finalResponse ?? '')).join('\n\n'))
    else {
      const { serializeResult } = await import('./serialize.ts')
      process.stdout.write(await serializeResult(result, options.format))
    }
  } catch (error) {
    const timeout = error instanceof IdleTimeoutError
    const modelRequired = error instanceof ModelSelectionRequiredError
    const output = {
      status: timeout ? 'idle-timeout' : modelRequired ? 'model-selection-required' : 'error',
      errorType: error instanceof Error ? error.name : 'Error',
      error: String(error),
      agentInstruction: modelRequired ? MODEL_SELECTION_AGENT_INSTRUCTION : undefined,
      models: modelRequired ? error.models : undefined,
      configPath: modelRequired ? error.configPath : undefined,
      nextAction: timeout ? '检查 runtime、stderr、notifications、session JSONL、cwd 变更和测试后再判断是否重试' : undefined,
    }
    const { serializeResult } = await import('./serialize.ts')
    process.stdout.write(await serializeResult(output, 'toon'))
    process.exitCode = 1
  }
}
