/**
 * 「步骤折叠」插件的浏览器端（client.js）。
 *
 * 干什么：宿主把一轮回答里的工具/思考过程渲染成一串步骤行（步骤体）。这个插件把
 * 每组步骤默认收成「最近 5 步」，下面加一条横条按钮，点一下展开全部，再点收回。
 *
 * 为什么不改宿主的 React 组件：
 *   步骤体是宿主自己渲染的，宿主没有给「步骤体内部」留插槽。整块替换它（keyed 槽
 *   conversation.chat.node 的 turn-process）在宿主升级后必坏。所以这里只做两件事：
 *   1. 注入一条 CSS，把每组步骤体里较老的行 display:none；
 *   2. 用 MutationObserver 给每组步骤体补一个我们自己创建的按钮。
 *   全程不读宿主的 React 状态，也不改宿主渲染的节点，最坏情况只是按钮不出现。
 *
 * 依赖的宿主属性（ui-chat-client.js 的 ChatGroupSeat 写在 DOM 上）：
 *   [data-step-process]          一组过程步骤的根
 *   [data-step-process-body]     可折叠的身体（宿主自己也会用它做 max-height 滚动）
 *   [data-step-process-content]  步骤行的容器，直接子元素就是每一「步」
 * 这些是宿主的稳定 DOM 约定；万一改版，折叠失效但不会弄坏聊天。
 */
