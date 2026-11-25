// 宿主装配：把 tianshu.plugin.json + index.js 真的加载起来，注入一个 TPI 2.0 形状的 host。
// local-run（命令行）和 serve（界面）共用这一份，避免两套行为慢慢漂开。
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const pluginDir = resolve(here, '..')
// 数据落在与真机同一个位置（宿主 pluginDataDir(id) 的规则），工程目录因此永远干净，
// cp 到安装位时也不会把运行时数据一起带过去。
export const defaultDataDir = resolve(
  process.env.MEDIA_DESK_DATA ?? join(homedir(), '.rivet', 'plugin-data', 'media-desk'),
)

/** 宿主给插件的 workspace：相对路径按当前工作目录解析。 */
export function makeWorkspace(workDir) {
  const at = (path) => (isAbsolute(path) ? path : join(workDir, path))
  return {
    read: (path) => readFile(at(path), 'utf8'),
    write: async (path, content) => {
      const target = at(path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
  }
}

export function makeShell() {
  return {
    run: (command, options = {}) => new Promise((resolvePromise, rejectPromise) => {
      execFile('bash', ['-c', command], { timeout: options.timeoutMs ?? 60_000 }, (error, stdout, stderr) => {
        if (error) rejectPromise(Object.assign(error, { stdout, stderr }))
        else resolvePromise({ stdout, stderr })
      })
    }),
  }
}

export const llmConfigPath = join(defaultDataDir, 'llm.json')

/**
 * 模型配置：环境变量优先（启动时给的），否则读 llm.json（面板里填的那份）。
 * @returns {Promise<{baseUrl: string, key: string, model: string, source: 'env'|'file'} | null>}
 */
export async function readLLMConfig() {
  const env = {
    baseUrl: process.env.MEDIA_DESK_LLM_BASE_URL,
    key: process.env.MEDIA_DESK_LLM_KEY,
    model: process.env.MEDIA_DESK_LLM_MODEL,
  }
  if (env.baseUrl && env.key && env.model) return { ...env, source: 'env' }
  try {
    const raw = JSON.parse(await readFile(llmConfigPath, 'utf8'))
    if (raw?.baseUrl && raw?.model) {
      return { baseUrl: String(raw.baseUrl), key: String(raw.key ?? ''), model: String(raw.model), source: 'file' }
    }
  } catch {
    // 没有配置文件就是没配：不猜内容，也不自己造一份。
  }
  return null
}

/**
 * sidePathLLM：把插件接到一个 OpenAI 兼容端点上。这里只在给了配置时才接，
 * 不去翻本机的密钥文件。
 *   MEDIA_DESK_LLM_BASE_URL  https://api.example.com/v1
 *   MEDIA_DESK_LLM_KEY       sk-...（留空则不发 Authorization）
 *   MEDIA_DESK_LLM_MODEL     deepseek-v4-pro
 */
export function makeSidePathLLM(config) {
  if (!config?.baseUrl || !config?.model) return undefined
  const { baseUrl, key, model } = config

  return {
    available: () => true,
    modelId: () => model,
    complete: async (messages, options = {}) => {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, messages, max_tokens: 4000 }),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 180_000),
      })
      if (!response.ok) throw new Error(`模型接口 ${response.status}：${(await response.text()).slice(0, 200)}`)
      const data = await response.json()
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string') throw new Error('模型接口没有返回 choices[0].message.content')
      return { text }
    },
  }
}

/**
 * 加载插件并激活。
 * @param {{workDir?: string, dataDir?: string, quiet?: boolean, onBlock?: (text: string) => void}} options
 */
export async function loadPlugin(options = {}) {
  const workDir = options.workDir ?? process.cwd()
  const dataDir = options.dataDir ?? defaultDataDir
  const quiet = options.quiet ?? true
  const manifest = JSON.parse(await readFile(join(pluginDir, 'tianshu.plugin.json'), 'utf8'))

  // 宿主在加载插件前把 SDK 装到 globalThis；tpi.js 靠它握手。
  globalThis.__tianshuTPI = { defineTianshuPlugin: spec => spec }

  const blocks = []
  const events = []
  const host = {
    pluginId: manifest.id,
    cwd: workDir,
    tpiVersion: '2.0',
    storage: { dataDir: () => dataDir },
    workspace: makeWorkspace(workDir),
    shell: makeShell(),
    ui: {
      post: async (view, message) => {
        events.push({ view, message })
        if (!quiet) console.error(`[ui→${view}]`, JSON.stringify(message))
      },
      setStatus: async (id, text) => {
        events.push({ status: id, text })
        if (!quiet) console.error(`[status:${id}]`, text)
      },
    },
    promptContext: {
      setBlock: (text) => {
        blocks.push(text)
        options.onBlock?.(text)
      },
    },
    log: {
      debug: (text) => { if (!quiet) console.error('[plugin]', text) },
      warn: (text) => console.error('[plugin:warn]', text),
    },
  }

  const sidePathLLM = makeSidePathLLM(await readLLMConfig())
  if (sidePathLLM) host.sidePathLLM = sidePathLLM

  await mkdir(dataDir, { recursive: true })
  const { default: plugin } = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
  const api = plugin.activate(host)
  // 1.0 的 promptContext.setBlock 只在 preTurn 窗口能过 phase 门；真机由宿主在每轮对话
  // 开始时调 lifecycle.turnStart。本地宿主在这里模拟同一个窗口。
  const preTurn = async () => { await api.lifecycle?.turnStart?.() }
  await preTurn()
  return { manifest, api, blocks, events, host, dataDir, workDir, preTurn }
}
