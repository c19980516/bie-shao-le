/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 余额观测层测试。
 *
 * 余额接口只代表对应计费账户；测试验证下降累计和时间窗口，不依赖真实账户。
 *
 * 核心不变量（错了会让预算算错方向）：
 *   1. 余额**下降** → 累加为消费
 *   2. 余额**上升**（充值/赠金）→ 单独记为 credit，**绝不冲掉已有消费**
 *   3. 当天首次观测是统计起点，不把此前余额算成今天消费
 *   4. 重复/乱序样本丢弃（否则消费会算反）
 *   5. 金额用定点整数，不能有浮点漂移
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  activeBook, balanceSummary, beijingDayOf, emptyBalance, fetchBalance, moneyUnits,
  observedSpendInWindow, observeBalance, readBalanceStore, readCredential, writeBalanceStore,
} from '../lib/balance.js'

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`}`)
  ok ? pass++ : fail++
}
const near = (label, got, want, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got=${got}  want=${want}`}`)
  ok ? pass++ : fail++
}

console.log('=== 1. 定点金额（不能有浮点漂移）===')
{
  check('moneyUnits 整数', moneyUnits(123.45), 12345000000)
  check('moneyUnits 拒绝 NaN', moneyUnits('abc'), null)
  // 0.1 + 0.2 这类经典漂移：定点相加必须精确
  const a = moneyUnits(0.1), b = moneyUnits(0.2)
  check('0.1 + 0.2 定点相加精确', (a + b) / 1e8, 0.3)
}

console.log('\n=== 2. observeBalance 核心语义 ===')
{
  // 起点 100，然后降到 90（消费 10），再降到 85（消费 5）
  let s = emptyBalance()
  let r = observeBalance(s, { at: 1000, balance: 100 })
  s = r.store
  near('首次观测记起点，消费为 0', r.summary.observedSpend, 0)
  check('首次观测不产生消费（起点）', r.summary.observedSpend, 0)

  r = observeBalance(s, { at: 2000, balance: 90 })
  s = r.store
  near('余额下降 → 累计消费 10', r.summary.observedSpend, 10)

  r = observeBalance(s, { at: 3000, balance: 85 })
  s = r.store
  near('再降 5 → 累计 15', r.summary.observedSpend, 15)
  check('样本数 = 3', r.summary.samples, 3)
  check('partialDay 恒为 true（首次观测前看不到）', r.summary.partialDay, true)
}

console.log('\n=== 3. 充值不得冲掉消费（关键不变量）===')
{
  let s = emptyBalance()
  s = observeBalance(s, { at: 1000, balance: 100 }).store
  s = observeBalance(s, { at: 2000, balance: 90 }).store   // 消费 10
  const r = observeBalance(s, { at: 3000, balance: 190 }) // 充值 100
  s = r.store
  near('充值后消费**仍然是 10**（不被冲掉）', r.summary.observedSpend, 10)
  near('充值单独记为 credits = 100', r.summary.credits, 100)
  check('余额反映充值', r.summary.currentBalance, 190)

  // 充值后再消费，应从 10 继续加
  const r2 = observeBalance(s, { at: 4000, balance: 185 })
  near('充值后继续消费 → 15', r2.summary.observedSpend, 15)
  near('credits 不变', r2.summary.credits, 100)
}

console.log('\n=== 4. 重复 / 乱序样本 ===')
{
  let s = emptyBalance()
  s = observeBalance(s, { at: 2000, balance: 100 }).store
  const dup = observeBalance(s, { at: 2000, balance: 50 })   // 同一时刻，值不同
  check('同一时刻的重复样本被丢弃', dup.skipped, true)
  near('丢弃后消费仍为 0（没把 50 的下降算进去）', dup.summary.observedSpend, 0)

  const late = observeBalance(s, { at: 1000, balance: 50 })  // 迟到的旧样本
  check('乱序（更早）样本被丢弃', late.skipped, true)
  near('乱序样本不改变消费', late.summary.observedSpend, 0)
}

console.log('\n=== 5. 跨日：新的一天重新记起点 ===')
{
  let s = emptyBalance()
  const d1 = Date.parse('2026-09-21T10:00:00+08:00')
  const d2 = Date.parse('2026-09-22T10:00:00+08:00')
  s = observeBalance(s, { at: d1, balance: 100 }).store
  s = observeBalance(s, { at: d1 + 3600000, balance: 90 }).store   // 21 日消费 10
  const r = observeBalance(s, { at: d2, balance: 88 })            // 22 日首次观测
  s = r.store
  check('新的一天', r.summary.day, '2026-09-22')
  near('新的一天消费从 0 起算', r.summary.observedSpend, 0)
  near('新的一天起点余额 = 88', r.summary.openingBalance, 88)
  // 昨天那 10 还在
  near('昨天的消费仍在账里', balanceSummary(s, '2026-09-21').observedSpend, 10)
}

