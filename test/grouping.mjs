/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 分组归属与"各组之和 = 当日总额"不变式。
 *
 * 这个测试是**为了钉住一个真实 bug**：
 *   插件有三处 `currentSpend(now, day)` 调用**都没传** `opts.groupOf`，
 *   而 ledger.js 在没有 groupOf 时会把**所有事件归到 default**。
 *   后果是启动那一刻 `memory.spentByGroup = {default: 全部}` ——
 *   分组从一开始就是错的，A/B 组永远显示 ¥0；
 *   更糟的是 mergeGroups 取最大值，那个错误的 default 键再也清不掉。
 *
 * 另一方面，账本事件里的 `group` 字段是**写入当时**按当时配置记的，
 * 改一次分组它就过期了。所以必须验证：改配置后旧组名**不会**变成幽灵组。
 *
 * 两条断言方向相反，缺一不可：
 *   · 旧组名不得残留成幽灵组（会各自拿一份上限 → 假硬停）
 *   · 各组之和必须等于总额（否则同一笔钱被算两遍，或有钱没人管）
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
const near = (label, got, want, tol = 1e-6) => {
  const ok = typeof got === 'number' && Math.abs(got - want) <= tol
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got=${got}  want=${want}`}`)
  ok ? pass++ : fail++
}

const bjDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)

/**
 * 在隔离的 DSH_HOME 里放一本账，然后 boot 插件。
 * @param events 账本事件（provider/units/group）
 */
async function boot(events, cfg = {}) {
  const env = await bootEnv(events, cfg)
  return env.snapshot()
}

/**
 * 同 boot()，但保留路由与 snapshot —— 用于"改了配置之后会怎样"的测试。
 * 需要真实 PUT 路径，才能验证 reloadConfig 之后归属有没有跟上。
 */
async function bootEnv(events, cfg = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-grp-'))
  process.env.DSH_HOME = home
  const now = Date.now()
  const day = bjDay(now)
  fs.writeFileSync(path.join(home, 'dsh-cost-budget.json'), JSON.stringify({
    version: 1, currency: 'CNY', day, spentUnits: 0, spentByGroup: {},
    events: events.map((e, i) => ({ sessionId: `s${i}`, at: now - (events.length - i) * 1000, ...e })),
  }))
  const seen = {}
  const routes = new Map()
  const handlers = new Map()
  const intervals = new Map()
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = (fn, ms) => { intervals.set(ms, fn); return { unref() {} } }
  try {
  apply({
    logger: { info: () => {}, warn: () => {} },
    on: (name, fn) => { handlers.set(name, fn); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    provide: (n, v) => { seen[n] = v; return () => {} },
    inject: () => {},
    webServer: {
      register: (r) => { routes.set(r.path, r); return () => {} },
      tapIndex: () => () => {},
    },
    sessions: { list: () => [] },
    agents: { list: () => [] },
    goals: { get: () => undefined },
    tools: {},
    sessionProjections: {},
  }, {
    dryRun: true,
    balance: { enabled: false, poll: false },
    ...cfg,
  })
  } finally {
    globalThis.setInterval = originalInterval
  }
  // 启动对账是异步的（readSpend 是 await），等它落定
  await new Promise((r) => setTimeout(r, 400))

  /** 调一个已注册路由；PUT 的 handler 是异步的，必须等 end() 才拿到结果 */
  const request = (routePath, method, body) => new Promise((resolve) => {
    const r = routes.get(routePath)
    if (!r) throw new Error('路由未注册: ' + routePath)
    r.handler(
      { method, url: routePath, headers: {}, on(ev, fn) { if (ev === 'data' && body !== undefined) fn(JSON.stringify(body)); if (ev === 'end') fn() } },
      { statusCode: 0, setHeader() {}, writeHead(c) { this.statusCode = c }, end(s) { resolve(JSON.parse(s)) } },
    )
  })

  return {
    home,
    snapshot: () => seen.costBudget.snapshot(),
    get: (p) => request(p, 'GET'),
    put: (p, body) => request(p, 'PUT', body),
    reconcile: () => intervals.get(15_000)(),
    event: (session, event) => handlers.get('session/event')(session, event),
  }
}

const sums = (s) => s.groups.reduce((a, g) => a + g.spentCny, 0)
const named = (s, n) => (s.groups.find((g) => g.name === n) || {}).spentCny

console.log('=== 1. 分组必须按 provider 正确归属（不是全落到 default）===')
{
  // 账本里的 group 字段是**旧配置**留下的，必须被当前配置覆盖重算
  const s = await boot([
    { provider: 'deepseek-official', units: 100000, group: 'deepseek-official' }, // ¥10
    { provider: 'example-gateway', units: 150000, group: 'official' },                        // ¥15
    { provider: 'example-gateway', units: 50000, group: 'example-gateway' },                              // ¥5
  ], {
    quotaMode: 'group',
    providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] },
    groupCapScale: { A: 0.75, B: 0.6 },
  })

  near('总额 = ¥30', s.spentCny, 30)
  near('A 组 = ¥10（deepseek-official）', named(s, 'A'), 10)
  near('B 组 = ¥20（example-gateway 两笔合并）', named(s, 'B'), 20)
  check('没有空 default 行', s.groups.some((g) => g.name === 'default'), false)
  check('A 的倍率生效', s.groups.find((g) => g.name === 'A').scale, 0.75)
  check('B 的倍率生效', s.groups.find((g) => g.name === 'B').scale, 0.6)
}

