// 纯函数层测试：模型回来的东西怎么解析、清单怎么归一化、导出文件名怎么取、状态怎么落盘。
// 这一层没有 host，跑得快，出问题一定是逻辑问题。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { extractJson, textOf } from '../lib/llm.js'
import { renderMarkdown, slugify } from '../src/export.js'
import { buildContextBlock } from '../lib/context.js'
import { applyOps } from '../src/ops.js'
import { State, initialState } from '../lib/state.js'

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-desk-unit-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const freshState = (patch = {}) => ({
  ...initialState(),
  items: [{
    id: 'it_1', kind: 'note', title: '原标题', body: '', tags: [], status: 'idea',
    personaIds: [], createdAt: new Date().toISOString(), drafts: {},
  }],
  ...patch,
})

test('extractJson：围栏、裸 JSON、前后带解释文字都能取到', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('好的，这是策划案：\n{"a":{"b":2}}\n希望有用'), { a: { b: 2 } })
  // 围栏里不是 JSON、正文里才是：要退到后面的候选
  assert.deepEqual(extractJson('```\nnot json\n```\n结果：{"ok":true}'), { ok: true })
})

test('extractJson：空输入与非 JSON 明确报错，不返回空对象', () => {
  assert.throws(() => extractJson(''), /没有返回内容/)
  assert.throws(() => extractJson('   '), /没有返回内容/)
  assert.throws(() => extractJson('抱歉，我无法完成'), /不是 JSON/)
  assert.throws(() => extractJson('[1,2,3]'), /不是 JSON/)
})

test('textOf：几种常见返回形状都收，认不出就报错', () => {
  assert.equal(textOf('纯文本'), '纯文本')
  assert.equal(textOf({ text: 'a' }), 'a')
  assert.equal(textOf({ content: 'b' }), 'b')
  assert.equal(textOf({ output: 'c' }), 'c')
  assert.equal(textOf({ message: { content: 'd' } }), 'd')
  assert.throws(() => textOf({}), /看不懂/)
  assert.throws(() => textOf(null), /看不懂/)
})

