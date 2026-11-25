// 工作台的唯一写入口：对话、界面操作都走这里，统一校验字段并产出回执。
// 模型输出也是不可信输入，所以这里只放行白名单字段。
import { monthDay, whenText } from '../lib/time.js'
import { platformName, tr } from './i18n.js'

export const STATUSES = ['idea', 'outline', 'draft', 'ready', 'published']
export const STATUS_LABEL = { idea: '灵感', outline: '大纲', draft: '草稿', ready: '待发布', published: '已发布' }
export const KINDS = ['image', 'video', 'web', 'quote', 'note']
export const PLATFORMS = ['公众号', '小红书', '抖音', 'B站', '视频号', 'TikTok', 'Instagram', 'YouTube', 'X']

/** 状态在当前语言下的名字。 */
export function statusLabel(status) {
  return tr(STATUS_LABEL[status] ?? String(status))
}

const ITEM_FIELDS = {
  title: 'text', body: 'text', kind: 'kind', url: 'url', source: 'text', tags: 'list', status: 'status', angleId: 'id',
  personaIds: 'list', parentId: 'id', rel: 'text', scheduledAt: 'date', platform: 'platform', pinned: 'bool', media: 'media', pos: 'pos', score: 'num',
}
const STYLE_FIELDS = { name: 'text', icon: 'text', summary: 'text', tone: 'text', sentences: 'text', opening: 'text', structure: 'text', logic: 'text', story: 'text', flow: 'text', words: 'list', avoid: 'list', samples: 'list', reference: 'text' }
const SKILL_FIELDS = { name: 'text', rule: 'text', source: 'text', status: 'text', confidence: 'num', evidence: 'text' }
const METRIC_FIELDS = { itemId: 'id', platform: 'platform', date: 'date', views: 'num', likes: 'num', comments: 'num', shares: 'num', saves: 'num' }

let counter = 0
export function newId(prefix = 'x') {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

/** 只收 http(s)：file:// / javascript: 之类不能混进媒体字段。 */
export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 插件自己的媒体引用（导出后由面板按相对路径取）。 */
const ASSET_REF = /^media-desk\/(assets|files)\/[\w.-]+$/
export function isAssetRef(value) {
  return typeof value === 'string' && ASSET_REF.test(value)
}

function coerce(type, value) {
  switch (type) {
    case 'text': return typeof value === 'string' ? value.slice(0, 40000) : undefined
    case 'id': return value === null || typeof value === 'string' ? value : undefined
    case 'kind': return KINDS.includes(value) ? value : undefined
    case 'status': return STATUSES.includes(value) ? value : undefined
    case 'platform': return value === null || PLATFORMS.includes(value) ? value : undefined
    case 'list': return Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 24) : undefined
    case 'bool': return typeof value === 'boolean' ? value : undefined
    case 'num': return Number.isFinite(value) ? value : undefined
    case 'url': return value === null || value === '' ? null : isHttpUrl(value) ? value : undefined
    case 'date': return value === null ? null : typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined
    case 'pos': return value && [value.x, value.y].every(Number.isFinite) ? { x: value.x, y: value.y, r: Number.isFinite(value.r) ? value.r : 0 } : undefined
    case 'media': {
      if (value === null) return null
      if (!value || typeof value.src !== 'string') return undefined
      // 媒体只允许插件自己的相对路径或 http(s) 地址
      if (!isAssetRef(value.src) && !isHttpUrl(value.src)) return undefined
      const poster = typeof value.poster === 'string' && (isAssetRef(value.poster) || isHttpUrl(value.poster)) ? value.poster : undefined
      return { src: value.src, ...(poster ? { poster } : {}), ...(Number.isFinite(value.w) ? { w: value.w } : {}), ...(Number.isFinite(value.h) ? { h: value.h } : {}) }
    }
    default: return undefined
  }
}

