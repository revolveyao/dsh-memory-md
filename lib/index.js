// dsh-memory-md — 分层 Markdown 记忆（用户级 / 项目级 / 会话目录级）。
//
// 设计取舍（基于对 dsh-memory-palace 与两个社区插件的源码评审）：
//
// 1. **真源是人类可读的 Markdown 单文件**（每层一个 MEMORY.md）。不用 DSH 的 storage domain
//    服务——那会把落盘格式交给 host（`dsh-storage-json` 落 JSON），代价正是我们最在意的那一项：
//    人不能随手改、git diff 看不出改了哪条。存储层自己实现，换来「记事本可改 + 可 diff」。
// 2. **写入 = 整文件原子替换 + 内容 CAS**（见 store.js）。带版本哈希写入，磁盘若已被别处改动
//    （人工编辑 / 另一会话 / 另一次 DSH 进程）则拒绝并明确报冲突，绝不静默覆盖。
// 3. **注入走 `systemPrompt.context`（函数形态）而不是静态 section**：DSH 每个 step 都会重新
//    assemble，函数每次从磁盘现读 → **写入后本会话下一步立即可见**，不会出现 palace 那种
//    「会话起始快照、写完不刷新」。
// 4. **零自动写入路径**：没有 turn/end 监听、没有错误捕获、没有定时任务、没有 LLM 摘要。
//    记忆只可能来自模型显式调 memory_note / memory_note_user，或人工编辑文件。
// 5. 分层按**会话 cwd 的祖先链**（项目根 → … → cwd），越具体越靠后、优先级越高；
//    空的层直接跳过（不是每个子目录都开会话，也就不必有记忆文件）。
// 6. **兼容项目下的 WorkBuddy / CodeBuddy 记忆目录**：每目录候选 `.deepseek-harness/MEMORY.md`
//    → `.workbuddy/memory/MEMORY.md` → `.codebuddy/memory/MEMORY.md`；存在的都读，写入落
//    「首选」（第一个存在的）——所以只有 WorkBuddy 记忆的项目继续与 WB 共享同一份。用户级不桥接。
// 7. cwd 一律取自**当前 agent 自己的** `agent.session.header.cwd`，不用全局"活跃会话"状态
//    —— 后者会被子会话覆盖，是 palace 跨会话污染的直接原因。
// 8. **配置可在 DSH 设置页调整**（见 settings.js 与 client.js）：`inject` 只声明必需服务，
//    settings / webServer 走可选注入，因此 headless（无 web 服务）场景下插件照常工作，
//    只是没有设置面板与 route。
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_MEMORY_REL_CANDIDATES, DEFAULT_USER_MEMORY_CANDIDATES, resolveLayers } from './paths.js'
import { renderIncremental, renderMemory } from './inject.js'
import { registerTools } from './tools.js'
import { registerSettings } from './settings.js'

export const name = 'memory-md'

const RULES = `[记忆] 你有跨会话的 Markdown 记忆文件，人类可直接阅读、编辑、审计。三层，越靠后越具体、优先级越高：
- 用户级：跨项目的个人偏好与本机环境事实
- 项目级：本项目约定
- 会话目录级：当前会话所在子目录专属（通常一个子目录开一个会话）

写入：memory_note（scope=session 默认写会话目录 / scope=project 写项目根）；跨项目偏好用 memory_note_user。
读取：memory_read（scope=all/user/project/session）。删除：memory_forget（两阶段，先预览再确认）。
只记「下个会话还需要」的信息：结论先行 + 关键细节（命令/路径/数字）。不记临时状态、一次性失败、工具输出原文、能从仓库读到的事实。
下方是各层记忆的**每条一行摘要**；需要某条细节时用 memory_read 读全文。**每步都重新读盘，写入后本会话下一步即可见**，无需重启、无需重读。`

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用分层记忆的注入与写入工具。'),
  userMemoryPaths: Schema.array(Schema.string()).default([...DEFAULT_USER_MEMORY_CANDIDATES]).description('用户级记忆文件候选（存在的都会读取，写入落首个）。默认只认 DSH 自己的 ~/.deepseek-harness/MEMORY.md。'),
  memoryRelCandidates: Schema.array(Schema.string()).default([...DEFAULT_MEMORY_REL_CANDIDATES]).description('项目级/会话目录级的候选相对路径，按优先级：.deepseek-harness/MEMORY.md → .workbuddy/memory/MEMORY.md → .codebuddy/memory/MEMORY.md。存在的都读，写入落第一个存在的（这样只有 WorkBuddy 记忆的项目会写回 .workbuddy）。'),
  rootMarkers: Schema.array(Schema.string()).default(['.git', '.deepseek-harness']).description('判定项目根的目录标记名（任一命中即为根）。'),
  budgetChars: Schema.number().default(0).description('每层注入的字符预算；0 = 不限。超预算丢弃尾部条目并报出条数。'),
  summaryChars: Schema.number().default(120).description('每条记忆注入的摘要长度（字符）；0 = 不摘要（整条注入，靠 budgetChars 兜底）。调小可省每步 token，代价是摘要更短。'),
  injectInSubagents: Schema.boolean().default(true).description('是否给子代理会话注入记忆。子代理多为独立调研任务，若不需要项目记忆上下文，设为 false 可省下每次注入的开销。'),
})

