// 测试专用模块解析钩子：把宿主的两个包指向本地 stub，使 lib/index.js 能在
// 不装 DSH 依赖的情况下被 import（装配测试用）。
const STUBS = new Map([
  ['@deepseek-ai/schemastery', new URL('./stubs/schemastery.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-tools', new URL('./stubs/dsh-tools.mjs', import.meta.url).href],
])

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier)
  if (stub !== undefined) return { url: stub, shortCircuit: true }
  return next(specifier, context)
}
