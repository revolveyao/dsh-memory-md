// 记忆工具：memory_note / memory_note_user / memory_read / memory_forget。
//
// 契约刻意贴近 @max-null/dsh-memory 的 memory_save：描述里明确「记什么、不记什么」，
// 让「不记临时状态/一次性失败/仓库可读事实」成为工具契约的一部分，而不是靠事后清洗。
//
// 写入落点：每层的 `primary` 文件（该目录存在哪份候选记忆就写哪份——只有 WorkBuddy
// 记忆的项目写回 .workbuddy/memory/，与 WB 共享；否则写 .deepseek-harness/MEMORY.md）。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendEntry, readSync, removeEntries, stats } from './store.js'
import { renderRead } from './inject.js'
import { toHomeShort } from './paths.js'

const NOTE_DESC =
  'Save one durable cross-session memory into a Markdown file the human can read and edit. ' +
  'Write what the NEXT session needs: a conclusion first, then key details (commands, paths, numbers). ' +
  'Do NOT record transient state, one-off failures, raw tool output, or facts already readable from the repo. ' +
  '保存一条跨会话记忆到人类可读可编辑的 Markdown 文件：结论先行 + 关键细节（命令/路径/数字）。' +
  '不要记临时状态、一次性失败、工具输出原文、或能从仓库读到的事实。'

