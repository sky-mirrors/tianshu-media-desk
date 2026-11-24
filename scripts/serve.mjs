// 本地工作台服务：把面板真的跑起来，浏览器里就是完整界面。
//   node scripts/serve.mjs [--port 8788] [--open]
//
// 面板本来是宿主 iframe 里的页面，用 postMessage 和插件通信。这里起一个本地 HTTP 服务，
// 把同一份 views/ 静态文件发出去，并把 postMessage 换成 POST /rpc —— 面板代码只多一条传输分支。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

import { loadPlugin, pluginDir } from './host.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const port = Number(argOf('--port', process.env.MEDIA_DESK_PORT ?? 8788))
const host = argOf('--host', '127.0.0.1')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

const { api, dataDir, preTurn } = await loadPlugin({ quiet: true, onBlock: (block) => {
  console.log('\n— 上下文块（宿主里会写进每轮对话）—')
  console.log(block)
} })

const readBody = (req, limit = 2_000_000) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) {
      reject(new Error('请求体过大'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`)
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    // 静态文件是 Buffer：直接送，别让 JSON.stringify 把它变成 {"type":"Buffer",...}
    if (Buffer.isBuffer(body)) res.end(body)
    else res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  try {
    if (url.pathname === '/rpc' && req.method === 'POST') {
      const payload = JSON.parse(await readBody(req))
      await preTurn()
      const value = await api.ui.onMessage('desk', payload)
      return send(200, { value })
    }

    // 静态文件：views/ 下的资源，只允许这两个子目录，路径不能逃出去
    const rel = url.pathname === '/' ? '/desk.html' : url.pathname
    if (rel.startsWith('/files/')) {
      return send(404, { error: '本地服务不代理插件文件' })
    }
    const target = normalize(join(pluginDir, 'views', rel))
    if (!target.startsWith(join(pluginDir, 'views'))) return send(403, { error: '路径越界' })
    const data = await readFile(target)
    return send(200, data, MIME[extname(target)] ?? 'application/octet-stream')
  } catch (err) {
    if (err.code === 'ENOENT') return send(404, { error: 'Not Found' })
    return send(500, { error: err.message })
  }
})

server.listen(port, host, () => {
  console.log(`自媒体工作台已启动：http://${host}:${port}/`)
  console.log(`数据目录：${dataDir}`)
  console.log(process.env.MEDIA_DESK_LLM_KEY ? '一键成稿：已接入模型（环境变量）' : '一键成稿：未接模型（设 MEDIA_DESK_LLM_* 环境变量后可用）')
  console.log('Ctrl+C 退出')
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
