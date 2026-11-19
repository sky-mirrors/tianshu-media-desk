// 导出 worker：跑在宿主进程里（shell.run），不受插件沙箱的文件白名单限制。
// 插件把它写好的 job.json 交过来，它把 Markdown 与图片落进工作区，再写一份 result.json。
import { readFile, writeFile } from 'node:fs/promises'
import { exportProduction } from '../src/export.js'

const args = process.argv.slice(2)
const jobIndex = args.indexOf('--job')
const jobFile = jobIndex >= 0 ? args[jobIndex + 1] : ''
if (!jobFile) {
  process.stderr.write('usage: export-worker.mjs --job <job.json>\n')
  process.exit(2)
}

const resultFile = `${jobFile}.result.json`
try {
  const job = JSON.parse(await readFile(jobFile, 'utf8'))
  const result = await exportProduction(job.production, job.item, { dir: job.dir })
  await writeFile(resultFile, JSON.stringify({ ok: true, ...result }))
} catch (err) {
  await writeFile(resultFile, JSON.stringify({ ok: false, error: err.message }))
  process.exit(1)
}
