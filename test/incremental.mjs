// 增量注入的验证：首次全量 → 之后只注入新增 → 无变化返回 null（**不是空串**）。
//
// 为什么最后那条是关键：DSH 把「当前运行时上下文为空」渲染成 CLEARED
// （"Earlier runtime-context snapshots no longer apply."）。若本插件在"没有新条目"时返回空串，
// 模型会收到一条"以前的记忆全部作废"的消息——比多花 token 严重得多。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEntry } from '../lib/store.js'
import { entryFingerprint, renderIncremental } from '../lib/inject.js'

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
  if (cond) pass++
  else fail++
}

const root = mkdtempSync(join(tmpdir(), 'mem-md-inc-'))
const memFile = join(root, '.deepseek-harness', 'MEMORY.md')
const layers = [{ level: 'project', label: '项目级记忆 (test)', file: memFile }]

try {
  console.log('=== 首次注入 ===')
  await appendEntry(memFile, '第零条记忆')
  const first = renderIncremental({ layers })
  check('首次给全量（带"你的记忆"标题）', first.text !== null && first.text.includes('你的记忆'))
  check('首次 added 等于条目数', first.added === 1, String(first.added))

  console.log('\n=== 新增一条：只注入那一条 ===')
  await appendEntry(memFile, '第一条记忆')
  const second = renderIncremental({ layers, previous: { text: first.text, fingerprints: first.fingerprints } })
  check('输出含新条目', second.text !== null && second.text.includes('第一条记忆'))
  check('不含旧条目（不重发全量）', second.text !== null && !second.text.includes('第零条记忆'))
  check('不再是全量标题，而是"记忆更新"', second.text !== null && second.text.includes('记忆更新'))
  check('added = 1', second.added === 1, String(second.added))

  console.log('\n=== 无变化：返回 null ===')
  const third = renderIncremental({ layers, previous: { text: second.text, fingerprints: second.fingerprints } })
  check('text 为 null（调用方复用上次文本 → DSH 判为未变）', third.text === null, String(third.text))
  check('added = 0', third.added === 0)

  console.log('\n=== 再新增一条：只含最新的 ===')
  await appendEntry(memFile, '第二条记忆')
  const fourth = renderIncremental({ layers, previous: { text: second.text, fingerprints: third.fingerprints } })
  check('只含第二条', fourth.text !== null && fourth.text.includes('第二条记忆') && !fourth.text.includes('第一条记忆'))

  console.log('\n=== 条目被改写：视作新增并重新注入 ===')
  writeFileSync(memFile, '- 第零条记忆\n- 第一条记忆（已更正）\n- 第二条记忆\n', 'utf8')
  const fifth = renderIncremental({ layers, previous: { text: fourth.text, fingerprints: fourth.fingerprints } })
  check('改写后的版本被重新注入', fifth.text !== null && fifth.text.includes('已更正'))

  console.log('\n=== 指纹稳定性 ===')
  check('列表符/空白差异不影响指纹', entryFingerprint('-  某条记忆 ') === entryFingerprint('* 某条记忆'))
  check('内容不同则指纹不同', entryFingerprint('- 甲') !== entryFingerprint('- 乙'))

  console.log('\n=== 预算兜底 ===')
  writeFileSync(memFile, '', 'utf8')
  await appendEntry(memFile, 'AAA'.repeat(60))
  await appendEntry(memFile, 'BBB'.repeat(60))
  const freshState = renderIncremental({ layers, budget: 80, summaryChars: 200 })
  const entryLines = (freshState.text?.match(/^- /gm) ?? []).length
  check('超预算时只收首条（预算是条目预算，不含标题与体积行）', freshState.text !== null && entryLines === 1, `${entryLines} 条 / ${freshState.text?.length} 字符`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass} 项通过, ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
