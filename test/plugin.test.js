// 端到端：用假 host 注入 TPI SDK，走完整条链路（记灵感 → 简报 → 回写 → 导出）。
// 真实宿主加载行为无法在会话内验证（要重启天枢），这里覆盖的是插件自身的契约。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { readdir } from 'node:fs/promises'

let root
let dataDir
let workDir
let api
let plugin
const posted = []
const blocks = []
const llmCalls = []
let llmQueue = []

// 宿主怎么解析 shell.run 的命令串是宿主的职责，测试只验证插件产出的命令能不能被切成 argv 执行；
// 这样不依赖本机是否装了 bash / cmd 的引号规则。
const shellRun = (command, options) => new Promise((resolve, reject) => {
  const argv = command.match(/"[^"]*"|\S+/g).map(token => token.replace(/^"|"$/g, ''))
  const [bin, ...rest] = argv
  execFile(bin, rest, { timeout: options?.timeoutMs ?? 30_000 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr }))
    else resolve({ stdout, stderr })
  })
})

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-desk-'))
  dataDir = join(root, 'data')
  workDir = join(root, 'work')
  await mkdir(workDir, { recursive: true })
  globalThis.__tianshuTPI = { defineTianshuPlugin: spec => spec }
  plugin = (await import('../index.js')).default
  api = plugin.activate({
    storage: { dataDir: () => dataDir },
    workspace: { read: async () => '', write: async () => {} },
    shell: { run: shellRun },
    ui: { post: async (view, message) => { posted.push(message) }, setStatus: async () => {} },
    sidePathLLM: {
      available: () => llmQueue.length >= 0,
      complete: async (messages, options) => {
        llmCalls.push({ messages, options })
        const next = llmQueue.shift()
        if (!next) throw new Error('no fake response queued')
        return next
      },
    },
    promptContext: { setBlock: (text) => { blocks.push(text) } },
  })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const tool = name => api.tools.find(row => row.name === name)

async function call(name, args, cwd = workDir) {
  const result = await tool(name).execute({ args, cwd })
  return result
}

test('插件暴露 7 个工具且都带 inputSchema', () => {
  assert.equal(api.tools.length, 7)
  for (const row of api.tools) {
    assert.equal(row.inputSchema.type, 'object')
    assert.ok(row.description.length > 6)
  }
})

test('记灵感 → 列表 → 详情', async () => {
  const created = await call('media_idea', { text: '把旧手机改成行车记录仪。第一个月就省了 300 块', tags: ['省钱'] })
  assert.notEqual(created.isError, true, created.content)
  assert.match(created.content, /记下灵感/)
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  assert.ok(id, created.content)
  assert.match(created.content, /media_brief/)

  const list = await call('media_list', {})
  assert.match(list.content, new RegExp(id))
  assert.match(list.content, /灵感 1/)

  const detail = await call('media_item', { id })
  assert.match(detail.content, /把旧手机改成行车记录仪/)
  assert.match(detail.content, /状态：灵感/)
})

test('简报带体裁规范、策划案字段与回写指引', async () => {
  const list = await call('media_list', {})
  const id = /it_[a-z0-9]+/.exec(list.content)?.[0]
  const brief = await call('media_brief', { id, format: 'script', imageCount: 2, shotCount: 6 })
  assert.notEqual(brief.isError, true, brief.content)
  assert.match(brief.content, /口播脚本/)
  assert.match(brief.content, /"coverText"/)
  assert.match(brief.content, /images` 正好 2 个/)
  assert.match(brief.content, /shots` 正好 6 个/)
  assert.match(brief.content, /media_save/)
})

