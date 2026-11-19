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
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTianshuPlugin } from './tpi.js'
import { parametersToJsonSchema } from './lib/schema.js'
import { State } from './lib/state.js'
import { buildBrief, buildStyleBrief } from './lib/brief.js'
import { buildContextBlock } from './lib/context.js'
import { ARTICLE_SYSTEM, PLAN_SYSTEM, extractJson, textOf } from './lib/llm.js'
import { itemLine, renderItem, renderList, renderReceipts } from './lib/render.js'
import { KINDS, PLATFORMS, STATUSES, applyOps } from './src/ops.js'
import { slugify } from './src/export.js'

const WORKER = fileURLToPath(new URL('./lib/export-worker.mjs', import.meta.url))
const LIST_LIMIT = 50

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
    media: { type: 'json', description: '图片/视频：{src:"本地绝对路径或 http(s)", poster?:"封面帧"}' },
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
      if (block) void host.promptContext?.setBlock(block)
    }

    /** 面板与工具发来的写操作：只走 applyOps。整批全军覆没时抛错，让调用方看见失败。 */
    async function runOps(ops, label) {
      const result = await state.mutate(draft => applyOps(draft, Array.isArray(ops) ? ops : []))
      void host.ui?.post('desk', { type: 'changed', label }).catch(() => {})
      if (result.errors.length && !result.receipts.length) throw new Error(result.errors.join('；'))
      await pushContext()
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
      const { name, description, parameters } = spec()
      return {
        name,
        description,
        inputSchema: parametersToJsonSchema(parameters),
        timeoutMs: name === 'media_export' ? 60_000 : 20_000,
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
          media: args.media,
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
          const result = await runOps([{ op: 'attach_asset', id, target: args.target, src: args.src }], '写画面')
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
        const dir = typeof args.dir === 'string' && args.dir.trim()
          ? join(cwd, args.dir.trim())
          : join(cwd, 'media-desk-export', slugify(item.production.title || item.title))
        const jobFile = join(dataDir, `export-${Date.now()}.json`)
        const resultFile = `${jobFile}.result.json`
        await writeFile(jobFile, JSON.stringify({ production: item.production, item, dir }))
        await host.shell.run(`"${process.execPath}" "${WORKER}" --job "${jobFile}"`, { timeoutMs: 60_000 })
        const result = JSON.parse(await readFile(resultFile, 'utf8'))
        if (!result.ok) throw new Error(result.error)
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

    // 激活时先推一次，避免模型在第一次对话里不知道工作台有什么。
    void pushContext()

    return {
      tools,
      ui: {
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
          return null
        },
        /** 命令面板里的刷新。 */
        async onCommand(id) {
          if (id !== 'refresh') return
          await host.ui?.post('desk', { type: 'changed', label: '刷新' }).catch(() => {})
        },
      },
    }
  },
})
