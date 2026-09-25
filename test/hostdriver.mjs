/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。 真正加载宿主 round driver，验证预算恢复不会绕过余量门槛或重复续跑。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const hostRequire = process.env.DSH_TEST_HARNESS_ROOT
  ? createRequire(path.join(process.env.DSH_TEST_HARNESS_ROOT, 'package.json'))
  : createRequire(import.meta.url)
let driverFile
try {
  driverFile = hostRequire.resolve('@deepseek-ai/dsh-goal-round-driver')
} catch (error) {
  throw new Error('真实宿主 round driver 不可用；请通过 test/run.mjs --harness-root <harness目录> 运行。', { cause: error })
}

const tempRoot = path.resolve(os.tmpdir())
const home = fs.mkdtempSync(path.join(tempRoot, 'dsh-hostdriver-'))
process.env.DSH_HOME = home
process.env.HOME = home
process.env.USERPROFILE = home

let pass = 0, fail = 0
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}

const original = {
  now: Date.now,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}
let at = Date.parse('2026-09-21T02:05:00Z') // 北京 10:05
const timers = new Set()
const intervals = new Set()
const disposers = []
const handlers = new Map()
const services = {}
const warnings = []
const calls = { pause: [], resume: [], followup: [], cancel: [], flush: [] }
let goal

// 仅模拟内存中的会话、CAS goal 状态和事件总线；续跑决策由真实宿主代码执行。
const agent = {
  id: 'offline-hostdriver-agent',
  session: { id: 'offline-hostdriver-session' },
  status: 'running',
  inbox: { nextTurn: [], nextStep: [] },
  followup(message) {
    calls.followup.push(message)
    this.status = 'running'
    this.inbox.nextTurn.push(message)
    emit('agent/inbox/inserted', { agent: this, message })
  },
  cancel(reason, options) {
    calls.cancel.push({ reason, options })
    this.status = 'idle'
    emit('agent/status', { agent: this, status: 'idle' })
  },
  async whenIdle() {},
}

function emit(name, ...args) {
  for (const fn of [...(handlers.get(name) || [])]) fn(...args)
}

function requireCurrent(owner, ref) {
  if (owner !== agent) throw new Error('goal mutation must use the exact live agent')
  if (!goal || goal.id !== ref.id || goal.revision !== ref.revision) {
    throw new Error('stale goal revision')
  }
}

function transition(owner, ref, operation, phase, activation) {
  requireCurrent(owner, ref)
  if ((operation === 'pause' && goal.phase !== 'active') ||
      (operation === 'resume' && goal.phase !== 'paused')) throw new Error('invalid goal phase')
  calls[operation].push({ agent: owner.id, ref: { ...ref } })
  goal = { ...goal, revision: goal.revision + 1, phase, activation }
  const view = { ...goal }
  emit('goal/changed', { agent: owner, change: { operation, ref: { id: goal.id, revision: goal.revision }, goal: view } })
  return view
}

const ctx = {
  logger: { info() {}, warn(message) { warnings.push(message) } },
  tools: {}, sessionProjections: {},
  fiber: { state: 2 },
  on(name, fn) {
    const listeners = handlers.get(name) || new Set()
    listeners.add(fn)
    handlers.set(name, listeners)
    return () => listeners.delete(fn)
  },
  effect(fn) {
    const effect = fn()
    if (effect && typeof effect.next === 'function') {
      for (let step = effect.next(); !step.done; step = effect.next()) {
        if (typeof step.value === 'function') disposers.push(step.value)
      }
    } else if (typeof effect === 'function') disposers.push(effect)
  },
  provide(name, value) { services[name] = value; return () => delete services[name] },
  webServer: { register: () => () => {}, tapIndex: () => () => {} },
  sessions: {
    list: () => [],
    async flush(session) { calls.flush.push(session.id) },
  },
  agents: {
    list: () => [agent],
    get: (id) => id === agent.id ? agent : undefined,
    withoutInitiator: (fn) => fn(),
    currentInitiator: () => undefined,
  },
  goals: {
    get(owner) {
      if (owner !== agent) throw new Error('goal read must use the exact live agent')
      return goal ? { ...goal } : undefined
    },
    pause: (owner, ref) => transition(owner, ref, 'pause', 'paused', 'disarmed'),
    resume: (owner, ref) => transition(owner, ref, 'resume', 'active', 'armed'),
    disarm(owner) {
      if (owner !== agent) throw new Error('invalid live agent')
      if (goal) goal = { ...goal, activation: 'disarmed' }
      return goal ? { ...goal } : undefined
    },
    block() { throw new Error('round driver unexpectedly blocked the in-memory goal') },
  },
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await wait(5)
  }
  throw new Error(`等待离线宿主调度超时: ${warnings.join('; ')}`)
}

