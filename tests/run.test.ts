import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { DEFAULT_IDLE_TIMEOUT_SECONDS, MODEL_SELECTION_AGENT_INSTRUCTION, ModelSelectionRequiredError, announceCwd, capabilityMatrix, finishReason, parseArgs, parseEnv, runtimeLaunch, scrubEnvironment } from '../scripts/run.ts'
import { CURRENT_MODELS, localModelOptions, readModelConfig, writeModelConfig } from '../scripts/model-config.ts'
import { parseArgs as parseStartArgs, processMatches } from '../scripts/start-dsh.ts'

describe('Node SDK skill runner helpers', () => {
  it('uses one hour idle timeout and parses repeated tasks', () => {
    const options = parseArgs(['--task', 'one', '--task', 'two'])
    assert.equal(options.idleTimeoutSeconds, DEFAULT_IDLE_TIMEOUT_SECONDS)
    assert.deepEqual(options.tasks, ['one', 'two'])
  })

  it('supports structured input and disabling idle timeout', () => {
    const options = parseArgs(['--input-json', '[{"type":"text","text":"x"}]', '--no-idle-timeout'])
    assert.equal(options.idleTimeoutSeconds, 0)
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
    assert.equal(launch.env.DSH_CWD, options.cwd)
    assert.equal(launch.cwd, options.cwd)
  })

  it('keeps the Python request-timeout spelling as seconds', () => {
    assert.equal(parseArgs(['--task', 'x', '--request-timeout', '2']).requestTimeoutMs, 2000)
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

  it('announces the exact cwd for text and structured tasks', () => {
    assert.match(announceCwd('task', '/workspace') as string, /Current working directory \(cwd\): \/workspace/)
    assert.deepEqual(announceCwd([{ type: 'text', text: 'task' }], '/workspace'), [
      { type: 'text', text: '[Codex parent execution context]\nCurrent working directory (cwd): /workspace\n' },
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
      assert.match(await readFile(path, 'utf8'), /deepseek-v4-pro/)
      assert.doesNotMatch(await readFile(path, 'utf8'), /API_KEY|SECRET|PASSWORD/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('represents first-use model selection as a recoverable state', () => {
    const error = new ModelSelectionRequiredError('/home/user/.config/deepseek-harness-subagent/config.json')
    assert.equal(error.configPath, '/home/user/.config/deepseek-harness-subagent/config.json')
    assert.ok(error.models.some((model) => model.id === 'deepseek-v4-flash'))
    assert.match(MODEL_SELECTION_AGENT_INSTRUCTION, /models 列表告知用户/)
    assert.match(MODEL_SELECTION_AGENT_INSTRUCTION, /configure\.ts --set-model MODEL/)
  })

  it('discovers local pi-ai and vision routes without exposing credentials', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tmp-dsh-settings-'))
    const settings = join(directory, 'settings.yaml')
    const fs = await import('node:fs/promises')
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
})
