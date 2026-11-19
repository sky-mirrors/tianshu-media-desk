/**
 * tpi.js — TPI 2.0 SDK 入口（随插件分发）。
 *
 * 宿主在加载插件前把 SDK 装到 globalThis；宿主之外 import 本插件会直接抛错，
 * TPI 插件不能脱离天枢运行。
 */
export function defineTianshuPlugin(spec) {
  const sdk = globalThis.__tianshuTPI;
  if (!sdk) throw new Error('not running inside Tianshu: TPI plugins load only through the Tianshu host');
  return sdk.defineTianshuPlugin(spec);
}
