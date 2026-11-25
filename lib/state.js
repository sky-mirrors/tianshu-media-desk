// 持久化：<插件数据目录>/state.json。天枢插件写不了任意路径，只写宿主给的 dataDir。
// 同一个进程里可能有并发写（工具调用 + 面板消息），所以读写都串行排队。
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 空工作台。上游首启会灌示例数据（依赖 assets 里的图片），天枢版不灌：装插件是为了写自己的东西。 */
export function initialState() {
  return {
    items: [],
    people: [],
    angles: [],
    styles: [],
    skills: [],
    metrics: [],
    accounts: [],
    chat: [],
    activeStyleId: null,
    draftFormat: 'script',
  }
}

export class State {
  /** @param {string} root - 插件数据目录。 */
  constructor(root) {
    this.root = root
    this.file = join(root, 'state.json')
    this.filesDir = join(root, 'files')
    this.state = null
    // 另一个进程写过没有：靠 mtime 判断。界面服务和命令行是两个进程共用一份 state.json。
    this.mtimeMs = 0
    this.queue = Promise.resolve()
    this.filesDirReady = null
  }

  async refresh() {
    // filesDir 建一次就够：每次 read 都 mkdir 是白付一次 syscall。失败就把闸门复位，下次重试。
    this.filesDirReady ??= mkdir(this.filesDir, { recursive: true }).catch((err) => {
      this.filesDirReady = null
      throw err
    })
    await this.filesDirReady
    let info = null
    try {
      info = await stat(this.file)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (!info) {
      if (!this.state) {
        this.state = initialState()
        await this.persist()
      }
      return
    }
    // 文件没被别的进程动过就用内存里的；动过就重读，否则界面看不到命令行的写入。
    if (this.state && info.mtimeMs === this.mtimeMs) return
    this.state = JSON.parse(await readFile(this.file, 'utf8'))
    this.mtimeMs = info.mtimeMs
  }

  async persist() {
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.state))
    await rename(tmp, this.file)
    // 记下自己的写入时间，下一次 refresh 才不会把刚写的又读一遍
    this.mtimeMs = (await stat(this.file)).mtimeMs
  }

  /** 丢掉内存里的状态并从磁盘重读：回滚用，也省掉每次 mutate 前的全量深拷贝。 */
  async reload() {
    this.state = JSON.parse(await readFile(this.file, 'utf8'))
    this.mtimeMs = (await stat(this.file)).mtimeMs
  }

  /** 串行执行，避免同一进程内的并发写互相覆盖。 */
  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  read() {
    return this.run(async () => {
      await this.refresh()
      return this.state
    })
  }

  /**
   * 就地修改状态并落盘。改到一半抛错或落盘失败时从磁盘重读退回调用前的状态——
   * 否则半截修改会留在内存里，被下一次成功写入顺带写进磁盘。
   * @param {(state: object) => any} mutate - 就地修改状态。
   * @returns {Promise<any>} mutate 的返回值。
   */
  mutate(mutate) {
    return this.run(async () => {
      await this.refresh()
      try {
        const result = await mutate(this.state)
        await this.persist()
        return result
      } catch (err) {
        // 磁盘上还是调用前那一份，重读即回滚。重读也失败就把内存置空，下一次 read 重新加载。
        try {
          await this.reload()
        } catch {
          this.state = null
        }
        throw err
      }
    })
  }
}
