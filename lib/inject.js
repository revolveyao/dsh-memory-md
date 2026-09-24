// 注入渲染：各层记忆**摘要化**后折进 system prompt 的 context
// （函数形态 → 每步重算 → 写入即刷新）。
//
// 为什么摘要化而不是整段注入：你的记忆条目平均约 1 KB（实测用户级 68 条 / 39,723 字符、
// 项目级 12,551 字符），整段注入等于每步付 5.4 万字符。借鉴 @max-null/dsh-memory 的做法——
// 注入「每条的摘要」，让模型知道**有哪些记忆、各讲什么**，需要细节时用 memory_read 取全文：
// **不丢条目，只丢细节**。这比"截掉尾部"强得多——后者会让文件头部的重要偏好永远不可见
// （memory-palace 就是这个毛病）。
//
// 三条硬约束来自其它插件的实战教训：
// 1. 不静默截断：省略了多少条、多少字符，都写在注入里；
// 2. 体积常显：每层条数与字符数写在层末，让模型与人都有成本意识；
// 3. 中和 `{{`：DSH 系统提示词走严格插值，正文里出现 `{{name}}` 会让该会话的**全部模型请求
//    一起失败**（模型没法自救——它改不了自己的记忆）。只改注入副本，磁盘原文不动。
import { createHash } from 'node:crypto'
import { normEntry, parseEntries, readSync, stats } from './store.js'

/** 每条记忆注入的摘要长度（字符）。0 = 不摘要（整条注入，靠 budgetChars 兜底）。 */
export const DEFAULT_SUMMARY_CHARS = 120
/** 记忆总量超过此字符数时，在注入末尾追加精简建议（防记忆无声膨胀）。 */
export const WARN_CHARS = 20000

/** 中和注入副本里的字面 `{{`（循环至稳定，覆盖 `{{{{` 之类连续花括号）。 */
export function neutralizeBraces(text) {
  let out = text
  while (out.includes('{{')) out = out.replaceAll('{{', '{ {')
  return out
}

/** 超预算裁剪：保留最近写入的部分，截断处给出标记与省略量。budget<=0 视为不限。 */
export function clipTail(text, budget) {
  if (!budget || budget <= 0 || text.length <= budget) return text
  const tail = text.slice(-budget)
  const firstBreak = tail.indexOf('\n')
  const kept = firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
  return `…（本层超预算，已省略前 ${text.length - kept.length} 字符，保留最近写入部分）\n${kept}`
}

/** 把一条记忆压成一行摘要。 */
export function summarizeEntry(entry, maxChars) {
  const body = String(entry ?? '').replace(/^\s*[-*]\s+/, '').trim()
  const oneLine = body.split('\n')[0]
  if (!maxChars || maxChars <= 0 || oneLine.length <= maxChars) return `- ${oneLine}`
  return `- ${oneLine.slice(0, maxChars)}…`
}

const LEVEL_SHORT = { user: '用户级', project: '项目级', subdir: '会话目录' }

