# dsh-memory-md

> Layered Markdown memory for DeepSeek Harness.

给 DeepSeek Harness 的分层记忆：**用户级 / 项目级 / 会话目录级**，每层一个 `MEMORY.md`。
记忆是人写的、也是给人看的，所以它就是普通 Markdown 文件——用任何编辑器打开、diff、
备份、提交进 git 都行，而不是被封在某个插件的私有格式里。

## 特性

- **分层且可同时生效**：用户级（跨项目偏好）+ 项目级 + 会话所在子目录级，越靠后越具体、优先级越高；空层直接跳过。
- **增量注入**：会话首步给全量每行摘要（默认 120 字符），之后**只注入本会话尚未见过的条目**（约 150 字符）；没有新增时不追加任何消息。避免每步重发整份记忆。
- **零自动写入**：没有 turn 监听、没有错误捕获、没有定时任务、没有 LLM 摘要。写入只可能来自模型显式调用工具，或你直接编辑文件。
- **写入安全**：整文件原子替换（`.tmp-<uuid>` → `rename`），写入携带内容哈希做 CAS——磁盘若已被别处改动就**拒绝并报冲突**，绝不静默覆盖。
- **兼容既有记忆目录**：项目里已有 WorkBuddy / CodeBuddy 记忆时，读取它们并写回原处，不另起一份。

## 安装

```sh
git clone https://github.com/revolveyao/dsh-memory-md.git C:\dsh-plugins\dsh-memory-md
dsh plugin --profile desktop add link:C:\dsh-plugins\dsh-memory-md
```

`<profile>` 一般是 `desktop`（用 `dsh plugin --profile desktop ls` 可确认）。装完**重启 DSH**。
也可以把 `link:` 换成 `file:`（复制安装；改源码后需重装）。

改动 `lib/` 后需重启 DSH 生效（Host 侧 ESM 入口在启动时加载）。要求 Node ≥ 20。

## 文件布局

```
~/.deepseek-harness/MEMORY.md                      # 用户级（跨项目偏好 + 本机环境事实）

<项目根>/.deepseek-harness/MEMORY.md               # 项目级（DSH 原生）
<项目根>/.workbuddy/memory/MEMORY.md               # 项目级（WorkBuddy，存在则读，且写入落这里）
<项目根>/.codebuddy/memory/MEMORY.md               # 项目级（CodeBuddy，同上）
<项目根>/<子目录>/.deepseek-harness/MEMORY.md      # 会话目录级（一层一个，候选同上）
```

- 项目根 = 从会话 cwd 向上第一个含 `.git` 或 `.deepseek-harness` 的目录
- 层级链按「项目根 → … → cwd」顺序注入
- 人类可直接编辑这些文件，插件下一步就会读到新内容

## 与 WorkBuddy / CodeBuddy 共存

每个目录的候选路径按优先级为 `.deepseek-harness/MEMORY.md` → `.workbuddy/memory/MEMORY.md` → `.codebuddy/memory/MEMORY.md`：

- **存在的都会被读取**——同一项目同时有两份记忆时，两份都进上下文，不丢任一侧
- **写入只落「首选」**（第一个存在的候选）——所以只有 WorkBuddy 记忆的项目**继续写回 `.workbuddy/memory/`**，与 WorkBuddy 共享同一份，不会另起一份 DSH 记忆
- 一个都不存在时退回第一个候选（`.deepseek-harness/MEMORY.md`）作为写入目标
- **用户级不桥接**：只认 `~/.deepseek-harness/MEMORY.md`，不动 `~/.workbuddy/MEMORY.md`

## 工具

| 工具 | 作用 |
|---|---|
| `memory_note(content, scope?)` | 写记忆。`scope=session`（默认）写会话目录层，`scope=project` 写项目根层 |
| `memory_note_user(content)` | 写用户级（只放跨项目偏好与本机环境事实） |
| `memory_read(scope?)` | 读记忆正文，不截断，附体积。`all`（默认）/`user`/`project`/`session` |
| `memory_forget(match, scope?, confirm?)` | **两阶段**删除：不带 `confirm` 只预览匹配到的条目；确认后再以相同 `match` + `confirm=true` 才删。标题等结构行永不删 |

