// 加固回归：工具超时预算、导出临时文件清理、图片路径边界、上下文块 rejection、/rpc 的跨源门。
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

let root
let dataDir
let workDir
let api

const shellRun = (command, options) => new Promise((resolve, reject) => {
  const argv = command.match(/"[^"]*"|\S+/g).map(token => token.replace(/^"|"$/g, ''))
  const [bin, ...rest] = argv
  execFile(bin, rest, { timeout: options?.timeoutMs ?? 30_000 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr }))
    else resolve({ stdout, stderr })
  })
})

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-desk-hard-'))
  dataDir = join(root, 'data')
  workDir = join(root, 'work')
  await mkdir(workDir, { recursive: true })
  globalThis.__tianshuTPI = { defineTianshuPlugin: spec => spec }
  const plugin = (await import('../index.js')).default
  api = plugin.activate({
    storage: { dataDir: () => dataDir },
    workspace: { read: async () => '', write: async () => {} },
    shell: { run: shellRun },
    ui: { post: async () => {}, setStatus: async () => {} },
    sidePathLLM: { available: () => true, complete: async () => ({ text: '' }) },
    // setBlock 每次都 reject：插件必须自己吞掉，否则宿主进程收到 unhandledRejection。
    promptContext: { setBlock: () => Promise.reject(new Error('block 写不进去')) },
  })
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const tool = name => api.tools.find(row => row.name === name)
const call = async (name, args) => tool(name).execute({ args, cwd: workDir })
const newItem = async (text) => /it_[a-z0-9]+/.exec((await call('media_idea', { text })).content)[0]

test('media_write 的工具超时盖住两次模型调用（20 秒会被宿主中途切断）', () => {
  assert.ok(tool('media_write').timeoutMs >= 420_000, `实际 ${tool('media_write').timeoutMs}`)
  assert.ok(tool('media_export').timeoutMs >= 60_000, `实际 ${tool('media_export').timeoutMs}`)
  assert.ok(tool('media_list').timeoutMs <= 60_000)
})

test('导出之后插件数据目录不残留 job / result 临时文件', async () => {
  const id = await newItem('导出临时文件')
  await call('media_save', { id, kind: 'plan', plan: { title: '临时文件', outline: ['一'] } })
  await call('media_save', { id, kind: 'article', text: '# 临时文件\n\n正文' })

  const exported = await call('media_export', { id, dir: 'out-tmp' })
  assert.notEqual(exported.isError, true, exported.content)

  const leftovers = (await readdir(dataDir)).filter(row => row.startsWith('export-'))
  assert.deepEqual(leftovers, [])
})

test('导出失败时同样不留临时文件', async () => {
  const id = await newItem('导出失败的条目')
  await call('media_save', { id, kind: 'plan', plan: { title: '失败', outline: ['一'] } })
  await call('media_save', { id, kind: 'article', text: '# 失败\n\n正文' })

  // 含 NUL 字节的目录名无法落到任何文件系统：worker 落盘会失败
  const exported = await call('media_export', { id, dir: 'bad\u0000dir' })
  assert.equal(exported.isError, true, exported.content)
  const leftovers = (await readdir(dataDir)).filter(row => row.startsWith('export-'))
  assert.deepEqual(leftovers, [])
})

test('图片 src 只在工作区与插件数据目录内放行，外面的路径直接拒绝', async () => {
  const id = await newItem('图片路径边界')
  await call('media_save', { id, kind: 'plan', plan: { title: '边界', outline: ['一'] } })

  // 用 .png 后缀：这条测的是越界判据，别让扩展名判据先拦住
  const outside = join(root, 'outside.png')
  await writeFile(outside, 'secret')
  const rejected = await call('media_save', { id, kind: 'image', target: 'cover', src: outside })
  assert.equal(rejected.isError, true)
  assert.match(rejected.content, /不在工作区或插件数据目录里/)

  const inside = join(workDir, 'cover.png')
  await writeFile(inside, 'png')
  assert.notEqual((await call('media_save', { id, kind: 'image', target: 'cover', src: inside })).isError, true)

  assert.notEqual((await call('media_save', { id, kind: 'image', target: 'cover', src: 'https://example.com/a.png' })).isError, true)
})

test('media_idea 的 media 走同一道边界', async () => {
  const outside = join(root, 'outside.png')
  await writeFile(outside, 'x')
  const rejected = await call('media_idea', { text: '贴一张工作区外的图', media: { src: outside } })
  assert.equal(rejected.isError, true)
  assert.match(rejected.content, /不在工作区或插件数据目录里/)

  const inside = join(workDir, 'note.png')
  await writeFile(inside, 'x')
  assert.notEqual((await call('media_idea', { text: '贴一张工作区内的图', media: { src: inside } })).isError, true)
})

test('上下文块写不进去时插件吞掉 rejection，不给宿主抛 unhandledRejection', async () => {
  await newItem('上下文块的 rejection')
  const seen = []
  const onUnhandled = (reason) => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await api.lifecycle.turnStart()
    await new Promise(resolve => setTimeout(resolve, 30))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(seen, [])
})

test('/rpc 只认 application/json，并用 Origin 挡跨源写操作', async () => {
  const port = 18000 + Math.floor(Math.random() * 800)
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd,
    env: { ...process.env, MEDIA_DESK_DATA: join(root, 'serve-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务没起来')), 5000)
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('已启动')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', code => reject(new Error(`服务提前退出：${code}`)))
    })

    const url = `http://127.0.0.1:${port}/rpc`
    const post = (headers, body) => fetch(url, { method: 'POST', headers, body })

    // 浏览器能直接发的简单请求（text/plain）：以前能改台账和模型配置
    const simple = await post({ 'content-type': 'text/plain' }, JSON.stringify({ type: 'state' }))
    assert.equal(simple.status, 415)

    const crossed = await post({ 'content-type': 'application/json', origin: 'http://evil.example' }, JSON.stringify({ type: 'state' }))
    assert.equal(crossed.status, 403)

    const ok = await post({ 'content-type': 'application/json' }, JSON.stringify({ type: 'state' }))
    assert.equal(ok.status, 200)
    const payload = await ok.json()
    assert.ok(Array.isArray(payload.value.items))
  } finally {
    child.kill()
  }
})

// 审核报告 P2-2：数据目录里的 llm.json（带 key）曾被当成图片复制进工作区。
test('插件数据目录里的凭据文件不能当图片导出', async () => {
  const id = await newItem('凭据外泄探针')
  await call('media_save', { id, kind: 'plan', plan: { title: '探针', outline: ['一'] } })

  const secret = join(dataDir, 'llm.json')
  await writeFile(secret, JSON.stringify({ baseUrl: 'https://api.example', key: 'sk-probe-SECRET' }))
  const rejected = await call('media_save', { id, kind: 'image', target: 'cover', src: secret })
  assert.equal(rejected.isError, true, rejected.content)
  assert.match(rejected.content, /只接受图片文件/)

  // 工作区里的非图片同样不行：assets/ 只该放图片
  const notes = join(workDir, 'notes.md')
  await writeFile(notes, '正文')
  const nonImage = await call('media_save', { id, kind: 'image', target: 'cover', src: notes })
  assert.equal(nonImage.isError, true, nonImage.content)

  // 数据目录只放行 files/ 下的图片
  const inFiles = join(dataDir, 'files', 'pic.png')
  await mkdir(dirname(inFiles), { recursive: true })
  await writeFile(inFiles, 'png')
  assert.notEqual((await call('media_save', { id, kind: 'image', target: 'cover', src: inFiles })).isError, true)
})