function pick(fields, input) {
  const out = {}
  for (const [key, type] of Object.entries(fields)) {
    if (input?.[key] === undefined) continue
    const value = coerce(type, input[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

function findById(list, id) {
  const entry = list.find(row => row.id === id)
  if (!entry) throw new Error(tr('找不到对象：{id}', { id }))
  return entry
}

function short(text, n = 22) {
  const s = String(text || '').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export function fmtWhen(iso) {
  return iso ? whenText(iso) : tr('未排期')
}

/** 改状态时一并维护发布时间：进入已发布记下时间，离开已发布清掉。 */
function applyStatus(item, status) {
  item.status = status
  if (status === 'published' && !item.publishedAt) item.publishedAt = new Date().toISOString()
  if (status !== 'published') delete item.publishedAt
}

/** 排上日历就是待发布（还没成稿的算大纲）；取消排期退回去。已发布的不动。 */
function applySchedule(item, when) {
  item.scheduledAt = when
  if (item.status === 'published') return
  const produced = item.production?.status === 'done'
  if (when) item.status = produced || ['draft', 'ready'].includes(item.status) ? 'ready' : 'outline'
  else if (item.status === 'ready') item.status = 'draft'
  else if (item.status === 'outline' && !produced) item.status = 'idea'
}

const handlers = {
  add_item(state, op, now) {
    const fields = pick(ITEM_FIELDS, op)
    const item = {
      id: newId('it'), kind: 'note', title: '', body: '', tags: [], status: 'idea', personaIds: [], createdAt: now, drafts: {}, ...fields,
    }
    if (!item.title && !item.body && !item.media) throw new Error(tr('灵感内容为空'))
    // 只贴了图或视频也要有个名字，卡片和回执才有东西可显示
    if (!item.title) item.title = short(item.body, 28) || (item.media ? tr(item.kind === 'video' ? '{date}的视频' : '{date}的图片', { date: monthDay(now) }) : '')
    // 新灵感落在首屏文字旁边，一眼就能看到，也不会打乱已有布局
    if (!item.pos && !item.parentId) {
      const n = state.items.filter(row => !row.parentId && row.pos).length
      const scale = 1 + (n % 6) * 0.2
      item.pos = { x: Math.round(Math.cos(n * 2.39996) * 580 * scale), y: Math.round(Math.sin(n * 2.39996) * 340 * scale), r: ((n % 5) - 2) * 1.2 }
    }
    if (item.scheduledAt) applySchedule(item, item.scheduledAt)
    if (item.status === 'published') applyStatus(item, 'published')
    state.items.unshift(item)
    return { text: tr('记下灵感《{title}》', { title: short(item.title) }), target: item.id, kind: 'item' }
  },
  update_item(state, op) {
    const item = findById(state.items, op.id)
    const { status, scheduledAt, ...fields } = pick(ITEM_FIELDS, op)
    Object.assign(item, fields)
    if (scheduledAt !== undefined) applySchedule(item, scheduledAt)
    if (status !== undefined) applyStatus(item, status)
    const names = [...Object.keys(fields), ...(status !== undefined ? ['status'] : []), ...(scheduledAt !== undefined ? ['scheduledAt'] : [])].filter(key => key !== 'pos')
    return names.length ? { text: tr('更新《{title}》', { title: short(item.title) }), target: item.id, kind: 'item' } : null
  },
  delete_item(state, op) {
    const item = findById(state.items, op.id)
    state.items = state.items.filter(row => row.id !== op.id)
    for (const child of state.items) if (child.parentId === op.id) child.parentId = item.parentId ?? null
    state.metrics = state.metrics.filter(row => row.itemId !== op.id)
    return { text: tr('删除《{title}》', { title: short(item.title) }) }
  },
  schedule_item(state, op) {
    const item = findById(state.items, op.id)
    const when = coerce('date', op.scheduledAt)
    if (when === undefined) throw new Error(tr('排期时间无效'))
    const platform = coerce('platform', op.platform)
    if (platform !== undefined) item.platform = platform
    applySchedule(item, when)
    return { text: when ? tr('把《{title}》排到 {when}', { title: short(item.title), when: fmtWhen(when) }) + (item.platform ? ` · ${platformName(item.platform)}` : '') : tr('取消《{title}》的排期', { title: short(item.title) }), target: item.id, kind: 'item' }
  },
  set_status(state, op) {
    const item = findById(state.items, op.id)
    const status = coerce('status', op.status)
    if (!status) throw new Error(tr('状态无效'))
    applyStatus(item, status)
    return { text: tr('《{title}》状态改为「{status}」', { title: short(item.title), status: statusLabel(status) }), target: item.id, kind: 'item' }
  },
  save_draft(state, op, now) {
    const item = findById(state.items, op.id)
    const format = op.format === 'script' ? 'script' : 'article'
    if (typeof op.text !== 'string') throw new Error(tr('草稿内容无效'))
    const previous = item.drafts?.[format]
    item.drafts = { ...item.drafts, [format]: { text: op.text.slice(0, 200000), by: op.by === 'ai' ? 'ai' : 'user', engine: typeof op.engine === 'string' ? op.engine : undefined, at: now, aiText: op.by === 'ai' ? op.text : previous?.aiText } }
    if (['idea', 'outline'].includes(item.status)) item.status = 'draft'
    return { text: tr(format === 'script' ? '保存《{title}》的脚本' : '保存《{title}》的文章', { title: short(item.title) }), target: item.id, kind: 'item' }
  },
  add_style(state, op, now) {
    const style = { id: newId('st'), source: tr('手动'), createdAt: now, words: [], avoid: [], samples: [], ...pick(STYLE_FIELDS, op) }
    if (!style.name) throw new Error(tr('风格需要名字'))
    state.styles = [style, ...(state.styles ?? [])]
    return { text: tr('添加风格「{name}」', { name: style.name }), target: style.id, kind: 'style' }
  },
  set_style(state, op) {
    if (op.id === null) {
      state.activeStyleId = null
      return { text: tr('不再使用特定风格') }
    }
    const style = findById(state.styles ?? [], op.id)
    state.activeStyleId = style.id
    return { text: tr('之后按「{name}」的风格写', { name: style.name }) }
  },
  add_skill(state, op, now) {
    const skill = { id: newId('s'), name: '', rule: '', source: tr('对话'), status: 'proposed', confidence: 0.5, createdAt: now, ...pick(SKILL_FIELDS, op) }
    if (!skill.name || !skill.rule) throw new Error(tr('Skill 需要名字和规则'))
    state.skills.unshift(skill)
    return { text: tr('沉淀规则「{name}」', { name: skill.name }), target: skill.id, kind: 'skill' }
  },
  add_metric(state, op) {
    const metric = { id: newId('m'), date: new Date().toISOString(), views: 0, likes: 0, comments: 0, shares: 0, saves: 0, ...pick(METRIC_FIELDS, op) }
    if (!metric.platform) throw new Error(tr('数据需要平台'))
    state.metrics.push(metric)
    return { text: tr('记录 {platform} 数据 {views} 阅读', { platform: platformName(metric.platform), views: metric.views }) }
  },
  // 天枢版回写通道：上游由插件内部调模型直接生成，天枢里内容由 agent 产出，
  // 经这里落库。模型输出与 agent 输出同样不可信，所以照样走白名单归一化。
  save_plan(state, op, now) {
    const item = findById(state.items, op.id)
    const plan = op.plan && typeof op.plan === 'object' ? op.plan : {}
    const text = (value, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
    const list = (value, max, limit) => (Array.isArray(value) ? value.map(row => text(row, max)).filter(Boolean).slice(0, limit) : [])
    const previous = item.production ?? { status: 'planned' }
    // 先丢掉没有 prompt 的项再截断：上游是先截后滤，模型多给一张空项就会白占名额。
    const images = (Array.isArray(plan.images) ? plan.images : [])
      .map((row, index) => ({ caption: text(row?.caption, 60), anchor: text(row?.anchor, 60), prompt: text(row?.prompt, 1200), index }))
      .filter(row => row.prompt)
      .slice(0, 4)
      .map(row => ({ caption: row.caption, anchor: row.anchor, prompt: row.prompt, src: previous.images?.[row.index]?.src }))
    const shots = (Array.isArray(plan.shots) ? plan.shots : []).slice(0, 12)
      .map((row, index) => ({
        no: index + 1,
        shot: text(row?.shot, 12) || tr('中景'),
        visual: text(row?.visual, 200),
        voice: text(row?.voice, 200),
        seconds: Number.isFinite(row?.seconds) ? Math.max(1, Math.min(60, Math.round(row.seconds))) : 5,
        prompt: text(row?.prompt, 1200),
        src: previous.shots?.[index]?.src,
      }))
      .filter(row => row.prompt || row.visual)
    const outline = list(plan.outline, 40, 6)
    const facts = list(plan.facts, 120, 8)
    item.production = {
      ...previous,
      title: text(plan.title, 60) || previous.title || item.title,
      coverText: text(plan.coverText, 24) || previous.coverText || item.title.slice(0, 12),
      facts: facts.length ? facts : (previous.facts ?? []),
      outline: outline.length ? outline : (previous.outline ?? []),
      cover: { prompt: text(plan.cover, 1200) || previous.cover?.prompt || '', src: previous.cover?.src },
      characters: text(plan.characters, 400),
      images,
      shots,
      updatedAt: now,
    }
    if (item.status === 'idea') item.status = 'outline'
    return {
      text: tr('定下《{title}》的策划案：{n} 个小节、{i} 张配图、{s} 个分镜', {
        title: short(item.production.title), n: item.production.outline.length, i: images.length, s: shots.length,
      }),
      target: item.id,
      kind: 'item',
    }
  },
  save_production(state, op, now) {
    const item = findById(state.items, op.id)
    if (typeof op.text !== 'string' || !op.text.trim()) throw new Error(tr('正文内容无效'))
    const format = op.format === 'article' ? 'article' : 'script'
    const previous = item.production ?? { status: 'planned' }
    const markdown = op.text.trim()
    const heading = /^\s*#\s+(.+)\n?/.exec(markdown)
    item.production = {
      ...previous,
      status: 'done',
      format,
      title: heading ? heading[1].trim().slice(0, 60) : previous.title || item.title,
      article: (heading ? markdown.slice(heading[0].length) : markdown).trim().slice(0, 200000),
      updatedAt: now,
    }
    if (['idea', 'outline', 'draft'].includes(item.status)) item.status = item.scheduledAt ? 'ready' : 'draft'
    return {
      text: tr('写好《{title}》的成稿（{format}）：{n} 字', {
        title: short(item.production.title),
        format: format === 'article' ? tr('文章') : tr('口播脚本'),
        n: item.production.article.length,
      }),
      target: item.id,
      kind: 'item',
    }
  },
  attach_asset(state, op) {
    const item = findById(state.items, op.id)
    const production = item.production
    if (!production) throw new Error(tr('这条灵感还没有策划案'))
    const src = typeof op.src === 'string' ? op.src.trim().slice(0, 500) : ''
    if (!src) throw new Error(tr('图片路径为空'))
    const target = String(op.target ?? 'cover')
    if (target === 'cover') {
      production.cover = { ...(production.cover ?? {}), src }
      return { text: tr('封面图已写入《{title}》', { title: short(production.title) }), target: item.id, kind: 'item' }
    }
    const match = /^(image|shot):(\d{1,2})$/.exec(target)
    if (!match) throw new Error(tr('槽位无效：{target}', { target }))
    const slots = match[1] === 'image' ? production.images : production.shots
    const row = slots?.[Number(match[2]) - 1]
    if (!row) throw new Error(tr('没有第 {n} 个槽位', { n: match[2] }))
    row.src = src
    return { text: tr('{target} 已写入《{title}》', { target, title: short(production.title) }), target: item.id, kind: 'item' }
  },
}

/**
 * 依次执行一批操作。任何一条失败都不影响已成功的操作，失败写进回执。
 * @param {object} state - 会被就地修改的状态。
 * @param {Array<object>} ops - 操作列表。
 * @returns {{receipts: Array<object>, errors: string[]}} 面向用户的回执。
 */
export function applyOps(state, ops) {
  const receipts = []
  const errors = []
  const now = new Date().toISOString()
  for (const op of Array.isArray(ops) ? ops : []) {
    const handler = Object.hasOwn(handlers, op?.op) ? handlers[op.op] : undefined
    if (!handler) {
      errors.push(tr('不支持的操作：{op}', { op: String(op?.op) }))
      continue
    }
    try {
      const receipt = handler(state, op, now)
      if (receipt) receipts.push(receipt)
    } catch (err) {
      errors.push(err.message)
    }
  }
  return { receipts, errors }
}
