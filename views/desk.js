/**
 * views/desk.js — 工作台面板。
 *
 * 协议（照 TPI 2.0 示例）：
 *   宿主 → 视图：{tpi:'host', type:'hello'|'status'|'changed'}
 *   视图 → 宿主：{tpi:'view', type:'ask', requestId, payload} → 宿主回 {tpi:'host', type:'answer', requestId, value|error}
 *
 * 面板只管台账：看、改状态、排期、删除。写作与出图在对话里完成——插件没有模型，
 * 面板上的「去对话里写」只说清该说什么，不伪装成本地生成。
 */
const $ = (id) => document.getElementById(id)
const STATUS_TEXT = { idea: '灵感', outline: '大纲', draft: '草稿', ready: '待发布', published: '已发布' }
const FILTERS = [['', '全部'], ['idea', '灵感'], ['outline', '大纲'], ['draft', '草稿'], ['ready', '待发布'], ['published', '已发布']]

let state = { items: [], styles: [], activeStyleId: null }
let filter = ''
let openId = null

const resize = () => parent.postMessage({ tpi: 'view', type: 'resize', height: document.documentElement.scrollHeight }, '*')

// 两种宿主：天枢把它放在 iframe 里（走 postMessage），本地服务把它当普通页面（走 POST /rpc）。
const inIframe = window.parent !== window

const askHost = (payload, timeoutMs) => new Promise((resolve, reject) => {
  const requestId = Math.random().toString(36).slice(2)
  const timer = setTimeout(() => { window.removeEventListener('message', onMessage); reject(new Error('timeout')) }, timeoutMs)
  const onMessage = (event) => {
    const data = event.data
    if (!data || data.tpi !== 'host' || data.type !== 'answer' || data.requestId !== requestId) return
    clearTimeout(timer)
    window.removeEventListener('message', onMessage)
    if (data.error) reject(new Error(data.error))
    else resolve(data.value)
  }
  window.addEventListener('message', onMessage)
  parent.postMessage({ tpi: 'view', type: 'ask', requestId, payload }, '*')
})

const askHttp = async (payload) => {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data.value
}

const ask = (payload, timeoutMs = 5000) => (inIframe ? askHost(payload, timeoutMs) : askHttp(payload))

function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.hidden = !text
  if (text) setTimeout(() => { el.hidden = true }, 2600)
}

function whenText(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function renderFilters() {
  $('filters').replaceChildren(...FILTERS.map(([value, label]) => {
    const count = value ? state.items.filter(row => row.status === value).length : state.items.length
    const button = document.createElement('button')
    button.type = 'button'
    button.className = value === filter ? 'chip on' : 'chip'
    button.textContent = `${label} ${count}`
    button.addEventListener('click', () => { filter = value; render() })
    return button
  }))
}

function renderCard(item) {
  const li = document.createElement('li')
  li.className = `card s-${item.status}`
  li.tabIndex = 0

  const head = document.createElement('div')
  head.className = 'card-head'
  const status = document.createElement('span')
  status.className = 'badge'
  status.textContent = STATUS_TEXT[item.status] ?? item.status
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = item.title || '(无标题)'
  head.append(status, title)

  const meta = document.createElement('p')
  meta.className = 'meta'
  const bits = []
  if (item.platform) bits.push(item.platform)
  if (item.scheduledAt) bits.push(whenText(item.scheduledAt))
  if (item.production?.status === 'done') bits.push(`成稿 ${item.production.words} 字`)
  if (item.production?.status === 'planned') bits.push('已策划')
  if (item.tags?.length) bits.push(item.tags.map(tag => `#${tag}`).join(' '))
  meta.textContent = bits.join(' · ')

  li.append(head, meta)
  const open = () => showDetail(item.id)
  li.addEventListener('click', open)
  li.addEventListener('keydown', (event) => { if (event.key === 'Enter') open() })
  return li
}

function render() {
  const rows = state.items.filter(item => !filter || item.status === filter)
  $('stat').textContent = rows.length ? `${rows.length} 条 · 风格卡 ${state.styles.length} 张` : `风格卡 ${state.styles.length} 张`
  $('stat').dataset.state = 'ok'
  renderFilters()
  $('cards').replaceChildren(...rows.map(renderCard))
  $('empty').hidden = state.items.length > 0
  resize()
}

function showDetail(id) {
  const item = state.items.find(row => row.id === id)
  if (!item) return
  openId = id
  $('detail').hidden = false
  $('d-title').textContent = item.title || '(无标题)'
  const bits = [STATUS_TEXT[item.status] ?? item.status]
  if (item.platform) bits.push(item.platform)
  if (item.scheduledAt) bits.push(`排期 ${whenText(item.scheduledAt)}`)
  if (item.production?.status === 'done') bits.push(`成稿《${item.production.title}》${item.production.words} 字`)
  $('d-meta').textContent = bits.join(' · ')
  $('d-body').textContent = item.body || ''
  $('d-status').value = item.status
  $('d-when').value = item.scheduledAt ? new Date(item.scheduledAt).toISOString().slice(0, 16) : ''
  // 天枢里能去对话，本地服务没有对话入口——别让提示指向不存在的东西。
  const hint = inIframe
    ? (item.production?.status === 'done'
      ? '正文与画面在对话里改：说「把《' + item.title + '》改短一点」或「给第 2 张配图换个角度」。'
      : '点「让模型成稿」用天枢已配置的模型写；也可以去对话里说「用 media_brief 取简报，按简报写《' + item.title + '》」。')
    : (item.production?.status === 'done'
      ? '这条已成稿。界面里能改状态和排期；要改正文就重跑一次成稿，或用命令行 media_save 覆盖。'
      : '点「让模型成稿」由模型来写。没配模型时它会告诉你缺哪三个环境变量，也可以自己写好正文再用命令行 media_save 存进来。')
  $('d-hint').textContent = hint
  $('d-hint').hidden = false
  resize()
}

async function applyOps(ops) {
  try {
    const result = await ask({ type: 'ops', ops })
    state = result.state
    render()
    if (openId) showDetail(openId)
    if (result.errors.length) toast(result.errors.join('；'))
    else if (result.receipts.length) toast(result.receipts.join('；'))
  } catch (err) {
    toast(`没改成：${err.message}`)
  }
}

// 记灵感：界面自己就能开工，不用等对话。
$('new').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = $('new-text')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  await applyOps([{
    op: 'add_item',
    title: text.split(/[。！？\n]/)[0].slice(0, 40),
    body: text,
  }])
})

