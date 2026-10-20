/**
 * 真机自检（可选，比单测更硬）：把真实的 dsh 服务装进一个空 cordis 上下文，
 * 再挂上本插件，看它注册的四样东西是不是真的进了宿主的登记表。
 *
 * 它验证的是「API 有没有用错」——这类错误单测看不出来（单测用的是假 ctx），
 * 要等重启 DSH 才发现插件加载失败。
 *
 * 好处：不需要 API key、不启动 GUI、不写任何 DSH 数据，几秒钟出结果。
 *
 * 跑法：node test/runtime-probe.mjs
 * 需要本机有 dsh 运行时的 node_modules（默认 E:/npm/node_modules/@deepseek-ai/dsh，
 * 也可用环境变量 DSH_RUNTIME 指过去）。
 *
 * 它不在 package.json 的 test 脚本里：依赖本机绝对路径，换台机器就跑不了。
 */
import assert from 'node:assert/strict'

const RUNTIME = process.env.DSH_RUNTIME ?? 'E:/npm/node_modules/@deepseek-ai/dsh'
const modules = `${RUNTIME}/node_modules/@deepseek-ai`

/** 等 cordis 把服务挂完（服务在微任务里 init，多给一轮宏任务）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

const cordis = await import(`file:///${modules}/cordis/lib/index.js`)
const app = new cordis.Context()

for (const pkg of ['dsh-system-prompt', 'dsh-session-projection', 'dsh-tools', 'dsh-commands']) {
  const mod = await import(`file:///${modules}/${pkg}/lib/index.js`)
  app.plugin(mod.default)
}
await settle()

for (const service of ['systemPrompt', 'sessionProjections', 'tools', 'commands']) {
  assert.ok(app[service], `${service} 服务没挂上，检查运行时路径`)
}

const plugin = await import(new URL('../index.js', import.meta.url))
app.plugin({ name: 'step-fold', apply: plugin.apply })
await settle()

// 1) 提示词段进了真实 assembly
const assembly = await app.systemPrompt.assemble()
const section = assembly.sections.find((item) => item.name === 'stepfold:collaboration-mode')
assert.ok(
  section,
  `assembly 里没有我们的段落；实际有：${assembly.sections.map((item) => item.name).join(', ')}`,
)
assert.equal(section.interpolate, false, 'interpolate 必须是 false')
// 没有 agent（全局装配）时必须是一段空文本——等于「不注入」
assert.equal(section.text, '', '没有 agent 时不该注入任何规则')

// 2) 命令注册成功。find() 要 agent 作用域，list() 不需要。
const names = app.commands.list().map((command) => command.name ?? command)
assert.ok(names.includes('stepfold'), `命令没注册上；实际有：${names.join(', ')}`)

// 3) 默认挡位（无会话）不拦任何工具
for (const tool of ['write', 'edit', 'pwsh', 'subagent']) {
  const reason = app.tools.guardReason({ name: tool, callId: 'probe-1', arguments: {} })
  assert.equal(reason, undefined, `默认挡位不该拦 ${tool}`)
}

console.log('runtime ok: 插件在真实 cordis 上加载成功，提示词段 / 命令 / 守卫都进了登记表')
process.exit(0)
