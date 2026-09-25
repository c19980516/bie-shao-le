/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 可视化配置接口测试：GET 读、PUT 存、热重载生效、白名单、非法值拒绝。
 * 关键：保存后**不需要重启**，判定逻辑要立刻用新配置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}

// 每次跑用独立 DSH_HOME，避免污染真实配置
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-'))
process.env.DSH_HOME = HOME

const routes = new Map()
const services = {}
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: {}, sessionProjections: {},
  sessions: { list: () => [] }, agents: { list: () => [] },
  goals: { get: () => undefined, pause: () => {}, resume: () => {} },
  webServer: {
    register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) },
    tapIndex: () => () => {},
  },
  effect: (fn) => { const d = fn(); return () => d?.() },
  on: () => () => {},
  provide: (n, v) => { services[n] = v; return () => delete services[n] },
}

apply(ctx, {
  dryRun: true,
  balance: { enabled: false, poll: false },
  ladder: [{ until: '12:00', cap: 10 }, { until: '24:00', cap: 40 }],
  quotaMode: 'total',
})
await new Promise((r) => setTimeout(r, 80))

const cfgRoute = routes.get('/dsh-cost-budget/config.json')
const snap = () => services.costBudget.snapshot()

/** 造一个假的 req/res，驱动路由 */
function call(method, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(JSON.stringify(body))
        if (ev === 'end') cb()
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 0, headers: {}, body: '',
      setHeader(k, v) { this.headers[k] = v },
      end(b) { this.body = b; resolve({ code: res.statusCode, json: safe(b), headers: this.headers }) },
    }
    cfgRoute.handler(req, res)
  })
}
const safe = (b) => { try { return JSON.parse(b) } catch { return b } }

console.log('=== 1. GET 返回生效值、覆盖层、可改键 ===')
{
  const r = await call('GET')
  check('HTTP 200', r.code, 200)
  check('含 effective', typeof r.json.effective, 'object')
  check('含 override（初始为空）', r.json.override, {})
  check('含配置文件路径', typeof r.json.configPath, 'string')
  check('可改键含 quotaMode', r.json.mutableKeys.includes('quotaMode'), true)
  check('可改键不含 debug（防误写）', r.json.mutableKeys.includes('debug'), false)
  check('可改键不含 peakHours（官方计费规则，只读）', r.json.mutableKeys.includes('peakHours'), false)
  check('初始为 total 模式', r.json.effective.quotaMode, 'total')
  console.log(`        配置文件: ${r.json.configPath}`)
}

console.log('\n=== 2. PUT 保存 → 热重载生效（不重启）===')
{
  const r = await call('PUT', {
    override: {
      quotaMode: 'group',
      providerGroups: { official: ['deepseek-official'], internal: ['example-gateway'] },
      groupCapScale: { internal: 0.5 },
    },
  })
  check('HTTP 200', r.code, 200)
  check('返回 ok', r.json.ok, true)
  check('立即生效：模式变 group', r.json.applied.quotaMode, 'group')
  check('快照也变 group（无需重启）', snap().quotaMode, 'group')
  const names = snap().groups.map((g) => g.name).sort()
  check('分组已生效且没有空 default', names, ['internal', 'official'])
  check('PUT 返回已生效状态', r.json.state.groups.map((g) => g.name).sort(), names)
}

console.log('\n=== 3. 落盘：文件真的写了吗 ===')
{
  const p = path.join(HOME, 'dsh-cost-budget-config.json')
  check('配置文件已生成', fs.existsSync(p), true)
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  check('落盘内容正确', j.quotaMode, 'group')
  console.log(`        文件内容: ${JSON.stringify(j)}`)
}

console.log('\n=== 4. GET 能回显已保存的覆盖层 ===')
{
  const r = await call('GET')
  check('override 回显 quotaMode', r.json.override.quotaMode, 'group')
  check('effective 也是 group', r.json.effective.quotaMode, 'group')
}

