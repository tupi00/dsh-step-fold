/**
 * 纯函数单测：把 client.js 里 PURE-HELPERS 区抠出来跑，不加载 DOM。
 *
 * 跑法（沙箱里 node --test 目录形式会因 spawn 限制失败，直接跑文件）：
 *   node test/helpers.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('// >>>PURE-HELPERS')
const end = source.indexOf('// <<<PURE-HELPERS<<<')
assert.ok(start >= 0 && end > start, 'client.js 里找不到 PURE-HELPERS 区标记')

const body = source.slice(start, end)
const helpers = new Function(`${body}; return { KEEP_STEPS, fill, hiddenCount, needsFold, barLabel }`)()
const { KEEP_STEPS, fill, hiddenCount, needsFold, barLabel } = helpers

const zh = {
  showAll: '显示全部 {total} 步（还有 {hidden} 步）',
  collapse: '只看最近 {keep} 步',
  titleShowAll: '展开这一轮的全部 {total} 步',
  titleCollapse: '收起，只显示最近 {keep} 步',
}

// fill：占位符替换
assert.equal(fill('还有 {hidden} 步', { hidden: 6 }), '还有 6 步')
assert.equal(fill('未知 {missing} 留着', {}), '未知 {missing} 留着')

// hiddenCount：不足 KEEP 不藏，超了藏多出来的
assert.equal(hiddenCount(11), 6)
assert.equal(hiddenCount(5), 0)
assert.equal(hiddenCount(3), 0)
assert.equal(hiddenCount(0), 0)
assert.equal(hiddenCount('7'), 2)
// 非数字 / undefined / NaN 一律当 0，绝不让 NaN 漏进文案
assert.equal(hiddenCount(undefined), 0)
assert.equal(hiddenCount('abc'), 0)

// needsFold：只有超过 KEEP 才需要按钮
assert.equal(needsFold(11), true)
assert.equal(needsFold(5), false)
assert.equal(needsFold(4), false)

// barLabel：未展开写「显示全部 N 步（还有 M 步）」，已展开写「只看最近 5 步」
assert.equal(barLabel(11, false, zh), '显示全部 11 步（还有 6 步）')
assert.equal(barLabel(11, true, zh), '只看最近 5 步')
assert.equal(barLabel(6, false, zh), '显示全部 6 步（还有 1 步）')

// 自定义 keep 的边界
assert.equal(barLabel(10, false, zh, 8), '显示全部 10 步（还有 2 步）')
assert.equal(barLabel(10, true, zh, 8), '只看最近 8 步')

// KEEP_STEPS 常量必须是 5（用户明确要 5 步）
assert.equal(KEEP_STEPS, 5)

console.log('helpers ok: ' + 15 + ' passed')