console.log('\n=== 6. 持久化 ===')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bal-'))
  const file = path.join(dir, 'bal.json')
  // 固定同一天的样本及查询日，避免午夜运行时前一笔落到昨天。
  const now = Date.parse('2026-09-21T10:00:00+08:00')
  const day = beijingDayOf(now)
  let s = emptyBalance()
  s = observeBalance(s, { at: now - 2000, balance: 100 }).store
  s = observeBalance(s, { at: now, balance: 90 }).store
  writeBalanceStore(s, file)
  check('文件已写入', fs.existsSync(file), true)
  const back = readBalanceStore(file)
  near('读回后消费不丢', balanceSummary(back, day).observedSpend, 10)
  check('没有当天观测时返回 null（不是 0 —— 0 会被误读成"没花钱"）',
    balanceSummary(emptyBalance()), null)
  check('文件不存在时返回空账本（不抛）', readBalanceStore(path.join(dir, 'nope.json')).version, 1)
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{ 这不是 json')
  check('损坏文件不抛，回落空账本', readBalanceStore(bad).books, {})
  // 请求 POSIX 0600；Windows 的实际访问控制由 ACL 决定，不能用 mode 位验证。
  // 因此 Windows 只验证写入代码声明了 0600，不把 mode 位当作隔离保证。
  const src = fs.readFileSync(new URL('../lib/balance.js', import.meta.url), 'utf8')
  check('写入时请求了 0600（表达意图）', /mode:\s*0o600/.test(src), true)
  if (process.platform !== 'win32') {
    check('文件权限 0600', (fs.statSync(file).mode & 0o777).toString(8), '600')
  } else {
    console.log('  SKIP  文件权限 0600（Windows 上 POSIX mode 无意义）')
  }
}

console.log('\n=== 7. 凭证读取（密钥只进内存）===')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'))
  fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.dsh', '.credentials.yaml'),
    'version: 1\nrecords:\n  DEEPSEEK_API_KEY: synthetic-key\n  OTHER: "quoted-key"\n  EXAMPLE_GATEWAY_API_KEY: synthetic-gateway-key\n')
  check('裸值可读', readCredential('DEEPSEEK_API_KEY', dir), 'synthetic-key')
  check('带引号可读', readCredential('OTHER', dir), 'quoted-key')
  check('不存在的名字返回 null', readCredential('NOPE', dir), null)
  check('文件不存在返回 null', readCredential('X', path.join(dir, 'nowhere')), null)
  check('空名字返回 null', readCredential('', dir), null)
  // 关键：不能把别的 key 误读成目标 key（前缀相同的情况）
  check('EXAMPLE_GATEWAY_API_KEY 不串到 DEEPSEEK_API_KEY', readCredential('EXAMPLE_GATEWAY_API_KEY', dir), 'synthetic-gateway-key')
}

console.log('\n=== 8. fetchBalance 解析（不联网，注入 stub）===')
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '0.00' },
        { currency: 'CNY', total_balance: '123.45', topped_up_balance: '123.45' },
      ],
    }),
  })
  const r = await fetchBalance('https://example.invalid/balance', 'k')
  check('优先取 CNY', r.currency, 'CNY')
  near('解析出余额', r.balance, 123.45, 1e-9)

  globalThis.fetch = async () => ({ ok: false, status: 401 })
  let err = null
  try { await fetchBalance('https://example.invalid', 'k') } catch (e) { err = e.message }
  check('非 2xx 抛错并带状态码', err, 'HTTP 401')

  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  err = null
  try { await fetchBalance('https://example.invalid', 'k') } catch (e) { err = e.message }
  check('缺 balance_infos 抛错', err, '响应里没有 balance_infos')

  for (const [label, body, expected] of [
    ['不可用账户', { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: 5 }] }, '余额账户不可用'],
    ['缺少币种', { balance_infos: [{ total_balance: 5 }] }, '余额币种缺失'],
    ['null 金额', { balance_infos: [{ currency: 'CNY', total_balance: null }] }, 'total_balance 不是数字'],
    ['空金额', { balance_infos: [{ currency: 'CNY', total_balance: '' }] }, 'total_balance 不是数字'],
  ]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => body })
    err = null
    try { await fetchBalance('https://example.invalid', 'k') } catch (e) { err = e.message }
    check(`${label}不能误当有效零余额`, err, expected)
  }

  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  err = null
  try { await fetchBalance('https://example.invalid', 'k') } catch (e) { err = e.message }
  check('网络错误向上传播（由调用方兜）', err, 'ECONNREFUSED')
  globalThis.fetch = realFetch
}

console.log('\n=== 9. beijingDayOf ===')
{
  check('北京时间跨日', beijingDayOf(Date.parse('2026-09-21T16:00:00Z')), '2026-09-22')
  check('北京时间当日', beijingDayOf(Date.parse('2026-09-21T02:00:00Z')), '2026-09-21')
}

