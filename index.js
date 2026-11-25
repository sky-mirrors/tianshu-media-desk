/**
 * index.js — 天枢 TPI 2.0 入口。
 *
 * 与上游 dsh-media-desk 的分工差异（为什么这么切）：
 *   上游把「一键成稿」做在插件内部——插件自己调模型写文章、调生图接口画封面。
 *   天枢里对话模型本身就是执行者，插件再内置一套模型调用是重复建设，还得让用户另配 key。
 *   所以这里插件只管三件事：**台账**（灵感/成稿/风格/排期）、**规范**（创作简报）、**落盘**（导出）。
 *   写文章、出画面交给 agent：media_brief 给规范，agent 产出后 media_save 回写。
 *
 * 状态只有一个写入口：src/ops.js 的 applyOps（白名单字段校验），工具与面板都走它。
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTianshuPlugin } from './tpi.js'
import { parametersToJsonSchema } from './lib/schema.js'
import { State } from './lib/state.js'
import { buildBrief, buildStyleBrief } from './lib/brief.js'
import { buildContextBlock } from './lib/context.js'
import { ARTICLE_SYSTEM, PLAN_SYSTEM, extractJson, textOf } from './lib/llm.js'
import { itemLine, renderItem, renderList, renderReceipts } from './lib/render.js'
import { KINDS, PLATFORMS, STATUSES, applyOps, isAssetRef, isHttpUrl } from './src/ops.js'
import { exportProduction, slugify } from './src/export.js'

const WORKER = fileURLToPath(new URL('./lib/export-worker.mjs', import.meta.url))
const LIST_LIMIT = 50

/**
 * 工具级超时。media_write 串两次旁路模型调用（180s + 240s），预算必须盖住它，
 * 否则宿主会在第一次调用还没回来时就切断工具。
 */
const TOOL_TIMEOUT = { media_export: 60_000, media_write: 480_000 }

/** 导出只会把图片搬进 assets/：非图片文件（llm.json、state.json 之类）一个都别放进来。 */
const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif|avif|bmp|svg)$/i

/**
 * 图片 src 的边界校验：http(s) 地址、插件自己的 media 引用，或落在工作区（或插件数据目录 files/）里的图片文件。
 * 过了这道门下游直接信任它——导出会按这个路径 copyFile。
 */
function checkAssetSrc(raw, cwd, dataDir) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new Error('图片路径为空')
  if (isHttpUrl(text) || isAssetRef(text)) return text
  if (!IMAGE_EXT.test(text)) throw new Error(`只接受图片文件（png/jpg/jpeg/webp/gif/avif/bmp/svg）：${text}`)
  const absolute = isAbsolute(text) ? text : join(cwd, text)
  // 数据目录只放开 files/：llm.json 里的 key、state.json 的全文都不能被搬进工作区。
  const roots = [cwd, join(dataDir, 'files')].map(root => root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
  const target = absolute.replace(/\\/g, '/').toLowerCase()
  if (roots.some(root => target === root || target.startsWith(`${root}/`))) return text
  throw new Error(`图片路径不在工作区或插件数据目录里（数据目录只放行 files/ 下的图片）：${text}`)
}

/** id 允许写前缀：agent 从列表里复制半截也能用，只要唯一。 */
function resolveId(items, raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('缺少 id：先用 media_list 查')
  const exact = items.find(row => row.id === text)
  if (exact) return exact.id
  const hits = items.filter(row => row.id.startsWith(text))
  if (hits.length === 1) return hits[0].id
  if (!hits.length) throw new Error(`找不到条目：${text}`)
  throw new Error(`id 前缀不唯一：${text}（${hits.map(row => row.id).join('、')}）`)
}

