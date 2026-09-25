/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 面板契约测试：config.json / state.json 的**响应形状**。
 *
 * 为什么单独测：面板是 eval 出来的客户端脚本，跑在另一个作用域里。
 * 服务端少给一个字段、或把函数写在了够不着的作用域，界面上就是
 * "面板能打开但半截是空的" —— 单看服务端逻辑全是对的，测不出来。
 * 实测踩过两次：
 *   · renderPeakNow 写在服务端 → loadConfig 抛 "is not defined"，
 *     面板后半截（时段行、模式提示）全不渲染；
 *   · availableProviders 写在 snapshot 内部 → effectiveForUi 够不着，
 *     config.json 直接 500，面板完全打不开。
 * 所以这里断言的是**接口契约**，不是内部实现。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../lib/index.js'

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const ok = (label, cond, note = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + note}`)
  cond ? pass++ : fail++
}

const bjDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)
const now = Date.now()
const day = bjDay(now)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ctr-'))
process.env.DSH_HOME = home
fs.writeFileSync(path.join(home, 'dsh-cost-budget.json'), JSON.stringify({
  version: 1, currency: 'CNY', day, spentUnits: 0, spentByGroup: {},
  events: [
    // 事件里的 group 故意写成过期的旧名字，验证是按 provider 重算的
    { sessionId: 's1', at: now - 5000, provider: 'deepseek-official', units: 125000, group: 'default' },
    { sessionId: 's2', at: now - 4000, provider: 'example-gateway', units: 175000, group: 'default' },
  ],
}))
fs.writeFileSync(path.join(home, 'dsh-cost-budget-config.json'), JSON.stringify({
  quotaMode: 'group',
  providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] },
  groupCapScale: { A: 0.75, B: 0.6 },
}))

const routes = new Map()
const services = {}
apply({
  logger: { info: () => {}, warn: () => {} },
  on: () => () => {},
  effect: (fn) => { fn(); return () => {} },
  provide: (n, v) => { services[n] = v; return () => {} },
  inject: () => {},
  webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) }, tapIndex: () => () => {} },
  sessions: { list: () => [] }, agents: { list: () => [] },
  goals: { get: () => undefined }, tools: {}, sessionProjections: {},
}, { dryRun: true, balance: { enabled: false, poll: false } })
await new Promise((r) => setTimeout(r, 600))

/** 调一个已注册路由，返回解析后的 JSON */
async function get(routePath, method = 'GET', body) {
  const r = routes.get(routePath)
  if (!r) throw new Error('路由未注册: ' + routePath)
  let out
  const res = {
    statusCode: 0,
    setHeader() {}, writeHead(c) { this.statusCode = c },
    end(s) { out = JSON.parse(s) },
  }
  await r.handler({ method, url: routePath, headers: {}, body }, res)
  return out
}

console.log('=== 1. 路由已注册 ===')
ok('注册了 /dsh-cost-budget/config.json', routes.has('/dsh-cost-budget/config.json'))
ok('注册了 /dsh-cost-budget/state.json', routes.has('/dsh-cost-budget/state.json'))
ok('注册了 /dsh-cost-budget/bar.js', routes.has('/dsh-cost-budget/bar.js'))

console.log('\n=== 2. config.json：面板打开所需的字段一个都不能少 ===')
{
  const j = await get('/dsh-cost-budget/config.json')
  ok('有 effective', !!j.effective)
  const e = j.effective || {}
  ok('有 quotaMode', typeof e.quotaMode === 'string', JSON.stringify(e.quotaMode))
  ok('有 ladder 数组且非空', Array.isArray(e.ladder) && e.ladder.length > 0)
  ok('ladder 项含 until/cap', !!(e.ladder && e.ladder[0] && e.ladder[0].until && e.ladder[0].cap !== undefined),
    JSON.stringify(e.ladder && e.ladder[0]))
  check('providerGroups 原样带出', e.providerGroups, { A: ['deepseek-official'], B: ['example-gateway'] })
  check('groupCapScale 原样带出', e.groupCapScale, { A: 0.75, B: 0.6 })
  check('availableProviders = 账本∪配置', e.availableProviders, ['deepseek-official', 'example-gateway'])
  ok('有 resumeMinHeadroomPct', typeof e.resumeMinHeadroomPct === 'number', JSON.stringify(e.resumeMinHeadroomPct))
  ok('有 dryRun 布尔', typeof e.dryRun === 'boolean', JSON.stringify(e.dryRun))
  // ★ peakNow 在 effective **内部**。面板曾经读 j.peakNow（顶层），
  //   不报错但永远渲染成 "--"。这里把层级钉死。
  ok('effective.peakNow 存在（面板只显示当前时段）', !!e.peakNow, JSON.stringify(e.peakNow))
  const pn = e.peakNow || {}
  ok('peakNow 有 peak 布尔', typeof pn.peak === 'boolean', JSON.stringify(pn.peak))
  ok('peakNow 有 reason 说明', typeof pn.reason === 'string' && pn.reason.length > 0, JSON.stringify(pn.reason))
  ok('peakNow 有 hour', typeof pn.hour === 'number', JSON.stringify(pn.hour))
  // 只读键刻意保留在 effective 里（面板可只读展示、旧消费者不炸），
  // 但它们必须**不在** mutableKeys 白名单，PUT 才会丢掉它们。
  const mk = j.mutableKeys || []
  check('面板读取消费口径', e.spendSource, 'estimated')
  ok('消费口径不能被面板覆盖', !mk.includes('spendSource'))
  for (const k of ['peakHours', 'holidays', 'valleyDays', 'calendarUrl']) {
    ok(`${k} 是可读的（面板无需再展示，但契约保留）`, k in e)
    ok(`${k} 不在可改白名单里`, !mk.includes(k))
  }
  ok('顶层没有 peakNow（防止再次读错层级）', !('peakNow' in j),
    '若真加了顶层 peakNow，本断言应连同 loadConfig 一起更新')
}

console.log('\n=== 3. state.json：面板头部/分组条所需字段 ===')
{
  const j = await get('/dsh-cost-budget/state.json')
  ok('有 spentCny', typeof j.spentCny === 'number', JSON.stringify(j.spentCny))
  ok('有 capCny', typeof j.capCny === 'number', JSON.stringify(j.capCny))
  ok('有 exhausted 布尔', typeof j.exhausted === 'boolean')
  ok('有 dryRun 布尔', typeof j.dryRun === 'boolean')
  ok('有 tier / tierCount', typeof j.tier === 'number' && typeof j.tierCount === 'number')
  ok('有 groups 数组', Array.isArray(j.groups))
  ok('有 availableProviders', Array.isArray(j.availableProviders), JSON.stringify(j.availableProviders))
  check('availableProviders 与 config.json 一致', j.availableProviders, ['deepseek-official', 'example-gateway'])
}

console.log('\n=== 4. 分组金额：按 provider 重算，不认事件里的过期 group ===')
{
  const j = await get('/dsh-cost-budget/state.json')
  const by = Object.fromEntries((j.groups || []).map((g) => [g.name, g.spentCny]))
  const sum = (j.groups || []).reduce((a, g) => a + g.spentCny, 0)
  ok('总额 = ¥30', Math.abs(j.spentCny - 30) < 1e-4, String(j.spentCny))
  ok('A = ¥12.5（deepseek-official）', Math.abs((by.A || 0) - 12.5) < 1e-4, String(by.A))
  ok('B = ¥17.5（example-gateway）', Math.abs((by.B || 0) - 17.5) < 1e-4, String(by.B))
  check('没有空 default 行', Object.hasOwn(by, 'default'), false)
  ok('不变式：各组之和 = 总额', Math.abs(sum - j.spentCny) < 1e-6, `${sum} vs ${j.spentCny}`)
  const ghosts = (j.groups || []).map((g) => g.name).filter((n) => !['A', 'B'].includes(n))
  check('无幽灵组', ghosts, [])
}

console.log('\n=== 5. 每个组都能拿到额度（否则分组条没法画）===')
{
  const j = await get('/dsh-cost-budget/state.json')
  for (const g of j.groups || []) {
    ok(`组 ${g.name} 有 capCny`, typeof g.capCny === 'number' && g.capCny > 0, JSON.stringify(g.capCny))
    ok(`组 ${g.name} 有 scale`, typeof g.scale === 'number', JSON.stringify(g.scale))
    ok(`组 ${g.name} 有效金额可算`, typeof (g.effSpentCny !== undefined ? g.effSpentCny : g.spentCny) === 'number')
  }
}

console.log('\n=== 6. bar.js 是完整可执行的客户端脚本 ===')
{
  const r = routes.get('/dsh-cost-budget/bar.js')
  let out = ''
  const res = { statusCode: 0, setHeader() {}, writeHead(c) { this.statusCode = c }, end(s) { out = s } }
  await r.handler({ method: 'GET', url: '/dsh-cost-budget/bar.js', headers: {} }, res)
  ok('返回了非空脚本', out.length > 1000, `${out.length} 字节`)
  ok('脚本里没有未替换的模板插值', !/\$\{/.test(out))
  ok('脚本里定义了 renderPeakNow（客户端作用域）', /function renderPeakNow/.test(out))
  ok('脚本里没有重复定义 renderPeakNow', (out.match(/function renderPeakNow/g) || []).length === 1,
    `出现 ${(out.match(/function renderPeakNow/g) || []).length} 次`)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