console.log('\n=== 2. 不变式：各组之和 = 当日总额 ===')
{
  const s = await boot([
    { provider: 'deepseek-official', units: 100000, group: 'deepseek-official' },
    { provider: 'example-gateway', units: 150000, group: 'official' },
    { provider: 'example-gateway', units: 50000, group: 'example-gateway' },
  ], {
    quotaMode: 'group',
    providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] },
    groupCapScale: { A: 0.75, B: 0.6 },
  })
  near('各组之和 = 总额（没有钱被算两遍）', sums(s), s.spentCny, 1e-6)
}

console.log('\n=== 3. 旧组名不得变成幽灵组 ===')
{
  // 账本里带着三个历史组名，当前配置只声明了 A / B
  const s = await boot([
    { provider: 'deepseek-official', units: 100000, group: 'deepseek-official' },
    { provider: 'example-gateway', units: 150000, group: 'official' },
    { provider: 'example-gateway', units: 50000, group: 'example-gateway' },
  ], {
    quotaMode: 'group',
    providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] },
  })
  const names = s.groups.map((g) => g.name).sort()
  check('只出现 A / B', names, ['A', 'B'])
  for (const ghost of ['official', 'example-gateway', 'deepseek-official']) {
    check(`无幽灵组 ${ghost}`, s.groups.some((g) => g.name === ghost), false)
  }
}

console.log('\n=== 4. 未配置的 provider 自成一组，且金额不丢 ===')
{
  // 'other-api' 不在配置里 → 按设计自成一族，钱必须还在
  const s = await boot([
    { provider: 'deepseek-official', units: 100000, group: 'x' },
    { provider: 'other-api', units: 70000, group: 'y' },
  ], { quotaMode: 'group', providerGroups: { A: ['deepseek-official'] } })
  near('A 组 = ¥10', named(s, 'A'), 10)
  near('other-api 自成一组 = ¥7', named(s, 'other-api'), 7)
  near('各组之和仍 = 总额 ¥17', sums(s), s.spentCny, 1e-6)
  check('总额 = ¥17', s.spentCny, 17)
}

console.log('\n=== 5. total 模式：全部归 default ===')
{
  const s = await boot([
    { provider: 'deepseek-official', units: 100000, group: 'A' },
    { provider: 'example-gateway', units: 150000, group: 'B' },
  ], { quotaMode: 'total', providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] } })
  check('只有一组', s.groups.length, 1)
  check('组名是 default', s.groups[0].name, 'default')
  near('default 含全部 ¥25', named(s, 'default'), 25)
}

console.log('\n=== 6. 配了倍率但没配 provider 的组不该凭空出现 ===')
{
  const s = await boot([
    { provider: 'example-gateway', units: 100000, group: 'B' },
  ], {
    quotaMode: 'group',
    providerGroups: { B: ['example-gateway'] },
    groupCapScale: { B: 0.5, ghostly: 0.3 }, // ghostly 没有任何 provider
  })
  check('幽灵倍率组不出现', s.groups.some((g) => g.name === 'ghostly'), false)
  near('B = ¥10', named(s, 'B'), 10)
  near('不变式成立', sums(s), s.spentCny, 1e-6)
}

