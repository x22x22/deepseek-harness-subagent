import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_IDLE_TIMEOUT_SECONDS, DshTaskFailedError, MODEL_SELECTION_AGENT_INSTRUCTION, ModelSelectionRequiredError, announceCwd, capabilityMatrix, createSessionId, failureDetails, finishReason, parseArgs, parseEnv, resolveModelRoute, run, runtimeLaunch, scrubEnvironment, sessionMetadata } from '../scripts/run.ts'
import { CURRENT_MODELS, localModelOptions, readModelConfig, writeModelConfig } from '../scripts/model-config.ts'
import { parseArgs as parseStartArgs, processMatches } from '../scripts/start-dsh.ts'
import { DEFAULT_RUNTIME_ROOT, RUNTIME_VERSION, ensureRuntime } from '../scripts/bootstrap-runtime.mjs'
import { serializeResult } from '../scripts/serialize.ts'

describe('Node SDK skill runner helpers', () => {
  it('uses one hour idle timeout and parses repeated tasks', () => {
    const options = parseArgs(['--task', 'one', '--task', 'two'])
    assert.equal(options.idleTimeoutSeconds, DEFAULT_IDLE_TIMEOUT_SECONDS)
    assert.deepEqual(options.tasks, ['one', 'two'])
    assert.equal(options.format, 'toon')
  })

  it('supports TOON by default and JSON as an explicit compatibility format', () => {
    assert.equal(parseArgs(['--task', 'x', '--format', 'toon']).format, 'toon')
    assert.equal(parseArgs(['--task', 'x', '--format', 'json']).format, 'json')
    assert.throws(() => parseArgs(['--task', 'x', '--format', 'yaml']), /toon, json, or text/)
  })

  it('generates a friendly resumable session identity and exposes it at the top level', () => {
    const generated = createSessionId(new Date('2026-08-17T12:34:56.000Z'), 'abc123')
    assert.equal(generated, 'dsh-20260817123456-abc123')
    const options = parseArgs(['--task', 'x', '--cwd', process.cwd()])
    assert.equal(options.sessionIdSource, 'generated')
    assert.match(options.sessionId, /^dsh-\d{14}-[0-9a-f]{6}$/)
    assert.equal(options.sessionRoot, join(process.cwd(), '.dsh-sessions'))
    const metadata = sessionMetadata(options)
    assert.equal(metadata.sessionId, options.sessionId)
    assert.equal(metadata.sessionRoot, options.sessionRoot)
    assert.match(String(metadata.resumeHint), new RegExp(options.sessionId))
    const provided = parseArgs(['--task', 'x', '--session-id', 'weather-followup', '--session-root', '/workspace/.sessions'])
    assert.equal(provided.sessionIdSource, 'provided')
    assert.equal(provided.sessionId, 'weather-followup')
  })

  it('serializes agent results with the official TOON encoder', async () => {
    const toon = await serializeResult({ status: 'completed', turns: [{ answer: 'ok' }] }, 'toon')
    assert.match(toon, /status: completed/)
    assert.match(toon, /turns\[1\]\{answer\}:/)
    assert.match(await serializeResult({ status: 'completed' }, 'json'), /^\{"status":"completed"\}\n$/)
  })

  it('documents dsh-only delegation and concise task guidance', async () => {
    const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
    assert.match(skill, /Codex、OpenCode/)
    assert.match(skill, /必须实际运行本 skill 的脚本/)
    assert.match(skill, /任务提示词保持自包含、简短/)
    assert.doesNotMatch(skill, /DEEPSEEK_API_KEY|API key|api key/)
  })

  it('supports structured input and disabling idle timeout', () => {
    const options = parseArgs(['--input-json', '[{"type":"text","text":"x"}]', '--no-idle-timeout'])
    assert.equal(options.idleTimeoutSeconds, 0)
    assert.equal(parseArgs(['--task', 'x', '--include-events']).includeEvents, true)
    assert.deepEqual(options.tasks, [[{ type: 'text', text: 'x' }]])
  })

  it('keeps Python-compatible URL/key and cwd-announcement controls', () => {
    const options = parseArgs([
      '--task', 'x', '--base-url', 'https://gateway.example/v1', '--api-key', 'explicit', '--no-announce-cwd',
    ])
    assert.equal(options.announceCwd, false)
    const launch = runtimeLaunch(options)
    assert.equal(launch.env.DEEPSEEK_BASE_URL, 'https://gateway.example/v1')
    assert.equal(launch.env.DEEPSEEK_API_KEY, 'explicit')
    assert.equal(launch.env.DSH_HOME, process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
    assert.equal(launch.env.DSH_CWD, options.cwd)
    assert.equal(launch.cwd, options.cwd)
    const explicitHome = runtimeLaunch(parseArgs(['--task', 'x', '--env', 'DSH_HOME=/custom/dsh-home']))
    assert.equal(explicitHome.env.DSH_HOME, '/custom/dsh-home')
  })

  it('keeps the Python request-timeout spelling as seconds', () => {
    assert.equal(parseArgs(['--task', 'x', '--request-timeout', '2']).requestTimeoutMs, 2000)
    assert.equal(parseArgs(['--task', 'x', '--reasoning-effort', 'max']).reasoningEffort, 'max')
  })

  it('rejects invalid task source and timeout values', () => {
    assert.throws(() => parseArgs([]), /required/)
    assert.throws(() => parseArgs(['--task', 'x', '--stdin']), /combined/)
    assert.throws(() => parseArgs(['--task', 'x', '--idle-timeout', '-1']), /non-negative/)
    assert.throws(() => parseArgs(['--task', 'x', '--request-timeout-ms', '0']), /positive/)
  })

  it('scrubs inherited credentials but accepts explicit overrides', () => {
    assert.deepEqual(scrubEnvironment({ SAFE: 'yes', DEEPSEEK_API_KEY: 'secret', EMPTY: undefined }), { SAFE: 'yes' })
    assert.deepEqual(parseEnv(['DEEPSEEK_API_KEY=explicit', 'A=B=C']), { DEEPSEEK_API_KEY: 'explicit', A: 'B=C' })
  })

  it('turns credential failures into actionable secret-free messages', () => {
    const failure = failureDetails(new Error('MISSING_CREDENTIAL: no API key for provider route'))
    assert.equal(failure.message, 'dsh runtime 未检测到可用凭据。')
    assert.match(failure.nextAction, /配置本机 dsh 凭据/)
    assert.doesNotMatch(failure.message + failure.nextAction, /DEEPSEEK_API_KEY|sk-/)
    assert.equal(failureDetails(new DshTaskFailedError('error', 'credential')).message, 'dsh runtime 未检测到可用凭据。')
  })

  it('announces the exact cwd for text and structured tasks', () => {
    assert.match(announceCwd('task', '/workspace') as string, /Current working directory \(cwd\): \/workspace/)
    assert.deepEqual(announceCwd([{ type: 'text', text: 'task' }], '/workspace'), [
      { type: 'text', text: '[Parent agent execution context]\nCurrent working directory (cwd): /workspace\n' },
      { type: 'text', text: 'task' },
    ])
  })

  it('derives finish reason and exposes the protocol capability gaps', () => {
    assert.equal(finishReason([
      { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]), 'completed')
    assert.equal(finishReason([{ type: 'assistant/message', data: {} }]), undefined)
    const matrix = capabilityMatrix(3600)
    assert.equal(matrix.supported.finish_reason, 'derived from root turn/end events')
    assert.match(String(matrix.supported.idle_timeout), /3600/)
    assert.match(String(matrix.unsupported_by_current_sdk_wire.agent_name_or_preset_selector), /agentPreset/)
  })

  it('persists and reloads the selected default model without secrets', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tmp-model-config-'))
    const path = join(directory, 'config.json')
    try {
      assert.equal(CURRENT_MODELS.length, 2)
      const saved = await writeModelConfig('deepseek-v4-pro', 'deepseek-official', path)
      assert.deepEqual(await readModelConfig(path), saved)
      assert.equal(saved.reasoningEffort, 'high')
      assert.match(await readFile(path, 'utf8'), /deepseek-v4-pro/)
      assert.doesNotMatch(await readFile(path, 'utf8'), /API_KEY|SECRET|PASSWORD/)
      const derived = await writeModelConfig('deepseek-modlens/deepseek-v4-flash', 'deepseek-official', path)
      assert.deepEqual(derived, { version: 1, provider: 'deepseek-modlens', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('represents first-use model selection as a recoverable state', () => {
    const error = new ModelSelectionRequiredError('/home/user/.config/deepseek-harness-subagent/config.json')
    assert.equal(error.configPath, '/home/user/.config/deepseek-harness-subagent/config.json')
    assert.ok(error.models.some((model) => model.id === 'deepseek-v4-flash'))
    assert.match(MODEL_SELECTION_AGENT_INSTRUCTION, /models 列表告知用户/)
    assert.match(MODEL_SELECTION_AGENT_INSTRUCTION, /Flash \+ 视觉组合/)
    assert.match(MODEL_SELECTION_AGENT_INSTRUCTION, /只有没有视觉组合时才推荐官方 Flash/)
    assert.match(MODEL_SELECTION_AGENT_INSTRUCTION, /configure\.mjs --set-model MODEL/)
  })

  it('normalizes provider/model selections before they reach the API', () => {
    assert.deepEqual(resolveModelRoute('deepseek-official/deepseek-v4-flash'), {
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    assert.deepEqual(resolveModelRoute('deepseek-modlens/deepseek-v4-flash'), {
      provider: 'deepseek-modlens', model: 'deepseek-v4-flash',
    })
    assert.deepEqual(resolveModelRoute('deepseek-modlens/deepseek-v4-flash', 'deepseek-official'), {
      provider: 'deepseek-modlens', model: 'deepseek-v4-flash',
    })
  })

  it('requires human model selection when the config file is absent', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tmp-no-model-config-'))
    const previous = process.env.DSH_SUBAGENT_CONFIG
    process.env.DSH_SUBAGENT_CONFIG = join(directory, 'missing.json')
    try {
      await assert.rejects(
        run(parseArgs(['--task', 'diagnostic'])),
        (error: unknown) => error instanceof ModelSelectionRequiredError && error.models.length >= 2 && /models 列表/.test(MODEL_SELECTION_AGENT_INSTRUCTION),
      )
    } finally {
      if (previous === undefined) delete process.env.DSH_SUBAGENT_CONFIG
      else process.env.DSH_SUBAGENT_CONFIG = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('discovers local pi-ai and vision routes without exposing credentials', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tmp-dsh-settings-'))
    const settings = join(directory, 'settings.yaml')
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(directory, 'profiles/web/node_modules/dsh-vision-router'), { recursive: true })
    await fs.writeFile(settings, `vision-router:\n  httpProviders:\n    - name: zai-qwen-plus\n      model: qwen3.7-plus\nllm-pi-ai:\n  providers:\n    zai-gw:\n      displayName: ZAI 网关\n      models:\n        - id: qwen3.7-plus\n          contextWindow: 128000\n`)
    try {
      const models = localModelOptions({ DSH_HOME: directory })
      assert.ok(models.some((model) => model.provider === 'zai-gw' && model.id === 'qwen3.7-plus'))
      assert.ok(models.some((model) => model.provider === 'vision-http' && model.id.includes('zai-qwen-plus')))
      assert.doesNotMatch(JSON.stringify(models), /API_KEY|SECRET|PASSWORD/)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('selects global dsh first and recognizes existing web processes', () => {
    assert.equal(processMatches('/usr/local/bin/dsh web --port 3456', 'web'), true)
    assert.equal(processMatches('node @deepseek-ai/dsh web', 'web'), true)
    assert.equal(processMatches('dsh --profile headless', 'web'), false)
    assert.deepEqual(parseStartArgs(['--profile', 'web', '--port', '3456', '--check']), {
      profile: 'web', port: 3456, waitMs: 3000, checkOnly: true,
    })
  })

  it('falls back to the official catalog when optional vision plugins are absent', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tmp-no-plugins-'))
    const fs = await import('node:fs/promises')
    await fs.writeFile(join(directory, 'settings.yaml'), `vision-router:\n  httpProviders:\n    - name: stale\n      model: stale-model\nllm-pi-ai:\n  providers: {}\n`)
    try {
      const models = localModelOptions({ DSH_HOME: directory })
      assert.deepEqual(models.map((model) => `${model.provider}/${model.id}`), [
        'deepseek-official/deepseek-v4-flash',
        'deepseek-official/deepseek-v4-pro',
      ])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses a stable default cache and reports an unbootstrapped runtime without installing', async () => {
    assert.match(DEFAULT_RUNTIME_ROOT, /deepseek-harness-subagent\/runtime$/)
    const directory = await mkdtemp(join(process.cwd(), 'tmp-runtime-probe-'))
    try {
      const runtime = await ensureRuntime(directory, { install: false })
      assert.equal(runtime.cached, false)
      assert.equal(runtime.ready, false)
      assert.match(runtime.cordis, /cordis\.yml$/)
      assert.match(RUNTIME_VERSION, /^0\.0\.1-/)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
