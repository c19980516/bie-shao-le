/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。 goal 暂停/恢复专项：模拟宿主 revision 及 resume 自动安排下一轮，离线手动推进时钟。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'

const tempRoot = path.resolve(process.env.DSH_TEST_HOME || os.tmpdir())
fs.mkdirSync(tempRoot, { recursive: true })
const testRoot = fs.mkdtempSync(path.join(tempRoot, 'dsh-goalcontrol-'))
const original = {
  now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  home: process.env.DSH_HOME,
}
process.env.DSH_HOME = testRoot
const { apply } = await import('../lib/index.js')

const day = '2026-09-21'
const time = (hhmm, date = day) => Date.parse(`${date}T${hhmm}:00+08:00`)
let at = time('10:05')
let passed = 0, scenario = 0, current = null
const timers = new Set()
const intervals = new Set()
const check = (label, actual, expected) => {
  assert.deepStrictEqual(actual, expected, label)
  passed++
  console.log(`  PASS  ${label}`)
}
async function until(predicate) {
  const deadline = original.now() + 3000
  while (!predicate()) {
    if (original.now() > deadline) throw new Error('等待插件异步回调超时')
    await nextTurn()
  }
}

const normalLadder = [
  { until: '11:00', cap: 10 },
  { until: '12:00', cap: 14 },
  { until: '24:00', cap: 20 },
]

async function boot(config = {}, amounts = { 'provider-a': 12 }) {
  if (current) current.dispose()
  timers.clear()
  intervals.clear()
  at = time('10:05')
  const home = path.join(testRoot, `scenario-${++scenario}`)
  fs.mkdirSync(home)
  process.env.DSH_HOME = home
  const ledgerFile = path.join(home, 'dsh-cost-budget.json')
  fs.writeFileSync(ledgerFile, JSON.stringify({
    version: 1, currency: 'CNY', day,
    events: Object.entries(amounts).map(([provider, cny], i) => ({
      at: at - 1000 + i, sessionId: `seed-${i}`, provider, units: Math.round(cny * 10_000),
    })),
  }))
  const counters = { pauses: 0, resumes: 0, attempts: 0, hostRuns: 0, followups: 0, badRefs: 0 }
  const agents = ['active', 'manual', 'disarmed'].map((id) => ({ id, followup() { counters.followups++ } }))
  const views = new Map([
    [agents[0], { id: 'goal-active', revision: 1, phase: 'active', activation: 'armed' }],
    [agents[1], { id: 'goal-manual', revision: 17, phase: 'paused', activation: 'disarmed' }],
    [agents[2], { id: 'goal-disarmed', revision: 11, phase: 'active', activation: 'disarmed' }],
  ])
  const pauseRefs = [], resumeRefs = [], disposers = [], logs = []
  const services = {}, routes = new Map(), handlers = new Map()
  const state = {
    counters, views, agents, pauseRefs, resumeRefs, ledgerFile, failures: 0, enumerationFailures: 0,
    snap: () => services.costBudget.snapshot(),
    active: () => views.get(agents[0]),
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    put(override) {
      return new Promise((resolve) => {
        const req = {
          method: 'PUT', destroy() {},
          on(event, fn) {
            if (event === 'data') fn(JSON.stringify({ override }))
            if (event === 'end') fn()
            return req
          },
        }
        const res = {
          statusCode: 0, setHeader() {},
          end(body) { resolve({ code: this.statusCode, json: JSON.parse(body) }) },
        }
        routes.get('/dsh-cost-budget/config.json').handler(req, res)
      })
    },
    async fire(atNext, done) {
      assert.equal(timers.size, 1, '只有一个恢复定时器')
      const timer = [...timers][0]
      at = atNext
      timers.delete(timer)
      timer.fn()
      await until(done)
    },
    async reconcile(atNext) {
      at = atNext
      const tick = [...intervals].find((timer) => timer.ms === 15_000)
      assert.ok(tick, '定期对账回调存在')
      await tick.fn()
    },
  }
  const requireRef = (agent, ref, phase) => {
    const view = views.get(agent)
    if (!view || view.id !== ref.id || view.revision !== ref.revision || view.phase !== phase) {
      counters.badRefs++
      throw new Error('goal ref 已过期或状态不符')
    }
    return view
  }
  current = state
  apply({
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    tools: {}, sessionProjections: {}, sessions: { list: () => [] },
    agents: { list() {
      if (state.enumerationFailures > 0) {
        state.enumerationFailures--
        throw new Error('模拟 agent 枚举暂时失败')
      }
      return agents
    } },
    goals: {
      get: (agent) => ({ ...views.get(agent) }),
      pause(agent, ref) {
        const view = requireRef(agent, ref, 'active')
        pauseRefs.push({ ...ref })
        const paused = { ...view, phase: 'paused', revision: view.revision + 1, activation: 'disarmed' }
        views.set(agent, paused)
        counters.pauses++
        return { ...paused }
      },
      resume(agent, ref) {
        const view = requireRef(agent, ref, 'paused')
        counters.attempts++
        resumeRefs.push({ ...ref })
        if (view.roundsStarted >= view.maxGoalRounds) throw new Error('goal 已达到最大轮数')
        if (state.failures > 0) { state.failures--; throw new Error('模拟宿主 resume 暂时失败') }
        const active = { ...view, phase: 'active', revision: view.revision + 1, activation: 'armed' }
        views.set(agent, active)
        counters.resumes++
        counters.hostRuns++ // 本机 harness 的 resume 自身会 arm goal，由宿主调度下一轮。
        return { ...active }
      },
    },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    provide(name, value) { services[name] = value; return () => delete services[name] },
    webServer: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
      tapIndex: () => () => {},
    },
  }, {
    balance: { enabled: false, poll: false },
    ladder: normalLadder, resumeMinHeadroomPct: 15, ...config,
  })
  await until(() => config.dryRun
    ? logs.some((line) => line.includes('DRY-RUN') && line.includes('startup'))
    : timers.size === 1)
  return state
}