console.log('\n=== 7. 删光组后立即按 provider 自成组 ===')
{
  // PUT 返回后直接检查；不等待后台 tick 或下一次客户端轮询。
  const env = await bootEnv([
    { provider: 'deepseek-official', units: 100000, group: 'A' }, // ¥10
    { provider: 'example-gateway', units: 150000, group: 'B' },               // ¥15
  ], {
    quotaMode: 'group',
    providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] },
    groupCapScale: { A: 0.75, B: 0.6 },
  })

  const before = env.snapshot()
  near('删除前：各组之和 = 总额', sums(before), before.spentCny, 1e-6)
  near('删除前：A = ¥10（未打 0.75 折的原始值）', named(before, 'A'), 10)

  // 删光所有组，但**保持 group 模式**（用户当时就是这样）
  const put = await env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: {}, groupCapScale: {},
  })
  check('PUT 成功', put.ok, true)
  const cfgNow = await env.get('/dsh-cost-budget/config.json')
  check('配置里已无任何组', cfgNow.effective.providerGroups, {})
  check('模式仍是 group', cfgNow.effective.quotaMode, 'group')

  const after = env.snapshot()
  const names = after.groups.map((g) => g.name)

  check('已删除的组不残留', names.sort(), ['deepseek-official', 'example-gateway'])
  near('官方 provider 自成组且消费保留', named(after, 'deepseek-official'), 10)
  near('example-gateway 自成组且消费保留', named(after, 'example-gateway'), 15)
  near('各组之和立即等于总额', sums(after), after.spentCny)
  check('PUT 自带最新分组，无需再轮询', put.state.groups, after.groups)
  check('删除组后仍可从账本找到 provider', cfgNow.effective.availableProviders,
    ['deepseek-official', 'example-gateway'])
  check('自成组使用默认倍率', after.groups.every((g) => g.scale === 1), true)
}

console.log('\n=== 8. 切回 total 后唯一分组与总额立即一致 ===')
{
  const env = await bootEnv([
    { provider: 'deepseek-official', units: 100000, group: 'A' }, // ¥10
    { provider: 'example-gateway', units: 150000, group: 'B' },               // ¥15
  ], {
    quotaMode: 'group',
    providerGroups: { A: ['deepseek-official'], B: ['example-gateway'] },
  })
  const put = await env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'total', providerGroups: {}, groupCapScale: {},
  })
  check('PUT 成功', put.ok, true)

  const after = env.snapshot()
  check('切 total 后只剩 default 一组（组名立刻清掉）', after.groups.map((g) => g.name), ['default'])
  check('quotaMode = total', after.quotaMode, 'total')
  near('总额仍正确 = ¥25', after.spentCny, 25)

  near('default 立即含全部 ¥25', named(after, 'default'), 25)
  near('各组之和立即等于总额', sums(after), after.spentCny)
  near('PUT 状态里的 default 同步更新', named(put.state, 'default'), 25)
}

console.log('\n=== 9. 单组可见，空 default 隐藏，有消费或明确配置的 default 保留 ===')
{
  const env = await bootEnv([
    { provider: 'example-gateway', units: 120000 },
    { provider: 'deepseek-official', units: 50000 },
  ], { quotaMode: 'total' })
  const r = await env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: { A: ['deepseek-official', 'example-gateway'] },
  })
  check('总额切单组后只显示 A', r.state.groups.map((g) => g.name), ['A'])
  near('单组金额完整', named(r.state, 'A'), 17)
  const unnamed = await boot([{ provider: '', units: 20000 }], { quotaMode: 'group' })
  near('无名 provider 的金额仍由 default 管理', named(unnamed, 'default'), 2)
  const configured = await boot([], { quotaMode: 'group', providerGroups: { default: ['example-gateway'] } })
  check('用户明确命名为 default 的组保留', configured.groups.map((g) => g.name), ['default'])
}

console.log('\n=== 10. 保存失败不改变生效配置或消费归属 ===')
{
  const env = await bootEnv([{ provider: 'example-gateway', units: 100000 }], {
    quotaMode: 'group', providerGroups: { A: ['example-gateway'] },
  })
  const configFile = path.join(env.home, 'dsh-cost-budget-config.json')
  // 同名目录模拟无法写入配置；不是修改真实用户目录的权限。
  fs.mkdirSync(configFile)
  const before = env.snapshot()
  const r = await env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: { B: ['example-gateway'] },
  })
  check('保存失败明确返回错误', r.ok, false)
  check('旧组和消费保持不变', env.snapshot().groups, before.groups)
  fs.rmdirSync(configFile)
  const retry = await env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: { B: ['example-gateway'] },
  })
  check('失败不会阻塞后续保存', retry.ok, true)
  near('重试后 B 立即得到全部消费', named(retry.state, 'B'), 10)
}

