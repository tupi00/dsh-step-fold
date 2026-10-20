/**
 * 烟测：在最小 DOM 桩子里加载 client.js 并跑一遍折叠逻辑。
 *
 * 它验证的是「插件加载会不会炸」+「折叠/展开/撤按钮的判定对不对」：
 *   1. apply 后样式插了、<html> 上了折叠类；
 *   2. 一组 11 步的步骤体长出横条，按钮文案是「显示全部 11 步（还有 6 步）」；
 *   3. 点一下 → 这组标记为展开、文案变「只看最近 5 步」；再点回去；
 *   4. 步骤变成 4 行后再同步一次 → 横条自己消失；
 *   5. 卸载时清干净（样式、横条、标记属性、html 类）。
 *
 * 跑法：node test/smoke-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// ---------------------------------------------------------------- 假 DOM
const registry = []

/** 极简元素：支持本插件用到的那几个 DOM 接口，不是完整 DOM。 */
class FakeElement {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.attributes = new Map()
    this.parentNode = null
    this.textContent = ''
    this.className = ''
    this.title = ''
    this.type = ''
    this.listeners = {}
    this.ownerDocument = null
    // 插件里用 dataset 写 data-plugin / data-plugin-css，这里照样支持：
    // dataset 的键名会自动映射成 data-kebab 属性，所以用一个 Proxy 代理到 attributes 上。
    this.dataset = new Proxy(
      {},
      {
        set: (target, key, value) => {
          this.setAttribute(
            'data-' + String(key).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()),
            value,
          )
          return true
        },
        get: (target, key) =>
          this.getAttribute(
            'data-' + String(key).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()),
          ) ?? undefined,
      },
    )
    this.classList = {
      set: new Set(),
      add: (name) => this.classList.set.add(name),
      remove: (name) => this.classList.set.delete(name),
      contains: (name) => this.classList.set.has(name),
    }
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }
  hasAttribute(name) {
    return this.attributes.has(name)
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(handler)
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

/** 目前只需要 tag、[attr]、[attr="value"] 这几种选择器。 */
function matches(element, selector) {
  const parts = selector.trim().match(/^([a-z]*)((?:\[[^\]]*\])*)$/i)
  if (!parts) return false
  const [, tag, attrs] = parts
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false
  const attrPattern = /\[([^\]=]+)(?:="([^"]*)")?\]/g
  let match = attrPattern.exec(attrs || '')
  while (match) {
    const [, name, value] = match
    if (!element.hasAttribute(name)) return false
    if (value !== undefined && element.getAttribute(name) !== value) return false
    match = attrPattern.exec(attrs || '')
  }
  return true
}

let documentStub = null

function create(tag) {
  const element = new FakeElement(tag)
  element.ownerDocument = documentStub
  registry.push(element)
  return element
}

documentStub = {
  documentElement: create('html'),
  head: create('head'),
  body: create('body'),
  createElement: (tag) => create(tag),
  querySelector(selector) {
    return documentStub.querySelectorAll(selector)[0] || null
  },
  querySelectorAll(selector) {
    // 只返回「还挂在树上」的元素：插件会把横条 remove() 掉，
    // 但组件对象仍在 registry 里，不筛掉就会误判成残留。
    return registry.filter((element) => isAttached(element) && matches(element, selector))
  },
}

function isAttached(element) {
  let node = element
  while (node) {
    if (node === documentStub.documentElement || node === documentStub.head || node === documentStub.body) {
      return true
    }
    node = node.parentNode
  }
  return false
}
documentStub.documentElement.setAttribute('lang', 'zh-CN')

let observerCallback = null
class FakeMutationObserver {
  constructor(callback) {
    observerCallback = callback
  }
  observe() {}
  disconnect() {}
}

const windowStub = {
  __ModuleLoader__: { load: (spec) => (captured = spec) },
  requestAnimationFrame: (fn) => {
    fn()
    return 1
  },
  cancelAnimationFrame() {},
}

