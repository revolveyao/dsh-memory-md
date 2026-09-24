// 核心逻辑的最小可运行验证：存储层（追加/去重/CAS/删除）+ 分层路径解析。
// 全部用例都 await —— 同步 check 包装 async 函数会让异常落进未处理的 rejection，
// 表现为「假通过」（这是本项目踩过的坑，见工程记忆）。
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryConflictError,
  appendEntry,
  atomicWrite,
  contentHash,
  parseEntries,
  readSync,
  removeEntries,
} from '../lib/store.js'
import { resolveLayers } from '../lib/paths.js'
import { clipTail, neutralizeBraces, renderMemory, summarizeEntry } from '../lib/inject.js'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (error) {
    fail++
    console.error(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`)
}
function ok(cond, label = 'assertion failed') {
  if (!cond) throw new Error(label)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-md-'))
const file = join(root, 'MEMORY.md')
// 测试目录建在系统临时区，向上查找会经过家目录（那里有 .deepseek-harness），
// 故显式收窄标记，避免被测成"家目录才是项目根"。
const MARKERS = ['.git']

try {
  await check('appendEntry：首次写入建立文件', async () => {
    const r = await appendEntry(file, '第一条')
    ok(r.changed, 'should change')
    eq(readSync(file), '- 第一条\n', 'content')
  })

  await check('appendEntry：追加第二条，条目间空行分隔', async () => {
    await appendEntry(file, '第二条')
    eq(readSync(file), '- 第一条\n\n- 第二条\n', 'content')
  })

  await check('appendEntry：同一条重复写入被跳过', async () => {
    const r = await appendEntry(file, '第二条')
    eq(r.changed, false)
    eq(r.reason, 'duplicate')
    eq(parseEntries(readSync(file)).length, 2, 'entry count')
  })

  await check('去重按归一化等值：列表符/空白差异视为同一条', async () => {
    const r = await appendEntry(file, '  -   第二条   ')
    eq(r.changed, false, 'should be duplicate')
  })

  await check('去重不用子串：新条目是旧条目的前缀扩展时仍应写入', async () => {
    writeFileSync(file, '- 用户偏好：代码改动后由用户自己测试\n', 'utf8')
    const r = await appendEntry(file, '用户偏好：代码改动后由用户自己测试，交付时给出清单')
    eq(r.changed, true, 'should append (substring must not count as duplicate)')
    eq(parseEntries(readSync(file)).length, 2, 'entry count')
  })

  await check('CAS：读到旧版本后文件被外部改动 → 拒绝写入且保留外部内容', async () => {
    const stale = contentHash(readSync(file))
    writeFileSync(file, '- 外部编辑的内容\n', 'utf8')
    let threw = false
    try {
      await atomicWrite(file, '- 我要写的内容\n', stale)
    } catch (error) {
      threw = error instanceof MemoryConflictError
    }
    ok(threw, 'should throw MemoryConflictError')
    eq(readSync(file), '- 外部编辑的内容\n', 'external edit must survive')
  })

  await check('CAS：版本相符时写入成功', async () => {
    const current = contentHash(readSync(file))
    await atomicWrite(file, '- 新内容\n', current)
    eq(readSync(file), '- 新内容\n', 'content')
  })

  await check('原子写不残留临时文件', async () => {
    const leftovers = readdirSync(root).filter((name) => name.includes('.tmp-'))
    eq(leftovers, [], 'temp files')
  })

  await check('removeEntries：只删命中条目，结构行保留', async () => {
    writeFileSync(file, '# 章节\n\n- 要删掉的条目\n- 要保留的条目\n', 'utf8')
    const r = await removeEntries(file, '要删掉')
    eq(r.removed, 1, 'removed count')
    const after = readSync(file)
    ok(after.includes('# 章节'), 'heading kept')
    ok(after.includes('- 要保留的条目'), 'other entry kept')
    ok(!after.includes('- 要删掉的条目'), 'target removed')
  })

  await check('resolveLayers：用户级 → 项目级 → 会话目录级，顺序与归属正确', async () => {
    const proj = join(root, 'proj')
    const sub = join(proj, 'abap')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    const layers = resolveLayers({ cwd: sub, userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    eq(layers.map((l) => l.level), ['user', 'project', 'subdir'], 'levels')
    eq(layers[1].dir, proj, 'project dir')
    eq(layers[2].dir, sub, 'subdir dir')
  })

  await check('resolveLayers：cwd 即项目根时不产生重复层', async () => {
    const proj = join(root, 'proj2')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const layers = resolveLayers({ cwd: proj, userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    eq(layers.map((l) => l.level), ['user', 'project'], 'levels')
  })

  await check('resolveLayers：多层嵌套时从根到 cwd 逐级列出', async () => {
    const proj = join(root, 'proj3')
    const mid = join(proj, 'apps')
    const leaf = join(mid, 'web')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(leaf, { recursive: true })
    const layers = resolveLayers({ cwd: leaf, userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    eq(layers.map((l) => l.dir), [null, proj, mid, leaf], 'dirs')
    eq(layers.map((l) => l.level), ['user', 'project', 'subdir', 'subdir'], 'levels')
  })

  await check('resolveLayers：cwd 不在项目根下时只列出自身', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    const layers = resolveLayers({ cwd: proj6(), userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    eq(layers.length, 2, 'user + single dir')
  })

  await check('多候选：目录下只有 workbuddy 记忆时，读它并写回它', async () => {
    const proj = join(root, 'proj-wb')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(join(proj, '.workbuddy', 'memory'), { recursive: true })
    writeFileSync(join(proj, '.workbuddy', 'memory', 'MEMORY.md'), '- WB 记忆\n', 'utf8')
    const layers = resolveLayers({ cwd: proj, userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    const project = layers.filter((l) => l.level === 'project')
    eq(project.length, 1, 'one project layer')
    ok(project[0].file.includes(join('.workbuddy', 'memory')), 'points at workbuddy path')
    ok(project[0].primary === true, 'workbuddy is the write target')
  })

  await check('多候选：两份都在时都读，primary 取 .deepseek-harness', async () => {
    const proj = join(root, 'proj-both')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(join(proj, '.deepseek-harness'), { recursive: true })
    mkdirSync(join(proj, '.workbuddy', 'memory'), { recursive: true })
    writeFileSync(join(proj, '.deepseek-harness', 'MEMORY.md'), '- dsh 记忆\n', 'utf8')
    writeFileSync(join(proj, '.workbuddy', 'memory', 'MEMORY.md'), '- wb 记忆\n', 'utf8')
    const layers = resolveLayers({ cwd: proj, userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    const project = layers.filter((l) => l.level === 'project')
    eq(project.length, 2, 'both layers are read')
    ok(project[0].file.includes('.deepseek-harness'), 'dsh listed first')
    ok(project[0].primary === true, 'dsh is primary')
    ok(project[1].primary === false, 'workbuddy is read-only side')
  })

  await check('多候选：都不存在时退回第一个候选作为写入目标', async () => {
    const proj = join(root, 'proj-none')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const layers = resolveLayers({ cwd: proj, userMemoryPaths: [join(root, 'user.md')], rootMarkers: MARKERS })
    const project = layers.filter((l) => l.level === 'project')
    eq(project.length, 1, 'single fallback layer')
    ok(project[0].file.includes('.deepseek-harness'), 'falls back to dsh path')
    ok(project[0].primary === true, 'fallback remains writable')
  })

  await check('用户级默认只认 DSH 自己的文件（不桥接 ~/.workbuddy）', async () => {
    const layers = resolveLayers({ cwd: join(root, 'no-such-dir'), rootMarkers: MARKERS })
    const user = layers.filter((l) => l.level === 'user')
    eq(user.length, 1, 'single user layer')
    ok(user[0].file.includes('.deepseek-harness'), 'user memory stays in .deepseek-harness')
  })

  await check('clipTail：超预算保留尾部（最近写入）并报告省略量', async () => {
    const long = Array.from({ length: 50 }, (_, i) => `- 第 ${i} 条内容`).join('\n')
    const clipped = clipTail(long, 100)
    ok(clipped.startsWith('…（本层超预算'), 'has omission marker')
    ok(clipped.includes('第 49 条内容'), 'keeps newest entry')
    ok(!clipped.includes('第 0 条内容'), 'drops oldest entry')
  })

  await check('clipTail：预算内原样返回', async () => {
    eq(clipTail('- 短内容', 100), '- 短内容', 'unchanged')
    eq(clipTail('- 任意长内容', 0), '- 任意长内容', 'budget 0 means unlimited')
  })

  await check('neutralizeBraces：中和 {{ ——否则该会话全部模型请求会一起失败', async () => {
    const out = neutralizeBraces('正文有 {{name}} 与 {{{{x}}}}')
    ok(!out.includes('{{'), 'no double brace left')
  })

  await check('renderMemory：空层跳过，非空层带标题与体积行', async () => {
    const filled = join(root, 'inj-filled.md')
    const empty = join(root, 'inj-empty.md')
    writeFileSync(filled, '- 用户级一条\n', 'utf8')
    const text = renderMemory({
      layers: [
        { level: 'user', label: '用户级记忆 (~/x)', file: filled },
        { level: 'subdir', label: '会话目录记忆 (D:/y)', file: empty },
      ],
    })
    ok(text.includes('用户级记忆'), 'labels the filled layer')
    ok(!text.includes('会话目录记忆'), 'skips the empty layer')
    ok(text.includes('记忆体积'), 'appends volume line')
  })

  await check('renderMemory：各层都空时返回空串（不注入空壳）', async () => {
    eq(renderMemory({ layers: [{ level: 'user', label: 'x', file: join(root, 'absent.md') }] }), '', 'empty result')
  })

  await check('summarizeEntry：长条目截断并加省略号，短条目原样', async () => {
    const s = summarizeEntry(`- ${'A'.repeat(300)}`, 50)
    ok(s.startsWith('- AAAA'), 'keeps prefix')
    ok(s.endsWith('…'), 'marks truncation')
    ok(s.length <= 53, `bounded, got ${s.length}`)
    eq(summarizeEntry('- 短条目', 50), '- 短条目', 'short unchanged')
  })

  await check('renderMemory：摘要化注入——条数全在，正文不进上下文', async () => {
    const f = join(root, 'sum.md')
    writeFileSync(f, Array.from({ length: 30 }, (_, i) => `- 条目${i}：${'x'.repeat(200)}`).join('\n'), 'utf8')
    const text = renderMemory({ layers: [{ level: 'user', label: 'U', file: f }], summaryChars: 40 })
    ok(text.includes('条目0'), 'first entry present')
    ok(text.includes('条目29'), 'last entry present (no tail truncation)')
    ok(!text.includes('x'.repeat(60)), 'full body kept out of context')
    ok(text.length < 2000, `injection stays small, got ${text.length}`)
  })

  await check('renderMemory：超预算时丢弃尾部条目并报出条数（不静默）', async () => {
    const f = join(root, 'budget.md')
    writeFileSync(f, Array.from({ length: 30 }, (_, i) => `- 条目${i}`).join('\n'), 'utf8')
    const text = renderMemory({ layers: [{ level: 'user', label: 'U', file: f }], summaryChars: 50, budget: 60 })
    ok(text.includes('未注入'), 'reports omitted count')
    ok(text.includes('条目0'), 'keeps from head')
    ok(!text.includes('条目29'), 'drops tail under budget')
  })

  await check('renderMemory：summaryChars=0 退回整段注入 + 预算兜底', async () => {
    const f = join(root, 'fullmode.md')
    writeFileSync(f, `- ${'y'.repeat(500)}\n`, 'utf8')
    const text = renderMemory({ layers: [{ level: 'user', label: 'U', file: f }], summaryChars: 0, budget: 200 })
    ok(text.includes('超预算'), 'clip marker present in full mode')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

function proj6() {
  const p = join(root, 'nowhere', 'deep')
  mkdirSync(p, { recursive: true })
  return p
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
