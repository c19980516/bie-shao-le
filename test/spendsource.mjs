/** Synthetic account fixtures; exercise real hooks, polling and goal control without network. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'
import { apply } from '../lib/index.js'

const NOW = Date.parse('2026-09-21T20:00:00+08:00')
const TIER_START = Date.parse('2026-09-21T16:00:00+08:00')
const tempRoot = path.resolve(os.tmpdir())
const homes = []
const original = { now: Date.now, fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
let at = NOW, pass = 0, fail = 0
const timers = new Set(), intervals = new Set()
Date.now = () => at
for (const [name, entries] of [['Timeout', timers], ['Interval', intervals]]) {
  globalThis['set' + name] = (fn, ms) => { const t = { fn, ms, unref() {} }; entries.add(t); return t }
  globalThis['clear' + name] = (t) => entries.delete(t)
}
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: got=${JSON.stringify(got)}, want=${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await wait(3) }
  throw new Error('Timed out waiting for isolated plugin state')
}
const samples = (spent, start = TIER_START, end = NOW - 1000) => [
  { at: start, units: 100 * 1e8 }, { at: end, units: (100 - spent) * 1e8 },
]
async function boot({ balanceSamples = null, tokenSpend = 0, cfg = {},
  context = 'deepseek-CNY', currency = 'CNY', now = NOW, pollBalance = 100 } = {}) {
  at = now
  const home = fs.mkdtempSync(path.join(tempRoot, 'dsh-source-'))
  homes.push(home)
  process.env.DSH_HOME = home
  process.env.USERPROFILE = home
  process.env.HOME = home
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'DEEPSEEK_API_KEY: synthetic-only\n')
  fs.writeFileSync(path.join(home, 'dsh-cost-budget.json'), JSON.stringify({ version: 1,
    currency: 'CNY', day: '2026-09-21', events: tokenSpend ? [
      { sessionId: 'fixture', at: now - 1, units: tokenSpend * 10000, provider: 'fixture-provider' },
    ] : [] }))
  if (balanceSamples) fs.writeFileSync(path.join(home, 'dsh-cost-budget-balance.json'), JSON.stringify({
    version: 1, active: context, books: { [context]: { currency, days: {}, samples: balanceSamples,
      lastAt: balanceSamples.at(-1)?.at } },
  }))
  const services = {}, handlers = new Map(), routes = new Map(), disposers = [], logs = []
  const calls = { pause: 0, resume: 0, followup: 0, fetch: 0 }
  const response = { balance: pollBalance, currency: 'CNY', fail: false, deferred: null }
  let goal = { id: 'fixture-goal', revision: 1, phase: 'active', activation: 'armed' }
  const agent = { id: 'fixture-agent', followup() { calls.followup++ } }
  globalThis.fetch = async () => {
    calls.fetch++
    if (response.deferred) await response.deferred
    if (response.fail) throw new Error('synthetic-private-error')
    return { ok: true, async json() { return { balance_infos: [
      { currency: response.currency, total_balance: response.balance },
    ] } } }
  }
  try {
    apply({
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
      on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
      effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
      provide(name, value) { services[name] = value; return () => delete services[name] },
      inject() {}, tools: {}, sessionProjections: {}, sessions: { list: () => [] },
      webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
        tapIndex: () => () => {} },
      agents: { list: () => [agent] },
      goals: { get: () => goal,
        pause() { calls.pause++; goal = { ...goal, phase: 'paused', revision: goal.revision + 1 }; return goal },
        resume() { calls.resume++; goal = { ...goal, phase: 'active', revision: goal.revision + 1 }; return goal },
      },
    }, { dryRun: false, balance: { enabled: true, poll: false }, ...cfg })
    await until(() => logs.some((line) => line.includes('就绪：')))
    await wait(5)
  } catch (err) {
    for (const dispose of disposers.reverse()) dispose()
    throw err
  }
  return {
    home, calls, response, logs,
    snapshot: () => services.costBudget.snapshot(),
    tool: () => handlers.get('tools/pre-execute')({ name: 'fixture-tool' }, () => ({ kind: 'allow' })),
    model: () => handlers.get('agent/pre-step')({ agent, step: 1 }, () => ({ kind: 'enter' })),
    goal: () => goal,
    configure(override) {
      return new Promise((resolve) => {
        const req = { method: 'PUT', on(event, fn) {
          if (event === 'data') fn(JSON.stringify({ override }))
          if (event === 'end') fn()
          return req
        }, destroy() {} }
        const res = { statusCode: 0, setHeader() {}, end(body) { resolve({ code: res.statusCode, body: JSON.parse(body) }) } }
        routes.get('/dsh-cost-budget/config.json').handler(req, res)
      })
    },
    triggerPoll() { [...intervals].find((t) => t.ms === 60000).fn() },
    async tick() { await [...intervals].find((t) => t.ms === 15000).fn() },
    async poll() {
      const before = calls.fetch
      ;[...intervals].find((t) => t.ms === 60000).fn()
      await until(() => calls.fetch > before)
      await wait(10)
    },
    async boundary() {
      const timer = [...timers].find((t) => t.ms !== 8000)
      if (!timer) throw new Error('Missing budget boundary timer')
      timers.delete(timer)
      timer.fn()
      await wait(15)
    },
    dispose() { for (const dispose of disposers.reverse()) dispose(); timers.clear(); intervals.clear() },
  }
}
async function withBoot(options, run) {
  const plugin = await boot(options)
  try { await run(plugin) } finally { plugin.dispose(); at = NOW }
}
try {
  console.log('=== Spending source drives real enforcement ===')
  await withBoot({ balanceSamples: samples(50) }, (p) => {
    const s = p.snapshot()
    check('Default source is estimated', s.spendSource.requested, 'estimated')
    check('Default effective source is estimated', s.spendSource.effective, 'estimated')
    check('Default window is day', s.spendSource.window, 'day')
    check('Independent balance spend does not alter token mode', s.spentCny, 0)
    check('Token mode hook enters', p.model().kind, 'enter')
    check('Balance display retains valid observed spend', s.balance.tierSpend, 50)
  })
  await withBoot({ balanceSamples: samples(50), cfg: { spendSource: 'observed' } }, (p) => {
    const s = p.snapshot()
    check('Observed amount drives snapshot', s.spentCny, 50)
    check('Observed effective source', s.spendSource.effective, 'observed')
    check('Observed window is tier', s.spendSource.window, 'tier')
    check('Observed tier starts at the actual boundary', s.spendSource.startAt, TIER_START)
    check('Observed amount drives total group', s.groups[0].spentCny, 50)
    check('Budget exceeded with empty token ledger', s.budgetAllowed, false)
    check('Tools actually denied', p.tool().kind, 'deny')
    check('Model calls actually rejected', p.model().kind, 'reject')
    check('Active goal actually paused', p.goal().phase, 'paused')
    check('Goal paused once', p.calls.pause, 1)
  })
  await withBoot({ tokenSpend: 50, balanceSamples: samples(5), cfg: { spendSource: 'observed' } }, (p) => {
    check('Observed uses 5 instead of token ledger 50', p.snapshot().spentCny, 5)
    check('Token ledger stays independently visible', p.snapshot().realSpentCny, 50)
    check('Observed model hook allows under cap', p.model().kind, 'enter')
    check('Observed tool hook allows under cap', p.tool().kind, 'allow')
    check('Under cap does not pause', p.calls.pause, 0)
  })
  await withBoot({ balanceSamples: samples(50), cfg: { spendSource: 'observed', dryRun: true } }, (p) => {
    check('Dry run still shows exceeded budget', p.snapshot().budgetAllowed, false)
    check('Dry run never pauses goal', p.calls.pause, 0)
    check('Dry run model hook enters', p.model().kind, 'enter')
    check('Dry run tool hook allows', p.tool().kind, 'allow')
    check('Dry run schedules no recovery', timers.size, 0)
  })

  console.log('\n=== Missing or invalid observations fall back to the token ledger ===')
  const fallbackCases = [
    ['no-samples', {}],
    ['disabled', { balanceSamples: samples(0), cfg: { balance: { enabled: false, poll: false } } }],
    ['no-anchor', { balanceSamples: [{ at: NOW - 1000, units: 100e8 }] }],
    ['stale-samples', { balanceSamples: samples(0, TIER_START, NOW - 180001) }],
    ['stale-anchor', { balanceSamples: samples(0, TIER_START - 180001) }],
    ['context-mismatch', { balanceSamples: samples(0), context: 'another-account-CNY' }],
    ['context-mismatch', { balanceSamples: samples(0), context: 'deepseek-USD', currency: 'USD' }],
    ['context-mismatch', { balanceSamples: samples(0), currency: 'USD' }],
    ['invalid-samples', { balanceSamples: samples(0, TIER_START, NOW + 1) }],
    ['invalid-samples', { balanceSamples: [{ at: TIER_START, units: 'bad' }] }],
  ]
  for (const [reason, options] of fallbackCases) await withBoot({ tokenSpend: 50, ...options,
    cfg: { spendSource: 'observed', ...options.cfg } }, (p) => {
    const s = p.snapshot()
    check(`${reason}: explicit reason`, s.spendSource.fallback, reason)
    check(`${reason}: effective source is token`, s.spendSource.effective, 'estimated')
    check(`${reason}: day window after fallback`, s.spendSource.window, 'day')
    check(`${reason}: token spend preserved`, s.spentCny, 50)
    check(`${reason}: model really blocked`, p.model().kind, 'reject')
    check(`${reason}: tools really blocked`, p.tool().kind, 'deny')
    check(`${reason}: active goal paused`, p.calls.pause, 1)
    if (s.balance) check(`${reason}: untrusted tier amount is null`, s.balance.tierSpend, null)
  })
  console.log('\n=== Deposits cannot erase observed spending ===')
  await withBoot({ balanceSamples: [
    { at: TIER_START, units: 100e8 }, { at: NOW - 3000, units: 50e8 },
    { at: NOW - 2000, units: 200e8 }, { at: NOW - 1000, units: 195e8 },
  ], cfg: { spendSource: 'observed' } }, (p) => {
    check('Before/after top-up spending accumulates', p.snapshot().spentCny, 55)
    check('Top-up does not release tool brake', p.tool().kind, 'deny')
    check('Top-up does not release model brake', p.model().kind, 'reject')
  })
  let rejected = false
  try { await boot({ cfg: { spendSource: 'observed', quotaMode: 'group' } }) } catch (err) {
    rejected = /observed.*total.*estimated/.test(err.message)
  }
  check('Observed account total cannot pretend to be provider group amounts', rejected, true)
  await withBoot({ balanceSamples: samples(50), cfg: { spendSource: 'observed' } }, async (p) => {
    const response = await p.configure({ quotaMode: 'group' })
    check('UI cannot switch observed source into group mode', response.code, 400)
    check('Rejected UI change preserves total mode', p.snapshot().quotaMode, 'total')
    check('Rejected UI change preserves observed brake', p.model().kind, 'reject')
    check('Rejected UI change never persists invalid config', fs.existsSync(path.join(p.home, 'dsh-cost-budget-config.json')), false)
  })

  console.log('\n=== Polling and reconciliation update the actual brake ===')
  await withBoot({ balanceSamples: samples(0), cfg: { spendSource: 'observed', balance: { poll: true } } }, async (p) => {
    check('Initial polled balance under cap', p.model().kind, 'enter')
    at += 1000
    p.response.balance = 50
    await p.poll()
    check('Successful poll immediately updates actual spend', p.snapshot().spentCny, 50)
    check('Poll alone pauses active goal', p.calls.pause, 1)
    check('Poll alone rejects model work', p.model().kind, 'reject')
    check('Poll alone rejects tool work', p.tool().kind, 'deny')
    check('Poll did not need a token event', p.snapshot().realSpentCny, 0)
    at += 1000
    p.response.balance = 200
    await p.poll()
    check('Polled top-up preserves spend', p.snapshot().spentCny, 50)
    check('Polled top-up does not resume', p.calls.resume, 0)
    p.response.fail = true
    at += 1000
    await p.poll()
    check('Fresh prior balance survives brief network failure', p.snapshot().spendSource.effective, 'observed')
    check('Network error is classified without private text', p.snapshot().balance.error, 'BALANCE_POLL_FAILED')
  })
  await withBoot({ tokenSpend: 50, balanceSamples: samples(5), cfg: { spendSource: 'observed' } }, async (p) => {
    at += 180001
    check('Stale snapshot explicitly falls back', p.snapshot().spendSource.fallback, 'stale-samples')
    check('Before background tick, stale hook already rejects', p.model().kind, 'reject')
    await p.tick()
    check('Reconcile pauses on fallback without token change', p.calls.pause, 1)
    check('Reconcile updates exhausted', p.snapshot().exhausted, true)
  })
  console.log('\n=== Observed boundary recovery ===')
  const EARLY = Date.parse('2026-09-21T15:59:00+08:00')
  await withBoot({ now: EARLY, balanceSamples: samples(35, Date.parse('2026-09-21T14:00:00+08:00'), EARLY),
    cfg: { spendSource: 'observed' } }, async (p) => {
    check('Earlier tier paused using observed spend', p.calls.pause, 1)
    at = TIER_START
    await p.boundary()
    check('New tier starts from its own anchor', p.snapshot().spentCny, 0)
    check('Sufficient observed headroom restores goal', p.calls.resume, 1)
    check('Host alone schedules resumed work', p.calls.followup, 0)
    check('Model hook opens after boundary reconciliation', p.model().kind, 'enter')
  })
  await withBoot({ now: EARLY, pollBalance: 65,
    balanceSamples: samples(35, Date.parse('2026-09-21T14:00:00+08:00'), EARLY),
    cfg: { spendSource: 'observed', balance: { poll: true } } }, async (p) => {
    at = TIER_START + 60000
    p.response.balance = 26
    await p.poll()
    check('New tier observes 39 against cap 40', p.snapshot().groups[0].spentCny, 39)
    check('Remaining observed headroom is too small to resume', p.calls.resume, 0)
    check('Low observed headroom keeps goal paused', p.goal().phase, 'paused')
    const response = await p.configure({ groupCapScale: { default: 2 } })
    check('Increasing cap recomputes actual observed headroom', response.code, 200)
    check('Sufficient observed headroom now resumes exactly once', p.calls.resume, 1)
    check('Cap change leaves measured consumption unchanged', p.snapshot().spentCny, 39)
  })
  console.log('\n=== Poll lifecycle does not revive disposed plugins ===')
  await withBoot({ balanceSamples: samples(0), cfg: { spendSource: 'observed', balance: { poll: true } } }, async (p) => {
    let release
    p.response.deferred = new Promise((resolve) => { release = resolve })
    p.response.balance = 50
    at += 1000
    const before = p.calls.fetch
    const file = path.join(p.home, 'dsh-cost-budget-balance.json')
    const previous = fs.readFileSync(file, 'utf8')
    p.triggerPoll()
    p.triggerPoll()
    await until(() => p.calls.fetch > before)
    check('Overlapping balance polls collapse to one request', p.calls.fetch, before + 1)
    p.dispose()
    release()
    await wait(10)
    check('Disposed plugin does not write arriving poll result', fs.readFileSync(file, 'utf8'), previous)
    check('Disposed plugin does not pause goal on arriving result', p.calls.pause, 0)
    check('Disposed plugin leaves no recovery timer', timers.size, 0)
  })
} finally {
  Date.now = original.now
  globalThis.fetch = original.fetch
  for (const key of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) globalThis[key] = original[key]
  for (const home of homes) {
    const target = path.resolve(home)
    if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('dsh-source-')) throw new Error('Unsafe cleanup target')
    fs.rmSync(target, { recursive: true, force: true })
  }
}
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exitCode = fail ? 1 : 0
