import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

export interface ModelOption {
  provider: string
  id: string
  name: string
  contextWindow: number
  description: string
}

export interface StoredModelConfig {
  version: 1
  provider: string
  model: string
  reasoningEffort?: 'off' | 'high' | 'max'
}

/** Models advertised by the dsh official DeepSeek adapter. */
export const CURRENT_MODELS: readonly ModelOption[] = [
  {
    provider: 'deepseek-official',
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    contextWindow: 1_000_000,
    description: '默认快速模型，适合大多数编码和分析任务',
  },
  {
    provider: 'deepseek-official',
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1_000_000,
    description: '更高能力模型，适合复杂推理和大型改动',
  },
]

function option(provider: string, id: string, name = id, contextWindow = 1_000_000, description = ''): ModelOption {
  return { provider, id, name, contextWindow, description }
}

/**
 * Read the local dsh settings enough to mirror the Web model picker. This is
 * deliberately dependency-free: the skill is installed outside dsh's
 * node_modules tree, so it cannot assume a YAML package is resolvable here.
 */
export function localModelOptions(environment: NodeJS.ProcessEnv = process.env): ModelOption[] {
  const result = [...CURRENT_MODELS.map((model) => ({ ...model }))]
  const dshHome = resolve(environment.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  const settingsPath = join(dshHome, 'settings.yaml')
  let source = ''
  try { source = readFileSync(settingsPath, 'utf8') } catch { return result }
  const add = (model: ModelOption): void => {
    if (!result.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) result.push(model)
  }
  const deepseek = CURRENT_MODELS
  // Settings can outlive an uninstall. Only advertise plugin-owned routes when
  // the corresponding package is actually installed; stale YAML must never
  // make a plain dsh installation fail or expose unusable model choices.
  const hasModlens = existsSync(join(dshHome, 'profiles/web/node_modules/@liustack/modlens'))
  const hasVisionRouter = existsSync(join(dshHome, 'profiles/web/node_modules/dsh-vision-router'))
  if (hasModlens) {
    for (const model of deepseek) add(option('deepseek-modlens', model.id, `${model.name} (modlens vision)`, model.contextWindow, 'modlens 视觉桥接'))
  }
  if (hasVisionRouter) {
    for (const model of deepseek) {
      add(option('deepseek-vision', model.id, `${model.name} + 自动识图`, model.contextWindow, 'DeepSeek 自动识图路由'))
      if (hasModlens) add(option('deepseek-modlens-vision', model.id, `${model.name} (modlens vision) + 自动识图`, model.contextWindow, 'modlens + 自动识图路由'))
    }
    add(option('vision-http', 'ovh/Qwen3.5-397B-A17B', 'ovh/Qwen3.5-397B-A17B', 32768, 'vision-router 内置免费视觉模型'))
  }
  // Parse the configured llm-pi-ai provider catalog (currently ZAI 网关).
  const piStart = source.indexOf('llm-pi-ai:')
  const piSection = piStart >= 0 ? source.slice(piStart) : ''
  for (const match of piSection.matchAll(/^    ([A-Za-z0-9._-]+):\s*$/gm)) {
    const provider = match[1]
    const block = piSection.slice(match.index + match[0].length, match.index + match[0].length + 4000)
    const display = block.match(/^      displayName:\s*(.+)$/m)?.[1]?.trim() ?? provider
    for (const modelMatch of block.matchAll(/^\s{8}- id:\s*([^\s#]+)/gm)) {
      const id = modelMatch[1]
      const modelBlock = block.slice(modelMatch.index, modelMatch.index + 300)
      const context = Number(modelBlock.match(/^\s{10}contextWindow:\s*(\d+)/m)?.[1] ?? 128000)
      add(option(provider, id, `${display} / ${id}`, context, '本地 dsh llm-pi-ai 配置'))
      if (hasVisionRouter) add(option(`${provider}-vision`, id, `${display} / ${id} + 自动识图`, context, 'llm-pi-ai + 自动识图路由'))
    }
  }
  if (hasVisionRouter) {
    const httpStart = source.indexOf('vision-router:')
    const httpSection = httpStart >= 0 ? source.slice(httpStart) : ''
    for (const match of httpSection.matchAll(/^\s{4}- name:\s*([^\s#]+)[\s\S]*?^\s{6}model:\s*([^\s#]+)/gm)) {
      add(option('vision-http', `${match[1]}/${match[2]}`, `${match[1]}/${match[2]}`, 32768, 'vision-router HTTP provider'))
    }
  }
  return result
}

export function modelConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DSH_SUBAGENT_CONFIG?.trim()) return resolve(environment.DSH_SUBAGENT_CONFIG)
  const base = environment.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(base, 'deepseek-harness-subagent', 'config.json')
}

export function modelOptions(environment: NodeJS.ProcessEnv = process.env): ModelOption[] {
  return localModelOptions(environment)
}

export function findModel(model: string, environment: NodeJS.ProcessEnv = process.env): ModelOption | undefined {
  return modelOptions(environment).find((candidate) => candidate.id === model || `${candidate.provider}/${candidate.id}` === model)
}

export async function readModelConfig(path = modelConfigPath()): Promise<StoredModelConfig | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
    const effort = value.reasoningEffort
    if (effort !== undefined && effort !== 'off' && effort !== 'high' && effort !== 'max') return undefined
    return { version: 1, provider: value.provider, model: value.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeModelConfig(model: string, provider = 'deepseek-official', path = modelConfigPath(), reasoningEffort: StoredModelConfig['reasoningEffort'] = 'high'): Promise<StoredModelConfig> {
  const selected = findModel(model)
  if (!selected) throw new Error(`unknown model ${JSON.stringify(model)}; run --list-models first`)
  const config: StoredModelConfig = { version: 1, provider: selected.provider, model: selected.id, reasoningEffort }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  return config
}
