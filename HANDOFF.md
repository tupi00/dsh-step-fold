# HANDOFF · 交接文档

给「接下这个仓库的人」看。使用者看 [README.md](./README.md)，这里记的是：现在什么状态、为什么这么写、宿主改版时先查哪里、下一步该干什么。

最后更新：2026-10-20 · 版本 **1.1.0** · 上一版 1.0.0

---

## 1. 一句话现状

`@local/step-fold`：DSH Web 界面插件，两件事——**步骤折叠**（每组过程步骤默认只留最近 5 步，底部补横条点开看全部）+ **协作挡位**（输入框上方一排开关：只回答 / 分步骤 / 无限制）。

**能跑，测试全绿**：

| 项 | 命令 | 当前结果 |
|---|---|---|
| 客户端纯函数 | `node test/helpers.test.mjs` | `helpers ok: 15 passed` |
| 宿主半边 | `node test/host.test.mjs` | `host ok: 28 passed` |
| 假 DOM 烟测 | `node test/smoke-client.mjs` | `smoke ok: 折叠 / 展开 / 撤按钮 / 挡位开关 / 卸载 都符合预期` |
| 真机自检（可选） | `node test/runtime-probe.mjs` | `runtime ok: 插件在真实 cordis 上加载成功，提示词段 / 命令 / 守卫都进了登记表` |
| 语法 | `node --check index.js` / `client.js` | 通过 |

`runtime-probe.mjs` 用本机 `E:/npm/node_modules/@deepseek-ai/dsh` 的真实服务跑（可用 `DSH_RUNTIME` 改路径），所以**没放进 `npm test`**——换台机器就跑不了。它的价值是抓「API 用错了」这类单测看不见、只在重启时才炸的错误。

烟测和单测验的是「加载不炸 + 判定对」，**视觉效果只能在浏览器里看**（见第 6 节）。

## 2. 装在哪、怎么生效

本机以 **link 方式**挂进 desktop profile：

```
C:\Users\tupi\.dsh\profiles\desktop\package.json
  dependencies:  "@local/step-fold": "link:F:/DSH产出/StepFold"
  dsh.profile.bundles: [ … , "@local/step-fold" ]
```

- **改 `client.js` → 刷新网页即可**。
- **改 `index.js` → 必须重启 DSH**。宿主半边是 cordis ESM 模块，按 URL 缓存求值结果；插件管理器里关掉再打开**不会**重新求值 `index.js`。
- 别人的安装方式：`plugin_manager install_bundle`，target 指向本目录。

## 3. 文件地图

| 文件 | 作用 | 改它的风险 |
|---|---|---|
| `client.js`（467 行） | 浏览器半边：折叠 CSS + 横条观察器 + 挡位开关 React 组件 | 主战场 |
| `index.js`（279 行） | 宿主半边：投影 `stepfold`、提示词段、工具守卫、`/stepfold` 命令 | 高——见第 4 节 |
| `cordis.patch.yml` | 注入 `id: step-fold` 的插件条目 | 低 |
| `package.json` | 元数据 + `dsh.bundle` / `dsh.client` 声明。`dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-conversation`（我们要用它的 `conversation.input.dock` 槽位），React 靠 `require('react')` 拿 | 中 |
| `locale/*.json` | 插件列表标题描述 + 挡位文案 | 低 |
| `test/helpers.test.mjs` | 客户端纯函数（从 `// >>>PURE-HELPERS` 区抠出来跑） | 低 |
| `test/host.test.mjs` | 宿主半边单测：认挡位 / 折叠日志 / 拦哪些工具 / 提示词文本 | 中，改 `index.js` 要同步改它 |
| `test/smoke-client.mjs` | 最小 DOM + 最小 React 桩跑整个 `client.js` | 中，改 DOM 逻辑要同步改它 |
| `prototype/` | **开发期原型**（静态复刻的步骤样式 + 那版烟测） | 见第 8 节，考虑去留 |

## 4. 架构与关键取舍

### 4.1 步骤折叠为什么不用 React

宿主把一轮里的过程步骤渲染成一串行，**没有给「步骤体内部」留插槽**。整块替换它（keyed 槽 `conversation.chat.node` 的 `turn-process`）在宿主升级后必坏。

所以只做两件不碰宿主 React 的事：

1. **一条 CSS 规则**折叠老步骤（`:nth-last-child` 从末尾数，后 5 个留着）；
2. **一个 MutationObserver** 给每组末尾补一条横条，点了给该组根加 `data-dshsf-all`，CSS 对已标记的组不生效。

```
html.dshSF_fold [data-step-process]:not([data-dshsf-all])
  [data-step-process-content] > :nth-last-child(n+6) { display:none !important }
```

