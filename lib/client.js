// dsh-memory-md — 浏览器半：在 DSH 设置页注册「记忆」面板。
//
// 硬契约：client 半必须是**单文件 CommonJS 包装**（宿主每个插件只服务一个文件
// `/plugins/<pkg>/client.js`，不能代码分割）；React 由平台 seed 表提供（`require("react")`）。
// 因此这里手写 `h()`，不引入 JSX、CSS 文件或任何依赖，也不需要构建步骤。
//
// 只做一件事：注册 `settings.section`，渲染一个表单；读写走同源
// `POST /memory-md/api/settings.get|update`（保存 = 整节替换，留空回退默认）。
//
// 失败策略：client 的 `apply` 抛错会让**整个 web shell 启动失败**，所以全程 try/catch——
// 服务缺失、接口不通都只打日志并让面板保持 inert。
window.__ModuleLoader__.load({
  id: 'dsh-memory-md',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const API = '/memory-md/api/'

    /** 表单字段定义；与 host 的 Config 一一对应。 */
    const FIELDS = [
      { key: 'enabled', type: 'boolean', label: '启用记忆', hint: '总开关：关闭后不再注入记忆，写入工具也拒绝写入。' },
      { key: 'summaryChars', type: 'number', label: '每条摘要长度（字符）', hint: '每条记忆注入上下文的摘要字符数。调小可省每步 token，调大看得更全；0 = 不摘要（整条注入）。' },
      { key: 'budgetChars', type: 'number', label: '每层注入预算（字符）', hint: '0 = 不限。超预算会丢弃尾部条目，并在注入里报出丢弃条数（不静默截断）。' },
      { key: 'injectInSubagents', type: 'boolean', label: '给子代理注入记忆', hint: '子代理多为独立调研任务，关掉可省下每次注入的开销。' },
      { key: 'userMemoryPaths', type: 'lines', label: '用户级记忆文件（每行一个）', hint: '按优先级排序；存在的都会被读取，写入落第一个。默认 ~/.deepseek-harness/MEMORY.md。' },
      { key: 'memoryRelCandidates', type: 'lines', label: '项目级 / 会话目录级候选（每行一个，相对路径）', hint: '存在的都读，写入落第一个存在的；只有 WorkBuddy 记忆的项目会写回 .workbuddy。' },
      { key: 'rootMarkers', type: 'lines', label: '项目根标记目录名（每行一个）', hint: '从会话 cwd 向上第一个含标记的目录即项目根。' },
    ]

    /** 调同源 route；非 2xx 或 ok:false 一律抛错，由调用方显示。 */
    async function call(method, payload) {
      const res = await fetch(API + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await res.json().catch(() => undefined)
      if (body === undefined || body.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      }
      return body.value
    }

    /** 把表单草稿转成配置节：空行剔除，数字/布尔归一。 */
    function toSection(draft) {
      const section = {}
      for (const field of FIELDS) {
        const raw = draft[field.key]
        if (field.type === 'boolean') section[field.key] = raw === true
        else if (field.type === 'number') {
          const n = Number(raw)
          section[field.key] = Number.isFinite(n) ? n : 0
        } else {
          const lines = String(raw ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
          if (lines.length > 0) section[field.key] = lines
        }
      }
      return section
    }

    function draftOf(value) {
      const draft = {}
      for (const field of FIELDS) {
        const v = value?.[field.key]
        if (v === undefined) draft[field.key] = ''
        else if (field.type === 'array' || Array.isArray(v)) draft[field.key] = v.join('\n')
        else draft[field.key] = v
      }
      return draft
    }

    const rowStyle = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '14px' }
    const labelStyle = { fontWeight: 600, fontSize: '13px' }
    const hintStyle = { color: 'var(--text-secondary, #888)', fontSize: '12px', lineHeight: 1.5 }
    const inputStyle = {
      padding: '6px 8px',
      fontSize: '13px',
      border: '1px solid var(--border-color, #ccc)',
      borderRadius: '6px',
      background: 'var(--bg-color, transparent)',
      color: 'inherit',
      fontFamily: 'inherit',
    }

    function MemorySection() {
      const [state, setState] = react.useState({ phase: 'loading', error: '', note: '', draft: {}, revision: undefined })

      const load = react.useCallback(() => {
        setState((s) => ({ ...s, phase: 'loading', error: '' }))
        call('settings.get')
          .then((view) => setState({
            phase: 'ready',
            error: '',
            note: '',
            draft: draftOf(view?.value ?? {}),
            revision: view?.revision,
          }))
          .catch((error) => setState((s) => ({ ...s, phase: 'ready', error: error.message })))
      }, [])

      react.useEffect(() => { load() }, [load])

      const set = (key, value) => setState((s) => ({ ...s, draft: { ...s.draft, [key]: value }, note: '' }))

      const save = () => {
        setState((s) => ({ ...s, phase: 'saving', error: '', note: '' }))
        call('settings.update', { section: toSection(state.draft), expectedRevision: state.revision })
          .then((view) => setState({
            phase: 'ready',
            error: '',
            note: '已保存，立即生效（下一步注入就带上新设置）',
            draft: draftOf(view?.value ?? {}),
            revision: view?.revision,
          }))
          .catch((error) => setState((s) => ({ ...s, phase: 'ready', error: error.message })))
      }

      const children = []
      children.push(h('div', { key: 'title', style: { fontSize: '14px', marginBottom: '4px' } }, '分层 Markdown 记忆'))
      children.push(h('div', { key: 'intro', style: { ...hintStyle, marginBottom: '16px' } },
        '用户级 / 项目级 / 会话目录级三层，每层一个 MEMORY.md；注入的是每条一行摘要，细节由 memory_read 取。'))

      for (const field of FIELDS) {
        const value = state.draft[field.key]
        let control
        if (field.type === 'boolean') {
          control = h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' } },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              onChange: (event) => set(field.key, event.target.checked),
            }),
            h('span', null, value === true ? '已启用' : '已关闭'))
        } else if (field.type === 'number') {
          control = h('input', {
            type: 'number',
            value: value === '' || value === undefined ? '' : String(value),
            onChange: (event) => set(field.key, event.target.value),
            style: { ...inputStyle, width: '140px' },
          })
        } else {
          control = h('textarea', {
            value: value ?? '',
            onChange: (event) => set(field.key, event.target.value),
            rows: 3,
            spellCheck: false,
            style: { ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'monospace' },
          })
        }
        children.push(h('div', { key: field.key, style: rowStyle }, [
          h('div', { key: 'l', style: labelStyle }, field.label),
          control,
          field.hint ? h('div', { key: 'h', style: hintStyle }, field.hint) : null,
        ]))
      }

      const actions = [h('button', {
        key: 'save',
        type: 'button',
        onClick: save,
        disabled: state.phase === 'saving',
        style: { ...inputStyle, cursor: 'pointer', fontWeight: 600, padding: '6px 16px' },
      }, state.phase === 'saving' ? '保存中…' : '保存')]
      actions.push(h('button', {
        key: 'reload',
        type: 'button',
        onClick: load,
        style: { ...inputStyle, cursor: 'pointer', marginLeft: '8px', padding: '6px 12px', fontWeight: 400 },
      }, '重新载入'))
      children.push(h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', marginTop: '4px' } }, actions))

      if (state.note) children.push(h('div', { key: 'note', style: { ...hintStyle, marginTop: '10px', color: 'var(--link-color, #4d6bfe)' } }, state.note))
      if (state.error) children.push(h('div', { key: 'err', style: { ...hintStyle, marginTop: '10px', color: '#e5534b' } }, `设置不可用：${state.error}`))

      return h('section', { style: { display: 'block' } }, children)
    }

    function apply(ctx) {
      try {
        if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.slots?.register !== 'function') {
          console.warn('[memory-md] slots service unavailable — the settings panel stays unregistered')
          return
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'memory-md',
          order: 20,
          label: () => '记忆',
        }, MemorySection))
      } catch (error) {
        console.warn(`[memory-md] settings panel could not be registered: ${error?.message ?? error}`)
      }
    }

    exports.apply = apply
    // 只需要槽位注册表；其余服务（若有）由宿主自行提供。
    exports.inject = ['slots']
    exports.MemorySection = MemorySection
    return module.exports
  },
})
