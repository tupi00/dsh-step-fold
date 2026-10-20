/**
 * 一次性的冒烟检查：用一个极小的 DOM 替身把 index.html 里的脚本跑一遍，
 * 确认没有运行时错误、折叠行数/文案/变体切换都符合预期。
 *
 * 这不是测试套件，只是「我这边没有无头浏览器，至少证明它不会一打开就白屏」。
 * 原型定稿后这个文件可以整个删掉。
 *
 * 跑法：node prototype/smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'index.html'), 'utf8')

const script = html.match(/<script>([\s\S]*?)<\/script>/)
if (!script) {
  console.error('没找到 <script>')
  process.exit(1)
}

/* ---------------- 迷你 DOM ---------------- */
class El {
  constructor(tag) {
    this.tagName = tag
    this.className = ''
    this.textContent = ''
    this.title = ''
    this.type = ''
    this.dataset = {}
    this.attrs = new Map()
    this.children = []
    this.classes = new Set()
    this.listeners = {}
    this.classList = {
      add: (name) => { this.classes.add(name) },
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : !!force
        if (on) this.classes.add(name); else this.classes.delete(name)
      },
      contains: (name) => this.classes.has(name),
    }
  }
  set innerHTML(v) { if (v === '') this.children = [] }
  get innerHTML() { return '' }
  append(...nodes) { for (const n of nodes) this.children.push(n) }
  setAttribute(k, v) { this.attrs.set(k, String(v)) }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {} }) }
}

const app = new El('div')
const stateEl = new El('div')
const switchButtons = [1, 2, 3, 4].map((n) => {
  const b = new El('button')
  b.dataset.v = String(n)
  return b
})

const document = {
  createElement: (tag) => new El(tag),
  getElementById: (id) => (id === 'app' ? app : id === 'state' ? stateEl : null),
  querySelectorAll: (sel) => (sel === '.switcher button' ? switchButtons : []),
}

let search = '?v=1'
const location = {
  get search() { return search },
  get href() { return 'file:///prototype/index.html' + search },
}
const history = { replaceState() {} }
const URLSearchParams_ = URLSearchParams

/* ---------------- 跑脚本 ---------------- */
const factory = new Function(
  'document', 'location', 'history', 'URLSearchParams',
  script[1] + '\nreturn { render, state, TURNS };'
)
const mod = factory(document, location, history, URLSearchParams_)

/* ---------------- 断言 ---------------- */
let failed = 0
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name) }
  else { failed++; console.log('FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

function hiddenCount(el) {
  let n = 0
  const walk = (node) => {
    for (const c of node.children) {
      if (c.classList.contains('hidden-step')) n++
      walk(c)
    }
  }
  walk(el)
  return n
}
function buttonTexts(el) {
  const out = []
  const walk = (node) => {
    for (const c of node.children) {
      if (c.tagName === 'button') out.push(c.textContent)
      walk(c)
    }
  }
  walk(el)
  return out
}

check('三轮都渲染了', app.children.length === 3, 'got ' + app.children.length)

const turn0 = app.children[0]
check('第 1 轮默认藏 6 行（11 - 5）', hiddenCount(turn0) === 6, 'got ' + hiddenCount(turn0))
check('按钮文案含总数', buttonTexts(turn0).some((t) => t.includes('显示全部 11 步')), JSON.stringify(buttonTexts(turn0)))

// 点第一轮按钮 → 展开
const btn = (function find(node) {
  for (const c of node.children) {
    if (c.tagName === 'button') return c
    const hit = find(c)
    if (hit) return hit
  }
  return null
})(turn0)
check('第 1 轮有按钮', !!btn)
btn.click()
check('展开后不藏行', hiddenCount(app.children[0]) === 0, 'got ' + hiddenCount(app.children[0]))
check('展开后文案变「只看最近 5 步」', buttonTexts(app.children[0]).includes('只看最近 5 步'), JSON.stringify(buttonTexts(app.children[0])))

// 第 3 轮只有 4 步 → 不该有按钮
check('第 3 轮（4 步）没有按钮', buttonTexts(app.children[2]).length === 0, JSON.stringify(buttonTexts(app.children[2])))
check('第 3 轮不藏行', hiddenCount(app.children[2]) === 0)

// 切到变体 3
mod.state.expanded.clear()
switchButtons[2].click()
check('变体 3 生效', mod.state.variant === 3, 'got ' + mod.state.variant)
check('变体 3 用 chip 文案 5/11', buttonTexts(app.children[0]).includes('5/11'), JSON.stringify(buttonTexts(app.children[0])))

// 变体 4
switchButtons[3].click()
check('变体 4 生效', mod.state.variant === 4, 'got ' + mod.state.variant)
check('变体 4 按钮文案正常', buttonTexts(app.children[0]).includes('显示全部 11 步（还有 6 步）'), JSON.stringify(buttonTexts(app.children[0])))

console.log('')
console.log(failed === 0 ? '全部通过' : failed + ' 条失败')
process.exit(failed === 0 ? 0 : 1)