- 开关挂在 `<html>` 的 `dshSF_fold` 类上：禁用时移除这个类，页面一秒复原。
- 横条插在 `[data-step-process]` 根的最后、**不是** `[data-step-process-body]` 里面（那是宿主自己的滚动容器）。
- `refreshButton()` 每处都「变了才写」，否则 MutationObserver 会自己触发自己。
- `requestAnimationFrame` 合帧：流式输出时 DOM 变动极密。

### 4.2 挡位为什么走「命令 + 投影」

**挡位的真相在会话日志里，不在客户端内存里。** 三条路都是同一条：

```
点按钮  →  ctx.remote.commands.execute(sessionId, '/stepfold answer', [])
                    ↓
            宿主把 command/run + command/done 写进会话日志
                    ↓
      投影 stepfold 折叠出 { mode, running }
                    ↓
   控件用 useProjection('stepfold') 读它；宿主用 stateOf 判拦截
```

这么做的收益：刷新页面、切会话、会话 fork 之后挡位都还在；界面和手敲命令走同一条路，不用维护两套逻辑。

**命令执行一定是异步的**（处理器跑完才 append `command/done`），所以控件在点击后先本地高亮（`pendingMode`），等投影追上来再交权——否则点下去要等半秒才有反馈。

### 4.3 为什么用 `ctx.tools.guard` 而不是 `tools/pre-execute`

`tools/pre-execute` 是可排队的 waterfall，后面注册的监听器能把前面插件的拒绝**翻回允许**；`ctx.tools.guard(fn)` 是单调同步守卫，返回字符串即拒绝，没人能翻案。硬性拦截必须用后者。

`guard` 是**同步**的，不能 await 投影——所以它直接读 `stateOf(session,'stepfold')`（实时状态，O(1)）。

### 4.4 挡位语义

| 挡位 | 宿主端行为 |
|---|---|
| `answer` 只回答 | guard 拦 `BLOCKED_TOOLS` 表里的工具；提示词段注入「只读，不要动手，把该讲的讲清楚」 |
| `steps` 分步骤 | 不拦任何工具；提示词段注入「开头先报 3–6 条计划（每条一句话、带文件或模块名、不展开代码），然后一路做完」 |
| `free` 无限制 | 提示词段返回空串（等于不注入），guard 放行 |

`BLOCKED_TOOLS` 是一张**白名单式的黑名单**：`write` / `edit` / `pwsh` / `subagent` / `workflow` / `workflow-run` / `apply_patch` / `create_goal`。宿主以后新增的动手类工具默认**放行**——这是已知缺口，加工具时记得同步（见第 8 节）。

## 5. 宿主契约清单（升级 DSH 后先查这几处）

| 依赖 | 用途 | 挂了会怎样 |
|---|---|---|
| `[data-step-process]` / `-body` / `-content` | 折叠与横条定位 | 折叠失效，横条不出现 |
| `conversation.input.dock` 槽位（`kind:'list'`, `scope:'session'`） | 挂挡位开关 | 挡位开关整块消失 |
| 槽位 props 里的 `useProjection` / `sessionId` / `t` | 读挡位、发命令、取文案 | 同上 |
| `ctx.remote.commands.execute(sessionId, line, [])` → `{ok,value}` / `{ok:false,error}` | 切挡位 | 点了没反应，控件显示错误 |
| `ctx.commands.register` 的 `definitionId` 可选 | 注册 `/stepfold` | 命令注册直接 throw |
| `ctx.sessionProjections.register`（`stateSchema.parse` / `wire.viewSchema.parse`） | 挡位投影 | 插件加载失败 |
| `ctx.tools.guard(exec)` 同步返回 `string\|undefined` | 只回答挡位拦截 | 拦截失效（**最危险**，会以为挡住了其实没挡） |
| `ctx.systemPrompt.section({ name, order, interpolate:false, text })` | 按挡位注入规则 | 提示词不生效，但拦截还在 |
| `stateOf(session, key)` | guard 里读实时挡位 | 同上 |

宿主改版最坏的结果应是**折叠失效、挡位开关消失**，**不能**是「以为拦住了其实没拦」。改 guard 那段代码后请跑 `test/host.test.mjs`。

## 6. 在浏览器里调它

1. 打开 DSH Web（`http://127.0.0.1:4632`），F12。
2. 折叠是否加载：`document.querySelector('style[data-plugin-css="@local/step-fold/client.css"]')` 应存在；`document.documentElement.classList.contains('dshSF_fold')` 应为 `true`。
3. 步骤数：`document.querySelectorAll('[data-step-process-content]')[0].children.length`；横条数应等于「超过 5 步的组数」。
4. 挡位开关是否在场：输入框上方应出现三个小按钮，当前挡位是有底色那个。
5. 宿主半边是否加载：控制台敲 `/stepfold free` 应该有回执；如果显示「宿主不认识这个挡位命令」，就是 `index.js` 没重新求值 → 重启 DSH。
6. 验证拦截真的生效：切到「只回答」，让助手改个文件，它应该说「当前挡位拦住我了」而不是真的改。
7. 卸载验证：禁用插件后，`dshSF*` 节点、`<html>` 上的类、`style` 标签都应消失；提示词里不该再出现挡位段落。