test('回写策划案与正文，状态推进到草稿', async () => {
  const list = await call('media_list', {})
  const id = /it_[a-z0-9]+/.exec(list.content)?.[0]
  const plan = await call('media_save', {
    id,
    kind: 'plan',
    plan: {
      title: '旧手机改行车记录仪，一个月省 300',
      coverText: '旧手机别扔',
      facts: ['旧手机 1 台', '每月省 300 元'],
      outline: ['为什么换', '怎么装', '用了多久'],
      cover: 'a phone mounted on a windshield, daylight',
      characters: 'a compact black phone on a suction mount',
      images: [{ anchor: '怎么装', caption: '吸盘支架', prompt: 'phone suction mount close up' }],
      shots: [{ shot: '特写', visual: '旧手机屏幕亮起', voice: '这台手机在抽屉里躺了两年', seconds: 4, prompt: 'old phone screen turning on' }],
    },
  })
  assert.notEqual(plan.isError, true, plan.content)
  assert.match(plan.content, /策划案：3 个小节、1 张配图、1 个分镜/)

  const body = await call('media_save', {
    id,
    kind: 'script',
    text: '# 旧手机改行车记录仪，一个月省 300\n\n## 为什么换\n抽屉里那台手机还在。\n\n## 怎么装\n吸盘一贴就好。\n\n## 用了多久\n一个月，没出过问题。\n',
  })
  assert.notEqual(body.isError, true, body.content)
  assert.match(body.content, /口播脚本/)

  const detail = await call('media_item', { id })
  assert.match(detail.content, /状态：草稿/)
  assert.match(detail.content, /成稿《旧手机改行车记录仪/)
  assert.match(detail.content, /image:1 \[待出图\]/)
  assert.match(detail.content, /shot:1 \[待出图\]/)
})

test('画面槽位写入，越界槽位报错而不是静默丢弃', async () => {
  const list = await call('media_list', {})
  const id = /it_[a-z0-9]+/.exec(list.content)?.[0]
  const ok = await call('media_save', { id, kind: 'image', target: 'cover', src: join(workDir, 'cover.png') })
  assert.notEqual(ok.isError, true, ok.content)

  const bad = await call('media_save', { id, kind: 'image', target: 'image:9', src: join(workDir, 'x.png') })
  assert.equal(bad.isError, true)
  assert.match(bad.content, /没有第 9 个槽位/)
})

test('面板快照与面板写操作走同一条 applyOps 通路', async () => {
  const snapshot = await api.ui.onMessage('desk', { type: 'state' })
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.items[0].production.status, 'done')
  const id = snapshot.items[0].id

  const scheduled = await api.ui.onMessage('desk', { type: 'ops', ops: [{ op: 'schedule_item', id, scheduledAt: '2026-03-01T12:00:00.000Z', platform: '小红书' }] })
  assert.deepEqual(scheduled.errors, [])
  assert.equal(scheduled.state.items[0].status, 'ready')
  assert.equal(scheduled.state.items[0].platform, '小红书')
  assert.ok(posted.some(row => row.type === 'changed'))
})

test('白名单挡住脏字段：状态机不接受未知状态', async () => {
  const list = await call('media_list', {})
  const id = /it_[a-z0-9]+/.exec(list.content)?.[0]
  const bad = await call('media_item', { id, action: 'status', status: 'whatever' })
  assert.match(bad.content, /状态无效/)
  const ok = await call('media_item', { id, action: 'status', status: 'published' })
  assert.match(ok.content, /已发布/)
})

