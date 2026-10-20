/**
 * StepFold 的 host 半边：协作挡位（只回答 / 分步骤 / 无限制）。
 *
 * 为什么要有挡位：AI 接到一句话就埋头干活，中途看不到它想干什么，跑偏了只能等它
 * 跑完再回头。挡位把「这一轮它能做到哪一步」变成用户按得动的一个开关：
 *
 *   只回答 —— 只能读、搜、看网页；写文件、跑命令、派子代理一律拦下来，
 *             把该说的说清楚，别动手。（拦在 tools.guard 里，模型绕不过去）
 *   分步骤 —— 动手前先报 3–6 条计划，然后一路做完，中途用户随时可以打断。
 *   无限制 —— 和没装这个插件一样（默认）。
 *
 * 状态存哪：不存插件内存。挡位的每一次切换都通过 /stepfold 命令完成，命令的
 * `command/run` / `command/done` 事件本来就在会话日志里，投影把它们折叠成
 * 「这个会话现在是哪个挡位」。所以刷新页面、重开会话、fork 出来的会话都能
 * 恢复挡位，插件自己不需要记任何东西。
 *
 * 为什么不用 session.append 存自定义事件：宿主只允许「已注册类型」或带
 * `ignorable: true` 的事件进日志，插件的 live append 设不了这个标记，
 * 写进去的会话下次可能打不开。折命令事件是零风险的写法。
 */

/** 三个挡位的内部名。改名字要连投影的 stateVersion 一起升。 */
const MODE_ANSWER = 'answer'
const MODE_STEPS = 'steps'
const MODE_FREE = 'free'

/** 默认挡位：无限制，也就是「和没装这个插件一样」。 */
const DEFAULT_MODE = MODE_FREE

/** 挡位的中文名，用在命令回执和界面上。 */
const MODE_LABEL = {
  [MODE_ANSWER]: '只回答',
  [MODE_STEPS]: '分步骤',
  [MODE_FREE]: '无限制',
}

/** 用户敲的命令名：/stepfold answer|steps|free（也认 1/2/3 和中文）。 */
const COMMAND_NAME = 'stepfold'

/** 投影的 key 与版本。字段或折叠规则变了就把版本 +1，旧的检查点会自动作废。 */
const PROJECTION_KEY = 'stepfold'
const STATE_VERSION = 1

/**
 * 注入到系统提示词里的那一段的名字与排序号。
 *
 * 排序号 550 是特意挑的：宿主自己的标准座位里 PLAN_POLICY 是 500、TEAM_POLICY 是 600，
 * 都在整份提示词的靠前位置（后面 1000 往后全是各个工具的说明，几千行）。
 * 早先用 5050，正好夹在工具说明中间，模型基本不会注意到——「注入了但没照做」
 * 有一半原因在这儿。
 */
const SECTION_NAME = 'stepfold:collaboration-mode'
const SECTION_ORDER = 550

/**
 * 只回答挡位要拦下来的工具。
 *
 * 用「点名拦」而不是「点名放行」：宿主的工具集会随版本增加，白名单会让新工具
 * 悄悄溜过去；黑名单只会让新工具默认放行——但那恰好是「只回答」想要的宽松面吗？
 * 不是。所以两边都要：先拦这批明确的动手工具，再兜住几个前缀。
 */
const BLOCKED_TOOLS = new Set([
  'pwsh',
  'bash',
  'write',
  'edit',
  'apply_patch',
  'subagent',
  'spawn_teammate',
  'workflow',
  'delegate',
  'create_goal',
  'update_goal',
  'notify_wechat',
  'send_to_wechat',
  'send_message',
  'interrupt_agent',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'team_task_create',
  'team_task_update',
  'session_control',
  'job_kill',
])

/**
 * 只回答挡位里，模型会看到的说明。
 *
 * 写在提示词里而不是只靠工具拦截：模型先知道规则，就不会白跑一趟再被拒绝，
 * 回答的口吻也会跟着变成「解释」而不是「准备开工」。
 */