## 7. 已知坑

- **改 `index.js` 一定要重启 DSH**。关开插件管理器不算——cordis 的模块缓存按 URL 记，不会重新求值。
- **别写成 `display:revert`**：会把宿主给步骤行设的布局一起退回浏览器默认值，行高错乱。
- **`refreshButton` 里必须「变了才写」**，否则 MutationObserver 自我触发死循环。
- **点击横条要 `preventDefault()` + `stopPropagation()`**：宿主的步骤体有点一下展开整组的处理。
- **`barOf()` 只在根的直接子元素里找横条**：宿主若把根改成 `<ul>`/`<table>`，这条要重设计。
- **步数 = 步骤行容器的直接子元素数**：宿主若插占位/加载行，计数会偏。
- **纯函数区**（`// >>>PURE-HELPERS` 到 `// <<<PURE-HELPERS<<<`）里不许碰 DOM，否则单测抠出来跑不起来。
- **挡位投影不写自定义事件**：插件没法给 append 的事件设 `ignorable` 标记，写进去的会话下次可能打不开。只折叠 `command/run` + `command/done`。
- **`command/done` 要按 `commandId` 核对**：不核对的话，任何一条命令跑完都会把挂起的切换落实。
- **烟测里 `attachments` 是 vm 沙箱里造的数组**，原型不同，`assert.deepEqual(x, [])` 会报 "same structure but not reference-equal"——只比 `.length`。
- **假 React 的 hook 游标每次渲染前要归零**，否则 `useState` 每次 push 新槽位，重渲染拿到旧值。

## 8. 下一步待办（按优先级）

**P0 · 对外发布前要有**
- [ ] README 和本文件补「**适配的 DSH 版本**」。公开项目最常见的 issue 是「装了没反应」，而失效是静默的（横条不出现 / 挡位按钮不见），没有版本声明根本查不出来。
- [ ] 补 `CHANGELOG.md`（1.0.0 折叠、1.1.0 加挡位）。
- [ ] 加 GitHub Actions 跑三个测试 + `node --check`。零依赖。
- [ ] 决定 `prototype/` 的去留（开发期原型，对使用者无用，建议移到 `docs/` 或删掉）。

**P1 · 挡位功能的缺口**
- [ ] `BLOCKED_TOOLS` 是按工具名硬编码的。宿主新增动手类工具（比如以后有 `move`/`delete`）默认会**放行**。更稳的做法是反过来：只放行读类前缀（`read`/`get_`/`list_`/`search`/`inspect_`/`web_`/`glob`/`grep`）。**改之前先跑 `test/host.test.mjs`**，那边断言了当前两张表。
- [ ] 决策时讨论过、这一版**没做**的两条：①一轮做完自动跳回「分步骤」；②发含「开工」的消息自动切「无限制」。两者都需要在轮次边界写会话状态，得先确认 append 契约（能不能写 `ignorable` 事件）。
- [ ] 挡位只在**当前会话**生效；跨会话没有「全局默认挡位」设置。

**P2 · 小问题**
- [ ] `KEEP_STEPS = 5` 写死；改它要同时改 CSS 里的 `nth-last-child`（代码里是 `KEEP_STEPS + 1` 拼的，别手改数字）。
- [ ] `locale/zh.json` 用顶层 `title`/`description`，姊妹项目 QuickReply 用 `meta.title`/`meta.description`，两边不一致；宿主是否两种都认**未核实**。
- [ ] 横条不折「思考」正文（宿主自己有折叠）。

**P3 · 功能候选（先问需求再动）**
- [ ] 每轮折叠步数可配置（1/3/5/10）。
- [ ] 记住每组展开状态（现在切会话就重置成折叠）。

## 9. 发布流程

1. 改 `package.json` 的 `version`（当前 1.1.0）。
2. 同步 README 的「行为细节」「已知限制」两节。
3. 跑第 1 节那四条命令，全绿。
4. `git commit` → `git tag vX.Y.Z` → 推到 `origin`（`git@github.com:tupi00/dsh-step-fold.git`），发 GitHub Release。
5. Release 里要写清楚：**1.1.0 起有宿主半边，升级必须重启 DSH**（1.0.0 只要刷新页面）。

> 本机提醒：受限沙箱下 `ssh` 会报 `fatal error - couldn't create signal pipe, Win32 error 5`，`git push` 需要 `danger-full-access`，或改用 HTTPS + token。

## 10. 许可

MIT（见 `LICENSE`）。
