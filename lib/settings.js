// 设置集成 + 同源 route：让 DSH 设置页的「记忆」面板能读写本插件配置。
//
// 两条通道：
// 1. `installSection(owner, ns, schema, entry, hooks)` —— 把 Config 注册进 DSH 设置服务，
//    配置与其它插件一起落在 settings.yaml；`hooks.setSource` 让运行时热读用户覆盖值。
// 2. 自有 route `POST /memory-md/api/settings.get|update` —— 客户端表单走这条。
//    为什么不直接用 settingsScope：非 loopback 下它的 persistence=memory，`set()` 是 no-op，
//    保存永不落盘。
//
// 安全：这条 route 能改插件配置，按「读盘级」接口对待——同源 fence 一条不少
// （loopback / 已配置 trustedHosts、非 cross-site、Origin 必须等于 Host）。
// 另：本模块**不**把 webServer 写进 index.js 的声明式 `inject`——那会让 headless 场景
// （无 web 服务的子代理运行时）直接不加载插件。这里用可选注入，缺失就只跳过 route。

/** 设置命名空间；必须与 index.js 里 installSection 用的名字一致。 */
export const SETTINGS_NAMESPACE = 'memory-md'

/** Largest settings payload accepted (the form posts one flat object). */
const MAX_BODY_BYTES = 64 * 1024

function header(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/** Parse an authority (`host:port`) into a URL, or undefined when malformed. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts ?? []).some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
    return canonical === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/** Same-origin fence for the settings route (loopback or configured trusted hosts). */
export function isTrustedRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const writeOk = (res, value) => writeJson(res, 200, { ok: true, value })
const writeErr = (res, status, code, message) => writeJson(res, status, { ok: false, error: { code, message } })

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Register the settings section and, when a web server exists, the settings route.
 * @param {{ctx:object, Config:object, baseEntry:object, setSource:(next:()=>object)=>void}} deps
 */
export function registerSettings({ ctx, Config, baseEntry, setSource }) {
  // 宿主没提供 `inject`（测试用的最小 ctx）时跳过设置集成——记忆功能本身不受影响。
  if (typeof ctx?.inject !== 'function') {
    console.warn('[memory-md] ctx.inject unavailable — the settings section stays unregistered')
    return
  }

  // 运行时配置读写面；settings 服务就绪前为 null（route 会回 503 而不是崩）。
  let face = null

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, baseEntry, {
      setSource: (next) => setSource(next),
      onChange: () => {},
    })
    const viewOf = () => {
      const descriptor = settingsCtx.settings
        .describe({ redactSecrets: true })
        .find((candidate) => candidate.ns === SETTINGS_NAMESPACE)
      return descriptor === undefined
        ? { value: undefined, user: undefined, revision: undefined }
        : { value: descriptor.value, user: descriptor.user, revision: descriptor.revision }
    }
    face = {
      get: viewOf,
      // 整节替换语义：表单留空的字段回退 schema 默认，与「保存=提交整个表单」一致。
      replace: async (section, expectedRevision) => {
        await settingsCtx.settings.replace(SETTINGS_NAMESPACE, section, expectedRevision)
        return viewOf()
      },
    }
  })

  const get = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (typeof webServer?.register !== 'function') return
    webCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/memory-md/api',
      handler: async (req, res) => {
        if (!isTrustedRequest(req, get('webRuntime')?.trustedHosts ?? [])) {
          writeErr(res, 403, 'forbidden', 'forbidden')
          return
        }
        try {
          if (req.method !== 'POST') {
            writeErr(res, 405, 'method-error', 'method not allowed')
            return
          }
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const prefix = '/memory-md/api/'
          if (!url.pathname.startsWith(prefix)) {
            writeErr(res, 404, 'not-found', 'unknown endpoint')
            return
          }
          const method = url.pathname.slice(prefix.length)
          if (method === '' || method.includes('/')) {
            writeErr(res, 404, 'not-found', `unknown method: ${method}`)
            return
          }
          if (face === null) {
            writeErr(res, 503, 'not-ready', 'the settings service is not ready yet')
            return
          }
          if (method === 'settings.get') {
            writeOk(res, face.get())
            return
          }
          if (method === 'settings.update') {
            const payload = await readJsonBody(req)
            writeOk(res, await face.replace(payload.section, payload.expectedRevision))
            return
          }
          writeErr(res, 404, 'not-found', `unknown method: ${method}`)
        } catch (error) {
          writeErr(res, 500, 'internal', error instanceof Error ? error.message : String(error))
        }
      },
    }), 'memory-md: /memory-md/api routes')
  })
}
