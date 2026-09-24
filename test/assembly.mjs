// 装配测试：用 mock ctx 驱动 apply()，验证「注册面 + 注入文本 + 4 个工具的端到端行为」。
// 跑法：node --import ./test/register.mjs test/assembly.mjs
//
// 这一步的价值：不用等 DSH 重启，就能确证插件装配逻辑、注入内容与工具契约都对。
// 工具写入落在系统临时目录，绝不碰真实记忆文件。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, inject as injectList, name } from '../lib/index.js'

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
  if (cond) pass++
  else fail++
}

const sections = []
const contexts = []
const tools = []
const ctx = {
  systemPrompt: {
    section: (entry) => sections.push(entry),
    context: (entry) => contexts.push(entry),
  },
  tools: { register: (tool) => tools.push(tool) },
}

// 建临时工作目录，并把用户级也指向临时路径 —— 否则会读到真实的 ~/.deepseek-harness/MEMORY.md，
// 于是「空层不注入」这类断言就不能成立（那是测试环境的坑，不是插件行为）。
const tmp = mkdtempSync(join(tmpdir(), 'mem-md-assembly-'))
const memoryFile = join(tmp, '.deepseek-harness', 'MEMORY.md')
const userFile = join(tmp, 'user-memory.md')

// 只覆盖 userMemoryPaths，其余键走 apply() 的默认值兜底（顺带验证兜底生效）。
// rootMarkers 显式收窄成 ['.git']：临时目录建在家目录下，用默认标记会向上找到家目录。
apply(ctx, { userMemoryPaths: [userFile], rootMarkers: ['.git'] })

console.log('=== 1. 注册面 ===')
check('cordis name 为 memory-md', name === 'memory-md', name)
check('inject 声明 systemPrompt / tools', injectList.includes('systemPrompt') && injectList.includes('tools'))
check('注册 1 个 section、1 个 context、4 个工具', sections.length === 1 && contexts.length === 1 && tools.length === 4, `${sections.length}/${contexts.length}/${tools.length}`)
check(
  '四个工具名齐全',
  ['memory_note', 'memory_note_user', 'memory_read', 'memory_forget'].every((n) => tools.some((t) => t.name === n)),
  tools.map((t) => t.name).join(','),
)
check('导出 Config（宿主据此渲染设置）', Config !== undefined && Config.__stubSchema === true)

console.log('\n=== 2. 恒定指令（section）===')
const rules = sections[0].text()
check('指令提到写入/读取/删除工具', rules.includes('memory_note') && rules.includes('memory_read') && rules.includes('memory_forget'))
check('指令声明「写入后本会话下一步即可见」', rules.includes('下一步即可见'))
check('指令声明「不记工具输出原文」', rules.includes('工具输出原文'))

const tmpWasCreatedAbove = true
void tmpWasCreatedAbove
try {
  const agent = { agent: { session: { header: { cwd: tmp } } } }

  console.log('\n=== 3. 注入（context 函数形态）===')
  check('空层时注入空串（不注入空壳）', contexts[0].text(agent) === '')

  console.log('\n=== 4. memory_note 端到端 ===')
  const note = tools.find((t) => t.name === 'memory_note')
  const first = await note.execute({ content: '装配测试条目' }, agent)
  check('写入成功', first.ok === true && first.changed === true, JSON.stringify(first).slice(0, 80))
  check('落盘到 <cwd>/.deepseek-harness/MEMORY.md', existsSync(memoryFile) && readFileSync(memoryFile, 'utf8').includes('装配测试条目'))
  check('写入后注入里立刻可见（这就是「不用重启」的机制）', contexts[0].text(agent).includes('装配测试条目'))

  const dup = await note.execute({ content: '装配测试条目' }, agent)
  check('重复写入被去重', dup.changed === false && dup.ok === true, JSON.stringify(dup).slice(0, 80))

  console.log('\n=== 5. scope 路由 ===')
  const toProject = await note.execute({ content: '项目级条目', scope: 'project' }, agent)
  check('cwd 即项目根时 scope=project 与 session 同层', toProject.file === memoryFile, toProject.file)

  console.log('\n=== 6. 子代理开关 ===')
  const subagent = { agent: { session: { header: { cwd: tmp, origin: 'subagent' } } } }
  check('默认（injectInSubagents=true）子代理也注入', contexts[0].text(subagent).includes('装配测试条目'))

  console.log('\n=== 7. memory_read ===')
  const read = tools.find((t) => t.name === 'memory_read')
  const readAll = await read.execute({ scope: 'all' }, agent)
  check('读全文含已写条目', readAll.message.includes('装配测试条目'))
  const readUser = await read.execute({ scope: 'user' }, agent)
  check('scope=user 只读用户级', !readUser.message.includes('装配测试条目'))

  console.log('\n=== 8. memory_forget 两阶段 ===')
  const forget = tools.find((t) => t.name === 'memory_forget')
  const preview = await forget.execute({ match: '装配测试' }, agent)
  check('不传 confirm 只预览', preview.preview === true && Array.isArray(preview.matched) && preview.matched.length === 1)
  check('预览阶段文件未变', readFileSync(memoryFile, 'utf8').includes('装配测试条目'))
  const done = await forget.execute({ match: '装配测试', confirm: true }, agent)
  check('confirm 后真删', done.removed === 1 && !readFileSync(memoryFile, 'utf8').includes('装配测试条目'))
  check('同目录其它条目未受影响', readFileSync(memoryFile, 'utf8').includes('项目级条目'))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} 项通过, ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
