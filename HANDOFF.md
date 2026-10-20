# HANDOFF · 交接文档

给「接下这个仓库的人」看。使用者看 [README.md](./README.md)，这里记的是：现在什么状态、为什么这么写、宿主改版时先查哪里、下一步该干什么。

最后更新：2026-10-20 · 版本 **1.0.0** · HEAD `7b7dada`

---

## 1. 一句话现状

`@local/step-fold`：DSH Web 界面的「步骤折叠」插件。每组过程步骤默认只留最近 5 步，底部补一条横条，点开看全部。

**能跑，测试全绿**：

| 项 | 命令 | 当前结果 |
|---|---|---|
| 纯函数单测 | `node test/helpers.test.mjs` | `helpers ok: 15 passed` |
| 假 DOM 烟测 | `node test/smoke-client.mjs` | `smoke ok: 折叠 / 展开 / 撤按钮 / 卸载 都符合预期` |
| 语法检查 | `node --check client.js` | 通过 |

烟测验的是「加载不炸 + 折叠判定对」，**视觉效果只能在浏览器里看**（见第 6 节）。

## 2. 装在哪、怎么生效

本机以 **link 方式**挂进 desktop profile：

```
C:\Users\tupi\.dsh\profiles\desktop\package.json
  dependencies:  "@local/step-fold": "link:F:/DSH产出/StepFold"
  dsh.profile.bundles: [ … , "@local/step-fold" ]
```

- 纯客户端插件，改完 `client.js` **刷新网页**即可，**不需要重启 DSH**。
- 别人的安装方式：`plugin_manager install_bundle`，target 指向本目录。

## 3. 文件地图

| 文件 | 作用 | 改它的风险 |
|---|---|---|
| `client.js`（283 行） | 全部逻辑：CSS + 横条 + MutationObserver | 主战场 |
| `index.js` | 宿主半边，空实现 | 低。`exports` 指向它，别删 |
| `cordis.patch.yml` | 注入 `id: step-fold` 的插件条目 | 低 |
| `package.json` | 元数据 + `dsh.bundle` / `dsh.client` 声明 | 中 |
| `locale/*.json` | 插件列表里的标题与描述（元数据） | 低 |
| `test/helpers.test.mjs` | 纯函数单测（`// >>>PURE-HELPERS` 区） | 低 |
| `test/smoke-client.mjs` | 最小 DOM 桩子跑整个 `client.js` | 中，改 DOM 逻辑要同步改它 |
| `prototype/` | **开发期原型**：`index.html` 是静态复刻的聊天步骤样式，`smoke.mjs` 是它那版的烟测 | 见第 8 节，考虑是否随仓库保留 |

## 4. 架构：为什么不用 React，只做两件事

宿主把一轮里的过程步骤渲染成一串行，**没有给「步骤体内部」留插槽**。整块替换它（keyed 槽 `conversation.chat.node` 的 `turn-process`）在宿主升级后必坏。

所以这里只做两件不碰宿主 React 的事：

1. **一条 CSS 规则**折叠老步骤（`display:none`，用 `:nth-last-child` 从末尾数，后 5 个留着）；
2. **一个 MutationObserver** 给每组步骤体末尾补一条自己的横条按钮，点了给该组根加 `data-dshsf-all` 标记，CSS 规则对已标记的组不生效。

```
html.dshSF_fold [data-step-process]:not([data-dshsf-all])
  [data-step-process-content] > :nth-last-child(n+6) { display:none !important }
```

关键取舍：

- **开关挂在 `<html>` 上的 `dshSF_fold` 类**：插件禁用时移除这个类，页面一秒恢复原样，不需要逐条还原样式。
- **横条插在 `[data-step-process]` 根的最后、不是步骤体里面**：`[data-step-process-body]` 是宿主自己的滚动容器，横条放进去会被滚出视野。
- **只写变了才写**：`refreshButton()` 里每处都先比对再写，避免 MutationObserver 自己触发自己形成死循环。
- **`requestAnimationFrame` 合帧**：流式输出时 DOM 变动极密，每处变动都 `syncAll` 会拖死主线程。

## 5. 宿主契约清单（升级 DSH 后先查这几处）

| 依赖 | 用途 |
|---|---|
| `[data-step-process]` | 一组过程步骤的根；横条挂在它最后，`data-dshsf-all` 也打在它上面 |
| `[data-step-process-body]` | 宿主的可折叠身体（我们**不**往里插东西，只用它判断存在） |
| `[data-step-process-content]` | 步骤行容器；**直接子元素数 = 步数**，`nth-last-child` 也作用在它 |
| 宿主给整组的折叠按钮 | 我们不动它；一组整体收起时我们的横条跟着不可见 |