$('close').addEventListener('click', () => { $('detail').hidden = true; openId = null; resize() })

$('d-save').addEventListener('click', () => {
  if (!openId) return
  const ops = []
  const item = state.items.find(row => row.id === openId)
  const status = $('d-status').value
  if (item && status !== item.status) ops.push({ op: 'set_status', id: openId, status })
  const raw = $('d-when').value
  const when = raw ? new Date(raw).toISOString() : null
  const currentWhen = item?.scheduledAt ? new Date(item.scheduledAt).toISOString() : null
  if (when !== currentWhen) ops.push({ op: 'schedule_item', id: openId, scheduledAt: when })
  if (!ops.length) { toast('没有改动'); return }
  applyOps(ops)
})

// 面板这边没有模型，写稿交给插件进程里的旁路模型：点一下等它写完。
$('d-write').addEventListener('click', async () => {
  if (!openId) return
  const button = $('d-write')
  const label = button.textContent
  button.disabled = true
  button.textContent = '模型在写…'
  try {
    const result = await ask({ type: 'write', id: openId }, 300000)
    state = result.state
    render()
    showDetail(openId)
    toast(result.text.split('\n').filter(Boolean).slice(0, 2).join('；'))
  } catch (err) {
    toast(`没写成：${err.message}`)
  } finally {
    button.disabled = false
    button.textContent = label
  }
})

$('d-del').addEventListener('click', () => {
  if (!openId) return
  const item = state.items.find(row => row.id === openId)
  if (!confirm(`删除《${item?.title ?? ''}》？这一步不能撤销。`)) return
  applyOps([{ op: 'delete_item', id: openId }]).then(() => { $('detail').hidden = true; openId = null })
})

// 本地服务没有推送通道：自己拉一次，然后低频轮询（写完稿能自动刷新）。
if (!inIframe) {
  const refresh = async () => {
    try {
      state = await ask({ type: 'state' })
      render()
    } catch (err) {
      $('stat').textContent = `加载失败：${err.message}`
      $('stat').dataset.state = 'bad'
    }
  }
  refresh()
  setInterval(refresh, 3000)
}

window.addEventListener('message', async (event) => {
  const data = event.data
  if (!data || data.tpi !== 'host') return
  if (data.type === 'hello') {
    try {
      state = await ask({ type: 'state' })
      render()
    } catch (err) {
      $('stat').textContent = `加载失败：${err.message}`
      $('stat').dataset.state = 'bad'
    }
    return
  }
  if (data.type === 'changed') {
    try {
      state = await ask({ type: 'state' })
      render()
    } catch { /* 视图还活着，忽略这一次刷新失败 */ }
  }
})

resize()