// 与 Config 的 default 保持一致；宿主未填默认值时兜底（headless 装配、单元测试）。
const DEFAULTS = Object.freeze({
  enabled: true,
  userMemoryPaths: [...DEFAULT_USER_MEMORY_CANDIDATES],
  memoryRelCandidates: [...DEFAULT_MEMORY_REL_CANDIDATES],
  rootMarkers: ['.git', '.deepseek-harness'],
  budgetChars: 0,
  summaryChars: 120,
  injectInSubagents: true,
})

// 只声明真正必需的服务：settings / webServer 走可选注入，缺失时插件照常工作。
export const inject = ['systemPrompt', 'tools']

/** 当前 agent 自己会话的 cwd —— 不用全局活跃会话，避免子会话串扰。 */
function agentCwd(value) {
  const cwd = value?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** 是否子代理会话：dsh-session 的 header 校验保证了 `origin==='subagent'` 与 `parentSession` 两种标记。 */
function isSubagent(value) {
  const header = value?.agent?.session?.header
  return header?.origin === 'subagent' || header?.parentSession !== undefined
}

export function apply(ctx, config) {
  // 运行时配置来源：settings 服务就绪后由 installSection 的 setSource 切到「用户设置覆盖层」，
  // 所以设置页一保存，注入与工具立刻读到新值（无需重启）。
  let source = () => ({ ...DEFAULTS, ...(config ?? {}) })
  const getConfig = () => ({ ...DEFAULTS, ...source() })

  const layersFor = (cwd) => {
    const cfg = getConfig()
    return resolveLayers({
      cwd,
      userMemoryPaths: cfg.userMemoryPaths,
      memoryRelCandidates: cfg.memoryRelCandidates,
      rootMarkers: cfg.rootMarkers,
    })
  }

  // 恒定指令放 section（内容不变 → 前缀缓存友好）
  ctx.systemPrompt.section({
    name: 'memory-md:rules',
    order: 50,
    text: () => (getConfig().enabled ? RULES : ''),
  })

  // 每个会话的注入状态（增量注入用）。key = sessionId。
  // 上限 64：这只是个记账表，超了丢最老的——宁可多注一次，也不无限增长。
  const injectionState = new Map()
  const MAX_TRACKED_SESSIONS = 64

  // compaction 会把投影消息移出 surface（DSH 之后会自动重投影）→ 丢掉本会话的增量状态，
  // 让下一次重新全量注入，模型不会因为"以为自己已经知道"而缺记忆。
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      const id = session?.id
      if (typeof id !== 'string') return
      const type = String(event?.type ?? '')
      if (type === 'compaction' || type.startsWith('compaction/')) injectionState.delete(id)
    })
  }

  // 记忆正文放 context（函数形态 → 每步重算 → 写入即刷新）。
  // 渲染是**增量**的：只注入本会话还没见过的条目；没有新增就返回上次的文本，
  // 让 DSH 判为「未变」从而不追加任何消息——避免一次会话里堆起多份完整快照。
  ctx.systemPrompt.context({
    name: 'memory-md:content',
    order: 51,
    text: (assembly) => {
      const cfg = getConfig()
      if (!cfg.enabled) return ''
      if (cfg.injectInSubagents === false && isSubagent(assembly)) return ''
      const sessionId = assembly?.agent?.session?.id
      const tracked = typeof sessionId === 'string'
      try {
        const previous = tracked ? injectionState.get(sessionId) : undefined
        const { text, fingerprints } = renderIncremental({
          layers: layersFor(agentCwd(assembly)),
          previous,
          budget: cfg.budgetChars,
          summaryChars: cfg.summaryChars,
        })
        // null = 本步没有新条目：复用上次文本，DSH 判为未变 → 一条都不追加。
        if (text === null) return previous?.text ?? ''
        if (tracked) {
          if (!injectionState.has(sessionId) && injectionState.size >= MAX_TRACKED_SESSIONS) {
            injectionState.delete(injectionState.keys().next().value)
          }
          injectionState.set(sessionId, { text, fingerprints })
        }
        return text
      } catch (error) {
        // 注入绝不能抛错：context 求值失败会让整个 turn 失败，模型无从自救。
        console.error(`[memory-md] injection skipped: ${error?.message ?? error}`)
        return ''
      }
    },
  })

  registerTools({ ctx, getConfig, layersFor, cwdOf: agentCwd })

  // 设置页 + 同源 route（settings / webServer 缺失时各自静默跳过）
  registerSettings({
    ctx,
    Config,
    baseEntry: { ...(config ?? {}) },
    setSource: (next) => {
      source = next
    },
  })
}