宿主改版最坏的结果是**折叠失效、横条不出现**，不会弄坏聊天——请保持这个约束。

## 6. 在浏览器里调它

1. 打开 DSH Web（`http://127.0.0.1:4632`），F12。
2. 确认加载：`document.querySelector('style[data-plugin-css="@local/step-fold/client.css"]')` 应存在；`document.documentElement.classList.contains('dshSF_fold')` 应为 `true`。
3. 数步数：`document.querySelectorAll('[data-step-process-content]')[0].children.length`。
4. 看某组是否展开：`document.querySelectorAll('[data-step-process][data-dshsf-all]').length`。
5. 横条不该出现时（≤5 步的组）：`document.querySelectorAll('[data-dshsf-bar]').length` 应等于「超过 5 步的组数」。
6. 卸载验证：禁用插件后，`dshSF*` 节点、`<html>` 上的类、`style` 标签都应消失。

## 7. 已知坑

- **别写成 `display:revert`**：会把宿主给步骤行设的布局一起退回浏览器默认值，行高错乱。
- **`refreshButton` 里必须「变了才写」**：否则 MutationObserver 会被自己的写入再次触发。
- **点击横条要 `preventDefault()` + `stopPropagation()`**：宿主的步骤体有点一下展开整组的处理，不拦住会一起响。
- **`barOf()` 只在根的直接子元素里找横条**：假设根是可以接收任意子元素的容器。如果宿主把根改成 `<ul>`/`<table>`，这条要重新设计。
- **步数是「步骤行容器的直接子元素数」**：宿主若在这个容器里插占位/加载行，计数会偏，横条文案里的「还有 N 步」会不准。
- **纯函数区**（`// >>>PURE-HELPERS` 到 `// <<<PURE-HELPERS<<<`）里不许碰 DOM，否则单测抠出来跑不起来。

## 8. 下一步待办（按优先级）

**P0 · 对外发布前要有**
- [ ] README 和本文件补「**适配的 DSH 版本**」。公开项目最常见的 issue 就是「装了没反应」，而失效是静默的（横条不出现），没有版本声明根本查不出来。
- [ ] 补 `CHANGELOG.md`（目前只有 v1.0.0 一个提交 `7b7dada`，补齐很容易）。
- [ ] 加 GitHub Actions 跑 `test/helpers.test.mjs` + `test/smoke-client.mjs` + `node --check`。零依赖。
- [ ] 决定 `prototype/` 的去留：它是开发期静态原型（`index.html` + 那版烟测），对使用者无用、对维护者只有考古价值。建议移到 `docs/` 或删掉，别和 `test/` 混在一起让人误以为要跑。

**P1 · 小问题**
- [ ] `KEEP_STEPS = 5` 写死的常量，没做成设置项；改它要同时改 CSS 里的 `nth-last-child(n+6)`（代码里是 `KEEP_STEPS + 1` 拼出来的，**别手改数字**）。
- [ ] `locale/zh.json` 用的是顶层 `title`/`description`，而姊妹项目 QuickReply 用的是 `meta.title`/`meta.description`。两个仓库写法不一致；宿主是否两种都认**还没核实**（`app.asar` 打不开，见插件列表实际显示），要统一先确认这一点。
- [ ] 横条不折「思考」正文（那是另一类节点，宿主自己有折叠），README 已列为限制。

**P2 · 功能候选（先问需求再动）**
- [ ] 每轮「折叠步数」可配置（1/3/5/10）。
- [ ] 「全部收成 1 步」的一键模式。
- [ ] 记住每组展开状态（现在切会话就重置成折叠）。

## 9. 发布流程

1. 改 `package.json` 的 `version`（当前 1.0.0）。
2. 同步 README 的「行为细节」「已知限制」两节。
3. 跑第 1 节那三条命令，全绿。
4. `git commit` → `git tag vX.Y.Z` → 推到 `origin`（`git@github.com:tupi00/dsh-step-fold.git`），发 GitHub Release。
5. 告诉使用者刷新网页（本插件不需要重启 DSH，这点值得在 Release 里写明）。

> 本机提醒：受限沙箱下 `ssh` 会报 `fatal error - couldn't create signal pipe, Win32 error 5`，`git push` 需要 `danger-full-access` 权限，或改用 HTTPS + token。

## 10. 许可

MIT（见 `LICENSE`）。
