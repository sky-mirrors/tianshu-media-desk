// 用天枢自己的校验器验证 tianshu.plugin.json —— 改完清单先跑这个，再重启会话。
//
// 用法：node scripts/check-manifest.mjs [清单路径]
// 默认读同目录上一级的 tianshu.plugin.json，宿主运行时目录按顺序探测：
//   $TIANSHU_RUNTIME → D:/Tianshu/rivet-runtime → ~/AppData/Local/Programs/Tianshu/rivet-runtime
//
// 能验到什么、验不到什么（别高估它）：
//   ✓ TPI 版本判定（isTpiManifestV2）
//   ✓ 清单形状解析（parseTpiManifest，返回 {ok,manifest}）
//   ✓ permissions 的严格校验（permissionsV2Schema，类型错误会被拒）
//   ✗ capabilities 枚举值、contributes.ui 与 "ui" 能力的配对、工具名长度 —— 这三个
//     parseTpiManifest 都不查（用坏清单做过对照实验，照样 ok:true），只在真实加载时暴露。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(process.argv[2] ?? join(here, '..', 'tianshu.plugin.json'))

const candidates = [
  process.env.TIANSHU_RUNTIME,
  'D:/Tianshu/rivet-runtime',
  join(homedir(), 'AppData/Local/Programs/Tianshu/rivet-runtime'),
].filter(Boolean)

const runtime = candidates.find(dir => existsSync(join(dir, 'chunk-CIXVI7BW.js')))
if (!runtime) {
  console.log('跳过：没找到天枢运行时的 chunk-CIXVI7BW.js（设 TIANSHU_RUNTIME 指向 rivet-runtime）')
  process.exit(0)
}

const { TPI_SUPPORTED_VERSIONS, isTpiManifestV2, parseTpiManifest, permissionsV2Schema } = await import(
  `file://${join(runtime, 'chunk-CIXVI7BW.js').replace(/\\/g, '/')}`
)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
console.log('清单        :', manifestPath)
console.log('支持的 TPI  :', JSON.stringify(TPI_SUPPORTED_VERSIONS))
console.log('判定为 v2   :', isTpiManifestV2(manifest))

const parsed = parseTpiManifest(manifest)
console.log('形状解析    :', parsed.ok ? 'ok' : '失败')

const permissions = permissionsV2Schema.safeParse(manifest.permissions)
console.log('permissions :', permissions.success
  ? `通过 ${JSON.stringify(permissions.data)}`
  : `拒绝 ${JSON.stringify(permissions.error.issues.map(issue => issue.message))}`)

const tools = manifest.contributes?.tools ?? []
const badNames = tools.map(row => row.name).filter(name => typeof name !== 'string' || !name.length || name.length > 40)
console.log('工具名长度  :', badNames.length ? `超限 ${badNames.join(',')}` : `${tools.length} 个都合法`)

process.exitCode = permissions.success && parsed.ok ? 0 : 1
