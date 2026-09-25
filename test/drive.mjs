/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 进程外驱动 apply()：不依赖 dsh 重启，直接验证刹车 → goal 暂停 → 边界恢复。
 * 黑盒：只喂事件、只调钩子、只看结果。
 */
import { apply } from '../lib/index.js'
import { makeDom, bootBar } from './mock-dom.mjs'

const DSH = process.env.DSH_HOME || `${process.env.USERPROFILE}\\.dsh`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}

/** 让判定时钟指向北京 hh:mm */
function offsetTo(hh, mm) {
  const bj = new Date(Date.now() + 8 * 3600 * 1000)
  const t = new Date(bj)
  t.setUTCHours(hh, mm, 0, 0)
  if (t <= bj) t.setUTCDate(t.getUTCDate() + 1)
  return t.getTime() - bj.getTime()
}

const calls = { followup: [], pause: [], resume: [] }
let goalPhase = 'active'
const agent = {
  id: 'session-test-1',
  session: { id: 'session-test-1' },
  followup: (m) => calls.followup.push(m),
}

// 重定向 DSH_HOME 到临时目录，避免测试污染真实账本
const os = await import('node:os')
const path = await import('node:path')
if (!process.env.DSH_TEST_HOME) {
  console.log('（提示：本测试会写账本；设 DSH_HOME 到临时目录可避免污染真实账本）')
}

const handlers = new Map()
const services = {}
const routes = new Map()
const taps = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {},
  sessionProjections: {},
  sessions: { list: () => [] },
  agents: { list: () => [agent] },
  webServer: {
    register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) },
    tapIndex: (t) => { taps.push(t); return () => taps.splice(taps.indexOf(t), 1) },
  },
  goals: {
    get: () => (goalPhase ? { id: 'goal-abc', revision: 7, phase: goalPhase } : undefined),
    pause: (a, ref) => { calls.pause.push({ id: a.id, ref }); goalPhase = 'paused' },
    resume: (a, ref) => { calls.resume.push({ id: a.id, ref }); goalPhase = 'active' },
  },
  effect: (fn) => { const d = fn(); return () => d?.() },
  on: (e, f) => { handlers.set(e, f); return () => handlers.delete(e) },
  provide: (n, v) => { services[n] = v; return () => delete services[n] },
}

apply(ctx, {
  balance: { enabled: false, poll: false },
  ladder: [
    { until: '10:00', cap: 5 },
    { until: '11:00', cap: 10 },
    { until: '12:00', cap: 15 },
    { until: '24:00', cap: 40 },
  ],
  dryRun: false,
  debug: {
    timeOffsetMs: offsetTo(10, 5),   // 落在 10:00-11:00 档（上限 ¥10）
    forceSpentCny: 12,               // 高于 ¥10 → 立即触顶
    treatBoundaryAsInMs: 3000,       // 3 秒后重判
    stepClockMs: 3600_000,           // 重判时时钟推快 1 小时 → 跨入 ¥15 档
  },
})

const brake = handlers.get('tools/pre-execute')
const allow = () => brake({ name: 'pwsh' }, async () => ({ kind: 'allow' }))

console.log('=== 阶段 1：触顶后拒绝工具，理由模型可读 ===')
await sleep(500)
const d1 = await allow()
check('工具被拒绝', d1.kind, 'deny')
check('理由含已花金额 ¥12.00', /¥12\.00/.test(d1.reason), true)
check('理由含当前上限 ¥10', /¥10/.test(d1.reason), true)
check('理由含下一个边界 11:00', /11:00/.test(d1.reason), true)
check('理由要求停止调工具并汇报', /停止调用工具/.test(d1.reason), true)
console.log('        拒绝全文：')
String(d1.reason).split('\n').forEach((l) => console.log(`          ${l}`))

console.log('\n=== 阶段 2：goal 被暂停（CAS ref 正确）===')
check('pause 调用 1 次', calls.pause.length, 1)
check('pause 传 {id, revision}', calls.pause[0]?.ref, { id: 'goal-abc', revision: 7 })
check('pause 传的是 live agent', calls.pause[0]?.id, 'session-test-1')

// 这是真正的止损点：reject 让这一步根本不进 LLM，所以不产生 token 消耗。
// 而 tools/pre-execute 的 deny 只是让工具不执行——模型"想并写出这次调用"的钱已经花了。
console.log('\n=== 阶段 2b：agent/pre-step 拦在 LLM 之前 ===')
const preStep = handlers.get('agent/pre-step')
check('agent/pre-step 钩子已注册', typeof preStep, 'function')
// waterfall 的终止值是 { kind:'enter' }，调用方紧接着读 decision.kind。
// 所以放行路径**必须**返回一个真的 decision，不能是 undefined。
const TERMINAL = { kind: 'enter', messages: [] }
const nextFn = async () => TERMINAL
const ps = preStep
  ? await preStep({ agent, step: 1, signal: { aborted: false } }, nextFn)
  : null
check('触顶时返回 reject', ps?.kind, 'reject')
const psAborted = preStep
  ? await preStep({ agent, step: 1, signal: { aborted: true } }, nextFn)
  : 'missing'
// 回归：曾经这里返回 undefined，导致调用方读 decision.kind 抛
// "Cannot read properties of undefined (reading 'kind')"，每个正常回合都崩。
check('已取消的信号放行，且返回真 decision（不是 undefined）', psAborted, TERMINAL)
check('放行返回值可安全读 .kind', psAborted?.kind, 'enter')