window.__ModuleLoader__.load({
  id: '@local/step-fold',
  factory(require) {
    // 步骤折叠按钮是纯 DOM（不经过 React），但输入框上方的挡位开关是一个真正的
    // React 组件——宿主把 slot 里的东西当组件渲染，必须返回 React 元素。
    const React = require('react')
    const h = React.createElement

    /** 本插件自己的文案命名空间。 */
    const NS = 'step-fold'

    /** 本插件所有 class / 属性的前缀，避免和宿主撞名。 */
    const CLS = 'dshSF'

    /** 挂在 <html> 上的开关类：有它才折叠。卸载时去掉，页面立刻恢复原样。 */
    const FOLD_CLASS = CLS + '_fold'

    /** 我们插入的横条的标记属性（清理时按它找）。 */
    const BAR_ATTR = 'data-dshsf-bar'

    /** 某一组已展开全部时，挂在该组根上的标记属性。 */
    const ALL_ATTR = 'data-dshsf-all'

    // 以下纯函数会被 test/helpers.test.mjs 抠出来单测，别在这里碰 DOM。
    // >>>PURE-HELPERS
    /** 每组默认只显示最近几步。 */
    const KEEP_STEPS = 5

    /** 把 {name} 占位符换成参数值。 */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        params[name] === undefined ? whole : String(params[name]),
      )
    }

    /** 这一组藏起来几行（不足 KEEP 时是 0）。 */
    function hiddenCount(total, keep = KEEP_STEPS) {
      const count = Number(total)
      if (!Number.isFinite(count) || count <= keep) return 0
      return Math.ceil(count) - keep
    }

    /** 这一组需不需要折叠按钮（行数多于 KEEP 才需要）。 */
    function needsFold(total, keep = KEEP_STEPS) {
      return hiddenCount(total, keep) > 0
    }

    /**
     * 按钮上写什么。labels 是当前语言的文案字典：
     *   showAll  未展开时：「显示全部 11 步（还有 6 步）」
     *   collapse 已展开时：「只看最近 5 步」
     */
    function barLabel(total, expanded, labels, keep = KEEP_STEPS) {
      if (expanded) return fill(labels.collapse, { keep })
      return fill(labels.showAll, { total, hidden: hiddenCount(total, keep) })
    }
    // <<<PURE-HELPERS<<<

    /**
     * 本插件要注入的样式。
     *
     * 折叠规则用 :nth-last-child —— 从末尾数，后 5 个留着，更早的藏掉。
     * 只作用于「没被标记为展开」的组，所以展开某一组不会影响别的组。
     * 注意别写成 display:revert：那会把宿主给步骤行设的布局一起退回浏览器默认值。
     */
    const STYLE_TEXT = [
      `html.${FOLD_CLASS} [data-step-process]:not([${ALL_ATTR}]) [data-step-process-content] > :nth-last-child(n+${KEEP_STEPS + 1}){display:none!important}`,
      // 底部横条：与步骤体之间用一条细线分开，按钮居中，像一条「还有更多」的封口。
      `.${CLS}_bar{display:flex;justify-content:center;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));margin-top:6px;padding-top:6px}`,
      `.${CLS}_btn{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;font-size:12px;line-height:1.4;padding:3px 12px;border-radius:999px;cursor:pointer}`,
      `.${CLS}_btn:hover{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.4))}`,
      `.${CLS}_btn:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#4183c4);outline-offset:1px}`,
      // 挡位开关：输入框上方那一条。三个胶囊装在一个圆角壳里，当前挡位填成主色，
      // 其余是透明的——和宿主自己的分段控件一个长相，一眼能看出现在选了哪个。
      `.${CLS}_modes{display:flex;align-items:center;gap:8px;min-width:0}`,
      `.${CLS}_modeGroup{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}`,
      `.${CLS}_mode{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font:inherit;font-size:12px;line-height:1;padding:4px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}`,
      `.${CLS}_mode:hover{color:var(--dsw-alias-label-primary,inherit)}`,
      `.${CLS}_mode[aria-pressed="true"]{background:var(--dsw-alias-button-info-fill,#4183c4);color:var(--dsw-alias-bg-base,#fff);cursor:default}`,
      `.${CLS}_mode:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#4183c4);outline-offset:1px}`,
      `.${CLS}_mode:disabled{opacity:.6;cursor:progress}`,
      `.${CLS}_modeHint{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8a8f98);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
      `.${CLS}_modeError{font-size:12px;line-height:1.4;color:var(--dsw-alias-state-error-primary,#c0392b)}`,
    ].join('\n')

    /**
     * 把样式插进页面。
     *
     * 为什么不用 ctx.styles：那是「动态插件」沙箱里才有的参数，装进 profile 的普通插件
     * 拿不到。宿主自带的客户端插件也都是自己 createElement('style') 塞进 head。
     */
    function insertStyles() {
      if (typeof document === 'undefined') return () => {}
      const tagId = '@local/step-fold/client.css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/step-fold'
        tag.dataset.pluginCss = tagId
        tag.textContent = STYLE_TEXT
        document.head.appendChild(tag)
        return () => tag.remove()
      }
      return () => {}
    }

    // ------------------------------------------------------------------
    // DOM 操作：给每组步骤体补一个「显示全部 / 收起」按钮
    // ------------------------------------------------------------------
    /** 找一组的步骤行容器（找不到说明结构变了，安静跳过）。 */
    function contentOf(root) {
      return root.querySelector('[data-step-process-content]')
    }

    /** 数这一组有几行步骤。 */
    function totalOf(content) {
      return content && content.children ? content.children.length : 0
    }

    /** 找我们插在这一组里的横条（没有就返回 null）。 */
    function barOf(root) {
      const children = root.children || []
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]
        if (child && typeof child.hasAttribute === 'function' && child.hasAttribute(BAR_ATTR)) return child
      }
      return null
    }

    /** 更新按钮文案与无障碍属性。只在真的变了才写，免得 MutationObserver 自己触发自己。 */
    function refreshButton(button, total, expanded, labels) {
      const text = barLabel(total, expanded, labels)
      if (button.textContent !== text) button.textContent = text
      const aria = expanded ? 'true' : 'false'
      if (button.getAttribute('aria-expanded') !== aria) button.setAttribute('aria-expanded', aria)
      const title = expanded ? labels.titleCollapse : fill(labels.titleShowAll, { total })
      if (button.title !== title) button.title = title
    }

    /** 点一下：在「只看最近几步」和「看全部」之间切换这一组。 */
    function toggle(root, button, labels) {
      const expanded = root.hasAttribute(ALL_ATTR)
      if (expanded) root.removeAttribute(ALL_ATTR)
      else root.setAttribute(ALL_ATTR, '')
      const content = contentOf(root)
      refreshButton(button, totalOf(content), !expanded, labels)
    }

    /** 横条还不存在就创建一条，插在步骤体后面（不在宿主的滚动容器里）。 */
    function ensureBar(root, labels) {
      const existing = barOf(root)
      if (existing) return existing
      const doc = root.ownerDocument || document
      const bar = doc.createElement('div')
      bar.className = CLS + '_bar'
      bar.setAttribute(BAR_ATTR, '')

      const button = doc.createElement('button')
      button.type = 'button'
      button.className = CLS + '_btn'
      button.addEventListener('click', (event) => {
        // 别让点击冒泡到宿主的步骤体（那里有「点一下展开整组」的处理）
        event.preventDefault()
        event.stopPropagation()
        toggle(root, button, labels)
      })
      bar.appendChild(button)
      // 把按钮引用挂在横条上，下一次同步直接拿来用，不用再 query
      bar.__dshsfButton = button

      // 插在根的最后：body 是宿主的滚动容器，横条必须在它外面才始终可见
      root.appendChild(bar)
      return bar
    }

    /**
     * 同步一组：行数够就补横条，不够就撤掉；已展开的组顺手刷新按钮文案。
     */
    function syncGroup(root, labels) {
      if (!root || typeof root.querySelector !== 'function') return
      const content = contentOf(root)
      if (!content) return
      const total = totalOf(content)
      const bar = barOf(root)

      if (!needsFold(total)) {
        if (bar) bar.remove()
        if (root.hasAttribute(ALL_ATTR)) root.removeAttribute(ALL_ATTR)
        return
      }

      const expanded = root.hasAttribute(ALL_ATTR)
      if (!bar) {
        const created = ensureBar(root, labels)
        refreshButton(created.__dshsfButton, total, expanded, labels)
        return
      }
      refreshButton(bar.__dshsfButton, total, expanded, labels)
    }

    /** 把页面上所有步骤体都同步一遍。 */
    function syncAll(labels) {
      if (typeof document === 'undefined') return
      document.querySelectorAll('[data-step-process]').forEach((root) => syncGroup(root, labels))
    }

    /**
     * 监听聊天流：步骤是流式追加的，每来一批就重新同步。
     *
     * 用 requestAnimationFrame 合帧：聊天跑起来时 DOM 变动很密，
     * 每一处变动都同步一次会把主线程拖死。
     */
    function observe(labels) {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {}
      let frame = 0
      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          syncAll(labels)
        })
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        if (frame !== 0) window.cancelAnimationFrame(frame)
      }
    }

    // ------------------------------------------------------------------
    // 文案
    // ------------------------------------------------------------------
    const zh = {
      showAll: '显示全部 {total} 步（还有 {hidden} 步）',
      collapse: '只看最近 {keep} 步',
      titleShowAll: '展开这一轮的全部 {total} 步',
      titleCollapse: '收起，只显示最近 {keep} 步',
      // 挡位开关（输入框上方那一排）
      'modes.aria': '协作挡位',
      'modes.answer': '只回答',
      'modes.steps': '分步骤',
      'modes.free': '无限制',
      'modes.answer.title': '只读：能看文件、搜内容、开网页，不能改文件也不能跑命令',
      'modes.steps.title': '动手前先报 3–6 条计划，然后一路做完，中途随时可以打断',
      'modes.free.title': '不设限制，和平时一样',
      'modes.failed': '没切成功，再点一次试试',
    }

    const en = {
      showAll: 'Show all {total} steps ({hidden} hidden)',
      collapse: 'Show last {keep} steps',
      titleShowAll: 'Expand all {total} steps in this turn',
      titleCollapse: 'Collapse to the last {keep} steps',
      'modes.aria': 'Collaboration mode',
      'modes.answer': 'Answer only',
      'modes.steps': 'Step by step',
      'modes.free': 'Unrestricted',
      'modes.answer.title': 'Read-only: read files, search, browse — no edits, no commands',
      'modes.steps.title': 'Announce 3–6 steps first, then carry them out; interrupt anytime',
      'modes.free.title': 'No restriction, same as usual',
      'modes.failed': 'Switch failed — click again',
    }

    /** DOM 文本没有宿主 t 可用，按页面语言挑字典（中文界面占绝大多数，默认中文）。 */
    function currentLabels() {
      const lang =
        typeof document !== 'undefined' ? String(document.documentElement.lang || '') : ''
      return lang.toLowerCase().startsWith('en') ? en : zh
    }

    /**
     * 取一条文案：优先问宿主的 t（它会读 locale/zh.json 那些文件），
     * 拿不到就按页面语言回落本地字典。两边都没有就原样显示 key，绝不抛错。
     */
    function tr(t, key) {
      if (typeof t === 'function') {
        try {
          const value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          /* 宿主的 t 抛错就当没有，下面回落 */
        }
      }
      const labels = currentLabels()
      return labels[key] === undefined ? key : labels[key]
    }

    // ------------------------------------------------------------------
    // 挡位开关：只回答 / 分步骤 / 无限制
    // ------------------------------------------------------------------
    /**
     * 三个挡位，数组顺序就是界面上从左到右的顺序（1 号档 = 只回答）。
     *
     * 这三个名字要和 host 半边 index.js 里的 MODE_ANSWER / MODE_STEPS / MODE_FREE 一致；
     * 点击时它们会被拼成 `/stepfold <名字>` 发给宿主。
     */
    const MODE_ORDER = ['answer', 'steps', 'free']

    /** 宿主没给 useProjection 时的兜底 hook：永远返回 undefined，但占住 hook 位置。 */
    function useNoProjection() {
      return undefined
    }

    /**
     * 输入框上方的挡位开关。
     *
     * 状态从宿主的投影读（就是 host 半边注册的那个 `stepfold`），点击则走
     * `/stepfold <名字>` 命令 —— 界面和手敲命令是同一条路，不会出现两套逻辑。
     *
     * 为什么要 pending：命令是异步的，点下去到投影更新之间有几十毫秒。
     * 不给反馈的话用户会以为没点上，连点三下就是三次切换。
     */
    function ModeSwitch(props) {
      const pickProjection =
        typeof props.useProjection === 'function' ? props.useProjection : useNoProjection
      const state = pickProjection('stepfold')
      const mode =
        state !== undefined && state !== null && typeof state.mode === 'string' ? state.mode : 'free'
      const [pending, setPending] = React.useState(null)
      const [error, setError] = React.useState(null)
      const aliveRef = React.useRef(true)
      React.useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      // 宿主没把 setMode 注入进来（比如 host 半边没加载），就不画这个控件，
      // 免得用户点了个永远没反应的按钮。
      if (typeof props.setMode !== 'function') return null

      const choose = (next) => {
        if (next === (pending === null ? mode : pending)) return
        setPending(next)
        setError(null)
        Promise.resolve(props.setMode(next)).then(
          (failure) => {
            if (!aliveRef.current) return
            setPending(null)
            setError(failure === undefined ? null : failure)
          },
          (reason) => {
            if (!aliveRef.current) return
            setPending(null)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }

      const shown = pending === null ? mode : pending
      return h(
        'div',
        { className: CLS + '_modes' },
        h(
          'div',
          { className: CLS + '_modeGroup', role: 'group', 'aria-label': tr(props.t, 'modes.aria') },
          MODE_ORDER.map((name) =>
            h(
              'button',
              {
                key: name,
                type: 'button',
                className: CLS + '_mode',
                'aria-pressed': name === shown ? 'true' : 'false',
                disabled: pending !== null,
                title: tr(props.t, 'modes.' + name + '.title'),
                onClick: () => choose(name),
              },
              tr(props.t, 'modes.' + name),
            ),
          ),
        ),
        error === null
          ? null
          : h(
              'span',
              { className: CLS + '_modeError', role: 'status', title: error },
              tr(props.t, 'modes.failed'),
            ),
      )
    }

    /**
     * 把错误文案压成一句人话：宿主给的是 `{ ok, error }`，可能是英文、
     * 可能带错误码，直接亮给用户太吵。这里只截第一行。
     */
    function shortReason(reason) {
      const text = String(reason === undefined ? '' : reason).split('\n')[0].trim()
      return text === '' ? '' : text
    }

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'step-fold: dictionaries')
        ctx.effect(() => insertStyles(), 'step-fold: styles')
        ctx.effect(() => {
          const labels = currentLabels()
          document.documentElement.classList.add(FOLD_CLASS)
          const stopObserving = observe(labels)
          // 先同步一次：已经渲染在屏幕上的旧轮次立刻收起来，不用等下一批 DOM 变动
          syncAll(labels)
          return () => {
            stopObserving()
            document.documentElement.classList.remove(FOLD_CLASS)
            document.querySelectorAll(`[${BAR_ATTR}]`).forEach((bar) => bar.remove())
            document
              .querySelectorAll(`[data-step-process][${ALL_ATTR}]`)
              .forEach((root) => root.removeAttribute(ALL_ATTR))
          }
        }, 'step-fold: folding')

        // 挡位开关：输入框上方那一排（和「目标」小卡片同一处）。
        // 用 /stepfold 命令切挡位，而不是自己维护一份客户端状态——
        // 挡位的真相在会话日志里，刷新页面、换会话都能读回来。
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'step-fold-modes',
              order: 40,
              locale: NS,
              inject: (sessionId) => ({
                setMode: async (mode) => {
                  if (typeof sessionId !== 'string' || sessionId === '') return '当前没有会话'
                  let result
                  try {
                    result = await ctx.remote.commands.execute(sessionId, `/stepfold ${mode}`, [])
                  } catch (reason) {
                    // 命令通道本身没连上（宿主重启中、连接断了）
                    return shortReason(reason) || '连不上宿主'
                  }
                  if (result === undefined || result === null) return '连不上宿主'
                  if (!result.ok) return shortReason(result.error && result.error.message) || '命令被拒绝'
                  if (result.value === undefined) return '宿主不认识这个挡位命令（host 半边没加载？）'
                  if (result.value.kind === 'error') return shortReason(result.value.text) || '挡位命令出错了'
                  return null
                },
              }),
            },
            ModeSwitch,
          ),
        )
      },
    }
  },
})
