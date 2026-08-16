import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

export interface ModelOption {
  id: string
  name: string
  contextWindow: number
  description: string
}

export interface StoredModelConfig {
  version: 1
  provider: string
  model: string
}

/** Models advertised by the dsh official DeepSeek adapter. */
export const CURRENT_MODELS: readonly ModelOption[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    contextWindow: 1_000_000,
    description: '默认快速模型，适合大多数编码和分析任务',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1_000_000,
    description: '更高能力模型，适合复杂推理和大型改动',
  },
]

export function modelConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DSH_SUBAGENT_CONFIG?.trim()) return resolve(environment.DSH_SUBAGENT_CONFIG)
  const base = environment.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(base, 'deepseek-harness-subagent', 'config.json')
}

export function modelOptions(): ModelOption[] {
  return CURRENT_MODELS.map((model) => ({ ...model }))
}

export function findModel(model: string): ModelOption | undefined {
  return CURRENT_MODELS.find((candidate) => candidate.id === model)
}

export async function readModelConfig(path = modelConfigPath()): Promise<StoredModelConfig | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const value = parsed as Record<string, unknown>
    if (value.version !== 1 || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
    return { version: 1, provider: value.provider, model: value.model }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeModelConfig(model: string, provider = 'deepseek-official', path = modelConfigPath()): Promise<StoredModelConfig> {
  if (!findModel(model)) throw new Error(`unknown model ${JSON.stringify(model)}; run --list-models first`)
  const config: StoredModelConfig = { version: 1, provider, model }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  return config
}
