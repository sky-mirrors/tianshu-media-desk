// 真机入场第一关：用宿主自己的 readTpiManifest 读真机安装位上的插件。
// 这是宿主加载插件时真正走的那一步（读盘 → 解析 → 校验），不是工程目录里的自测。
// 用法：node scripts/check-real-load.mjs [插件根目录] [只查这一个]
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readTpiManifest } from 'file:///D:/Tianshu/rivet-runtime/chunk-JHS3EY74.js'

const pluginsRoot = process.argv[2] ?? join(process.env.USERPROFILE, '.rivet', 'plugins')
const only = process.argv[3]

const dirs = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => !only || name === only)

for (const name of dirs) {
  const dir = join(pluginsRoot, name)
  try {
    const result = await readTpiManifest(dir)
    const manifest = result?.manifest ?? result
    // readTpiManifest 对没有 tianshu.plugin.json 的旧式插件目录也返回对象，ok 才是判据。
    const ok = result?.ok ?? Boolean(manifest?.$tpi)
    console.log(`✔ ${name} | ok=${ok} | $tpi=${manifest?.$tpi} | id=${manifest?.id} | caps=${JSON.stringify(manifest?.capabilities)}`)
    if (result?.issues?.length) console.log('   issues:', JSON.stringify(result.issues))
  } catch (err) {
    console.log(`✘ ${name} | 读取失败：${String(err.message).split('\n')[0]}`)
  }
}