const ANSWER_TEXT = [
  '【当前挡位：只回答】',
  '这一轮你只负责回答，不要动手：不写文件、不改文件、不运行命令、不派子代理、不改目标。',
  '需要核对事实时可以用只读工具：读文件、按内容搜索、看网页。',
  '如果用户真正要的是「去做」而不是「说清楚」，就在回答里把方案讲明白，',
  '并提醒他把输入框上方的挡位切到「分步骤」或「无限制」再让你开工。',
].join('\n')

/** 分步骤挡位里，模型会看到的说明。 */
const STEPS_TEXT = [
  '【当前挡位：分步骤】这一轮的**回答格式**是硬性要求，不是建议：',
  '1. 回答的第一个字就要开始列计划：把这一轮打算做的 3–6 件事写出来，每条一句话，带上要改的文件名或模块名，不贴代码。',
  '2. 列完直接一路做完，不要停下来等用户逐条批准——用户会在这期间随时打断或改方向。',
  '3. 只说明情况、不需要动手的一轮，就写一行「这轮不需要动手」，然后直接回答。',
  '4. 做完简要说明改了哪几处、怎么验证的。',
  '5. 干到一半发现计划里没写、但必须做的事：**能撤销的**（多改一个文件、多跑一次测试、下载到临时目录）先用一句话说明「计划外多一步：要做什么、为什么」，然后接着做，不要停下来等批准。',
  '6. **不能撤销或有副作用的**（装全局包、改系统配置、删目录、强制推送、花钱）：先停下来说明原因，等用户点头再做。',
].join('\n')

/** 命令回执里给的用法提示。 */
const USAGE = '用法：/stepfold answer（只回答）| steps（分步骤）| free（无限制），也可以写 1 / 2 / 3。'

/**
 * 一个「什么都不校验」的 schema。
 *
 * 宿主的投影注册表只要求 schema 有 `.parse()`，没有规定必须是 zod。插件从
 * profile 目录加载，自己拉不到 zod（也不该为了校验一种三种取值的字符串去拉），
 * 所以给一个原样返回的壳。
 */
const PASSTHROUGH_SCHEMA = { parse: (value) => value }

// >>>PURE-HELPERS
/**
 * 把用户写的东西认成挡位。
 *
 * 认三种写法：英文名、数字（1/2/3，对着界面从左到右）、中文名。
 * 认不出来返回 undefined —— 调用方要把它当「没听懂」，别默默改成默认挡位。
 */
function parseMode(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return undefined
  if (text === 'answer' || text === 'only' || text === '1' || text === '只回答') return MODE_ANSWER
  if (text === 'steps' || text === 'step' || text === '2' || text === '分步骤') return MODE_STEPS
  if (text === 'free' || text === '3' || text === '无限制') return MODE_FREE
  return undefined
}

/** 这个工具名在「只回答」挡位里要不要拦。 */
function isBlockedTool(name) {
  const tool = String(name ?? '')
  if (tool === '') return false
  if (BLOCKED_TOOLS.has(tool)) return true
  // 前缀兜底：宿主的 workflow 系列、以及将来可能出现的 patch 类工具
  return tool.startsWith('workflow') || tool.startsWith('apply_patch')
}

/**
 * 投影：从会话日志折叠出「这个会话现在是什么挡位」。
 *
 * 只认两件事：
 *   command/run  —— 用户敲了一次 /stepfold xxx，把想要的值挂起
 *   command/done —— 这次切换结算了；成功才真的换挡，失败就丢掉
 * 其它事件原样返回同一个 state 引用（宿主靠引用判断「没变化」，别每次新建对象）。
 */
function applyState(state, event) {
  if (event.type === 'command/run' && event.data !== undefined && event.data.name === COMMAND_NAME) {
    const wanted = parseMode(event.data.args)
    if (wanted === undefined) return state
    return { mode: state.mode, running: { commandId: event.data.commandId, mode: wanted } }
  }
  if (
    event.type === 'command/done' &&
    event.data !== undefined &&
    state.running !== null &&
    event.data.commandId === state.running.commandId
  ) {
    if (event.data.kind !== 'success') return { mode: state.mode, running: null }
    return { mode: state.running.mode, running: null }
  }
  return state
}

/** 控件上显示的挡位：正在切换时先显示目标值，点下去立刻有反馈。 */
function viewOf(state) {
  return { mode: state.running === null ? state.mode : state.running.mode }
}
// <<<PURE-HELPERS<<<

