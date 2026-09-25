/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。 边界恢复遇到账本暂不可读时，必须保留刹车并重试，不能永久停住。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as wait } from 'node:timers/promises'

const tempRoot = path.resolve(os.tmpdir())
const home = fs.mkdtempSync(path.join(tempRoot, 'dsh-recovery-'))
process.env.DSH_HOME = home
process.env.HOME = home
process.env.USERPROFILE = home
const { apply } = await import('../lib/index.js')

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
  readFile: fs.promises.readFile,
}
let at = Date.parse('2026-09-21T02:05:00Z') // 北京 10:05，当前上限 10
const timers = new Set()
const intervals = new Map()
const disposers = []
const handlers = new Map()
const services = {}
let phase = 'active'
let resumed = 0, followups = 0
const agent = { id: 'recovery-test', followup() { followups++ } }
const ledgerFile = path.join(home, 'dsh-cost-budget.json')
const ledger = {
  version: 1, currency: 'CNY', day: '2026-09-21',
  events: [{ sessionId: 's', at: at - 1000, provider: 'example-gateway', units: 120000 }],
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await wait(5)
  }
  throw new Error('等待插件异步更新超时')
}

function fireTimer() {
  const timer = [...timers][0]
  if (!timer) throw new Error('恢复定时器缺失')
  timers.delete(timer)
  timer.fn()
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
    intervals.set(ms, timer)
    return timer
  }
  globalThis.clearInterval = (timer) => intervals.delete(timer.ms)
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger))

  const startPlugin = () => apply({
    logger: { info() {}, warn() {} },
    tools: {}, sessionProjections: {},
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    provide(name, value) { services[name] = value; return () => delete services[name] },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    sessions: { list: () => [] }, agents: { list: () => [agent] },
    goals: {
      get: () => ({ id: 'g', revision: 1, phase }),
      pause() { phase = 'paused' },
      resume() { phase = 'active'; resumed++ },
    },
  }, {
    balance: { enabled: false, poll: false },
    ladder: [{ until: '11:00', cap: 10 }, { until: '24:00', cap: 20 }],
  })
  startPlugin()
  const snapshot = () => services.costBudget.snapshot()
  const allow = () => handlers.get('tools/pre-execute')({}, () => ({ kind: 'allow' }))
  await until(() => timers.size === 1)
  check('初始消费触顶，goal 暂停', phase, 'paused')
  check('初始已安排恢复', snapshot().exhausted, true)

  // 新档已有余量，但恰在边界读到账本错误。
  at = Date.parse('2026-09-21T03:05:00Z')
  fs.writeFileSync(ledgerFile, '{broken')
  fireTimer()
  await until(() => timers.size === 1)
  check('失败时保留已知消费', snapshot().realSpentCny, 12)
  check('失败时保持暂停', phase, 'paused')
  check('失败时不自动续跑', followups, 0)
  check('失败后 15 秒重试', [...timers][0].ms, 15000)

  // 多次失败不会丢失定时器，也不重复恢复 goal。
  at += 15000
  fireTimer()
  await until(() => timers.size === 1)
  check('连续失败仍只保留一个重试', timers.size, 1)
  check('连续失败不恢复 goal', resumed, 0)

  fs.writeFileSync(ledgerFile, JSON.stringify(ledger))
  await intervals.get(15000).fn()
  check('账本消费未变时对账不会误丢重试', timers.size, 1)
  at += 15000
  fireTimer()
  await until(() => resumed === 1)
  check('账本恢复后解除刹车', snapshot().exhausted, false)
  check('恢复后 goal 活跃', phase, 'active')
  check('恢复后工具放行', (await allow()).kind, 'allow')
  check('只恢复 goal 一次', resumed, 1)
  check('插件不额外发送续跑消息', followups, 0)
  check('恢复完成不残留重试', timers.size, 0)

  // 卸载可能恰在异步读取尚未完成时发生；成功和失败返回均不得重启生命周期。
  for (const readFails of [true, false]) {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    at = Date.parse('2026-09-21T02:05:00Z')
    phase = 'active'
    resumed = 0
    followups = 0
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger))
    startPlugin()
    await until(() => timers.size === 1)
    at = Date.parse('2026-09-21T03:05:00Z')
    let release, started = false, finished = false
    const gate = new Promise((resolve) => { release = resolve })
    fs.promises.readFile = async (file, ...args) => {
      if (path.resolve(String(file)) !== ledgerFile) return original.readFile(file, ...args)
      started = true
      await gate
      try {
        if (readFails) throw new Error('模拟卸载期间账本读取失败')
        return await original.readFile(file, ...args)
      } finally {
        finished = true
      }
    }
    syncBuiltinESMExports()
    fireTimer()
    await until(() => started)
    for (const dispose of disposers.splice(0).reverse()) dispose()
    release()
    await until(() => finished)
    await wait(10)
    const result = readFails ? '失败' : '成功'
    check(`卸载后读盘${result}不安排定时器`, timers.size, 0)
    check(`卸载后读盘${result}不恢复 goal`, resumed, 0)
    check(`卸载后读盘${result}不发送续跑`, followups, 0)
    fs.promises.readFile = original.readFile
    syncBuiltinESMExports()
  }
} finally {
  for (const dispose of disposers.reverse()) dispose()
  Date.now = original.now
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  globalThis.setInterval = original.setInterval
  globalThis.clearInterval = original.clearInterval
  fs.promises.readFile = original.readFile
  syncBuiltinESMExports()
  const cleanupPath = path.resolve(home)
  if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-recovery-')) {
    throw new Error(`拒绝清理意外路径: ${cleanupPath}`)
  }
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exitCode = fail ? 1 : 0