/** 渲染单层：摘要化 + 按条预算（超预算丢弃**尾部**条目并报出条数，不静默）。 */
function renderLayer(text, budget, summaryChars) {
  if (!summaryChars || summaryChars <= 0) {
    return { body: clipTail(text, budget), omitted: 0, injected: parseEntries(text).length }
  }
  const entries = parseEntries(text)
  if (entries.length === 0) return { body: clipTail(text, budget), omitted: 0, injected: 0 }
  const lines = []
  let used = 0
  let omitted = 0
  let full = false
  for (const entry of entries) {
    const line = summarizeEntry(entry, summaryChars)
    if (full) {
      omitted++
      continue
    }
    if (budget > 0 && lines.length > 0 && used + line.length + 1 > budget) {
      full = true
      omitted++
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  return { body: lines.join('\n'), omitted, injected: lines.length }
}

/**
 * 渲染各层记忆。空的层直接跳过（不是每个子目录都开会话，也就不必有记忆文件）。
 * @param {{layers: Array<{level:string,label:string,file:string}>, budget?: number, summaryChars?: number}} input
 * @returns {string} 注入文本（无内容时返回空串）
 */
export function renderMemory({ layers, budget = 0, summaryChars = DEFAULT_SUMMARY_CHARS }) {
  const blocks = []
  const volume = []
  let totalChars = 0
  for (const layer of layers) {
    const text = readSync(layer.file).trim()
    if (text === '') continue
    const s = stats(text)
    totalChars += s.chars
    const { body, omitted, injected } = renderLayer(text, budget, summaryChars)
    const short = LEVEL_SHORT[layer.level] ?? layer.level
    const note = omitted > 0 ? `，另有 ${omitted} 条未注入（超预算）` : ''
    volume.push(`${short} ${s.entries} 条 / ${s.chars} 字符`)
    blocks.push(`## ${layer.label}\n\n${body}\n\n（${short}：共 ${s.entries} 条 / ${s.chars} 字符，本处为每步注入的摘要${note}；完整正文用 memory_read）`)
  }
  if (blocks.length === 0) return ''
  const body = `# 你的记忆（Markdown，人类可直接编辑）\n\n${blocks.join('\n\n')}`
  const warn = totalChars > WARN_CHARS
    ? `\n（记忆总量 ${totalChars} 字符偏大：把细节移进技能文档，记忆只留「结论 + 去哪查」）`
    : ''
  const footer = `\n\n（记忆体积：${volume.join('；')}）${warn}`
  return neutralizeBraces(body + footer)
}

/** 读取指定层的正文（供 memory_read；不摘要、不截断，只附体积行）。 */
export function renderRead({ layers, levels }) {
  const wanted = levels === undefined ? undefined : new Set(levels)
  const blocks = []
  const volume = []
  for (const layer of layers) {
    if (wanted !== undefined && !wanted.has(layer.level)) continue
    const text = readSync(layer.file).trim()
    if (text === '') {
      blocks.push(`## ${layer.label}\n\n（空——该层还没有记忆）`)
      continue
    }
    const s = stats(text)
    volume.push(`${LEVEL_SHORT[layer.level] ?? layer.level} ${s.entries} 条 / ${s.chars} 字符`)
    blocks.push(`## ${layer.label}\n\n${text}`)
  }
  if (blocks.length === 0) return { text: '（该 scope 下没有可读的记忆层）', volume: [] }
  const footer = volume.length > 0 ? `\n\n（记忆体积：${volume.join('；')}）` : ''
  return { text: neutralizeBraces(blocks.join('\n\n') + footer), volume }
}

/** 条目指纹：归一化文本的短哈希，用来判断「这条是否已经注入过」。 */
export function entryFingerprint(entry) {
  return createHash('sha256').update(normEntry(entry), 'utf8').digest('hex').slice(0, 16)
}

/** 采集各层当前全部条目（带指纹），供增量渲染比对。 */
export function collectEntries(layers) {
  const items = []
  for (const layer of layers) {
    const text = readSync(layer.file)
    if (text.trim() === '') continue
    for (const entry of parseEntries(text)) {
      items.push({ level: layer.level, label: layer.label, entry, fingerprint: entryFingerprint(entry) })
    }
  }
  return items
}

/** 把「本次新增」的条目按层压成一段可以独立成消息的文本。 */
function renderFresh(fresh, budget, summaryChars) {
  const byLayer = new Map()
  for (const item of fresh) {
    if (!byLayer.has(item.label)) byLayer.set(item.label, [])
    byLayer.get(item.label).push(summarizeEntry(item.entry, summaryChars))
  }
  const blocks = []
  let used = 0
  for (const [label, lines] of byLayer) {
    const kept = []
    for (const line of lines) {
      if (budget > 0 && kept.length > 0 && used + line.length + 1 > budget) break
      kept.push(line)
      used += line.length + 1
    }
    blocks.push(`## ${label}\n\n${kept.join('\n')}`)
  }
  const head = `# 记忆更新（本次新注入 ${fresh.length} 条；需要细节或完整列表用 memory_read）`
  return neutralizeBraces(`${head}\n\n${blocks.join('\n\n')}`)
}

/**
 * **增量**渲染：只输出「本会话尚未注入过」的条目。
 *
 * 为什么需要它：DSH 的 runtime-context 投影按**渲染后文本**去重，文本一变就**追加**一条新
 * user 消息，旧快照留在历史里（这正是"每步重算"的代价）。若每次都重发全部摘要（本机实测约
 * 6,400 字符），一次会话写 5 条记忆就堆 5 份快照。改成增量后：写一条只注入那一条（约 150
 * 字符），**没有新增时不追加任何消息**。
 *
 * ⚠️ 没新增时**绝不能返回空串**：DSH 把「当前为空」渲染成 `CLEARED`
 * （"Earlier runtime-context snapshots no longer apply."），那会让模型以为记忆全被作废。
 * 因此这里返回 `text: null`，由调用方复用自己缓存的上一次文本（文本未变 → DSH 跳过）。
 *
 * @param {{layers:Array, previous?:{text:string, fingerprints:Set<string>}, budget?:number, summaryChars?:number}} input
 * @returns {{text: string|null, fingerprints: Set<string>, added: number}} text=null 表示"无变化"
 */
export function renderIncremental({ layers, previous, budget = 0, summaryChars = DEFAULT_SUMMARY_CHARS }) {
  const items = collectEntries(layers)
  const fingerprints = new Set(items.map((item) => item.fingerprint))

  // 首次注入（本会话还没有状态）：给全量摘要，否则模型不知道该有什么。
  if (previous === undefined) {
    return { text: renderMemory({ layers, budget, summaryChars }), fingerprints, added: items.length }
  }

  const fresh = items.filter((item) => !previous.fingerprints.has(item.fingerprint))
  if (fresh.length === 0) return { text: null, fingerprints, added: 0 }
  return { text: renderFresh(fresh, budget, summaryChars), fingerprints, added: fresh.length }
}

export { LEVEL_SHORT }
