// 天枢界面是中文的，上游那套中英双语运行时分枝在这里收成单一语言。
// ops.js / style.js 依赖 tr / currentLang / byLang / platformName 四个符号。

export function currentLang() {
  return 'zh'
}

/** 翻译一段给用户看的文字。key 是中文原文，{name} 是占位符。 */
export function tr(zh, vars) {
  return vars ? zh.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key]))) : zh
}

/** 按当前语言二选一。天枢只有中文，保留这个符号是为了让上游代码原样复用。 */
export function byLang(zh) {
  return zh
}

/** 平台在数据里一直是中文值。 */
export function platformName(platform) {
  return platform
}
