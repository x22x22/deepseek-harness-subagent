import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type OutputFormat = 'toon' | 'json' | 'text'

const DEFAULT_RUNTIME_NODE_MODULES = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'deepseek-harness-subagent', 'runtime', 'node_modules',
)

/** Serialize an agent-facing result. TOON is the default compact, lossless format. */
export async function serializeResult(value: unknown, format: OutputFormat): Promise<string> {
  if (format === 'json') return `${JSON.stringify(value)}\n`
  if (format === 'text') return String(value)
  const nodeModules = process.env.DSH_RUNTIME_NODE_MODULES || DEFAULT_RUNTIME_NODE_MODULES
  const toonEntry = pathToFileURL(join(nodeModules, '@toon-format', 'toon', 'dist', 'index.mjs')).href
  try {
    const { encode } = await import(toonEntry)
    return `${encode(value)}\n`
  } catch (error) {
    throw new Error(`TOON runtime is unavailable; rerun bootstrap or use --format json: ${error instanceof Error ? error.message : String(error)}`)
  }
}