export function registerTools({ ctx, getConfig, layersFor, cwdOf }) {
  const cfg = () => getConfig()

  /** 按 scope 选出**写入目标**层：session=会话所在目录（默认），project=项目根，user=用户级。 */
  function pickLayer(layers, scope) {
    const primary = (level) => layers.filter((l) => l.level === level && l.primary)
    if (scope === 'user') return primary('user')[0] ?? layers.find((l) => l.level === 'user')
    if (scope === 'project') return primary('project')[0] ?? layers.find((l) => l.level === 'project')
    // session：取最具体的一层（链尾）的首选
    const subdirs = primary('subdir')
    if (subdirs.length > 0) return subdirs.at(-1)
    return primary('project')[0]
      ?? primary('user')[0]
      ?? layers.find((l) => l.level === 'project')
      ?? layers.find((l) => l.level === 'user')
  }

  async function save(layer, content) {
    const where = toHomeShort(layer.file)
    try {
      const r = await appendEntry(layer.file, content)
      if (!r.changed && r.reason === 'duplicate') {
        return { ok: true, changed: false, file: layer.file, message: `Already present (skipped duplicate) in ${where}.` }
      }
      return { ok: true, changed: r.changed, file: layer.file, message: `Saved to ${where}. It is visible from the next step of this session.` }
    } catch (error) {
      return { ok: false, message: `Failed: ${error?.message ?? error}` }
    }
  }

  ctx.tools.register(defineTool({
    name: 'memory_note',
    description:
      `${NOTE_DESC} scope=session writes to the CURRENT session directory (default), scope=project writes to the project root. ` +
      'scope=session 写入当前会话所在目录（默认）；scope=project 写入项目根。',
    parameters: {
      content: { type: 'string', required: true, description: 'One memory entry; conclusion first, then key details. 一条记忆：结论先行 + 关键细节。' },
      scope: { type: 'string', enum: ['session', 'project'], description: 'Which layer to write. Defaults to session (the current directory). 写哪一层，默认 session（当前会话目录）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? 'Done.' }],
    },
    async execute(args, exec) {
      if (!cfg().enabled) return { ok: false, message: 'memory-md is disabled.' }
      const layer = pickLayer(layersFor(cwdOf(exec)), args.scope ?? 'session')
      if (layer === undefined) return { ok: false, message: 'No writable memory layer for this session.' }
      return save(layer, args.content)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_note_user',
    description:
      `${NOTE_DESC} This writes to the USER-LEVEL memory (cross-project preferences and machine-level environment facts only). ` +
      '本工具写入用户级记忆——只放跨项目的个人偏好与本机环境事实，项目专属内容请用 memory_note。',
    parameters: {
      content: { type: 'string', required: true, description: 'One cross-project preference or environment fact. 一条跨项目偏好或环境事实。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? 'Done.' }],
    },
    async execute(args, exec) {
      if (!cfg().enabled) return { ok: false, message: 'memory-md is disabled.' }
      const layer = pickLayer(layersFor(cwdOf(exec)), 'user')
      if (layer === undefined) return { ok: false, message: 'User-level memory path is not configured.' }
      return save(layer, args.content)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description:
      'Read the Markdown memory layers of this session. scope=all (default) reads user + project + session directory; ' +
      'narrow it with user / project / session when you only need one layer. No truncation is applied here. ' +
      '读取本会话各层记忆正文（不截断，并附体积）。scope=all 默认读全部；只要某一层时用 user/project/session。',
    parameters: {
      scope: { type: 'string', enum: ['all', 'user', 'project', 'session'], description: 'Which layers to read. Defaults to all. 读哪些层，默认全部。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? 'Done.' }],
    },
    async execute(args, exec) {
      const layers = layersFor(cwdOf(exec))
      const scope = args.scope ?? 'all'
      const levels = scope === 'all' ? undefined : scope === 'user' ? ['user'] : scope === 'project' ? ['project'] : ['subdir']
      const { text, volume } = renderRead({ layers, levels })
      return { ok: true, scope, message: text, volume, files: layers.map((l) => l.file) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Delete memory entries by content match. TWO-PHASE: without confirm it only PREVIEWS what would be deleted; ' +
      'you must call it again with confirm=true (and the same match) to actually delete. Structure lines (headings) are never removed. ' +
      '按内容删除记忆条目。两阶段：不传 confirm 只预览将被删除的条目；确认后再以 confirm=true 与相同 match 调用才真正删除。标题等结构行不会被删。',
    parameters: {
      match: { type: 'string', required: true, description: 'Substring of the entry text to delete. 要删除的条目文本片段。' },
      scope: { type: 'string', enum: ['session', 'project', 'user'], description: 'Which layer to delete from. Defaults to session. 从哪一层删除，默认 session。' },
      confirm: { type: 'boolean', description: 'Set true to actually delete (after a preview call). 预览确认后传 true 真正删除。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? 'Done.' }],
    },
    async execute(args, exec) {
      if (!cfg().enabled) return { ok: false, message: 'memory-md is disabled.' }
      const layer = pickLayer(layersFor(cwdOf(exec)), args.scope ?? 'session')
      if (layer === undefined) return { ok: false, message: 'No writable memory layer for this session.' }
      const where = toHomeShort(layer.file)
      const needle = String(args.match ?? '').trim()
      if (needle === '') return { ok: false, message: 'Empty match — nothing to do.' }
      const before = readSync(layer.file)
      const matched = before
        .split(/\r?\n/)
        .filter((l) => /^\s*[-*]\s+\S/.test(l))
        .filter((l) => l.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase().includes(needle.toLowerCase()))
      if (args.confirm !== true) {
        return {
          ok: true,
          preview: true,
          file: layer.file,
          matched,
          message: matched.length === 0
            ? `No entry in ${where} contains "${args.match}". Nothing to delete.`
            : `PREVIEW — ${matched.length} entry(ies) in ${where} would be deleted:\n${matched.map((m) => `  ${m}`).join('\n')}\n\nCall memory_forget again with confirm=true and the same match to delete.`,
        }
      }
      if (matched.length === 0) return { ok: true, removed: 0, file: layer.file, message: `No entry in ${where} contains "${args.match}". Nothing deleted.` }
      try {
        const r = await removeEntries(layer.file, args.match)
        return { ok: true, removed: r.removed, file: layer.file, removedLines: r.lines, message: `Deleted ${r.removed} entry(ies) from ${where}.` }
      } catch (error) {
        return { ok: false, message: `Failed: ${error?.message ?? error}` }
      }
    },
  }))
}
