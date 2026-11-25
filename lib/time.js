// 时间文案只有一套：工具回执、上下文块、操作回执都从这里取，别各写一份慢慢漂开。
// 面板（views/desk.js）是独立的经典脚本，import 不了模块，它自己那份保持同格式即可。

const pad = v => String(v).padStart(2, '0')

/** 只到日：「3月1日」。 */
export function monthDay(value) {
  const d = new Date(value)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 「3月1日 20:00」；没有值返回空串。 */
export function whenText(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${monthDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