function fireBoundary() {
  if (timers.size !== 1) throw new Error(`预期一个预算恢复定时器，实际 ${timers.size}`)
  const timer = [...timers][0]
  timers.delete(timer)
  timer.fn()
}

try {
  const [{ apply }, { apply: applyDriver }] = await Promise.all([
    import('../lib/index.js'), import(pathToFileURL(driverFile).href),
  ])
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

  fs.writeFileSync(path.join(home, 'dsh-cost-budget.json'), JSON.stringify({
    version: 1, currency: 'CNY', day: '2026-09-21',
    events: [{ sessionId: 'usage', at: at - 1000, provider: 'example-gateway', units: 120000 }],
  }))

  applyDriver(ctx)
  // driver 安装后模拟人工已授权且正在运行的 goal，未真正启动模型或会话。
  goal = {
    id: 'offline-goal', revision: 1, phase: 'active', activation: 'armed',
    objective: 'offline integration test', roundsStarted: 0, maxGoalRounds: 3,
  }
  emit('goal/changed', { agent, change: { operation: 'create', goal: { ...goal } } })
  apply(ctx, {
    dryRun: false,
    balance: { enabled: false, poll: false },
    resumeMinHeadroomPct: 15,
    ladder: [{ until: '11:00', cap: 10 }, { until: '12:00', cap: 13 }, { until: '24:00', cap: 20 }],
  })

  const snapshot = () => services.costBudget.snapshot()
  await until(() => goal.phase === 'paused' && timers.size === 1)
  await wait(10)
  check('初始预算触顶', snapshot().exhausted, true)
  check('插件暂停一次', calls.pause.length, 1)
  check('暂停使用当前 CAS revision', calls.pause[0].ref, { id: 'offline-goal', revision: 1 })
  check('暂停后 revision 增加且取消自动权限', [goal.revision, goal.activation], [2, 'disarmed'])
  check('真实 driver 取消正在运行的 goal', calls.cancel.length, 1)
  check('暂停阶段没有续跑消息', calls.followup.length, 0)

  at = Date.parse('2026-09-21T03:05:00Z') // 新档 ¥13，余量不足 15%。
  fireBoundary()
  await until(() => timers.size === 1)
  await wait(10)
  check('低余量档位解除预算刹车', snapshot().exhausted, false)
  check('低余量仍保留 paused', goal.phase, 'paused')
  check('低余量不调用 resume', calls.resume.length, 0)
  check('真实 driver 在低余量档位不续跑', calls.followup.length, 0)
  check('低余量保留下一边界复检', timers.size, 1)

  at = Date.parse('2026-09-21T04:05:00Z') // 新档 ¥20，余量 40%。
  fireBoundary()
  await until(() => calls.followup.length === 1 && timers.size === 0)
  await wait(10)
  check('充足余量只恢复一次', calls.resume.length, 1)
  check('恢复使用暂停后 CAS revision', calls.resume[0].ref, { id: 'offline-goal', revision: 2 })
  check('恢复后 active armed 且 revision 再增加', [goal.phase, goal.activation, goal.revision], ['active', 'armed', 3])
  check('真实 driver 只生成一条续跑消息', calls.followup.length, 1)
  check('续跑消息具有宿主 goal source', calls.followup[0].source, {
    kind: 'goal', goalId: 'offline-goal', revision: 3, round: 1,
  })
  check('续跑消息含宿主 goal_round 提示', calls.followup[0].content.some((block) => /<goal_round>/.test(block.text || '')), true)
  check('真实 driver 执行持久化 checkpoint', calls.flush.length > 0, true)
  check('恢复后无残留预算定时器', timers.size, 0)
  check('真实 driver 未报告执行错误', warnings.filter((message) => message.includes('goal-round-driver:')), [])
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  handlers.clear()
  Date.now = original.now
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  globalThis.setInterval = original.setInterval
  globalThis.clearInterval = original.clearInterval
  const cleanupPath = path.resolve(home)
  if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-hostdriver-')) {
    throw new Error(`拒绝清理意外路径: ${cleanupPath}`)
  }
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exitCode = fail ? 1 : 0
