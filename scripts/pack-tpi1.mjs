// 产出 TPI 1.0 入库包。
//
// 为什么要有两份清单：插件库准入 schema 硬要求 `$tpi` 是字面量 "1.0"，capabilities 枚举里
// 也没有 workspace / shell / ui；而运行时用的主清单是 2.0。所以入库包从 dist/ 派生一份源目录：
// 换成 tianshu.plugin.1.0.json、去掉面板（1.0 没有 contributes.ui）、去掉生成元数据
// （官方 pack 拒绝源目录里带 xiaosi.release.json / xiaosi.contents.json），再交给官方 devkit
// 的 `pack` 算 permission_digest 与 xiaosi.contents/1。
//
// 用法：node scripts/pack-tpi1.mjs [devkit 目录]
//   devkit 缺省看环境变量 TIANSHU_DEVKIT，再缺省 D:/Februus/.tmp-devkit
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const SOURCE = join(ROOT, '.local-data', 'tpi1-src')
const OUT = join(ROOT, 'tianshu-media-desk-0.1.1-tpi1.0.zip')
const DEVKIT = resolve(process.argv[2] ?? process.env.TIANSHU_DEVKIT ?? join('D:/Februus/.tmp-devkit'))
const MANIFEST_1_0 = join(ROOT, 'tianshu.plugin.1.0.json')
// 与 2.0 包的 release_id 分开：同一个 release_id 挂着两份不同产物，平台那边会打架。
const RELEASE_ID = 'rel_media_desk_011_tpi10'
const PUBLISHER_ID = 'b226234e-c3c8-4223-9e58-7e9fadbb5bea'

if (!existsSync(join(DIST, 'index.js'))) throw new Error('dist/ 还没生成：先跑 node scripts/pack-release.mjs')
if (!existsSync(join(DEVKIT, 'cli.mjs'))) throw new Error(`找不到官方 devkit：${DEVKIT}（用法：node scripts/pack-tpi1.mjs <devkit 目录>）`)

rmSync(SOURCE, { recursive: true, force: true })
cpSync(DIST, SOURCE, {
  recursive: true,
  filter: (src) => {
    const rel = relative(DIST, src).split('\\').join('/')
    if (rel === 'views' || rel.startsWith('views/')) return false
    if (rel === 'xiaosi.release.json' || rel === 'xiaosi.contents.json') return false
    return true
  },
})
writeFileSync(join(SOURCE, 'tianshu.plugin.json'), readFileSync(MANIFEST_1_0))

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
rmSync(OUT, { force: true })
execFileSync(process.execPath, [
  'cli.mjs', 'pack', SOURCE, OUT,
  '--release-id', RELEASE_ID,
  '--publisher-id', PUBLISHER_ID,
  '--source-commit', sourceCommit,
  '--platforms', 'win32-x64',
], { cwd: DEVKIT, stdio: 'inherit' })
console.log(`入库包：${OUT}（release_id ${RELEASE_ID}，source_commit ${sourceCommit.slice(0, 12)}）`)