console.log('\n=== 5. 改阶梯：热重载后判定用新上限 ===')
{
  const r = await call('PUT', { override: { ladder: [{ until: '24:00', cap: 7 }] } })
  check('HTTP 200', r.code, 200)
  check('阶梯已换成单档', r.json.applied.ladder, ['24:00=¥7'])
  check('快照上限变 7', snap().capCny, 7)
  check('档位数变 1', snap().tierCount, 1)
}

console.log('\n=== 6. 白名单：非法键被忽略而不是报错 ===')
{
  const r = await call('PUT', {
    override: { dryRun: false, debug: { forceSpentCny: 999 }, 恶意键: 1 },
  })
  check('HTTP 200', r.code, 200)
  check('dryRun 生效', r.json.applied ? true : false, true)
  check('debug 被忽略', r.json.dropped.includes('debug'), true)
  check('快照未被 debug 影响', snap().dryRun, false)
  console.log(`        被忽略的键: ${JSON.stringify(r.json.dropped)}`)
}

console.log('\n=== 7. 非法配置被拒绝，且不破坏现有配置 ===')
{
  const before = snap().capCny
  const r = await call('PUT', { override: { ladder: [{ until: '99:99', cap: -5 }] } })
  check('HTTP 400', r.code, 400)
  check('返回 ok=false', r.json.ok, false)
  check('带错误信息', typeof r.json.error === 'string' && r.json.error.length > 0, true)
  console.log(`        错误: ${r.json.error}`)
  check('现有配置未被破坏', snap().capCny, before)
}

console.log('\n=== 7b. 午夜只能写成 24:00，不能超过一天 ===')
{
  const before = snap().capCny
  for (const until of ['24:01', '24:59']) {
    const r = await call('PUT', { ladder: [{ until, cap: 3 }] })
    check(`${until} 被拒绝`, r.code, 400)
    check('无效时间不修改现有上限', snap().capCny, before)
  }
  const midnight = await call('PUT', { ladder: [{ until: '24:00', cap: 9 }] })
  check('24:00 仍可作为午夜边界', midnight.code, 200)
  check('午夜边界生效', snap().capCny, 9)
}

console.log('\n=== 8. 坏 JSON 不崩 ===')
{
  const req = { method: 'PUT', on(ev, cb) { if (ev === 'data') cb('{不是JSON'); if (ev === 'end') cb(); return req }, destroy() {} }
  const out = await new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ code: res.statusCode, json: safe(b) }) } }
    cfgRoute.handler(req, res)
  })
  check('返回 400 而不是抛崩', out.code, 400)
  check('插件仍存活', typeof snap().capCny, 'number')
}

console.log('\n=== 9. 节假日/峰谷/日历是只读的（官方计费规则，不该能被改）===')
{
  // 这些键不在白名单里：手搓的 PUT 也必须被丢弃，且**不能污染覆盖层**。
  const r = await call('PUT', {
    override: {
      holidays: ['2026-12-25'],
      calendarUrl: 'https://example.com/h.json',
      peakHours: [[1, 2]],
      valleyDays: ['2026-12-31'],
    },
  })
  check('HTTP 200（不报错，只是丢弃）', r.code, 200)
  check('全部被 dropped', (r.json.dropped || []).sort(),
    ['calendarUrl', 'holidays', 'peakHours', 'valleyDays'])
  const g = await call('GET')
  check('holidays 未被改写', g.json.effective.holidays.includes('2026-12-25'), false)
  check('calendarUrl 未被改写', g.json.effective.calendarUrl, '')
  check('peakHours 未被改写', JSON.stringify(g.json.effective.peakHours), JSON.stringify([[9, 12], [14, 18]]))
  check('可改键不含 holidays', g.json.mutableKeys.includes('holidays'), false)
  check('可改键不含 peakHours', g.json.mutableKeys.includes('peakHours'), false)
  check('可改键不含 calendarUrl', g.json.mutableKeys.includes('calendarUrl'), false)
  check('可改键不含 valleyDays', g.json.mutableKeys.includes('valleyDays'), false)
  // 白名单里该有的仍在
  for (const k of ['ladder', 'quotaMode', 'providerGroups', 'groupCapScale', 'dryRun', 'resumeMinHeadroomPct']) {
    check(`可改键仍含 ${k}`, g.json.mutableKeys.includes(k), true)
  }
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
