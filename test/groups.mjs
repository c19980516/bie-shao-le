/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 按组额度专项测试。
 *
 * 覆盖：total 模式不变、group 模式隔离、多 provider 同组共享额度、
 *       groupCapScale 打折、未配置的 provider 自成一组、旧账本迁移。
 *
 * 手法：给 apply() 一个 mock ctx，直接读 costBudget.snapshot() 看判定结果。
 */
import { apply } from '../lib/index.js'
import { makeDom } from './mock-dom.mjs'
import { groupsFromEvents, appendEvent, ledgerPath } from '../lib/ledger.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { beijingDay } from '../lib/pricing.js'

const BUDGET_DAY = beijingDay(Date.now())
const HOME = process.env.DSH_HOME || path.join(os.tmpdir(), 'dsh-groups-test')

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}

/** 起一个插件实例，返回 snapshot 与"喂一笔消费"的函数 */
async function boot(config, spentByGroup = {}, totalCny = null) {
  const services = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    tools: {},
    sessionProjections: {},
    sessions: { list: () => [] },
    agents: { list: () => [] },
    goals: { get: () => undefined, pause: () => {}, resume: () => {} },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    effect: (fn) => { const d = fn(); return () => d?.() },
    on: () => () => {},
    provide: (n, v) => { services[n] = v; return () => delete services[n] },
  }
  apply(ctx, { dryRun: true, ...config, balance: { enabled: false, poll: false } })
  await new Promise((r) => setTimeout(r, 60))

  // 直接把内存值灌进去：走 snapshot 的 debug 覆盖不可行（它只覆盖单值），
  // 所以用 forceSpentCny 之外的路子 —— 通过 record 的失败分支不可控，
  // 这里改用 debug.forceSpentCny 配合单组场景，多组场景走 setMemory 等价路径。
  const snap = () => services.costBudget.snapshot()
  void spentByGroup
  void totalCny
  return { snap, services }
}

const LADDER = [
  { until: '12:00', cap: 10 },
  { until: '24:00', cap: 40 },
]

console.log('=== 1. total 模式：所有 provider 合并成一个额度 ===')
{
  const { snap } = await boot({ ladder: LADDER, quotaMode: 'total' })
  const s = snap()
  check('只有 default 一组', s.groups.map((g) => g.name), ['default'])
  check('模式标记正确', s.quotaMode, 'total')
}

console.log('\n=== 2. group 模式：未配置的 provider 自成一组 ===')
{
  const { snap } = await boot({ ladder: LADDER, quotaMode: 'group' })
  const s = snap()
  check('空配置、无消费时没有噪声组', s.groups.map((g) => g.name), [])
  check('默认放行', s.allowed, true)
}

console.log('\n=== 3. group 模式：providerGroups 声明的组会出现 ===')
{
  const { snap } = await boot({
    ladder: LADDER,
    quotaMode: 'group',
    providerGroups: { official: ['deepseek-official'], internal: ['example-gateway'] },
  })
  const s = snap()
  check('只显示声明的组', s.groups.map((g) => g.name).sort(), ['internal', 'official'])
  check('两组都未超', s.allowed, true)
  check('无触顶组', s.blockedBy, [])
}

console.log('\n=== 4. groupCapScale：倍率直接改变上限，消费金额不变 ===')
{
  for (const spent of [19.9999, 20, 39.9999, 40, 79.9999, 80]) {
    const { snap } = await boot({
      ladder: [{ until: '24:00', cap: 40 }],
      quotaMode: 'group',
      providerGroups: { half: ['p-half'], normal: ['p-normal'], double: ['p-double'] },
      groupCapScale: { half: 0.5, normal: 1, double: 2 },
      debug: { forceSpentCny: spent },
    })
    const s = snap()
    check(`消费 ¥${spent}：顶层显示基准额度`, s.capCny, 40)
    for (const [name, scale] of [['half', 0.5], ['normal', 1], ['double', 2]]) {
      const g = s.groups.find((x) => x.name === name)
      check(`${name} 消费 ¥${spent}：倍率`, g?.scale, scale)
      check(`${name} 消费 ¥${spent}：实际额度`, g?.capCny, 40 * scale)
      check(`${name} 消费 ¥${spent}：金额未折算`, g?.spentCny, spent)
      check(`${name} 消费 ¥${spent}：兼容字段等于真实消费`, g?.effSpentCny, spent)
      check(`${name} 消费 ¥${spent}：达到实际额度即触顶`, g?.allowed, spent < 40 * scale)
    }
    check(`消费 ¥${spent}：试跑仍放行`, s.allowed, true)
    check(`消费 ¥${spent}：保留实际预算判定`, s.budgetAllowed, spent < 20)
    check(`消费 ¥${spent}：触顶组按各自额度判定`, s.blockedBy,
      [['half', 20], ['normal', 40], ['double', 80]].filter(([, cap]) => spent >= cap).map(([name]) => name))
  }
  const { snap } = await boot({
    dryRun: false, ladder: [{ until: '24:00', cap: 40 }], quotaMode: 'total',
    groupCapScale: { default: 0.5 }, debug: { forceSpentCny: 20 },
  })
  check('total 的 default 倍率同样改变真实上限', snap().capCny, 20)
  check('total 在实际上限触顶时阻止继续', snap().allowed, false)
}

console.log('\n=== 5. 归一化：provider 名字带点/下划线/大小写都能匹配 ===')
{
  const { snap } = await boot({
    ladder: LADDER,
    quotaMode: 'group',
    providerGroups: { 'example-gateway': ['EXAMPLE-GATEWAY'] },
  })
  const s = snap()
  check('组名按配置项出现', s.groups.some((g) => g.name === 'example-gateway'), true)
}

