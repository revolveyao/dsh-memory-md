// 记忆文件路径解析：用户级 + 项目根到会话 cwd 的每一级。
// 分层依据是**会话的 cwd**（一般一个子目录开一个会话，但不是每个子目录都有会话
// —— 所以空的层级直接跳过，不建文件）。
//
// 每个目录支持**多份候选记忆**：DSH 原生目录优先，其次是 WorkBuddy / CodeBuddy 的项目记忆目录
// （实测：有的项目用 .deepseek-harness，有的只有 .workbuddy/memory）。
// 存在的候选**都会被读取**（不丢任一侧的内容）；其中该目录的「首选」标 `primary: true`，
// **写入只落 primary** —— 只有 WorkBuddy 记忆的项目，写入自然继续落在 .workbuddy 里，与 WB 共享。
import { homedir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { existsSync } from 'node:fs'

export const DEFAULT_MEMORY_REL_CANDIDATES = [
  join('.deepseek-harness', 'MEMORY.md'),
  join('.workbuddy', 'memory', 'MEMORY.md'),
  join('.codebuddy', 'memory', 'MEMORY.md'),
]
// 用户级**只认 DSH 自己的文件**（只处理项目下的 WorkBuddy 记忆）。
export const DEFAULT_USER_MEMORY_CANDIDATES = ['~/.deepseek-harness/MEMORY.md']
// 项目根标记：命中任一即视为项目根。
// 刻意不放 `.workbuddy`——家目录下就有 `~/.workbuddy`，它会把"家目录下的任意工作目录"
// 误判成家目录的子层级；`.deepseek-harness` 才是本项目体系自己的根标记。
export const DEFAULT_ROOT_MARKERS = ['.git', '.deepseek-harness']

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

export function toHomeShort(p) {
  if (!p) return p
  const h = homedir()
  if (p === h) return '~'
  if (p.startsWith(h + sep)) return '~/' + p.slice(h.length + 1).split(sep).join('/')
  return p.split(sep).join('/')
}

/** 从 cwd 向上找第一个含标记的目录；找不到返回 cwd 本身。**家目录不算项目根**。 */
export function findProjectRoot(cwd, markers = DEFAULT_ROOT_MARKERS) {
  const start = resolve(cwd)
  const home = resolve(homedir())
  let cur = start
  while (true) {
    // 家目录不算项目根：`~/.deepseek-harness` 在家目录下也存在，若把它当根，
    // 「家目录下任意无标记的工作目录」都会被判成家目录的子树，于是
    // ~/.deepseek-harness/MEMORY.md 会被当作**项目级**记忆再读一遍。
    if (cur !== home) {
      for (const marker of markers) {
        if (existsSync(join(cur, marker))) return cur
      }
    }
    const parent = dirname(cur)
    if (parent === cur) return start
    cur = parent
  }
}

/** 项目根 → cwd 的目录链（含两端，按「宽松 → 具体」顺序）。cwd 不在根下时只返回 cwd。 */
export function ancestorChain(projectRoot, cwd) {
  const root = resolve(projectRoot)
  const target = resolve(cwd)
  if (target === root) return [root]
  if (!target.startsWith(root + sep)) return [target]
  const out = []
  let cur = target
  while (true) {
    out.unshift(cur)
    if (cur === root) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return out
}

/**
 * 在一组候选路径里选出「实际要用的」：存在若干个就都用（都读），
 * 一个都不存在则退回候选顺序里的第一个（作为写入目标）。
 * @returns {{files: string[], primary: string}}
 */
function chooseExisting(candidates) {
  const uniq = [...new Set(candidates.filter(Boolean))]
  const existing = uniq.filter((file) => existsSync(file))
  if (existing.length > 0) return { files: existing, primary: existing[0] }
  return { files: uniq.slice(0, 1), primary: uniq[0] }
}

/**
 * 解析各层记忆文件，按「宽松 → 具体」顺序返回（越靠后优先级越高）。
 * 同一文件只出现一次；同一目录下多个候选都在时各占一层（primary 标出写入目标）。
 * @returns {Array<{level:'user'|'project'|'subdir', dir:string|null, file:string, primary:boolean, label:string}>}
 */
export function resolveLayers({
  cwd,
  userMemoryPaths = DEFAULT_USER_MEMORY_CANDIDATES,
  memoryRelCandidates = DEFAULT_MEMORY_REL_CANDIDATES,
  rootMarkers = DEFAULT_ROOT_MARKERS,
} = {}) {
  const layers = []
  const seen = new Set()

  const userChosen = chooseExisting(userMemoryPaths.map(expandHome))
  for (const file of userChosen.files) {
    if (seen.has(file)) continue
    seen.add(file)
    layers.push({
      level: 'user',
      dir: null,
      file,
      primary: file === userChosen.primary,
      label: `用户级记忆 (${toHomeShort(file)})`,
    })
  }

  if (!cwd) return layers
  const root = findProjectRoot(cwd, rootMarkers)
  const chain = ancestorChain(root, cwd)
  chain.forEach((dir, index) => {
    const chosen = chooseExisting(memoryRelCandidates.map((rel) => join(dir, rel)))
    const isRoot = index === 0
    for (const file of chosen.files) {
      if (seen.has(file)) continue
      seen.add(file)
      layers.push({
        level: isRoot ? 'project' : 'subdir',
        dir,
        file,
        primary: file === chosen.primary,
        label: `${isRoot ? '项目级' : '会话目录'}记忆 (${toHomeShort(file)})`,
      })
    }
  })
  return layers
}
