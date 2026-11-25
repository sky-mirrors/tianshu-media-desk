// 天枢界面是中文的，上游那套中英双语运行时分枝在这里收成单一语言。
// ops.js 只依赖 tr / platformName 两个符号（时间文案在 lib/time.js）。

/** 翻译一段给用户看的文字。key 是中文原文，{name} 是占位符。 */
export function tr(zh, vars) {
  return vars ? zh.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key]))) : zh
}

/** 平台在数据里一直是中文值。 */
export function platformName(platform) {
  return platform
}
