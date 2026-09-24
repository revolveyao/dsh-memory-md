// Markdown 记忆文件的读 / 解析 / 写入。
// 写入 = 写临时文件 → rename 覆盖（整文件原子替换）+ sha256 内容 CAS：
// 调用方若带着「读到的版本哈希」来写，而磁盘已被别处改动（人工编辑、另一会话/进程），
// 则拒绝写入并抛 MemoryConflictError，绝不静默覆盖。
//
// 借鉴 @hr98w/dsh-memory 的 revision CAS 与 tmp+rename 原子替换；
// 借鉴 @max-null/dsh-memory 的「写入即生效、人是例外干预者」。
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class MemoryConflictError extends Error {
  constructor(file, current) {
    super(`memory file changed since it was read (${file})`)
    this.name = 'MemoryConflictError'
    this.file = file
    this.current = current
  }
}

export const contentHash = (text) => createHash('sha256').update(text ?? '', 'utf8').digest('hex')

/**
 * 同步读。systemPrompt 的 section/context 渲染要求同步，故这里用 readFileSync；
 * 文件不存在返回空串（不抛错——记忆文件按需创建）。
 */
export function readSync(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 归一化条目用于去重：去列表符、合并空白、转小写。 */
export function normEntry(line) {
  return String(line ?? '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 取全部条目行（含 `- ` / `* ` 前缀），忽略标题、注释与空行。 */
export function parseEntries(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s+\S/.test(line))
}

/**
 * 该条是否已存在。用**归一化精确等值**比较，不用子串包含——
 * 子串判据会把「新条目恰好是旧条目的子串」误判为重复并静默丢弃。
 */
export function hasEntry(text, entry) {
  const target = normEntry(entry)
  if (target === '') return false
  return parseEntries(text).some((line) => normEntry(line) === target)
}

/**
 * 整文件原子替换。expectedHash 给出时先做 CAS 校验。
 * 同目录内 rename 覆盖在 Windows 上同样是原子替换（libuv 走 MoveFileEx + REPLACE_EXISTING）。
 */
export async function atomicWrite(file, content, expectedHash) {
  if (expectedHash !== undefined) {
    const current = readSync(file)
    if (contentHash(current) !== expectedHash) throw new MemoryConflictError(file, current)
  }
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

/**
 * 追加一条记忆（去重）。条目之间以空行分隔，与既有文件形态一致。
 * @returns {{changed:boolean, reason:string, hash:string}}
 */
export async function appendEntry(file, entry) {
  const text = entry.trim()
  if (text === '') return { changed: false, reason: 'empty', hash: contentHash(readSync(file)) }
  const current = readSync(file)
  if (hasEntry(current, text)) return { changed: false, reason: 'duplicate', hash: contentHash(current) }
  const body = current === '' ? '' : current.endsWith('\n') ? current : `${current}\n`
  const next = body === '' ? `- ${text}\n` : `${body}\n- ${text}\n`
  await atomicWrite(file, next, contentHash(current))
  return { changed: true, reason: 'appended', hash: contentHash(next) }
}

/** 按归一化子串删除条目行（保留结构行），返回删除明细。用于 memory_forget 的物理删除。 */
export async function removeEntries(file, match) {
  const needle = normEntry(match)
  if (needle === '') return { removed: 0, lines: [], hash: contentHash(readSync(file)) }
  const current = readSync(file)
  const kept = []
  const removed = []
  for (const line of current.split('\n')) {
    const isEntry = /^\s*[-*]\s+\S/.test(line)
    if (isEntry && normEntry(line).includes(needle)) {
      removed.push(line.trim())
      continue
    }
    kept.push(line)
  }
  if (removed.length === 0) return { removed: 0, lines: [], hash: contentHash(current) }
  const next = kept.join('\n')
  await atomicWrite(file, next, contentHash(current))
  return { removed: removed.length, lines: removed, hash: contentHash(next) }
}

/** 体积统计：字符数与条目数。 */
export function stats(text) {
  const body = String(text ?? '')
  return { chars: body.length, entries: parseEntries(body).length }
}