const ideaTool = () => ({
  name: 'media_idea',
  description: '把一句话灵感、一条链接或一张图记进自媒体工作台。没有内容时用来开新条目；返回条目 id 供后续 media_brief / media_save 使用。',
  parameters: {
    text: { type: 'string', description: '灵感原文，一段话即可；没给 title 时取第一句当标题' },
    title: { type: 'string', description: '标题；给了就原样用' },
    body: { type: 'string', description: '补充说明' },
    kind: { type: 'string', enum: KINDS, description: '素材类型，默认 note' },
    url: { type: 'string', description: '来源链接（http/https）' },
    source: { type: 'string', description: '来源名称，如某公众号' },
    tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    platform: { type: 'string', enum: PLATFORMS, description: '计划发布的平台' },
    media: { type: 'json', description: '图片/视频：{src:"http(s) 地址，或工作区内的本地路径", poster?:"封面帧"}' },
    status: { type: 'string', enum: STATUSES, description: '初始状态，默认 idea' },
  },
})

const listTool = () => ({
  name: 'media_list',
  description: '列出工作台里的灵感与成稿，按状态/平台/关键词筛。返回每条一行（id · 状态 · 标题 · 平台 · 排期）。',
  parameters: {
    status: { type: 'string', enum: STATUSES, description: '只看某个状态' },
    platform: { type: 'string', enum: PLATFORMS, description: '只看某个平台' },
    query: { type: 'string', description: '标题/正文关键词' },
    limit: { type: 'number', description: '最多几条，默认 20' },
  },
})

const itemTool = () => ({
  name: 'media_item',
  description: '看一条的详情（含大纲、成稿、画面槽位），或改字段、改状态、排期、删除。',
  parameters: {
    id: { type: 'string', required: true, description: '条目 id，可写唯一前缀' },
    action: { type: 'string', enum: ['get', 'update', 'status', 'schedule', 'delete'], description: '默认 get' },
    title: { type: 'string', description: 'update：新标题' },
    body: { type: 'string', description: 'update：补充' },
    tags: { type: 'array', items: { type: 'string' }, description: 'update：标签' },
    url: { type: 'string', description: 'update：来源链接' },
    platform: { type: 'string', enum: PLATFORMS, description: 'update/schedule：平台' },
    status: { type: 'string', enum: STATUSES, description: 'status：目标状态' },
    scheduledAt: { type: 'string', description: 'schedule：排期时间（ISO 或 2026-03-01 20:00；传空字符串取消排期）' },
  },
})

const briefTool = () => ({
  name: 'media_brief',
  description: '取一条灵感的创作简报：体裁写法、策划案 JSON 字段、当前风格卡与写作规则、已有成稿。写完用 media_save 回写。',
  parameters: {
    id: { type: 'string', required: true, description: '条目 id' },
    format: { type: 'string', enum: ['script', 'article'], description: '口播脚本（默认）或文章' },
    imageCount: { type: 'number', description: '配图数量 0-4，默认 2' },
    shotCount: { type: 'number', description: '分镜数量 0-12，默认 6' },
  },
})

const saveTool = () => ({
  name: 'media_save',
  description: '把生成结果写回条目：策划案（plan）、正文成稿（article/script）、草稿（draft）、画面（image）、风格卡（style）、数据（metric）、写作规则（rule）。',
  parameters: {
    id: { type: 'string', required: true, description: '条目 id（style/metric/rule 不需要，可留空）' },
    kind: { type: 'string', required: true, enum: ['plan', 'article', 'script', 'draft', 'image', 'style', 'metric', 'rule'], description: '写回什么' },
    plan: { type: 'json', description: 'kind=plan：{title,coverText,facts[],outline[],cover,characters,images[],shots[]}' },
    text: { type: 'string', description: 'kind=article/script/draft：Markdown 全文' },
    target: { type: 'string', description: 'kind=image：cover / image:1 / shot:2' },
    src: { type: 'string', description: 'kind=image：图片本地绝对路径' },
    name: { type: 'string', description: 'kind=style/rule：名字' },
    style: { type: 'json', description: 'kind=style：风格卡 {summary,tone,sentences,opening,structure,logic,story,flow,words[],avoid[],samples[]}' },
    rule: { type: 'string', description: 'kind=rule：一条写作规则' },
    platform: { type: 'string', enum: PLATFORMS, description: 'kind=metric：平台' },
    views: { type: 'number', description: 'kind=metric：阅读/播放' },
    likes: { type: 'number', description: 'kind=metric：赞' },
    comments: { type: 'number', description: 'kind=metric：评论' },
    shares: { type: 'number', description: 'kind=metric：转发' },
    saves: { type: 'number', description: 'kind=metric：收藏' },
  },
})