test('导出：Markdown 带正文与分镜表，图片复制到 assets/', async () => {
  const list = await call('media_list', {})
  const id = /it_[a-z0-9]+/.exec(list.content)?.[0]
  const cover = join(workDir, 'cover.png')
  await writeFile(cover, 'png')
  await call('media_save', { id, kind: 'image', target: 'cover', src: cover })

  const exported = await call('media_export', { id, dir: 'out' })
  assert.notEqual(exported.isError, true, exported.content)
  assert.match(exported.content, /导出到/)

  const files = await readdir(join(workDir, 'out'))
  const md = files.find(row => row.endsWith('.md'))
  assert.ok(md, files.join(','))
  const text = await readFile(join(workDir, 'out', md), 'utf8')
  assert.match(text, /^# 旧手机改行车记录仪/)
  assert.match(text, /> 封面大字：旧手机别扔/)
  assert.match(text, /!\[封面\]\(assets\/cover.png\)/)
  assert.match(text, /## 分镜/)
  assert.match(text, /\| 1 \| 特写 \| 旧手机屏幕亮起 \| 这台手机在抽屉里躺了两年 \| 4 \|/)

  const assets = await readdir(join(workDir, 'out', 'assets'))
  assert.deepEqual(assets, ['cover.png'])
})

test('没有成稿的条目导出时明确拒绝', async () => {
  const created = await call('media_idea', { text: '还没写的一条' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  const exported = await call('media_export', { id })
  assert.equal(exported.isError, true)
  assert.match(exported.content, /还没有成稿/)
})

test('风格提炼：只给原文时出规范，给成品卡才落库并设为当前风格', async () => {
  const guide = await call('media_save', { kind: 'style', name: '口语笔记', text: '我跟你讲，这事特别简单。' })
  assert.notEqual(guide.isError, true, guide.content)
  assert.match(guide.content, /风格提炼/)
  assert.match(guide.content, /"sentences"/)
  assert.match(guide.content, /我跟你讲，这事特别简单/)

  const empty = await call('media_save', { kind: 'style' })
  assert.equal(empty.isError, true)
  assert.match(empty.content, /style 对象/)

  const saved = await call('media_save', {
    kind: 'style',
    name: '口语笔记',
    style: { summary: '短句、第一人称', tone: '像跟人聊天', reference: '我跟你讲，这事特别简单。' },
  })
  assert.notEqual(saved.isError, true, saved.content)
  assert.match(saved.content, /已设为当前风格/)

  const list = await call('media_list', {})
  const id = /it_[a-z0-9]+/.exec(list.content)?.[0]
  const brief = await call('media_brief', { id })
  assert.match(brief.content, /当前风格卡「口语笔记」/)
  assert.match(brief.content, /作者原文节选/)
  assert.match(brief.content, /我跟你讲，这事特别简单/)
})

test('media_write：用天枢的模型一口气出策划案与正文', async () => {
  const created = await call('media_idea', { text: '把通勤时间用来听完一本书的三个办法' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]

  llmQueue = [
    JSON.stringify({
      title: '通勤 40 分钟听完一本书',
      coverText: '地铁就是书房',
      facts: ['单程 40 分钟', '一本 12 万字的书'],
      outline: ['先选对书', '倍速怎么调', '怎么记住'],
      cover: 'a paperback on a subway seat, morning light',
      characters: 'a paperback book on a seat',
      images: [{ anchor: '倍速怎么调', caption: '手机上的倍速条', prompt: 'phone showing speed control' }],
      shots: [{ shot: '近景', visual: '耳机塞进耳朵', voice: '第一件事不是打开播放器', seconds: 4, prompt: 'earbuds going in' }],
    }),
    '# 通勤 40 分钟听完一本书\n\n## 先选对书\n别挑需要做笔记的。\n\n## 倍速怎么调\n1.2 倍起步。\n\n## 怎么记住\n到站前用 60 秒复述一遍。\n',
  ]

  const written = await call('media_write', { id, format: 'script', imageCount: 1, shotCount: 1 })
  assert.notEqual(written.isError, true, written.content)
  assert.match(written.content, /策划案/)
  assert.match(written.content, /成稿/)
  assert.equal(llmCalls.length, 2)
  // 第一次要策划案，第二次要正文；简报都要带上灵感原文
  assert.match(JSON.stringify(llmCalls[0].messages), /通勤时间用来听完一本书/)
  assert.match(JSON.stringify(llmCalls[0].messages), /coverText/)
  assert.match(JSON.stringify(llmCalls[1].messages), /成稿已定/)

  const detail = await call('media_item', { id })
  assert.match(detail.content, /成稿《通勤 40 分钟听完一本书》/)
  assert.match(detail.content, /状态：草稿/)
  assert.match(detail.content, /这张图放在|image:1/)
})

test('media_write：模型吐回对象或带包装的文本都能吃下', async () => {
  const created = await call('media_idea', { text: '第二个用例：模型返回 {text:...}' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  llmQueue = [
    { text: JSON.stringify({ title: '包装测试', coverText: '包装', outline: ['一'], images: [], shots: [] }) },
    { content: '# 包装测试\n\n## 一\n正文一行。\n' },
  ]
  const written = await call('media_write', { id })
  assert.notEqual(written.isError, true, written.content)
  const detail = await call('media_item', { id })
  assert.match(detail.content, /成稿《包装测试》/)
})

test('media_write：宿主没给模型时说清楚该走哪条路', async () => {
  const created = await call('media_idea', { text: '没有模型的机器' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  const bare = plugin.activate({
    storage: { dataDir: () => dataDir },
    workspace: { read: async () => '', write: async () => {} },
    shell: { run: shellRun },
    ui: { post: async () => {}, setStatus: async () => {} },
  })
  const tool = bare.tools.find(row => row.name === 'media_write')
  const result = await tool.execute({ args: { id }, cwd: workDir })
  assert.equal(result.isError, true)
  assert.match(result.content, /media_brief/)
})

test('工作台状态写进对话上下文：块带 <media-desk> 标签，含待写与待发布', async () => {
  await api.lifecycle.turnStart()
  assert.ok(blocks.length > 0, 'turnStart 后应至少推一次上下文')
  const last = blocks[blocks.length - 1]
  assert.match(last, /^<media-desk>/)
  assert.match(last, /<\/media-desk>$/)
  assert.match(last, /待写|待发布/)
})

test('media_list：按平台、关键词、条数筛', async () => {
  const a = await call('media_idea', { text: '筛选A：抖音那条', platform: '抖音' })
  const idA = /it_[a-z0-9]+/.exec(a.content)?.[0]
  await call('media_idea', { text: '筛选B：小红书那条', platform: '小红书' })

  const byPlatform = await call('media_list', { platform: '抖音' })
  assert.match(byPlatform.content, new RegExp(idA))
  assert.doesNotMatch(byPlatform.content, /筛选B/)

  const byQuery = await call('media_list', { query: '筛选b' })
  assert.match(byQuery.content, /筛选B/)
  assert.doesNotMatch(byQuery.content, /筛选A/)

  const limited = await call('media_list', { limit: 1 })
  assert.equal(limited.content.split('\n').length, 2, '抬头一行 + 一条')
})

test('media_item：排期会推进状态，取消排期会退回去', async () => {
  const created = await call('media_idea', { text: '排期用例' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]

  await call('media_item', { id, action: 'schedule', scheduledAt: '2026-05-01T10:00:00.000Z', platform: '抖音' })
  const scheduled = await call('media_item', { id })
  assert.match(scheduled.content, /排期：5月1日/)
  assert.match(scheduled.content, /状态：大纲/)

  const cleared = await call('media_item', { id, action: 'schedule', scheduledAt: '' })
  assert.match(cleared.content, /取消/)
  const after = await call('media_item', { id })
  assert.doesNotMatch(after.content, /排期：/)
  assert.match(after.content, /状态：灵感/)
})

test('id 用前缀时：唯一才解析，不唯一就把候选全列出来，缺 id 说清楚', async () => {
  const created = await call('media_idea', { text: '前缀测试' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]

  // 完整 id 一定能用（列表里给的就是完整 id）
  const byFull = await call('media_item', { id })
  assert.notEqual(byFull.isError, true, byFull.content)
  assert.match(byFull.content, /前缀测试/)

  // 前缀只到 "it_" 时必然命中多条（id 带毫秒时间戳，同批创建的共享前缀），
  // 这时不能猜一个，要把候选 id 全给出来。
  const ambiguous = await call('media_item', { id: 'it_' })
  assert.equal(ambiguous.isError, true)
  assert.match(ambiguous.content, /不唯一/)
  assert.match(ambiguous.content, new RegExp(id), '候选里要含这条自己的完整 id')

  const missing = await call('media_item', { id: 'it_zzzzzz' })
  assert.equal(missing.isError, true)
  assert.match(missing.content, /找不到条目/)

  const empty = await call('media_item', {})
  assert.equal(empty.isError, true)
  assert.match(empty.content, /缺少 id/)
})

test('media_item update 改标题与标签', async () => {
  const created = await call('media_idea', { text: '要改标题的' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  const updated = await call('media_item', { id, action: 'update', title: '改过的标题', tags: ['新标签'] })
  assert.notEqual(updated.isError, true, updated.content)
  const detail = await call('media_item', { id })
  assert.match(detail.content, /改过的标题/)
  assert.match(detail.content, /标签：新标签/)
})

test('media_save 的 draft / metric / rule 三个分支', async () => {
  const created = await call('media_idea', { text: '分支测试' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]

  const draft = await call('media_save', { id, kind: 'draft', text: '# 草稿\n\n先存一版。', format: 'script' })
  assert.notEqual(draft.isError, true, draft.content)
  const afterDraft = await call('media_item', { id })
  assert.match(afterDraft.content, /口播草稿：\d+ 字/)

  const metric = await call('media_save', { id, kind: 'metric', platform: '抖音', views: 1200, likes: 88 })
  assert.notEqual(metric.isError, true, metric.content)
  assert.match(metric.content, /记录 抖音 数据 1200 阅读/)

  const rule = await call('media_save', { kind: 'rule', name: '开头别铺垫', rule: '第一句就进场景' })
  assert.notEqual(rule.isError, true, rule.content)
  assert.match(rule.content, /沉淀规则「开头别铺垫」/)

  // 存进去的规则会出现在下一次简报里
  const brief = await call('media_brief', { id })
  assert.match(brief.content, /开头别铺垫|第一句就进场景/)
})

test('media_export：图片文件不存在时如实报缺，不假装导出完整', async () => {
  const created = await call('media_idea', { text: '缺图导出' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  await call('media_save', {
    id,
    kind: 'plan',
    plan: { title: '缺图', outline: ['一'], cover: 'a cover', images: [{ anchor: '一', prompt: 'an image' }], shots: [] },
  })
  await call('media_save', { id, kind: 'script', text: '# 缺图\n\n## 一\n正文。\n' })
  await call('media_save', { id, kind: 'image', target: 'cover', src: join(workDir, 'not-exist.png') })

  const exported = await call('media_export', { id, dir: 'out-missing' })
  assert.notEqual(exported.isError, true, exported.content)
  assert.match(exported.content, /缺 1 张/)

  const files = await readdir(join(workDir, 'out-missing'))
  assert.ok(files.some(name => name.endsWith('.md')), '正文仍要导出')
})

test('media_export：dir 给绝对路径时按它落盘，不能拼到工作区后面', async () => {
  const created = await call('media_idea', { text: '绝对路径导出' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  await call('media_save', { id, kind: 'script', text: '# 绝对路径导出\n\n## 一\n正文。\n' })

  const abs = join(workDir, 'abs-export')
  const exported = await call('media_export', { id, dir: abs })
  assert.notEqual(exported.isError, true, exported.content)

  const files = await readdir(abs)
  assert.ok(files.some(name => name.endsWith('.md')), `应落在 ${abs}，实际 ${files.join(',')}`)
})

test('TPI 1.0 宿主（没有 ui / shell）：不挂面板，导出直接写文件', async () => {
  const bareData = join(root, 'bare-data')
  const bare = plugin.activate({
    storage: { dataDir: () => bareData },
    promptContext: { setBlock: () => {} },
  })
  assert.equal(bare.ui, undefined, '1.0 没有 ui 扩展点，不该返回面板')
  assert.equal(bare.tools.length, 7)

  const call = async (name, args = {}) => bare.tools.find(row => row.name === name).execute({ args, cwd: workDir })
  const created = await call('media_idea', { text: '1.0 宿主路径' })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  await call('media_save', { id, kind: 'script', text: '# 1.0 宿主路径\n\n## 一\n正文。\n' })

  const abs = join(workDir, 'v1-export')
  const exported = await call('media_export', { id, dir: abs })
  assert.notEqual(exported.isError, true, exported.content)
  const files = await readdir(abs)
  assert.ok(files.some(name => name.endsWith('.md')), `应直接写进 ${abs}，实际 ${files.join(',')}`)
})