## 配置

装好后在 DSH 设置页的「记忆」一节里改；也可以直接改配置源。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `userMemoryPaths` | `['~/.deepseek-harness/MEMORY.md']` | 用户级候选（存在都读，写入落首个） |
| `memoryRelCandidates` | `['.deepseek-harness/MEMORY.md', '.workbuddy/memory/MEMORY.md', '.codebuddy/memory/MEMORY.md']` | 项目级/会话目录级候选，按优先级 |
| `rootMarkers` | `['.git', '.deepseek-harness']` | 项目根标记（刻意不含 `.workbuddy`——家目录下就有它，会把家目录下的任意工作目录误判成子层级） |
| `budgetChars` | `0`（不限） | 每层注入预算；超限丢弃尾部条目并报出条数（不静默） |
| `summaryChars` | `120` | 每条记忆注入的摘要长度；`0` = 不摘要（整条注入，靠 `budgetChars` 兜底） |
| `injectInSubagents` | `true` | 是否给子代理会话注入。子代理多为独立调研任务，设 `false` 可省下每次注入开销 |

## 设计取舍

这个插件是从零写的，起因是已有的记忆插件在实测里暴露了三个问题：

| 常见做法 | 本插件的做法 |
|---|---|
| 把记忆按字符预算截断且**只留文件尾部**——一份 164 行的文件里只有 18 行进模型视野 | 注入**每条一行摘要**（默认 120 字符）：同一份记忆的注入量从 54,097 降到 12,063 字符（**4.5×**），且**条数一条不丢**。需要细节时用 `memory_read` 读全文；超出预算则丢弃尾部条目并**报出条数** |
| 注入去重按「文件身份」（首行 heading），同一文件内容再变也不重注 → 会话里只有起始快照 | 注入走 `systemPrompt.context` 的函数形态，DSH 每个 step 重新 assemble 时**现读磁盘** → 写入后本会话下一步即可见 |
| 监听 `turn/end`，用 `error` 正则扫工具输出并写进长期记忆（实测一份 161 行的项目记忆里 27 条是整段源码之类的噪声） | **零自动写入路径**，记忆只来自显式工具调用或人工编辑 |

其余几个刻意的选择：

- **去重按归一化精确等值**，不用子串——子串判据会把「新条目是旧条目的前缀扩展」误判成重复而静默丢弃。
- **注入副本中和 `{{`**：DSH 系统提示词走严格插值，正文里出现 `{{name}}` 会让该会话**全部模型请求一起失败**；注入副本里替换为 `{ {`，磁盘原文不动。
- **cwd 取自当前 agent 自己的 `agent.session.header.cwd`**，不用全局「活跃会话」状态——后者会被子会话覆盖。
- **存储就是文件**，不用宿主的 storageDomain/JSON：那会把磁盘格式的所有权交给宿主。

## 开发

```sh
node test/smoke.mjs                                  # 26 个用例：存储层 + 分层解析（含 WorkBuddy 桥接）+ 注入渲染
node --import ./test/register.mjs test/assembly.mjs  # 21 项：mock ctx 驱动 apply()，端到端跑 4 个工具
node test/incremental.mjs                            # 13 项：增量注入的指纹与预算
node test/verify-live.mjs <某个工作区路径>            # 对真实工作区验证分层解析与注入（只读真实记忆）
```

无测试框架，断言直接写在脚本里。

## 结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：Config、`systemPrompt.context` 注入、每会话注入状态 |
| `lib/paths.js` | 三层路径解析、项目根探测、候选优先级 |
| `lib/store.js` | 解析、原子写、CAS、去重、删除 |
| `lib/inject.js` | 注入渲染（全量摘要 / 增量指纹 / 预算裁剪） |
| `lib/tools.js` | 四个工具的 Schema 与实现 |
| `lib/settings.js` | 设置页与设置 API（可选依赖，缺失时静默跳过） |
| `lib/client.js` | 浏览器半：设置页的「记忆」面板 |

## 许可

MIT。
