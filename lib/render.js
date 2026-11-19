// 工具回执的渲染：给 agent 读的紧凑文本，不是给人看的富文本。
import { STATUS_LABEL } from '../src/ops.js'

const STATUS_ORDER = ['idea', 'outline', 'draft', 'ready', 'published']

function whenText(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = v => String(v).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一条灵感压成一行：id、状态、标题、平台与排期。 */
export function itemLine(item) {
  const bits = [`${item.id}`, STATUS_LABEL[item.status] ?? item.status, item.title || '(无标题)']
  if (item.platform) bits.push(item.platform)
  if (item.scheduledAt) bits.push(whenText(item.scheduledAt))
  if (item.production?.status === 'done') bits.push(`已成稿 ${item.production.article?.length ?? 0} 字`)
  if (item.sample) bits.push('示例')
  return bits.join(' · ')
}

export function countByStatus(items) {
  const counts = new Map()
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  return STATUS_ORDER.filter(s => counts.has(s)).map(s => `${STATUS_LABEL[s]} ${counts.get(s)}`).join(' / ')
}

/** 列表回执：抬头一行统计，后面每行一条。 */
export function renderList(items, { title = '灵感墙' } = {}) {
  if (!items.length) return `${title}：没有匹配的条目。`
  const head = `${title}：${items.length} 条（${countByStatus(items)}）`
  return [head, ...items.map(item => `- ${itemLine(item)}`)].join('\n')
}

/** 单条详情：字段、草稿、成稿与画面槽位。 */
export function renderItem(state, item) {
  const lines = [
    `# ${item.title || '(无标题)'}`,
    `id：${item.id}`,
    `状态：${STATUS_LABEL[item.status] ?? item.status}`,
  ]
  if (item.kind) lines.push(`类型：${item.kind}`)
  if (item.body) lines.push(`补充：${item.body}`)
  if (item.tags?.length) lines.push(`标签：${item.tags.join('、')}`)
  if (item.url) lines.push(`链接：${item.url}`)
  if (item.source) lines.push(`来源：${item.source}`)
  if (item.platform) lines.push(`平台：${item.platform}`)
  if (item.scheduledAt) lines.push(`排期：${whenText(item.scheduledAt)}`)
  if (item.publishedAt) lines.push(`发布：${whenText(item.publishedAt)}`)

  for (const [format, label] of [['article', '文章'], ['script', '口播']]) {
    const draft = item.drafts?.[format]
    if (draft?.text) lines.push(`${label}草稿：${draft.text.length} 字，${draft.by === 'ai' ? '模型写的' : '手写的'}，${whenText(draft.at)}`)
  }

  const production = item.production
  if (production && production.status === 'done') {
    lines.push('', `## 成稿《${production.title}》`)
    lines.push(`封面大字：${production.coverText}`)
    lines.push(`正文：${production.article?.length ?? 0} 字`)
    if (production.outline?.length) lines.push(`小标题：${production.outline.join(' / ')}`)
    if (production.facts?.length) lines.push(`事实：${production.facts.join('；')}`)
    const slots = []
    if (production.cover) slots.push(`cover ${production.cover.src ? `[图] ${production.cover.src}` : '[待出图]'} ${production.cover.prompt?.slice(0, 60) ?? ''}`)
    for (const [index, image] of (production.images ?? []).entries()) {
      slots.push(`image:${index + 1} ${image.src ? `[图] ${image.src}` : '[待出图]'} ${image.caption || image.prompt?.slice(0, 50) || ''}`)
    }
    for (const [index, shot] of (production.shots ?? []).entries()) {
      slots.push(`shot:${index + 1} ${shot.src ? `[图] ${shot.src}` : '[待出图]'} ${shot.shot} ${shot.visual ?? ''}`)
    }
    if (slots.length) lines.push('', '画面槽位：', ...slots.map(row => `- ${row}`))
    if (production.savedPath) lines.push('', `已导出：${production.savedPath}`)
  } else if (production) {
    lines.push(`成稿：进行中（${production.status}）`)
  }

  const angle = item.angleId ? state.angles.find(row => row.id === item.angleId) : null
  if (angle) lines.push('', `创作角度「${angle.name}」${angle.hook ? `：${angle.hook}` : ''}`)
  return lines.join('\n')
}

/** 写操作回执：一句人话 + 失败原因。 */
export function renderReceipts({ receipts, errors }, fallback = '没有改动') {
  const lines = receipts.length ? receipts.map(row => `- ${row.text}`) : [`- ${fallback}`]
  if (errors.length) lines.push('', '未完成：', ...errors.map(row => `- ${row}`))
  return lines.join('\n')
}