let captured = null
const sandbox = {
  window: windowStub,
  document: documentStub,
  MutationObserver: FakeMutationObserver,
  console,
  setTimeout,
}
sandbox.globalThis = sandbox

// ---------------------------------------------------------------- 加载插件
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.js' })
assert.ok(captured, '模块没有调用 window.__ModuleLoader__.load')
const plugin = captured.factory(() => {
  throw new Error('本插件不应该 require 任何客户端包')
})
assert.equal(plugin.inject.includes('locale'), true, 'inject 里应该有 locale')

// ---------------------------------------------------------------- 造一棵「宿主步骤体」树
function makeGroup(stepCount) {
  const root = create('div')
  root.setAttribute('data-step-process', '')
  const header = create('div')
  const body = create('div')
  body.setAttribute('data-step-process-body', '')
  const content = create('div')
  content.setAttribute('data-step-process-content', '')
  for (let index = 0; index < stepCount; index += 1) {
    const step = create('div')
    step.setAttribute('data-chat-flow-kind', 'tool-call')
    content.appendChild(step)
  }
  body.appendChild(content)
  root.appendChild(header)
  root.appendChild(body)
  documentStub.body.appendChild(root)
  return { root, content }
}

const big = makeGroup(11)
const small = makeGroup(4)

// ---------------------------------------------------------------- apply
const effects = []
const ctx = {
  effect(fn, label) {
    const cleanup = fn()
    effects.push({ label, cleanup })
    return cleanup
  },
  locale: {
    register(namespace) {
      assert.equal(namespace, 'step-fold')
      return () => {}
    },
  },
}

plugin.apply(ctx)

assert.equal(documentStub.documentElement.classList.contains('dshSF_fold'), true, '没挂折叠类')
const styleTag = documentStub.head.children[0]
assert.ok(styleTag, '没有插入样式')
assert.ok(styleTag.textContent.includes('nth-last-child'), '折叠 CSS 缺失')
assert.ok(styleTag.textContent.includes('dshSF_bar'), '横条样式缺失')

// 11 步：长出横条 + 文案正确
const bar = big.root.children.find((child) => child.hasAttribute('data-dshsf-bar'))
assert.ok(bar, '11 步的组没有长出横条')
const button = bar.children[0]
assert.equal(button.textContent, '显示全部 11 步（还有 6 步）')
assert.equal(button.getAttribute('aria-expanded'), 'false')

// 4 步：不需要横条
assert.equal(
  small.root.children.some((child) => child.hasAttribute('data-dshsf-bar')),
  false,
  '4 步的组不该有横条',
)

// 点一下：展开
button.listeners.click[0]({ preventDefault() {}, stopPropagation() {} })
assert.equal(big.root.hasAttribute('data-dshsf-all'), true, '展开标记没写上')
assert.equal(button.textContent, '只看最近 5 步')
assert.equal(button.getAttribute('aria-expanded'), 'true')

// 再点一下：收回
button.listeners.click[0]({ preventDefault() {}, stopPropagation() {} })
assert.equal(big.root.hasAttribute('data-dshsf-all'), false, '收回时标记没清掉')
assert.equal(button.textContent, '显示全部 11 步（还有 6 步）')

// 步骤变少（宿主重渲染 / 切会话）后同步一次，横条应该自己消失
while (big.content.children.length > 3) big.content.removeChild(big.content.children[0])
observerCallback()
assert.equal(
  big.root.children.some((child) => child.hasAttribute('data-dshsf-bar')),
  false,
  '步骤变少后横条没撤掉',
)

// ---------------------------------------------------------------- 卸载
for (const { cleanup } of effects) if (typeof cleanup === 'function') cleanup()
assert.equal(documentStub.documentElement.classList.contains('dshSF_fold'), false, '卸载后折叠类没去掉')
assert.equal(documentStub.querySelectorAll('[data-dshsf-bar]').length, 0, '卸载后还有残留横条')
assert.equal(documentStub.querySelectorAll('[data-dshsf-all]').length, 0, '卸载后还有残留展开标记')

console.log('smoke ok: 折叠 / 展开 / 撤按钮 / 卸载 都符合预期')
