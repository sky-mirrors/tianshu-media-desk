// 命令行直接调插件：不经过宿主，用完即走。
//   node scripts/local-run.mjs tools
//   node scripts/local-run.mjs call media_idea '{"text":"一句话灵感"}'
//   node scripts/local-run.mjs demo
//
// 想用界面就用 scripts/serve.mjs。数据与它共用（默认 .local-data/，MEDIA_DESK_DATA 可覆盖）。
import { join } from 'node:path'

import { loadPlugin } from './host.mjs'

const [command, ...rest] = process.argv.slice(2)

if (command === 'tools') {
  const { manifest, api, dataDir } = await loadPlugin({ quiet: true })
  console.log(`${manifest.displayName} v${manifest.version}（${manifest.id}，TPI ${manifest.$tpi}）`)
  console.log(`数据目录：${dataDir}`)
  console.log(`面板：${(manifest.contributes?.ui?.views ?? []).map(v => `${v.title}(${v.entry})`).join('、') || '无'}`)
  for (const tool of api.tools) {
    console.log(`\n${tool.name}\n  ${tool.description}`)
  }
} else if (command === 'call') {
  const name = rest[0]
  const args = rest[1] ? JSON.parse(rest[1]) : {}
  const { api, workDir } = await loadPlugin({ quiet: true })
  const tool = api.tools.find(row => row.name === name)
  if (!tool) {
    console.error(`没有这个工具：${name}`)
    process.exit(2)
  }
  const result = await tool.execute({ args, cwd: workDir })
  if (result.isError) {
    console.error(result.content)
    process.exit(1)
  }
  console.log(result.content)
} else if (command === 'demo') {
  const { api, blocks, workDir, dataDir } = await loadPlugin({ quiet: true })
  const call = async (name, args = {}) => {
    const result = await api.tools.find(row => row.name === name).execute({ args, cwd: workDir })
    console.log(`\n${result.isError ? '✘' : '✔'} ${name} ${args.id ?? ''}`)
    console.log(result.content.split('\n').slice(0, 6).map(line => `  ${line}`).join('\n'))
    if (result.isError) process.exitCode = 1
    return result
  }

  const created = await call('media_idea', { text: '本地宿主验证：一句话记灵感，然后一键成稿', tags: ['测试'] })
  const id = /it_[a-z0-9]+/.exec(created.content)?.[0]
  await call('media_list')
  await call('media_brief', { id, imageCount: 1, shotCount: 2 })
  await call('media_save', {
    id,
    kind: 'plan',
    plan: {
      title: '本地宿主跑通了', coverText: '真的能跑', facts: ['7 个工具'],
      outline: ['记灵感', '写正文'], cover: 'a desk with a laptop, warm light',
      images: [{ anchor: '写正文', caption: '正文', prompt: 'a notebook page' }],
      shots: [{ shot: '近景', visual: '屏幕亮起', voice: '它真的跑起来了', seconds: 3, prompt: 'screen lighting up' }],
    },
  })
  await call('media_save', { id, kind: 'script', text: '# 本地宿主跑通了\n\n## 记灵感\n一句话就够。\n\n## 写正文\n简报给规范，模型写内容。\n' })
  await call('media_item', { id })
  // 导出到数据目录下，工程目录保持干净
  await call('media_export', { id, dir: join(dataDir, 'export') })

  console.log('\n— 上下文块（本应写进每轮对话）—')
  console.log(blocks.at(-1) ?? '（空台账或本机未启用 promptContext）')
} else {
  console.log('用法：')
  console.log('  node scripts/local-run.mjs tools')
  console.log('  node scripts/local-run.mjs call <tool> \'<json>\'')
  console.log('  node scripts/local-run.mjs demo')
  console.log('界面：node scripts/serve.mjs')
}
