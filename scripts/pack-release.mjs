#!/usr/bin/env node
// 生成提交用的发行目录 dist/：只放运行时真正需要的文件，并写入 xiaosi.release.json。
//
// 两个来自官方校验器的硬约束（见 D:\Februus\disk-steward\scripts\pack-release.mjs 与 PUBLISH.md）：
//   1. dist/package.json 不能带 scripts / dependencies，否则 validateFile 直接拒绝；
//   2. permission_digest 是 sha256(permissions 的紧凑 JSON，保持 manifest 里的键顺序)。
//      这条是从 tianshi-see-2.5.2 的样例反推并命中的，不是猜的。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const ENTRY = 'index.js'
// 面板是宿主按路径加载的静态文件，不在 import 图里
const STATIC_DIRS = ['views']
// 用 new URL('...', import.meta.url) 交给 shell.run 跑的文件：也读不出来，必须显式列出。
// 漏了它 media_export 会在真机上 ENOENT。
const URL_ASSETS = ['lib/export-worker.mjs']
// 开发脚本不进发行包（规范要求只纳入运行所需）。
const EXTRA_DIRS = []

const toPosix = (p) => p.split(sep).join('/')
const manifest = JSON.parse(readFileSync(join(ROOT, 'tianshu.plugin.json'), 'utf8'))

// 从入口出发走 import 图；只允许 node: 内置与相对路径 —— 发行包不带 node_modules
const closure = new Set()
const queue = [ENTRY]
while (queue.length) {
  const rel = queue.shift()
  if (closure.has(rel)) continue
  const abs = join(ROOT, rel)
  const source = readFileSync(abs, 'utf8')
  closure.add(rel)
  for (const match of source.matchAll(/from '([^']+)'/g)) {
    const spec = match[1]
    if (spec.startsWith('node:')) continue
    if (!spec.startsWith('.')) throw new Error(`${rel}: 发行包不允许第三方依赖（${spec}）`)
    queue.push(toPosix(relative(ROOT, resolve(dirname(abs), spec))))
  }
}

const permissionDigest = createHash('sha256')
  .update(JSON.stringify(manifest.permissions ?? {}))
  .digest('hex')

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim()
const version = manifest.version
const releaseId = `rel_${manifest.id.replace(/-/g, '_')}_${version.replace(/\./g, '')}`

rmSync(DIST, { recursive: true, force: true })
for (const rel of [...closure, ...URL_ASSETS]) {
  const dest = join(DIST, rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(ROOT, rel), dest)
}
for (const dir of [...STATIC_DIRS, ...EXTRA_DIRS]) {
  cpSync(join(ROOT, dir), join(DIST, dir), { recursive: true })
}
// PUBLISH.md 是仓库的发布记录，不进包：否则改一次文档就得重打包、哈希又变。
for (const file of ['tianshu.plugin.json', 'LICENSE', 'README.md']) {
  cpSync(join(ROOT, file), join(DIST, file))
}

// 发行包的 package.json 只留标识：带 scripts 会被官方校验器拒绝
writeFileSync(
  join(DIST, 'package.json'),
  JSON.stringify({
    name: manifest.id,
    version,
    private: true,
    type: 'module',
    description: manifest.description,
  }, null, 2) + '\n',
)

const release = {
  channel: 'stable',
  // 与 make-release.py 同源：都从 manifest 派生，避免两个打包脚本给出不同的声明。
  compatibility: {
    core: (manifest.engines ?? {}).tianshu ?? '>=4.0.2 <5.0.0',
    platforms: ['win32-x64'],
    tpi: manifest.$tpi ?? '1.0',
  },
  data_schema: 1,
  migration_kind: 'none',
  permission_digest: permissionDigest,
  plugin_id: manifest.id,
  publisher_id: 'b226234e-c3c8-4223-9e58-7e9fadbb5bea',
  release_id: releaseId,
  runtime: 'agent',
  schema: 'xiaosi.release/1',
  source_commit: sourceCommit,
  version,
}
writeFileSync(join(DIST, 'xiaosi.release.json'), JSON.stringify(release, null, 2) + '\n')

const files = [...closure, ...URL_ASSETS, ...STATIC_DIRS, ...EXTRA_DIRS, 'tianshu.plugin.json', 'package.json', 'LICENSE', 'README.md', 'xiaosi.release.json']
console.log(`dist/ 就绪：入口闭包 ${closure.size} 个 + URL 引用 ${URL_ASSETS.length} 个 + 目录 ${STATIC_DIRS.length + EXTRA_DIRS.length} 个 + 清单与元数据`)
console.log(`permission_digest: ${permissionDigest}`)
console.log(`release_id: ${releaseId}  source_commit: ${sourceCommit.slice(0, 12)}`)
console.log(files.map(f => `  ${f}`).join('\n'))