test('slugify：路径字符换掉、空标题兜底、超长截断', () => {
  assert.equal(slugify('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(slugify('  ..拖尾..  '), '拖尾')
  assert.equal(slugify(''), 'untitled')
  assert.equal(slugify('   '), 'untitled')
  assert.equal(slugify('x'.repeat(100)).length, 60)
})

test('save_plan：数量截断、空 prompt 丢弃、旧图 src 保留', () => {
  const state = freshState()
  state.items[0].production = {
    status: 'planned',
    cover: { prompt: '旧封面', src: '/tmp/cover.png' },
    images: [{ caption: '旧图注', anchor: '一', prompt: '旧配图', src: '/tmp/i1.png' }],
  }
  const plan = {
    title: '新标题', coverText: '大字', facts: ['f1'], outline: ['一', '二'],
    cover: '新封面提示词',
    images: [
      { anchor: '一', caption: '图注', prompt: '配图一' },
      { anchor: '二', prompt: '   ' },              // 空 prompt：丢
      { prompt: '配图三' }, { prompt: '配图四' }, { prompt: '配图五' }, // 超 4 张：丢
    ],
    shots: Array.from({ length: 15 }, (_, i) => ({ shot: '近景', visual: `画面${i}`, seconds: 999 })),
  }
  const { receipts, errors } = applyOps(state, [{ op: 'save_plan', id: 'it_1', plan }])
  assert.deepEqual(errors, [])
  assert.equal(receipts.length, 1)

  const production = state.items[0].production
  assert.equal(production.title, '新标题')
  assert.equal(production.cover.prompt, '新封面提示词')
  assert.equal(production.cover.src, '/tmp/cover.png', '重新策划不该丢掉已经出好的封面图')
  assert.equal(production.images.length, 4, '配图最多 4 张')
  assert.equal(production.images[0].src, '/tmp/i1.png', '同序号的老图要留下')
  assert.equal(production.images[1].prompt, '配图三', '空 prompt 被丢弃后位次要前移')
  assert.equal(production.shots.length, 12, '分镜最多 12 个')
  assert.equal(production.shots[0].seconds, 60, '秒数夹到 1..60')
  assert.equal(state.items[0].status, 'outline', '灵感有策划案后进大纲')
})

test('save_production：有 # 标题就拆出来，没有就沿用策划案标题', () => {
  const a = freshState()
  applyOps(a, [{ op: 'save_plan', id: 'it_1', plan: { title: '策划案标题', outline: ['一'] } }])
  applyOps(a, [{ op: 'save_production', id: 'it_1', text: '# 正文标题\n\n正文一。\n', format: 'script' }])
  assert.equal(a.items[0].production.title, '正文标题')
  assert.equal(a.items[0].production.article, '正文一。')
  assert.equal(a.items[0].production.status, 'done')
  assert.equal(a.items[0].status, 'draft')

  const b = freshState()
  applyOps(b, [{ op: 'save_production', id: 'it_1', text: '没有标题的正文', format: 'article' }])
  assert.equal(b.items[0].production.title, '原标题')
  assert.equal(b.items[0].production.article, '没有标题的正文')
  assert.equal(b.items[0].production.format, 'article')
})

test('save_production：空正文拒绝写库', () => {
  const state = freshState()
  const { receipts, errors } = applyOps(state, [{ op: 'save_production', id: 'it_1', text: '   ' }])
  assert.equal(receipts.length, 0)
  assert.match(errors[0], /正文内容无效/)
  assert.equal(state.items[0].production, undefined)
})

test('attach_asset：槽位不存在时报错，不静默丢图', () => {
  const state = freshState()
  applyOps(state, [{ op: 'save_plan', id: 'it_1', plan: { outline: ['一'], shots: [{ visual: '画面', prompt: 'p' }] } }])
  assert.deepEqual(applyOps(state, [{ op: 'attach_asset', id: 'it_1', target: 'shot:1', src: '/tmp/s.png' }]).errors, [])
  assert.equal(state.items[0].production.shots[0].src, '/tmp/s.png')
  assert.match(applyOps(state, [{ op: 'attach_asset', id: 'it_1', target: 'shot:9', src: '/x.png' }]).errors[0], /没有第 9 个槽位/)
  assert.match(applyOps(state, [{ op: 'attach_asset', id: 'it_1', target: '封面', src: '/x.png' }]).errors[0], /槽位无效/)
})

test('renderMarkdown：配图跟着锚点小标题走，分镜出表格', () => {
  const production = {
    title: '标题', coverText: '大字', article: '开场一句。\n\n## 一\n正文一。\n\n## 二\n正文二。\n',
    facts: ['事实 1'],
    cover: { src: '/tmp/cover.png' },
    images: [{ anchor: '二', caption: '图注二', src: '/tmp/two.png' }, { caption: '无锚点', src: '/tmp/loose.png' }],
    shots: [{ shot: '近景', visual: '画面|带竖线', voice: '口播', seconds: 4 }],
  }
  const { markdown, assets } = renderMarkdown(production, { title: '标题', platform: '小红书' })
  assert.match(markdown, /^# 标题/)
  assert.match(markdown, /!\[封面\]\(assets\/cover.png\)/)
  assert.match(markdown, /## 二\n正文二。\n\n!\[图注二\]\(assets\/two.png\)/)
  assert.match(markdown, /!\[无锚点\]\(assets\/loose.png\)/)
  assert.match(markdown, /画面\\\|带竖线/, '表格里的竖线要转义')
  assert.match(markdown, /平台：小红书/)
  assert.deepEqual(assets.map(row => row.name), ['cover.png', 'two.png', 'loose.png'])
})

test('buildContextBlock：空台账不推块，有内容时带 id 与到期提示', () => {
  assert.equal(buildContextBlock(initialState()), '')

  const state = freshState({
    items: [
      { id: 'it_a', title: '待写一', status: 'idea' },
      { id: 'it_b', title: '该发了', status: 'ready', scheduledAt: '2026-01-01T00:00:00.000Z' },
    ],
    styles: [{ id: 'st1', name: '口语笔记', summary: '短句' }],
    activeStyleId: 'st1',
  })
  const block = buildContextBlock(state, new Date('2026-06-01T00:00:00.000Z'))
  assert.match(block, /^<media-desk>/)
  assert.match(block, /<\/media-desk>$/)
  assert.match(block, /it_a/)
  assert.match(block, /已过排期 1 条/)
  assert.match(block, /当前风格卡：口语笔记/)
})

test('State：并发写串行落盘，换一个实例能读回同样的数据', async () => {
  const dir = join(root, 'store')
  const state = new State(dir)
  await state.read()

  await Promise.all(Array.from({ length: 5 }, (_, i) => state.mutate(draft => {
    draft.items.push({ id: `it_${i}`, title: `第 ${i} 条`, status: 'idea' })
  })))

  assert.equal(state.state.items.length, 5, '并发写不能互相覆盖')

  const reopened = new State(dir)
  const reloaded = await reopened.read()
  assert.deepEqual(reloaded.items.map(row => row.id), ['it_0', 'it_1', 'it_2', 'it_3', 'it_4'])
})

test('State：首次读取自动建空台账而不是报错', async () => {
  const state = new State(join(root, 'empty'))
  const value = await state.read()
  assert.deepEqual(value.items, [])
  assert.equal(value.draftFormat, 'script')
})

test('State：mutate 中途抛错时不能把半截修改留在内存或磁盘里', async () => {
  const dir = join(root, 'dirty')
  const state = new State(dir)
  await state.read()
  await state.mutate(draft => { draft.items.push({ id: 'good', title: 'ok' }) })

  await assert.rejects(state.mutate(draft => {
    draft.items.push({ id: 'bad', title: '不该留下' })
    throw new Error('boom')
  }), /boom/)

  const inMemory = await state.read()
  assert.deepEqual(inMemory.items.map(row => row.id), ['good'], '内存里不能留下半截修改')

  const reopened = new State(dir)
  assert.deepEqual((await reopened.read()).items.map(row => row.id), ['good'], '磁盘同理')
})

test('State：一次 mutate 慢、一次快，慢的不能在快的之后才落盘', async () => {
  const dir = join(root, 'order')
  const state = new State(dir)
  await state.read()

  const slow = state.mutate(async draft => {
    await new Promise(resolve => setTimeout(resolve, 30))
    draft.items.push({ id: 'slow', title: '慢' })
  })
  const fast = state.mutate(draft => { draft.items.push({ id: 'fast', title: '快' }) })
  await Promise.all([slow, fast])

  const reopened = new State(dir)
  assert.deepEqual((await reopened.read()).items.map(row => row.id), ['slow', 'fast'], '排队顺序即写入顺序')
})

test('exportProduction：没有图片的成稿也要能导出（目录要自己建）', async () => {
  const { exportProduction } = await import('../src/export.js')
  const dir = join(root, 'export-plain', 'nested')
  const production = { title: '无图成稿', coverText: '无图', article: '# 无图成稿\n\n## 一\n只有文字。\n', shots: [] }
  const result = await exportProduction(production, { title: '无图成稿' }, { dir })
  assert.ok(result.path.endsWith('.md'))
  const text = await readFile(result.path, 'utf8')
  assert.match(text, /只有文字/)
  assert.deepEqual(result.copied, [])
})

test('两个 State 实例共用一个文件（两个进程）：后写的一方必须能读到先写的一方', async () => {
  const dir = join(root, 'shared')
  const a = new State(dir)   // 模拟界面服务进程
  const b = new State(dir)   // 模拟命令行进程
  await a.read()
  await b.read()

  await a.mutate(draft => { draft.items.push({ id: 'from-a', title: '界面写的' }) })
  const seenByB = await b.read()
  assert.deepEqual(seenByB.items.map(row => row.id), ['from-a'], '另一个进程的写入要能被读到')

  await b.mutate(draft => { draft.items.push({ id: 'from-b', title: '命令行写的' }) })
  const seenByA = await a.read()
  assert.deepEqual(seenByA.items.map(row => row.id), ['from-a', 'from-b'], '反过来也要通')
})
