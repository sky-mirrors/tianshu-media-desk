// 导出：把成稿写成一份能直接发的 Markdown，图片按相对路径引用。
// 工作区写入由 index.js 负责（宿主的 workspace.write 一次一个文件），这里只产出内容。
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 文件名：标题里的路径字符换成连字符。 */
export function slugify(title, fallback = 'untitled') {
  const text = String(title ?? '').trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60)
  return text || fallback
}

function imageRef(src, assets) {
  const name = basename(String(src).replace(/\\/g, '/'))
  if (!assets.includes(name)) return ''
  return name
}

/**
 * 成稿 → Markdown 文本。图片按 `assets/文件名` 引用，缺失的静默跳过（这里不猜路径）。
 * @param {object} production - 成稿。
 * @param {object} item - 灵感条目。
 * @returns {{markdown: string, assets: Array<{name: string, src: string}>}}
 */
export function renderMarkdown(production, item) {
  const assets = []
  const take = (src) => {
    if (!src) return null
    const name = basename(String(src).replace(/\\/g, '/'))
    assets.push({ name, src })
    return name
  }

  const lines = [`# ${production.title || item.title}`, '']
  if (production.coverText) lines.push(`> 封面大字：${production.coverText}`, '')
  const cover = take(production.cover?.src)
  if (cover) lines.push(`![封面](assets/${cover})`, '')

  if (production.facts?.length) {
    lines.push('**事实**', '', ...production.facts.map(row => `- ${row}`), '')
  }

  const images = (production.images ?? []).map(row => ({ ...row, file: take(row.src) }))
  const body = String(production.article ?? '').trim()
  if (body) {
    const blocks = body.split(/^(?=##\s+)/m)
    let index = 0
    lines.push(blocks[0].trim(), '')
    for (const block of blocks.slice(1)) {
      const heading = /^##\s+(.+)$/m.exec(block)?.[1]?.trim()
      lines.push(block.trim(), '')
      const matched = images.filter(row => {
        if (!row.file) return false
        if (row.anchor && heading) return row.anchor.trim() === heading
        return false
      })
      for (const row of matched) {
        lines.push(`![${row.caption || row.anchor || '配图'}](assets/${row.file})`, '')
        if (row.caption) lines.push(`*${row.caption}*`, '')
        index += 1
      }
    }
    // 没有 anchor 的配图统一放到正文末尾，不丢图
    for (const row of images.filter(r => r.file && !r.anchor)) {
      lines.push(`![${row.caption || '配图'}](assets/${row.file})`, '')
      if (row.caption) lines.push(`*${row.caption}*`, '')
    }
  }

  if (production.shots?.length) {
    lines.push('## 分镜', '', '| # | 景别 | 画面 | 口播 | 秒 |', '| --- | --- | --- | --- | --- |')
    for (const [i, shot] of production.shots.entries()) {
      const cells = [String(i + 1), shot.shot ?? '', shot.visual ?? '', shot.voice ?? '', String(shot.seconds ?? '')]
      lines.push(`| ${cells.map(cell => String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
      take(shot.src)
    }
    lines.push('')
  }

  const meta = [
    item.platform ? `平台：${item.platform}` : '',
    item.scheduledAt ? `排期：${item.scheduledAt}` : '',
    item.tags?.length ? `标签：${item.tags.join('、')}` : '',
    item.url ? `来源：${item.url}` : '',
  ].filter(Boolean)
  if (meta.length) lines.push('---', '', meta.join('  \n'), '')

  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n'), assets: dedupe(assets) }
}

function dedupe(assets) {
  const seen = new Set()
  return assets.filter(row => (seen.has(row.name) ? false : (seen.add(row.name), true)))
}

/**
 * 落盘：Markdown 一份，图片复制到同目录 assets/ 下。
 * @param {object} production
 * @param {object} item
 * @param {{dir: string}} options - dir 必须是宿主的 POSIX 绝对路径。
 * @returns {Promise<{path: string, copied: string[], missing: string[]}>}
 */
export async function exportProduction(production, item, { dir }) {
  const { markdown, assets } = renderMarkdown(production, item)
  const assetsDir = join(dir, 'assets')
  const copied = []
  const missing = []
  // 目录一定要自己建：没有图片时不会走 mkdir(assetsDir)，不能靠它顺带建父目录。
  await mkdir(dir, { recursive: true })
  if (assets.length) await mkdir(assetsDir, { recursive: true })
  for (const row of assets) {
    try {
      await copyFile(row.src, join(assetsDir, row.name))
      copied.push(row.name)
    } catch {
      missing.push(row.name)
    }
  }
  const path = join(dir, `${slugify(production.title || item.title)}.md`)
  await writeFile(path, markdown, 'utf8')
  return { path, copied, missing }
}
