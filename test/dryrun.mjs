/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 验证"关掉限制"：用发布示例配置里的 dryRun，确认三个拦截点全部失效。
 *
 * 手法：造一个远远超限的花费（debug.forceSpentCny），dryRun=false 时三个点都该拦，
 *       dryRun=true 时三个点都该放行。这样直接锁住"关限制"这个语义。
 */
import { apply } from '../lib/index.js'

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个实例，返回 { hook, preStep, snap } */
async function boot(config) {
  const handlers = new Map()
  const services = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    tools: {}, sessionProjections: {},
    sessions: { list: () => [] }, agents: { list: () => [] },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    goals: {
      get: () => ({ id: 'g', revision: 1, phase: 'active' }),
      pause: () => {}, resume: () => {},
    },
    effect: (fn) => { const d = fn(); return () => d?.() },
    on: (e, f) => { handlers.set(e, f); return () => handlers.delete(e) },
    provide: (n, v) => { services[n] = v; return () => delete services[n] },
  }
  apply(ctx, { ...config, balance: { enabled: false, poll: false } })
  await sleep(80)
  return {
    hook: handlers.get('tools/pre-execute'),
    preStep: handlers.get('agent/pre-step'),
    snap: () => services.costBudget.snapshot(),
  }
}

// 远超阶梯上限（最后一档 ¥40），确保一定"触顶"
const OVER = { debug: { forceSpentCny: 999 } }

console.log('=== 1. dryRun: false（硬停开）——三个拦截点都该拦 ===')
{
  const b = await boot({ ...OVER, dryRun: false })
  const snap = b.snap()
  check('快照 dryRun=false', snap.dryRun, false)
  check('快照 exhausted=true', snap.exhausted, true)
  check('快照 allowed=false', snap.allowed, false)

  const tool = b.hook
    ? await b.hook({ name: 'pwsh' }, async () => ({ kind: 'allow' }))
    : null
  check('tools/pre-execute → deny', tool?.kind, 'deny')

  const ps = b.preStep
    ? await b.preStep({ agent: { id: 'a' }, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }))
    : null
  check('agent/pre-step → reject（真止损）', ps?.kind, 'reject')
}

console.log('\n=== 2. dryRun: true（只看额度）——三个拦截点都必须放行 ===')
{
  const b = await boot({ ...OVER, dryRun: true })
  const snap = b.snap()
  check('快照 dryRun=true', snap.dryRun, true)
  check('快照 allowed=true', snap.allowed, true)
  check('快照 exhausted=false', snap.exhausted, false)
  check('仍暴露实际预算判定', snap.budgetAllowed, false)

  const terminal = { kind: 'allow' }
  const tool = b.hook
    ? await b.hook({ name: 'pwsh' }, async () => terminal)
    : null
  check('tools/pre-execute 原样放行（不是 deny）', tool, terminal)

  const psTerm = { kind: 'enter', messages: ['m'] }
  const ps = b.preStep
    ? await b.preStep({ agent: { id: 'a' }, step: 1, signal: { aborted: false } }, async () => psTerm)
    : null
  check('agent/pre-step 原样放行（不是 reject）', ps, psTerm)
  check('返回值可安全读 .kind', ps?.kind, 'enter')

  // 只看额度：金额仍在记账，只是不拦
  check('仍然记账（金额照算）', typeof snap.spentCny, 'number')
  console.log(`        快照 spentCny=${snap.spentCny}（debug 强制值，证明判定仍在跑）`)
}

console.log('\n=== 3. 发布示例配置读出来的 dryRun 就是 true ===')
{
  const fs = await import('node:fs')
  const { createRequire } = await import('node:module')
  const path = await import('node:path')
  // js-yaml 是 DSH 的依赖。显式指定宿主时借用它；否则保持本地依赖解析。
  const req = createRequire(process.env.DSH_TEST_HARNESS_ROOT
    ? path.join(process.env.DSH_TEST_HARNESS_ROOT, 'package.json')
    : import.meta.url)
  let yaml
  try {
    yaml = req('js-yaml')
  } catch (cause) {
    throw new Error('dryrun 测试需要 js-yaml；请使用 npm test -- --harness-root <harness目录>，或在本地提供该测试依赖。', { cause })
  }
  const doc = yaml.load(fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const cfg = doc[0].insert[0].config
  check('配置文件 dryRun', cfg.dryRun, true)
  check('配置文件仍是 6 档阶梯', cfg.ladder.length, 6)

  // 用发布示例配置起一个实例，确认它确实不拦；余额查询在 boot 中禁用。
  const b = await boot({ ...cfg, debug: { forceSpentCny: 999 } })
  const terminal = { kind: 'allow' }
  const tool = b.hook ? await b.hook({ name: 'pwsh' }, async () => terminal) : null
  check('示例配置 → 工具被放行', tool, terminal)
  const psTerm = { kind: 'enter', messages: [] }
  const ps = b.preStep
    ? await b.preStep({ agent: { id: 'a' }, step: 1, signal: { aborted: false } }, async () => psTerm)
    : null
  check('示例配置 → 回合被放行', ps, psTerm)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