const exportTool = () => ({
  name: 'media_export',
  description: '把成稿导出到工作区：一份 Markdown（正文、图注、分镜表）+ assets/ 里的图片。',
  pathParams: { dir: 'write' },
  parameters: {
    id: { type: 'string', required: true, description: '条目 id' },
    dir: { type: 'string', description: '导出目录（工作区相对路径）；默认 media-desk-export/<标题>' },
  },
})

const writeTool = () => ({
  name: 'media_write',
  description: '一键成稿：用天枢已配置的模型，按创作简报生成策划案和正文并直接落库。不需要用户配任何密钥。',
  parameters: {
    id: { type: 'string', required: true, description: '条目 id' },
    format: { type: 'string', enum: ['script', 'article'], description: '口播脚本（默认）或文章' },
    imageCount: { type: 'number', description: '配图数量 0-4，默认 2' },
    shotCount: { type: 'number', description: '分镜数量 0-12，默认 6' },
  },
})

const SPECS = [ideaTool, listTool, itemTool, briefTool, saveTool, writeTool, exportTool]

export default defineTianshuPlugin({
  id: 'media-desk',
  activate(host) {
    const dataDir = host.storage.dataDir()
    const state = new State(dataDir)

    /** 面板要的那份快照：条目 + 风格 + 统计。 */
    async function snapshot() {
      const current = await state.read()
      return {
        items: current.items.map(item => ({
          id: item.id,
          title: item.title,
          body: item.body,
          status: item.status,
          kind: item.kind,
          tags: item.tags,
          platform: item.platform,
          scheduledAt: item.scheduledAt,
          publishedAt: item.publishedAt,
          media: item.media,
          url: item.url,
          production: item.production
            ? {
              status: item.production.status,
              title: item.production.title,
              coverText: item.production.coverText,
              words: item.production.article?.length ?? 0,
              articlePreview: (item.production.article ?? '').slice(0, 600),
              outline: (item.production.outline ?? []).slice(0, 6),
              savedPath: item.production.savedPath ?? '',
              cover: item.production.cover?.src ?? '',
              images: (item.production.images ?? []).filter(row => row.src).length,
              shots: (item.production.shots ?? []).filter(row => row.src).length,
            }
            : null,
        })),
        styles: (current.styles ?? []).map(row => ({ id: row.id, name: row.name, summary: row.summary })),
        activeStyleId: current.activeStyleId,
      }
    }

    /**
     * 工作台状态写进每轮对话的上下文：模型不用被问就知道有哪些待写、哪条快到期。
     * 空台账不推块——占上下文不换信息。
     */
    async function pushContext() {
      const block = buildContextBlock(await state.read())
      // setBlock 是宿主的异步接口：吞掉 rejection，否则 unhandledRejection 会打断宿主进程。
      if (block) Promise.resolve(host.promptContext?.setBlock(block)).catch(() => {})
    }

    /** 面板与工具发来的写操作：只走 applyOps。整批全军覆没时抛错，让调用方看见失败。 */
    async function runOps(ops, label) {
      const result = await state.mutate(draft => applyOps(draft, Array.isArray(ops) ? ops : []))
      void host.ui?.post('desk', { type: 'changed', label }).catch(() => {})
      if (result.errors.length && !result.receipts.length) throw new Error(result.errors.join('；'))
      // promptContext.setBlock 只在 turnStart 钩子里过宿主 phase 门，工具调用期间推无效。
      return result
    }

    /**
     * 一键成稿：两次旁路模型调用（先策划案，再正文），结果都经 applyOps 落库。
     * 面板的「让模型成稿」和 media_write 工具走同一条路。
     * @param {string} id - 条目 id。
     * @param {{format?: string, imageCount?: number, shotCount?: number}} [options]
     */
    async function writeWithModel(id, options = {}) {
      if (!host.sidePathLLM?.available?.()) {
        throw new Error('这台机器的天枢没有可用的旁路模型：改用 media_brief 取规范、自己写，再用 media_save 回写')
      }
      const current = await state.read()
      const item = current.items.find(row => row.id === id)
      if (!item) throw new Error(`找不到条目：${id}`)

      const planText = textOf(await host.sidePathLLM.complete([
        { role: 'system', content: PLAN_SYSTEM },
        { role: 'user', content: buildBrief(current, item, { ...options, phase: 'plan' }) },
      ], { timeoutMs: 180_000 }))
      const planReceipt = await runOps([{ op: 'save_plan', id, plan: extractJson(planText) }], '定策划案')

      const afterPlan = await state.read()
      const planted = afterPlan.items.find(row => row.id === id)
      const articleText = textOf(await host.sidePathLLM.complete([
        { role: 'system', content: ARTICLE_SYSTEM },
        { role: 'user', content: buildBrief(afterPlan, planted, { ...options, phase: 'article' }) },
      ], { timeoutMs: 240_000 }))
      const bodyReceipt = await runOps([{
        op: 'save_production', id, text: articleText, format: options.format === 'article' ? 'article' : 'script',
      }], '存成稿')

      return [
        renderReceipts(planReceipt),
        renderReceipts(bodyReceipt),
        '',
        '画面槽位还空着：用生图工具按简报里的英文 prompt 出图，再用 media_save kind:"image" 写回。',
      ].join('\n')
    }

    const tools = SPECS.map((spec) => {
      const { name, description, parameters, pathParams } = spec()
      return {
        name,
        description,
        inputSchema: parametersToJsonSchema(parameters),
        // 宿主 wrapTpiTool 按这个声明做 validatePathSafe：越界/敏感路径在边界直接拒绝。
        ...(pathParams ? { pathParams } : {}),
        timeoutMs: TOOL_TIMEOUT[name] ?? 20_000,
        async execute({ args = {}, cwd }) {
          try {
            return { content: await run(name, args, cwd) }
          } catch (err) {
            return { content: `[${name}] ${err.message}`, isError: true }
          }
        },
      }
    })

    async function run(name, args, cwd) {
      const current = await state.read()

      if (name === 'media_idea') {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        const title = typeof args.title === 'string' && args.title.trim()
          ? args.title.trim()
          : (text ? text.split(/[。！？\n]/)[0].slice(0, 40) : '')
        const ops = [{
          op: 'add_item',
          title,
          body: typeof args.body === 'string' ? args.body : text,
          kind: args.kind,
          url: args.url,
          source: args.source,
          tags: args.tags,
          platform: args.platform,
          media: args.media && typeof args.media === 'object' && typeof args.media.src === 'string'
            ? { ...args.media, src: checkAssetSrc(args.media.src, cwd, dataDir) }
            : args.media,
          status: args.status,
        }]
        const result = await runOps(ops, '记灵感')
        const id = result.receipts[0]?.target
        const line = id ? (await state.read()).items.find(row => row.id === id) : null
        return [renderReceipts(result), line ? `\n${itemLine(line)}` : '', '\n下一步：media_brief 取创作简报。'].join('')
      }

      if (name === 'media_list') {
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, LIST_LIMIT) : 20
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        const items = current.items
          .filter(row => (args.status ? row.status === args.status : true))
          .filter(row => (args.platform ? row.platform === args.platform : true))
          .filter(row => (query ? `${row.title} ${row.body} ${(row.tags ?? []).join(' ')}`.toLowerCase().includes(query) : true))
          .slice(0, limit)
        return renderList(items)
      }

      if (name === 'media_item') {
        const id = resolveId(current.items, args.id)
        const action = args.action ?? 'get'
        if (action === 'get') {
          const item = current.items.find(row => row.id === id)
          return renderItem(current, item)
        }
        if (action === 'delete') {
          const result = await runOps([{ op: 'delete_item', id }], '删除条目')
          return renderReceipts(result)
        }
        if (action === 'status') {
          const result = await runOps([{ op: 'set_status', id, status: args.status }], '改状态')
          return renderReceipts(result)
        }
        if (action === 'schedule') {
          const when = typeof args.scheduledAt === 'string' ? args.scheduledAt.trim() : ''
          const result = await runOps([{ op: 'schedule_item', id, scheduledAt: when || null, platform: args.platform }], '排期')
          return renderReceipts(result)
        }
        const op = { op: 'update_item', id }
        for (const key of ['title', 'body', 'tags', 'url', 'platform', 'status']) {
          if (args[key] !== undefined) op[key] = args[key]
        }
        const result = await runOps([op], '更新条目')
        return renderReceipts(result)
      }

      if (name === 'media_brief') {
        const id = resolveId(current.items, args.id)
        const item = current.items.find(row => row.id === id)
        return buildBrief(current, item, { format: args.format, imageCount: args.imageCount, shotCount: args.shotCount })
      }

      if (name === 'media_save') {
        const kind = args.kind
        if (kind === 'style') {
          const style = args.style && typeof args.style === 'object' ? args.style : null
          if (!style) {
            // 没有成品卡时，工具只给提炼规范：风格由模型自己读原文提炼。
            const material = typeof args.text === 'string' ? args.text.trim() : ''
            if (!material) throw new Error('存风格卡需要一个 style 对象；或者给 text（作者原文），我给你提炼规范')
            return buildStyleBrief(material, args.name)
          }
          const result = await runOps([{ op: 'add_style', name: args.name ?? style.name, ...style }], '存风格卡')
          // 刚存的那张就是用户想用的：顺手设成当前风格，否则简报里看不到它。
          const styleId = result.receipts[0]?.target
          if (styleId) await runOps([{ op: 'set_style', id: styleId }], '启用风格卡')
          return renderReceipts(result) + (styleId ? '\n- 已设为当前风格' : '')
        }
        if (kind === 'metric') {
          const result = await runOps([{
            op: 'add_metric', itemId: args.id ? resolveId(current.items, args.id) : undefined, platform: args.platform,
            views: args.views, likes: args.likes, comments: args.comments, shares: args.shares, saves: args.saves,
          }], '记数据')
          return renderReceipts(result)
        }
        if (kind === 'rule') {
          const result = await runOps([{ op: 'add_skill', name: args.name, rule: args.rule, status: 'active' }], '存规则')
          return renderReceipts(result)
        }
        const id = resolveId(current.items, args.id)
        if (kind === 'plan') {
          const result = await runOps([{ op: 'save_plan', id, plan: args.plan }], '定策划案')
          return renderReceipts(result)
        }
        if (kind === 'image') {
          const result = await runOps([{ op: 'attach_asset', id, target: args.target, src: checkAssetSrc(args.src, cwd, dataDir) }], '写画面')
          return renderReceipts(result)
        }
        if (kind === 'draft') {
          const result = await runOps([{ op: 'save_draft', id, text: args.text, format: args.format, by: 'ai' }], '存草稿')
          return renderReceipts(result)
        }
        const format = kind === 'article' ? 'article' : 'script'
        const result = await runOps([{ op: 'save_production', id, text: args.text, format }], '存成稿')
        return renderReceipts(result)
      }

      if (name === 'media_write') {
        return writeWithModel(resolveId(current.items, args.id), {
          format: args.format, imageCount: args.imageCount, shotCount: args.shotCount,
        })
      }

      if (name === 'media_export') {
        const id = resolveId(current.items, args.id)
        const item = current.items.find(row => row.id === id)
        if (item.production?.status !== 'done') throw new Error('这条还没有成稿：先用 media_save 写正文')
        // 对外边界由宿主 pathParams 守（绝对路径越界直接拒绝）；插件内部仍做相对路径
        // 解析，测试与本地宿主绕过宿主 wrapper 直调 execute 时行为不变。
        const requested = typeof args.dir === 'string' ? args.dir.trim() : ''
        const dir = requested
          ? (isAbsolute(requested) ? requested : join(cwd, requested))
          : join(cwd, 'media-desk-export', slugify(item.production.title || item.title))
        // TPI 2.0 的插件跑在隔离沙箱里，写不了工作区：交给宿主进程的 worker。
        // 宿主没给 shell（本地宿主、测试直调 execute）时，插件自己就在 Node 里，直接写。
        let result
        if (host.shell?.run) {
          // 文件名带 pid 与随机后缀：同一毫秒内两次并发导出不会撞名。
          const jobFile = join(dataDir, `export-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`)
          const resultFile = `${jobFile}.result.json`
          // 临时文件里装着整篇成稿：成功失败都要删，否则数据目录会一直长。
          try {
            await writeFile(jobFile, JSON.stringify({ production: item.production, item, dir }))
            let runError = null
            try {
              // 命令是宿主的 shell 字符串：三个路径都套引号，并把路径内部的双引号转义。
              const quoted = path => `"${String(path).replace(/"/g, '\\"')}"`
              await host.shell.run(`${quoted(process.execPath)} ${quoted(WORKER)} --job ${quoted(jobFile)}`, { timeoutMs: 60_000 })
            } catch (err) {
              // worker 非零退出时也会写 result.json（含它自己的错误原因），优先用那份。
              runError = err
            }
            const text = await readFile(resultFile, 'utf8').catch(() => '')
            if (!text) throw runError ?? new Error('导出进程没有写回结果')
            result = JSON.parse(text)
            if (!result.ok) throw new Error(result.error)
          } finally {
            await unlink(jobFile).catch(() => {})
            await unlink(resultFile).catch(() => {})
          }
        } else {
          result = await exportProduction(item.production, item, { dir })
        }
        const lines = [`导出到 ${result.path}`, `图片 ${result.copied.length} 张${result.missing.length ? `，缺 ${result.missing.length} 张：${result.missing.join('、')}` : ''}`]
        await state.mutate(draft => {
          const target = draft.items.find(row => row.id === id)
          if (target?.production) {
            target.production.savedPath = result.path
            target.production.savedAt = new Date().toISOString()
          }
        })
        return lines.join('\n')
      }

      throw new Error(`未知工具：${name}`)
    }

    const api = {
      tools,
      // 宿主把 turnStart 钩子注册成 preTurn 阶段的 RuntimeHook；promptContext.setBlock
      // 只在这个窗口能过 phase 门，工具调用期间推无效。
      lifecycle: { async turnStart() { await pushContext() } },
    }
    // TPI 1.0 没有 ui 扩展点：面板只在 2.0 宿主里挂得上。
    if (!host.ui) return api
    api.ui = {
        /** 面板发来的请求：{type:'state'} | {type:'ops', ops:[...]}。 */
        async onMessage(_view, message) {
          const type = message?.type
          if (type === 'state') return snapshot()
          if (type === 'write') {
            const text = await writeWithModel(message.id, { format: message.format })
            return { text, state: await snapshot() }
          }
          if (type === 'ops') {
            const result = await runOps(message.ops, '面板操作')
            return { receipts: result.receipts.map(row => row.text), errors: result.errors, state: await snapshot() }
          }
          if (type === 'export') {
            const current = await state.read()
            const item = current.items.find(row => row.id === message.id)
            if (!item) throw new Error(`找不到条目：${message.id}`)
            const dir = join(dataDir, 'exports', slugify(item.production?.title || item.title))
            const text = await run('media_export', { id: item.id, dir }, host.cwd)
            return { text, path: dir, state: await snapshot() }
          }
          return null
        },
        /** 命令面板里的刷新。 */
        async onCommand(id) {
          if (id !== 'refresh') return
          await host.ui?.post('desk', { type: 'changed', label: '刷新' }).catch(() => {})
        },
    }
    return api
  },
})