console.log('\n=== 11. 对账更新同总额的新归属，也接受消费修正 ===')
{
  const env = await bootEnv([{ provider: 'example-gateway', units: 100000 }], {
    quotaMode: 'group', providerGroups: { A: ['example-gateway'], B: ['deepseek-official'] },
  })
  const ledgerFile = path.join(env.home, 'dsh-cost-budget.json')
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  ledger.events[0].provider = 'deepseek-official'
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger))
  await env.reconcile()
  near('总额不变时 A 消费也会清零', named(env.snapshot(), 'A'), 0)
  near('总额不变时 B 得到新消费', named(env.snapshot(), 'B'), 10)
  ledger.events[0].units = 70000
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger))
  await env.reconcile()
  near('消费下调修正同步总额', env.snapshot().spentCny, 7)
  near('修正后分组和总额一致', sums(env.snapshot()), 7)
}

console.log('\n=== 12. 保存期间的调用按最新配置归组，连续保存互不覆盖 ===')
{
  const env = await bootEnv([{ provider: 'example-gateway', units: 100000 }], {
    quotaMode: 'group', providerGroups: { A: ['example-gateway'] },
  })
  const saving = env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: { B: ['example-gateway'] },
  })
  env.event({ id: 'concurrent' }, {
    type: 'assistant/message', seq: 1, time: Date.now(),
    data: { message: { source: { provider: 'example-gateway', model: 'deepseek-flash' } }, usage: { inputTokens: 1000000 } },
  })
  const savedAgain = env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: { C: ['example-gateway'] },
  })
  const first = await saving
  const last = await savedAgain
  check('每次响应对应自己的保存结果', first.state.groups.map((g) => g.name), ['B'])
  check('后一次保存只剩 C', last.state.groups.map((g) => g.name), ['C'])
  check('并发消费没有漏记', last.state.spentCny > 10, true)
  near('消费全部按最终配置归组', named(last.state, 'C'), last.state.spentCny)
  const cfg = await env.get('/dsh-cost-budget/config.json')
  check('落盘配置与最后一次响应相同', cfg.override.providerGroups, { C: ['example-gateway'] })
}

console.log('\n=== 13. 写盘失败的消费不会被对账或改组抹掉 ===')
{
  const env = await bootEnv([{ provider: 'example-gateway', units: 100000 }], {
    quotaMode: 'group', providerGroups: { A: ['example-gateway'] }, ledgerWaitMs: 5,
  })
  const ledgerFile = path.join(env.home, 'dsh-cost-budget.json')
  const lockFile = ledgerFile + '.lock'
  fs.writeFileSync(lockFile, 'test lock', { flag: 'wx' })
  const at = Date.now()
  env.event({ id: 'pending-test' }, {
    type: 'assistant/message', seq: 1, time: at,
    data: { message: { source: { provider: 'example-gateway', model: 'deepseek-flash' } }, usage: { inputTokens: 1000000 } },
  })
  await env.reconcile()
  const total = env.snapshot().spentCny
  check('对账仍保留未落盘的消费', total > 10, true)
  const saved = await env.put('/dsh-cost-budget/config.json', {
    quotaMode: 'group', providerGroups: { B: ['example-gateway'] },
  })
  near('未落盘消费也按新组重新归属', named(saved.state, 'B'), total)
  fs.unlinkSync(lockFile)
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  ledger.events.push({ at, sessionId: 'pending-test', provider: 'example-gateway', units: Math.round((total - 10) * 10000) })
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger))
  await env.reconcile()
  near('同一事件落盘后不会重复计费', env.snapshot().spentCny, total)
}

console.log('\n=== 14. 特殊对象键也是普通组名/provider，金额不能丢 ===')
{
  const special = ['constructor', 'toString', '__proto__']
  const env = await bootEnv(special.map((provider, i) => ({ provider, units: (i + 1) * 10000 })), {
    quotaMode: 'total',
  })
  const providerGroups = Object.fromEntries(special.map((name) => [name, [name]]))
  const groupCapScale = Object.fromEntries(special.map((name) => [name, 1]))
  const result = await env.put('/dsh-cost-budget/config.json', { quotaMode: 'group', providerGroups, groupCapScale })
  check('特殊组名能成功保存', result.ok, true)
  check('特殊组名均保留', result.state.groups.map((g) => g.name).sort(), [...special].sort())
  for (let i = 0; i < special.length; i++) near(`${special[i]} 金额正常`, named(result.state, special[i]), i + 1)
  near('特殊组名各组之和等于总额', sums(result.state), 6)
  check('provider 统计保留所有名称', result.state.providers.map((p) => p.provider).sort(), [...special].sort())
  near('provider 金额之和正常', result.state.providers.reduce((sum, p) => sum + p.cny, 0), 6)
  const saved = await env.get('/dsh-cost-budget/config.json')
  check('特殊组名可原样回显', saved.effective.providerGroups, providerGroups)
  await env.reconcile()
  near('定时对账后金额仍然完整', sums(env.snapshot()), 6)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