console.log('\n=== 10. 时间窗消费（阶梯边界用）===')
{
  const T = (h, m = 0) => Date.parse(`2026-09-21T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`)

  // 12:00 前花掉 8 元，12:00–14:00 这一档又花 3 元
  let s = emptyBalance()
  s = observeBalance(s, { at: T(10), balance: 100 }).store
  s = observeBalance(s, { at: T(11), balance: 95 }).store   // 10-11 点花 5
  s = observeBalance(s, { at: T(12), balance: 92 }).store   // 11-12 点花 3  → 12:00 整余额 92
  s = observeBalance(s, { at: T(13), balance: 90 }).store   // 12-13 点花 2
  s = observeBalance(s, { at: T(14), balance: 89 }).store   // 13-14 点花 1

  const book = activeBook(s)
  const w = observedSpendInWindow(book, T(12), T(14))
  near('12:00–14:00 这一档消费 = 3（不是全天 11）', w.spend, 3)
  check('锚点已找到', w.anchored, true)
  check('锚点时间 = 12:00', w.anchorAt, T(12))
  near('锚点余额 = 92', w.anchorBalance, 92)
  near('当前余额 = 89', w.current, 89)

  // 关键反例：拿"当日累计"当判据会虚高
  const daily = balanceSummary(s, '2026-09-21').observedSpend
  near('对比：当日累计 = 11（虚高，会把 12 点前的 8 元算进这一档）', daily, 11)
  check('窗口值 < 当日累计（证明两者确实不同口径）', w.spend < daily, true)
}

console.log('\n=== 11. 时间窗的边界情况 ===')
{
  const T = (h) => Date.parse(`2026-09-21T${String(h).padStart(2, '0')}:00:00+08:00`)

  // 窗口起点之前没有样本 → 不可信，必须显式标记而不是返回 0
  let s = emptyBalance()
  s = observeBalance(s, { at: T(13), balance: 90 }).store
  const noAnchor = observedSpendInWindow(activeBook(s), T(12), T(14))
  check('无锚点时不返回 0，而是 anchored=false', noAnchor.anchored, false)
  check('无锚点时 spend 为 null（0 会被误读成"没花钱"）', noAnchor.spend, null)

  // 空账本
  const empty = observedSpendInWindow(activeBook(emptyBalance()), T(12), T(14))
  check('空账本 anchored=false', empty.anchored, false)
  check('空账本 spend=null', empty.spend, null)
  check('activeBook(空) 为 null', activeBook(emptyBalance()), null)

  // 余额上升（充值）→ 夹到 0，不能变负把额度放大
  let r = emptyBalance()
  r = observeBalance(r, { at: T(12), balance: 90 }).store
  r = observeBalance(r, { at: T(13), balance: 190 }).store  // 充值 100
  const credited = observedSpendInWindow(activeBook(r), T(12), T(14))
  near('充值导致的负值被夹到 0', credited.spend, 0)
  check('不会返回负数', credited.spend >= 0, true)

  let toppedUp = emptyBalance()
  toppedUp = observeBalance(toppedUp, { at: T(12), balance: 100 }).store
  toppedUp = observeBalance(toppedUp, { at: T(12) + 60000, balance: 50 }).store
  toppedUp = observeBalance(toppedUp, { at: T(12) + 120000, balance: 200 }).store
  toppedUp = observeBalance(toppedUp, { at: T(13), balance: 190 }).store
  const spending = observedSpendInWindow(activeBook(toppedUp), T(12), T(14))
  near('先消费再充值再消费，档内下降累计仍为 60', spending.spend, 60)
  check('时间窗提供末笔时间供新鲜度校验', spending.lastAt, T(13))
  const corrupt = observedSpendInWindow({ samples: [{ at: T(12), units: '100' }] }, T(12), T(14))
  check('损坏样本不能算成零消费', corrupt.spend, null)
  check('损坏样本标记无效', corrupt.invalid, true)
  const duplicate = observedSpendInWindow({ samples: [
    { at: T(12), units: 100 }, { at: T(12), units: 50 },
  ] }, T(12), T(14))
  check('矛盾的重复时间戳不参与判断', duplicate.invalid, true)
  let badTime = false
  try { observeBalance(emptyBalance(), { at: NaN, balance: 1 }) } catch { badTime = true }
  check('拒绝无效的采样时刻', badTime, true)

  // 窗口终点之后的样本不能污染计算
  let f = emptyBalance()
  f = observeBalance(f, { at: T(12), balance: 100 }).store
  f = observeBalance(f, { at: T(15), balance: 80 }).store   // 15 点，晚于窗口终点
  const future = observedSpendInWindow(activeBook(f), T(13), T(14))
  check('末样本晚于窗口终点 → 不可信', future.anchored, false)

  // 样本裁剪：不该无限增长
  let many = emptyBalance()
  for (let i = 0; i < 4600; i++) {
    many = observeBalance(many, { at: T(0) + i * 60_000, balance: 1000 - i * 0.001 }).store
  }
  const kept = activeBook(many).samples.length
  check('样本数被裁剪到上限内', kept <= 4500, true)
  console.log(`        实际保留 ${kept} 笔`)
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
