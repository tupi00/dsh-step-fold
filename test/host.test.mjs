/**
 * host 半边单测：挡位怎么认、什么时候生效、拦哪些工具。
 *
 * 不连真宿主——用假 ctx 把 apply() 跑一遍，检查它注册了哪些东西
 * （投影 / 提示词段 / guard / 命令），以及这些回调的判断对不对。
 *
 * 跑法：node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import {
  apply,
  applyState,
  isBlockedTool,
  parseMode,
  viewOf,
  MODE_ANSWER,
  MODE_FREE,
} from '../index.js'

// ---------------------------------------------------------------- parseMode
assert.equal(parseMode('answer'), MODE_ANSWER)
assert.equal(parseMode('ANSWER'), MODE_ANSWER)
assert.equal(parseMode('  only '), MODE_ANSWER)
assert.equal(parseMode('只回答'), MODE_ANSWER)
assert.equal(parseMode('1'), MODE_ANSWER)

assert.equal(parseMode('free'), MODE_FREE)
assert.equal(parseMode('2'), MODE_FREE)
assert.equal(parseMode('无限制'), MODE_FREE)

// 「分步骤」这一档已经砍掉：旧命令 /stepfold steps 必须认不出来，
// 这样命令处理器会回用法提示，而不是静默改成某个挡位。
assert.equal(parseMode('steps'), undefined)
assert.equal(parseMode('step'), undefined)
assert.equal(parseMode('3'), undefined)
assert.equal(parseMode('分步骤'), undefined)

// 认不出来就是 undefined —— 调用方要报错，不能默默当默认挡位
assert.equal(parseMode(''), undefined)
assert.equal(parseMode(undefined), undefined)
assert.equal(parseMode(null), undefined)
assert.equal(parseMode('随便什么'), undefined)
assert.equal(parseMode('0'), undefined)
assert.equal(parseMode('4'), undefined)

// ---------------------------------------------------------------- isBlockedTool
assert.equal(isBlockedTool('write'), true)
assert.equal(isBlockedTool('edit'), true)
assert.equal(isBlockedTool('pwsh'), true)
assert.equal(isBlockedTool('subagent'), true)
assert.equal(isBlockedTool('workflow'), true)
assert.equal(isBlockedTool('workflow-run'), true)
assert.equal(isBlockedTool('apply_patch'), true)
assert.equal(isBlockedTool('create_goal'), true)

assert.equal(isBlockedTool('read'), false)
assert.equal(isBlockedTool('grep'), false)
assert.equal(isBlockedTool('glob'), false)
assert.equal(isBlockedTool('web_search'), false)
assert.equal(isBlockedTool('ask_user_question'), false)
assert.equal(isBlockedTool('todo_write'), false)
assert.equal(isBlockedTool(''), false)
assert.equal(isBlockedTool(undefined), false)

// ---------------------------------------------------------------- applyState
const init = { mode: MODE_FREE, running: null }

// 无关事件：必须返回同一个引用（宿主靠引用判断「没变化」）
const untouched = applyState(init, { type: 'tool/result', data: {} })
assert.equal(untouched, init, '无关事件必须原样返回同一个 state 引用')

// 不认识参数的 /stepfold：不改状态
const badRun = applyState(init, {
  type: 'command/run',
  data: { name: 'stepfold', args: '???', commandId: 'c1' },
})
assert.equal(badRun, init, '参数不认识时不该挂起切换')

// 别的命令：不理
const otherCmd = applyState(init, {
  type: 'command/run',
  data: { name: 'plan', args: 'off', commandId: 'c9' },
})
assert.equal(otherCmd, init, '别的命令不该影响挡位')

// 正常切换：先挂起，等 done 成功才生效
const run = applyState(init, {
  type: 'command/run',
  data: { name: 'stepfold', args: 'answer', commandId: 'c1' },
})
assert.equal(run.mode, MODE_FREE, 'run 阶段不该立刻改生效挡位')
assert.equal(run.running.mode, MODE_ANSWER)
assert.equal(run.running.commandId, 'c1')

// 挂起期间控件显示目标值（点了立刻有反馈）
assert.equal(viewOf(run).mode, MODE_ANSWER, '挂起时视图要显示目标挡位')

const done = applyState(run, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } })
assert.equal(done.mode, MODE_ANSWER, 'done 成功后才生效')
assert.equal(done.running, null, '结算后要清掉挂起')

// 命令失败：丢弃，挡位不变
const failed = applyState(run, { type: 'command/done', data: { commandId: 'c1', kind: 'error' } })
assert.equal(failed.mode, MODE_FREE, '命令失败不该改挡位')
assert.equal(failed.running, null)

// 别的命令结算了：跟我们无关
const unrelated = applyState(run, { type: 'command/done', data: { commandId: 'zzz', kind: 'success' } })
assert.equal(unrelated, run, '别的 commandId 不该动我们的挂起')
assert.equal(viewOf(done).mode, MODE_ANSWER)
assert.equal(viewOf(init).mode, MODE_FREE)

// ---------------------------------------------------------------- apply() 集成
/** 造一个假 cordis ctx，记下插件注册了什么。 */
function makeCtx() {
  const registered = { projection: null, sections: [], guards: [], commands: [], effects: [] }
  const mode = { value: init }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['sessionProjections', 'systemPrompt', 'tools', 'commands'])
      callback({
        effect(fn, label) {
          registered.effects.push(label)
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : () => {}
        },
        sessionProjections: {
          register(definition) {
            registered.projection = definition
            return () => {}
          },
          stateOf(_session, key) {
            assert.equal(key, 'stepfold')
            return mode.value
          },
        },
        systemPrompt: {
          section(section) {
            registered.sections.push(section)
            return () => {}
          },
        },
        tools: {
          guard(fn) {
            registered.guards.push(fn)
            return () => {}
          },
        },
        commands: {
          register(command) {
            registered.commands.push(command)
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, registered, mode }
}

const { ctx, registered, mode } = makeCtx()
apply(ctx)

// 四样东西都注册了
assert.ok(registered.projection, '没有注册投影')
assert.equal(registered.projection.key, 'stepfold')
assert.equal(registered.projection.stateVersion, 1)
assert.deepEqual(registered.projection.init(), init)
// 自定义的 schema 壳只要能 parse 就行（宿主只要求有 .parse）
assert.equal(registered.projection.stateSchema.parse(init), init)
assert.equal(registered.projection.wire.viewSchema.parse({ mode: 'free' }).mode, 'free')

assert.equal(registered.sections.length, 1)
assert.equal(registered.sections[0].name, 'stepfold:collaboration-mode')
assert.equal(registered.sections[0].interpolate, false, '必须关掉插值，否则用户文本里的 {{ 会让组装挂掉')

assert.equal(registered.guards.length, 1)
assert.equal(registered.commands.length, 1)
assert.equal(registered.commands[0].name, 'stepfold')
assert.equal(registered.commands[0].input.hint, 'answer | free')

// 命令处理器：认参数给成功回执，不认就给用法
const ok = registered.commands[0].handler({ rawInput: ' free ' })
assert.equal(ok.kind, 'success')
assert.match(ok.text, /无限制/)
const bad = registered.commands[0].handler({ rawInput: 'whatever' })
assert.equal(bad.kind, 'error')
assert.match(bad.text, /用法/)

// 已经砍掉的 /stepfold steps 要落到「用法」这条路上，不能静默改挡位
const gone = registered.commands[0].handler({ rawInput: 'steps' })
assert.equal(gone.kind, 'error')
assert.match(gone.text, /用法/)

// 提示词段：按挡位给文本，默认（无限制）必须是空串
const section = registered.sections[0]
const agent = { session: { id: 's-1' } }
mode.value = { mode: MODE_FREE, running: null }
assert.equal(section.text({ agent }), '', '无限制挡位不该注入任何提示词')
assert.equal(section.text({}), '', '没有 agent 时不该注入')

mode.value = { mode: MODE_ANSWER, running: null }
assert.match(section.text({ agent }), /只回答/)
assert.match(section.text({ agent }), /不要动手/)

// 旧会话日志里存着的 'steps'（已砍掉的挡位）要按默认挡位处理：不注入任何提示词
mode.value = { mode: 'steps', running: null }
assert.equal(section.text({ agent }), '', '已砍掉的分步骤挡位应当按无限制处理')

// guard：只回答挡位拦动手工具，读工具放行
const guard = registered.guards[0]
const exec = (name) => ({ name, agent, callId: 'call-1', arguments: {} })

mode.value = { mode: MODE_ANSWER, running: null }
assert.match(guard(exec('write')), /只回答/, '只回答挡位必须拦住写文件')
assert.match(guard(exec('pwsh')), /只回答/, '只回答挡位必须拦住跑命令')
assert.equal(guard(exec('read')), undefined, '只回答挡位要放行读文件')
assert.equal(guard(exec('grep')), undefined, '只回答挡位要放行搜索')

// 其它挡位一律不拦
mode.value = { mode: MODE_FREE, running: null }
assert.equal(guard(exec('write')), undefined, '无限制挡位不拦工具')

// 没有 agent 的调用（宿主内部工具）不该被误拦
mode.value = { mode: MODE_ANSWER, running: null }
assert.equal(guard({ name: 'write', callId: 'x' }), undefined, '没有 agent 时按默认挡位处理')

// 投影还没算出来（新会话）：按默认挡位
mode.value = undefined
assert.equal(guard(exec('write')), undefined, '投影缺失时按默认挡位')

console.log('host ok: 28 passed')
