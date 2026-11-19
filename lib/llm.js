// 旁路模型（sidePathLLM）的适配层：把模型回来的各种形状收成纯文本，再从文本里抠出 JSON。
// 上游同名逻辑在 dsh-media-desk 的 src/ai.js（extractJson / callModel）。

/** 从 ```json 围栏或裸文本里取第一个能解析的 JSON 对象。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('模型没有返回内容')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidates = [fenced?.[1], raw]
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    try {
      const value = JSON.parse(candidate.trim())
      // 数组也满足 typeof 'object'，但它不是策划案；放过去会让上层当成空对象处理。
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('模型返回的不是 JSON')
}

/**
 * sidePathLLM.complete 的返回结构没有在宿主侧取证到明文（混淆代码只透传），
 * 所以这里接受常见的几种形状；都不是就报错，不猜内容。
 */
export function textOf(result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    for (const key of ['text', 'content', 'output']) {
      if (typeof result[key] === 'string') return result[key]
    }
    if (typeof result.message?.content === 'string') return result.message.content
  }
  throw new Error('看不懂旁路模型的返回结构')
}

export const PLAN_SYSTEM = '你是内容主编、美术指导和分镜师。只输出一个 JSON 对象，不要任何解释、不要围栏以外的文字。'
export const ARTICLE_SYSTEM = '你是这位创作者本人。只输出 Markdown 正文，不要解释、不要前后缀。'
