// 针对**真实环境**的验证（重启后在任意会话里可跑）：
//   node test/verify-live.mjs [cwd]
// 只读真实记忆文件；写入往返在系统临时目录做，绝不碰真实记忆。
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLayers } from '../lib/paths.js'
import { renderMemory, renderRead, summarizeEntry } from '../lib/inject.js'
import {
  appendEntry,
  atomicWrite,
  contentHash,
  MemoryConflictError,
  parseEntries,
  readSync,
  removeEntries,
} from '../lib/store.js'

const cwd = process.argv[2] ?? process.cwd()
let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

console.log(`会话 cwd: ${cwd}\n`)

console.log('=== 1. 分层解析（应命中真实记忆文件）===')
const layers = resolveLayers({ cwd })
for (const layer of layers) {
  const exists = existsSync(layer.file)
  const size = exists ? statSync(layer.file).size : 0
  const count = exists ? parseEntries(readSync(layer.file)).length : 0
  console.log(
    `  ${layer.level.padEnd(8)} ${exists ? 'EXISTS' : 'absent'} ${String(size).padStart(7)}B ${String(count).padStart(3)} 条  ${layer.file}`,
  )
}
check('至少解析出用户级一层', layers.some((l) => l.level === 'user'))
check('层顺序为宽松→具体', layers.every((l, i) => i === 0 || l.level !== 'user'))

console.log('\n=== 2. 注入渲染（每步实际进上下文的文本）===')
const summary = renderMemory({ layers })
const full = renderMemory({ layers, summaryChars: 0 })
console.log(`  摘要化: ${summary.length} 字符`)
console.log(`  整段  : ${full.length} 字符`)
if (summary.length > 0) {
  console.log(`  ---- 头部 200 ----\n${summary.slice(0, 200)}`)
  console.log(`  ---- 尾部 200 ----\n${summary.slice(-200)}`)
}
check('摘要化不大于整段注入', summary.length <= Math.max(full.length, 1), `${summary.length} <= ${full.length}`)
check('注入里没有未中和的双花括号', !summary.includes('{{'))

console.log('\n=== 3. 读全文（memory_read 的等价行为）===')
const read = renderRead({ layers })
console.log(`  返回 ${read.text.length} 字符，${read.volume.length} 层有内容`)
check('读全文不少于摘要化', read.text.length >= summary.length)

console.log('\n=== 4. 写入往返（临时目录，不碰真实记忆）===')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-memory-md-verify-'))
try {
  const file = join(tmp, 'MEMORY.md')
  const first = await appendEntry(file, '验证条目 A')
  const second = await appendEntry(file, '验证条目 B')
  const duplicate = await appendEntry(file, '验证条目 A')
  check('首次写入生效', first.changed === true)
  check('第二条追加生效', second.changed === true)
  check('重复写入被去重', duplicate.changed === false && duplicate.reason === 'duplicate')
  check('文件里恰好两条', parseEntries(readSync(file)).length === 2)
  check('无临时文件残留', readdirSync(tmp).filter((name) => name.includes('.tmp-')).length === 0)

  const stale = contentHash(readSync(file))
  writeFileSync(file, '- 外部改动\n', 'utf8')
  let conflicted = false
  try {
    await atomicWrite(file, '- 覆盖尝试\n', stale)
  } catch (error) {
    conflicted = error instanceof MemoryConflictError
  }
  check('CAS 拒绝被外部改动后的写入', conflicted)
  check('外部改动被保留（未被静默覆盖）', readSync(file).includes('外部改动'))

  const removed = await removeEntries(file, '外部改动')
  check('按内容删除生效', removed.removed === 1)
  console.log(`  摘要函数自检: ${summarizeEntry('- ' + 'z'.repeat(200), 40)}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