/** 投影定义：宿主会拿它在每个已提交事件上驱动一次 `apply`。 */
const projectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: STATE_VERSION,
  stateSchema: PASSTHROUGH_SCHEMA,
  init: () => ({ mode: DEFAULT_MODE, running: null }),
  apply: applyState,
  wire: {
    viewSchema: PASSTHROUGH_SCHEMA,
    view: viewOf,
  },
}

/**
 * 插件入口。
 *
 * @param {object} ctx cordis 上下文
 * @returns {void}
 */
export function apply(ctx) {  // 四个服务缺一个就整体不激活：挡位要同时改提示词、拦工具、记状态，缺一块
  // 就是「界面能点但不管用」，比不显示更糟。
  ctx.inject(['sessionProjections', 'systemPrompt', 'tools', 'commands'], (scoped) => {
    scoped.effect(
      () => scoped.sessionProjections.register(projectionDefinition),
      'step-fold: 挡位投影',
    )

    /** 读某个会话现在生效的挡位（会话还没进投影时按默认值算）。 */
    function modeOf(session) {
      if (session === undefined || session === null) return DEFAULT_MODE
      const state = scoped.sessionProjections.stateOf(session, PROJECTION_KEY)
      if (state === undefined || state === null) return DEFAULT_MODE
      return typeof state.mode === 'string' ? state.mode : DEFAULT_MODE
    }

    /** 读某个 agent 现在生效的挡位。 */
    function modeOfAgent(agent) {
      return agent === undefined ? DEFAULT_MODE : modeOf(agent.session)
    }

    // 1) 提示词：每轮组装时按当前挡位决定要不要加那一段。
    //    返回空串就是不注入，提示词和没装插件时一字不差。
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          // 我们的文本里没有 {{变量}}；关掉插值，避免用户的文本里出现 {{ 时把整轮组装搞崩。
          interpolate: false,
          text: (context) => {
            if (context.agent === undefined) return ''
            const mode = modeOfAgent(context.agent)
            if (mode === MODE_ANSWER) return ANSWER_TEXT
            if (mode === MODE_STEPS) return STEPS_TEXT
            return ''
          },
        }),
      'step-fold: 挡位提示词',
    )

    // 2) 只回答挡位的硬拦截。
    //    为什么用 guard 而不是 tools/pre-execute：guard 是单调的同步守卫，
    //    别的插件（包括后台策略）没法在它之后把拒绝改回允许；而 pre-execute
    //    是可排队的 waterfall，别人排在后面就能翻案。
    scoped.effect(
      () =>
        scoped.tools.guard((exec) => {
          if (modeOfAgent(exec.agent) !== MODE_ANSWER) return undefined
          if (!isBlockedTool(exec.name)) return undefined
          return (
            `当前挡位是「只回答」，${exec.name} 这类动手操作被挡住了：` +
            '不写文件、不跑命令、不派子代理。' +
            '请先把要做的事讲清楚；要真开工，让用户把输入框上方的挡位切到「分步骤」或「无限制」。'
          )
        }),
      'step-fold: 只回答挡位拦截',
    )

    // 3) 命令：界面上的挡位按钮和手动敲 /stepfold 走的是同一条路。
    scoped.effect(
      () =>
        scoped.commands.register({
          name: COMMAND_NAME,
          description: '切换协作挡位：只回答 / 分步骤 / 无限制',
          input: { hint: 'answer | steps | free' },
          handler: ({ rawInput }) => {
            const mode = parseMode(rawInput)
            if (mode === undefined) return { kind: 'error', text: USAGE }
            return { kind: 'success', text: `挡位已切到「${MODE_LABEL[mode]}」。` }
          },
        }),
      'step-fold: 挡位命令',
    )
  })
}

// 这些只是给 test/host.test.mjs 用的。宿主加载插件时只认 apply，多导出几个
// 纯函数不会改变任何行为，但能让「挡位怎么认、什么时候生效、拦哪些工具」
// 这些判断脱离真实运行时也能被测到。
export {
  applyState,
  isBlockedTool,
  parseMode,
  projectionDefinition,
  viewOf,
  MODE_ANSWER,
  MODE_FREE,
  MODE_STEPS,
}
