/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。 当日账本超过 2000 条后的持久化、重分组、去重和跨日回归。 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// 模块导入前隔离 DSH_HOME；所有读写都只使用本测试创建的目录。
const tempRoot = path.resolve(process.env.DSH_TEST_HOME || os.tmpdir())
await mkdir(tempRoot, { recursive: true })
const testHome = await mkdtemp(path.join(tempRoot, 'dsh-ledger-'))
const priorHome = process.env.DSH_HOME
process.env.DSH_HOME = testHome
let passed = 0
const check = (label, actual, expected) => {
  assert.deepStrictEqual(actual, expected, label)
  passed++
  console.log(`  PASS  ${label}`)
}

try {
  const {
    appendEvent, currentSpend, fromUnits, ledgerPath, mutateLedger, readLedger, rollDay,
  } = await import('../lib/ledger.js')
  const ledgerFile = ledgerPath()
  check('默认账本路径位于隔离目录', path.dirname(ledgerFile), testHome)
  const day = '2026-09-21'
  const start = Date.parse(`${day}T00:00:00+08:00`)
  const nextDay = '2026-09-22'
  const tomorrow = start + 86_400_000
  const groupOf = (provider) => provider === 'provider-a' ? 'alpha' : 'beta'
  const groupedTogether = () => 'merged'
  const events = Array.from({ length: 2500 }, (_, i) => ({
    at: start + i * 1000,
    sessionId: `session-${i % 7}`,
    provider: i % 2 ? 'provider-b' : 'provider-a',
    model: 'test-model',
    group: i % 2 ? 'beta' : 'alpha',
    units: i % 2 ? 20 : 10,
    basis: 'test',
  }))
  const totalUnits = 37_500
  const entry = (event) => ({ ...event, day, cny: fromUnits(event.units) })
  const persisted = async () => JSON.parse(await readFile(ledgerFile, 'utf8'))

  // 一次种入 2500 条，只做少量真实落盘，不通过数千次 append 拖慢测试。
  const seeded = await mutateLedger((cur) => ({
    ...cur, day, spentUnits: totalUnits,
    spentByGroup: { alpha: 12_500, beta: 25_000 }, events,
  }), { now: start })
  check('超过旧上限仍保留全部当日事件', seeded.ledger.events.length, 2500)
  check('落盘包含第一条和最后一条事件', (await persisted()).events, events)
  const firstRead = await readLedger(ledgerFile, start, day, groupOf)
  check('重读保持完整当日累计', firstRead.ledger.spentUnits, totalUnits)
  check('重读保持各 provider 分组累计', { ...firstRead.ledger.spentByGroup }, { alpha: 12_500, beta: 25_000 })

  const added = await appendEvent({
    at: start + 3_000_000, day, sessionId: 'new-session',
    provider: 'provider-a', model: 'test-model', cny: 0.004,
  }, { now: start + 3_000_000, groupOf })
  check('继续追加时不丢失旧消费', added.ledger.spentUnits, totalUnits + 40)
  check('追加后事件仍完整', added.ledger.events.length, 2501)
  check('追加后磁盘累计与返回值一致', (await persisted()).spentUnits, totalUnits + 40)
  const freshRead = await readLedger(ledgerFile, start, day, groupOf)
  check('再次读盘不会降低总额', freshRead.ledger.spentUnits, totalUnits + 40)
  check('再次读盘不会降低组额', { ...freshRead.ledger.spentByGroup }, { alpha: 12_540, beta: 25_000 })
  const spend = await currentSpend(start, day, { groupOf })
  check('刹车点读取完整当日金额', spend.spentCny, 3.754)
  check('刹车点读取完整组金额', spend.spentByGroup, { alpha: 1.254, beta: 2.5 })

  // 旧进程已经记过的最早消息，在重启回填中再次出现也不能重新收费。
  const duplicate = await appendEvent(entry(events[0]), { now: start, groupOf, maxEvents: 1 })
  check('旧事件重放仍只计费一次', duplicate.ledger.spentUnits, totalUnits + 40)
  check('旧 maxEvents 参数不会截断去重依据', duplicate.ledger.events.length, 2501)
  check('旧参数下落盘仍保留全部事件', (await persisted()).events.length, 2501)

  const regrouped = await readLedger(ledgerFile, start, day, groupedTogether)
  check('重新分组覆盖完整当日消费', { ...regrouped.ledger.spentByGroup }, { merged: totalUnits + 40 })
  const regroupedAppend = await appendEvent({
    at: start + 3_001_000, day, sessionId: 'new-session',
    provider: 'provider-b', model: 'test-model', cny: 0.002,
  }, { now: start + 3_001_000, groupOf: groupedTogether })
  check('重分组后追加保持总额', regroupedAppend.ledger.spentUnits, totalUnits + 60)
  check('重分组后追加保持组额', { ...regroupedAppend.ledger.spentByGroup }, { merged: totalUnits + 60 })
  const splitAgain = await readLedger(ledgerFile, start, day, groupOf)
  check('再次拆分仍可还原所有 provider 消费', { ...splitAgain.ledger.spentByGroup }, { alpha: 12_540, beta: 25_020 })

  const beforeRoll = await currentSpend(tomorrow, nextDay, { groupOf })
  check('午夜后读取不带入前一天金额', beforeRoll.spentCny, 0)
  check('午夜后读取不带入前一天事件', beforeRoll.events, [])
  check('午夜后读取不带入前一天组额', beforeRoll.spentByGroup, {})
  const rolled = await rollDay(nextDay, tomorrow)
  check('午夜归零会清空整日事件', rolled.events, [])
  check('午夜归零会清空总额和组额', [rolled.spentUnits, rolled.spentByGroup], [0, {}])
  check('归零结果已落盘', (await persisted()).events, [])
  const newDay = await appendEvent({ ...entry(events[0]), at: tomorrow, day: nextDay }, { now: tomorrow, groupOf })
  check('新一天从新消费开始累加', newDay.ledger.spentUnits, 10)
  check('新一天只保存当天事件', newDay.ledger.events.length, 1)

  // 定时归零未执行时，appendEvent 自身仍负责跨日清空。
  const laterDay = '2026-09-23'
  const implicitRoll = await appendEvent({
    ...entry(events[1]), at: tomorrow + 86_400_000, day: laterDay,
  }, { now: tomorrow + 86_400_000, groupOf })
  check('追加操作独立处理跨日总额', implicitRoll.ledger.spentUnits, 20)
  check('追加操作独立处理跨日组额', { ...implicitRoll.ledger.spentByGroup }, { beta: 20 })
  check('追加操作独立处理跨日事件', implicitRoll.ledger.events.length, 1)
  console.log(`\n===== ${passed} passed, 0 failed =====`)
} finally {
  if (priorHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorHome
  const cleanupPath = path.resolve(testHome)
  if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-ledger-')) {
    throw new Error(`Refusing to remove unexpected test directory: ${cleanupPath}`)
  }
  await rm(cleanupPath, { recursive: true, force: true })
}