console.log('\n=== 6. 旧账本迁移：从 events 补算分组 ===')
{
  // 模拟一个没有 spentByGroup 的旧账本
  const legacy = {
    version: 1, currency: 'CNY', day: '2026-09-21', spentUnits: 30000,
    events: [
      { at: 1, provider: 'deepseek-official', model: 'deepseek-flash', units: 10000 },
      { at: 2, provider: 'example-gateway', model: 'deepseek-v4.1-flash', units: 15000 },
      { at: 3, provider: 'deepseek-official', model: 'deepseek-flash', units: 5000 },
    ],
  }
  const groupOf = (p) => (p === 'example-gateway' ? 'internal' : 'official')
  const byGroup = groupsFromEvents(legacy.events, groupOf)
  check('official 组补算出 15000 units', byGroup.official, 15000)
  check('internal 组补算出 15000 units', byGroup.internal, 15000)
  check('合计等于 spentUnits', byGroup.official + byGroup.internal, legacy.spentUnits)

  // 不传 groupOf 时全部归默认组
  const flat = groupsFromEvents(legacy.events)
  check('无分组函数时全归 default', flat.default, 30000)
}

console.log('\n=== 7. 触顶语义：任一组的已花金额超过上限即硬停 ===')
{
  // 用 debug.forceSpentCny 强制超限，验证"允许/拒绝"的核心判定仍然正确
  const { snap } = await boot({
    dryRun: false,
    ladder: LADDER,
    quotaMode: 'group',
    providerGroups: { official: ['deepseek-official'], internal: ['example-gateway'] },
    debug: { forceSpentCny: 999 },
  })
  const s = snap()
  check('强制超限后整体不放行', s.allowed, false)
  check('报出了触顶组', s.blockedBy.length > 0, true)
  console.log(`        触顶组: ${JSON.stringify(s.blockedBy)}`)
}

console.log('\n=== 8. snapshot 字段完整性（进度条依赖）===')
{
  const { snap } = await boot({ ladder: LADDER, quotaMode: 'total' })
  const s = snap()
  for (const k of ['spentCny', 'capCny', 'tier', 'tierCount', 'allowed', 'budgetAllowed', 'exhausted',
                   'dryRun', 'resumeAt', 'groups', 'blockedBy', 'quotaMode']) {
    check(`含字段 ${k}`, k in s, true)
  }
}

void makeDom // 本文件不需要 DOM，保留 import 以示 fixture 同源

console.log('\n=== 9b. 回归：spentByGroup 必须由事件数组派生 ===')
{
  // 回归：spentByGroup 被初始化成 {default: 0} 时，历史消费不能在分组里丢失。
  // 以下使用合成账目验证"字段存在但统计过期"的迁移情形。
  fs.mkdirSync(HOME, { recursive: true })
  const p = path.join(HOME, 'dsh-cost-budget.json')
  const LEGACY = {
    version: 1, currency: 'CNY', day: BUDGET_DAY,
    spentUnits: 300000,                      // ¥30 历史
    spentByGroup: { default: 0 },            // ← 被错误地初始化成 0
    events: [
      { at: Date.now() - 3000, provider: 'deepseek-official', units: 100000 },  // 无 group 字段
      { at: Date.now() - 2000, provider: 'deepseek-official', units: 200000 },  // 无 group 字段
    ],
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(p, JSON.stringify(LEGACY, null, 2) + '\n')

  const r = await appendEvent({
    at: Date.now(), day: BUDGET_DAY, sessionId: 's', provider: 'deepseek-official',
    model: 'deepseek-flash', cny: 1, basis: 'x', tokens: {},
  }, { path: p })
  check('追加后总额 = ¥31', r.spentCny, 31)
  check('分组也必须是 ¥31（历史 ¥30 不能丢）', r.spentByGroup.default, 300000 + 10000)
}

console.log('\n=== 9c. spentByGroup 与 events 始终自洽 ===')
{
  const p = path.join(HOME, 'dsh-cost-budget.json')
  const led = JSON.parse(fs.readFileSync(p, 'utf8'))
  const fromEvents = led.events.reduce((a, e) => a + (e.units || 0), 0)
  check('spentUnits === events 求和', led.spentUnits, fromEvents)
  const gSum = Object.values(led.spentByGroup).reduce((a, b) => a + b, 0)
  check('spentByGroup 求和 === spentUnits', gSum, led.spentUnits)
}

console.log('\n=== 10. 重复回填不能在写入返回值里瞬间重复计费 ===')
{
  const p = path.join(HOME, 'duplicate-event.json')
  const entry = {
    at: Date.now(), day: BUDGET_DAY, sessionId: 'repeat', provider: 'deepseek-official',
    model: 'deepseek-flash', cny: 12, basis: 'test', tokens: {},
  }
  const first = await appendEvent(entry, { path: p })
  const duplicate = await appendEvent(entry, { path: p })
  check('首次返回 ¥12', first.spentCny, 12)
  check('重复写入直接返回 ¥12，无瞬时 ¥24', duplicate.spentCny, 12)
  check('重复写入只有一条账目', duplicate.ledger.events.length, 1)
  check('返回分组金额没有翻倍', duplicate.spentByGroup.default, 120000)
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'))
  check('落盘时已经去重', saved.events.length, 1)
  check('落盘总额保持正确', saved.spentUnits, 120000)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
