// 写进每轮对话的上下文块。天枢的 promptContext 要求块标签以插件 id 开头。
// 只放模型不看就会问的东西：有几条待写、哪条快到期、当前风格是什么。
const MAX_TODO = 6

function whenText(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = v => String(v).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * @param {object} state - 工作台状态。
 * @param {Date} [now]
 * @returns {string} 以 <media-desk> 开头的块；没有内容时返回空串（不推空块）。
 */
export function buildContextBlock(state, now = new Date()) {
  const items = state.items ?? []
  if (!items.length) return ''

  const todo = items.filter(row => ['idea', 'outline'].includes(row.status))
  const drafting = items.filter(row => row.status === 'draft')
  const ready = items.filter(row => row.status === 'ready')
  const overdue = ready.filter(row => row.scheduledAt && new Date(row.scheduledAt) < now)
  const lines = []

  if (todo.length) {
    const names = todo.slice(0, MAX_TODO).map(row => `「${row.title}」(${row.id})`).join('、')
    lines.push(`待写 ${todo.length} 条：${names}${todo.length > MAX_TODO ? '…' : ''}`)
  }
  if (drafting.length) lines.push(`写了一半 ${drafting.length} 条：${drafting.slice(0, MAX_TODO).map(row => `「${row.title}」(${row.id})`).join('、')}`)
  if (ready.length) {
    const rows = ready.slice(0, MAX_TODO).map(row => `${row.scheduledAt ? whenText(row.scheduledAt) : '未排期'}「${row.title}」(${row.id})`)
    lines.push(`待发布 ${ready.length} 条：${rows.join('、')}`)
  }
  if (overdue.length) lines.push(`已过排期 ${overdue.length} 条：${overdue.map(row => `「${row.title}」`).join('、')}`)

  const style = (state.styles ?? []).find(row => row.id === state.activeStyleId)
  if (style) lines.push(`当前风格卡：${style.name}${style.summary ? `（${style.summary}）` : ''}`)
  const published = items.filter(row => row.status === 'published').length
  if (published) lines.push(`已发布 ${published} 条`)

  if (!lines.length) return ''
  const block = [
    '<media-desk>',
    '自媒体工作台的状态（要动这些条目时用 media_* 工具，id 可直接用括号里的）：',
    ...lines.map(row => `- ${row}`),
    '</media-desk>',
  ].join('\n')
  return block
}