console.log('\n=== 阶段 2c：未触顶时的放行路径也必须返回真 decision ===')
// 独立实例：dryRun + 从未记账 ⇒ exhausted 恒为 false，走 !exhausted 分支。
// 这是**每个正常回合**都会走的路径 —— 曾经这里返回 undefined，导致
// "Cannot read properties of undefined (reading 'kind')"，整轮全崩。
{
  const h2 = new Map()
  const c2 = {
    logger: { info: () => {}, warn: () => {} },
    tools: {}, sessionProjections: {},
    sessions: { list: () => [] }, agents: { list: () => [] },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    effect: (fn) => { const d = fn(); return () => d?.() },
    on: (e, f) => { h2.set(e, f); return () => h2.delete(e) },
    provide: () => () => {},
  }
  apply(c2, { dryRun: true, balance: { enabled: false, poll: false } })
  await sleep(60)
  const hook = h2.get('agent/pre-step')
  check('独立实例注册了钩子', typeof hook, 'function')
  const terminal = { kind: 'enter', messages: ['m'] }
  const got = hook
    ? await hook({ agent: { id: 'a2' }, step: 1, signal: { aborted: false } }, async () => terminal)
    : undefined
  check('未触顶时原样传下终止值（不是 undefined）', got, terminal)
  check('返回值可安全读 .kind', got?.kind, 'enter')
  check('返回值带上了 messages', got?.messages, ['m'])
}

console.log('=== 阶段 3：等到边界 → 自动恢复 ===')
// 恢复定时器 = treatBoundaryAsInMs（3 秒）。留 6 秒余量。
console.log(`        现在真实北京=${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}，等 6 秒（定时器 3 秒）`)
await sleep(6000)
const snapMid = services.costBudget?.snapshot?.()
console.log(`        重判后快照: ${JSON.stringify(snapMid)}`)
const d2 = await allow()
check('工具恢复放行', d2.kind, 'allow')
check('goal 被 resume', calls.resume.length, 1)
check('resume 传 {id, revision}', calls.resume[0]?.ref, { id: 'goal-abc', revision: 7 })

console.log('\n=== 阶段 4：恢复由宿主调度，插件不重复推续跑消息 ===')
check('插件不直接调用 followup', calls.followup.length, 0)

console.log('\n=== 阶段 5：只读快照服务 ===')
const snap = services.costBudget?.snapshot?.()
console.log(`        ${JSON.stringify(snap)}`)
check('costBudget 已注册', !!snap, true)
check('快照显示已恢复', snap?.exhausted, false)

console.log('\n=== 阶段 6：可视进度条 ===')
check('bar.js 路由已注册', routes.has('/dsh-cost-budget/bar.js'), true)
check('state.json 路由已注册', routes.has('/dsh-cost-budget/state.json'), true)
check('index.html 注入钩子已注册', taps.length, 1)

// 模拟 index.html 注入
const injected = taps[0]('<html><body><div id="app"></div></body></html>')
check('脚本标签已插入 </body> 前',
  injected.includes('<script defer src="/dsh-cost-budget/bar.js"></script></body>'), true)
check('重复注入不会叠加', taps[0](injected).split('bar.js').length - 1, 1)

// 模拟 HTTP 响应，取回真实 body
function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.end = (b) => { r.body = b }
  return r
}
const stateRes = fakeRes()
await routes.get('/dsh-cost-budget/state.json').handler({}, stateRes)
const state = JSON.parse(stateRes.body)
console.log(`        state.json = ${stateRes.body}`)
check('状态含 spentCny', typeof state.spentCny, 'number')
check('状态含 capCny', typeof state.capCny, 'number')
check('状态含档位进度', `${state.tier + 1}/${state.tierCount}`, '3/4')
check('状态含恢复时刻', state.resumeAt, '12:00')
check('禁用了缓存', stateRes.headers['Cache-Control'], 'no-store')

const jsRes = fakeRes()
await routes.get('/dsh-cost-budget/bar.js').handler({}, jsRes)
check('bar.js 是 JS 内容类型', jsRes.headers['Content-Type'], 'application/javascript; charset=utf-8')
check('bar.js 是合法 JS', (() => { try { new Function(jsRes.body); return true } catch { return false } })(), true)

// 在模拟 DOM 里真跑一遍客户端脚本（fixture 与 test/bar.mjs 共用）
const dom = makeDom()
const store = {}
const bar = bootBar(dom, state, store)
await sleep(50)

check('进度条 DOM 已创建', !!bar, true)
check('显示金额/上限', bar?._q['#dsh-cb-num']?.textContent, '¥12.00 / ¥15.00')
check('进度按比例（12/15=80%）', bar?._q['#dsh-cb-fill']?.style.width, '80.0%')
check('≥80% 转为橙色', bar?._q['#dsh-cb-fill']?.style.background, '#f59e0b')
check('显示档位', bar?._q['#dsh-cb-l']?.textContent, '第 3/4 档')
check('显示下一个边界', bar?._q['#dsh-cb-r']?.textContent, '下档 12:00')
check('默认在右上角（不挡左下设置）', bar?.style.bottom, 'auto')

// 拖动一次，确认位置被记住
const head = bar.querySelector('#dsh-cb-head')
head.fire('pointerdown', { clientX: 100, clientY: 20, pointerId: 1 })
head.fire('pointermove', { clientX: 400, clientY: 250, pointerId: 1 })
head.fire('pointerup', { clientX: 400, clientY: 250, pointerId: 1 })
check('拖动后位置已持久化', JSON.parse(store['dsh-cb-pos'] ?? 'null') !== null, true)

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