function checkHost(state, expectedRuns) {
  check('仅由宿主安排预期轮数', state.counters.hostRuns, expectedRuns)
  check('插件没有额外发送 followup', state.counters.followups, 0)
  check('宿主没有收到过期 goal ref', state.counters.badRefs, 0)
  check('手动暂停的 goal 不受插件恢复影响', state.views.get(state.agents[1]), {
    id: 'goal-manual', revision: 17, phase: 'paused', activation: 'disarmed',
  })
  check('未启用的旧 goal 不被插件自动启用', state.views.get(state.agents[2]), {
    id: 'goal-disarmed', revision: 11, phase: 'active', activation: 'disarmed',
  })
}

try {
  Date.now = () => at
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, unref() {} }
    timers.add(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => timers.delete(timer)
  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms, unref() {} }
    intervals.add(timer)
    return timer
  }
  globalThis.clearInterval = (timer) => intervals.delete(timer)

  console.log('=== dryRun 启动仅观测预算 ===')
  {
    const s = await boot({ dryRun: true })
    check('试跑仍报告预算已经超限', s.snap().budgetAllowed, false)
    check('试跑实际放行', [s.snap().allowed, s.snap().exhausted], [true, false])
    check('试跑不暂停 goal', [s.active().phase, s.counters.pauses], ['active', 0])
    check('试跑不调用 resume', s.counters.resumes, 0)
    check('试跑不创建恢复定时器', timers.size, 0)
    checkHost(s, 0)
  }

  console.log('\n=== 暂停后 revision、余量不足延后、宿主单次续跑 ===')
  {
    const s = await boot()
    check('硬停暂停活跃 goal', [s.active().phase, s.counters.pauses], ['paused', 1])
    check('pause 改变 revision', s.active().revision, 2)
    await s.fire(time('11:05'), () => timers.size === 1)
    check('下一档不超限但续跑余量不足', [s.snap().budgetAllowed, s.active().phase], [true, 'paused'])
    check('余量不足没有调用 resume', s.counters.resumes, 0)
    check('余量不足等下一档而非短循环', [...timers][0].ms, 55 * 60_000)
    await s.fire(time('12:05'), () => s.counters.resumes === 1)
    check('再下一档余量充足恢复 goal', s.active(), {
      id: 'goal-active', revision: 3, phase: 'active', activation: 'armed',
    })
    check('恢复传递 pause 后的 revision', s.resumeRefs, [{ id: 'goal-active', revision: 2 }])
    check('完成恢复后撤销定时器', timers.size, 0)
    checkHost(s, 1)
  }

  console.log('\n=== 外部改动 goal 后不自动恢复 ===')
  {
    const s = await boot()
    s.views.set(s.agents[0], { ...s.active(), revision: 3 })
    await s.fire(time('12:05'), () => s.snap().exhausted === false)
    check('外部修改的 goal 仍暂停', s.active().phase, 'paused')
    check('外部 revision 改动阻止 resume', s.counters.attempts, 0)
    check('已失效的插件暂停记录不保留定时器', timers.size, 0)
    checkHost(s, 0)
  }

  console.log('\n=== 组倍率后的最紧组余量决定恢复 ===')
  {
    const s = await boot({
      quotaMode: 'group', providerGroups: { tight: ['provider-a'], roomy: ['provider-b'] },
      groupCapScale: { tight: 0.5 },
      ladder: [{ until: '11:00', cap: 10 }, { until: '12:00', cap: 20 }, { until: '24:00', cap: 30 }],
    }, { 'provider-a': 9, 'provider-b': 1 })
    await s.fire(time('11:05'), () => timers.size === 1)
    check('组额度按倍率减半', s.snap().groups.find((g) => g.name === 'tight').capCny, 10)
    check('总额低于基础档位仍检查组余量', s.snap().spentCny < s.snap().capCny, true)
    check('紧组仅余 10% 时仍暂停', [s.snap().budgetAllowed, s.active().phase, s.counters.resumes], [true, 'paused', 0])
    await s.fire(time('12:05'), () => s.counters.resumes === 1)
    check('组余量足够后恢复', s.active().phase, 'active')
    checkHost(s, 1)
  }

  console.log('\n=== 倍率计算的浮点边界 ===')
  for (const [spent, shouldResume] of [[15.3, true], [15.3001, false]]) {
    const s = await boot({
      quotaMode: 'group', providerGroups: { scaled: ['provider-a'] },
      groupCapScale: { scaled: 0.6 },
      ladder: [{ until: '11:00', cap: 20 }, { until: '24:00', cap: 30 }],
    }, { 'provider-a': spent })
    await s.fire(time('11:05'), () => shouldResume ? s.counters.resumes === 1 : timers.size === 1)
    check(`消费 ${spent} 时倍率后 cap 为 18`, s.snap().groups[0].capCny, 18)
    check(`消费 ${spent} 的 15% 余量边界判定`, s.active().phase, shouldResume ? 'active' : 'paused')
    check(`消费 ${spent} 的恢复次数`, s.counters.resumes, shouldResume ? 1 : 0)
    checkHost(s, shouldResume ? 1 : 0)
  }
  for (const [spent, allowed] of [[0.02, false], [0.0199, true]]) {
    const s = await boot({
      dryRun: true, quotaMode: 'group', providerGroups: { scaled: ['provider-a'] },
      groupCapScale: { scaled: 0.2 }, ladder: [{ until: '24:00', cap: 0.1 }],
    }, { 'provider-a': spent })
    check(`消费 ${spent} 的小数额度触顶判定`, s.snap().budgetAllowed, allowed)
    check(`消费 ${spent} 的小数分组触顶判定`, s.snap().groups[0].allowed, allowed)
  }
  {
    const s = await boot({
      quotaMode: 'group', providerGroups: { alpha: ['provider-a'], beta: ['provider-b'] },
      groupCapScale: { alpha: 2, beta: 2 },
      ladder: [{ until: '11:00', cap: 5 }, { until: '24:00', cap: 10 }],
    }, { 'provider-a': 14, 'provider-b': 14 })
    await s.fire(time('11:05'), () => s.counters.resumes === 1)
    check('总额超过基础档位', s.snap().spentCny > s.snap().capCny, true)
    check('每组额度独立加倍', s.snap().groups.map((g) => g.capCny), [20, 20])
    check('每组余量充足时可以恢复', s.active().phase, 'active')
    checkHost(s, 1)
  }

  console.log('\n=== 配置开关 dryRun 取消恢复，切回硬停后按余量恢复 ===')
  {
    const s = await boot()
    check('开启试跑配置成功', (await s.put({ dryRun: true })).code, 200)
    check('开启试跑撤销已安排恢复', timers.size, 0)
    check('开启试跑不恢复已暂停 goal', [s.active().phase, s.counters.resumes], ['paused', 0])
    check('开启试跑解除实际刹车', s.snap().exhausted, false)
    check('试跑期间抬高额度配置成功', (await s.put({ dryRun: true, ladder: [{ until: '24:00', cap: 100 }] })).code, 200)
    check('试跑期间有足够额度也不恢复 goal', [s.active().phase, timers.size], ['paused', 0])
    check('切回硬停配置成功', (await s.put({ dryRun: false, ladder: [{ until: '24:00', cap: 100 }] })).code, 200)
    check('切回硬停检查足够余量后恢复', s.active().phase, 'active')
    checkHost(s, 1)
  }
  {
    const s = await boot()
    check('硬停期间抬高额度配置成功', (await s.put({ ladder: [{ until: '24:00', cap: 100 }] })).code, 200)
    check('抬高额度立即恢复本插件暂停 goal', [s.active().phase, s.counters.resumes], ['active', 1])
    check('配置恢复撤销旧边界定时器', timers.size, 0)
    checkHost(s, 1)
  }

  console.log('\n=== 新日归零恢复 ===')
  {
    const s = await boot()
    await s.reconcile(time('10:05', '2026-09-22'))
    check('新日账本消费归零', [s.snap().day, s.snap().realSpentCny], ['2026-09-22', 0])
    check('新日余量恢复暂停 goal', [s.active().phase, s.counters.resumes], ['active', 1])
    checkHost(s, 1)
  }

  console.log('\n=== 跨日前另一进程已写入新日消费时不能误归零 ===')
  for (const trigger of ['恢复定时器', '定期对账']) {
    const s = await boot()
    const newDay = '2026-09-22'
    const newTime = time('10:05', newDay)
    fs.writeFileSync(s.ledgerFile, JSON.stringify({
      version: 1, currency: 'CNY', day: newDay,
      events: [{ at: newTime - 1000, sessionId: 'other-process', provider: 'provider-a', units: 120_000 }],
    }))
    if (trigger === '恢复定时器') await s.fire(newTime, () => timers.size === 1)
    else await s.reconcile(newTime)
    check(`${trigger}跨日读取另一进程新消费`, [s.snap().day, s.snap().realSpentCny], [newDay, 12])
    check(`${trigger}跨日已有超限消费继续暂停`, [s.active().phase, s.counters.resumes], ['paused', 0])
    check(`${trigger}跨日不会清掉新日账本`, JSON.parse(fs.readFileSync(s.ledgerFile, 'utf8')).events[0].units, 120_000)
    await s.fire(time('12:05', newDay), () => s.counters.resumes === 1)
    check(`${trigger}后续档位额度充分才恢复`, s.active().phase, 'active')
    checkHost(s, 1)
  }

  console.log('\n=== 宿主 resume 失败后 15 秒重试 ===')
  {
    const s = await boot()
    s.failures = 1
    await s.fire(time('12:05'), () => timers.size === 1)
    check('失败不改变暂停状态', s.active().phase, 'paused')
    check('失败没有启动宿主新轮次', [s.counters.attempts, s.counters.hostRuns], [1, 0])
    check('失败保留 15 秒重试', [...timers][0].ms, 15_000)
    await s.fire(time('12:05') + 15_000, () => s.counters.resumes === 1)
    check('重试仍使用 pause 后的 revision', s.resumeRefs, [
      { id: 'goal-active', revision: 2 }, { id: 'goal-active', revision: 2 },
    ])
    check('重试成功后停止重试', timers.size, 0)
    checkHost(s, 1)
  }

  console.log('\n=== goal 达到轮数上限时交还用户处理 ===')
  {
    const s = await boot()
    s.views.set(s.agents[0], { ...s.active(), roundsStarted: 2, maxGoalRounds: 2 })
    await s.fire(time('12:05'), () => s.snap().exhausted === false)
    check('达到轮数上限保持暂停', s.active().phase, 'paused')
    check('达到轮数上限不调用宿主 resume', s.counters.attempts, 0)
    check('达到轮数上限不重复安排重试', timers.size, 0)
    s.views.set(s.agents[0], { ...s.active(), maxGoalRounds: 3, revision: 3 })
    check('提高轮数后配置保存成功', (await s.put({ ladder: [{ until: '24:00', cap: 100 }] })).code, 200)
    check('已交还用户的 goal 不因额度提高而自动恢复', [s.active().phase, s.counters.attempts, timers.size], ['paused', 0, 0])
    checkHost(s, 0)
  }

  console.log('\n=== agent 枚举暂时失败保留暂停记录并重试 ===')
  {
    const s = await boot()
    s.enumerationFailures = 1
    await s.fire(time('12:05'), () => timers.size === 1)
    check('枚举失败保持 goal 暂停', [s.active().phase, s.counters.resumes], ['paused', 0])
    check('枚举失败 15 秒后重试', [...timers][0].ms, 15_000)
    await s.fire(time('12:05') + 15_000, () => s.counters.resumes === 1)
    check('枚举恢复后仍找到本插件暂停记录', s.resumeRefs, [{ id: 'goal-active', revision: 2 }])
    check('枚举恢复成功不残留重试', timers.size, 0)
    checkHost(s, 1)
  }
  console.log(`\n===== ${passed} passed, 0 failed =====`)
} finally {
  current?.dispose()
  Date.now = original.now
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  globalThis.setInterval = original.setInterval
  globalThis.clearInterval = original.clearInterval
  if (original.home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original.home
  const cleanupPath = path.resolve(testRoot)
  if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-goalcontrol-')) {
    throw new Error(`拒绝清理意外路径: ${cleanupPath}`)
  }
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}
