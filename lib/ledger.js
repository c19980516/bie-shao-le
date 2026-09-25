/**
 * 账本模块 —— 全局消费账本，跨会话共享，多进程安全。
 *
 * 本文件定义的 JSON 格式是公开契约：
 *    只增字段，不改语义；破坏性变更走 major 版本。
 *    小鲸鱼挂件等外部消费者可以按此格式读取。
 *
 * 金额一律用**定点整数**（1/10000 元）存储，避免浮点累加误差。
 *
 * 并发安全来自 DSH 自带原语：
 *    withFileLock   —— wx 独占创建 <path>.lock，跨进程互斥
 *    writeFileAtomic —— 临时文件 + rename，读方永远看到完整文件
 * 两个坑：必须在锁**内**重读；崩溃会留孤儿锁（需人工清理）。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** 定点单位：1 元 = 10000 units。 */
export const UNITS_PER_CNY = 10_000

export const toUnits = (cny) => Math.round(Number(cny || 0) * UNITS_PER_CNY)
export const fromUnits = (units) => Number(units || 0) / UNITS_PER_CNY

export const LEDGER_VERSION = 1

/** 账本路径。用 dshHomePath 以尊重 $DSH_HOME，不硬编码 ~/.dsh。 */
export function ledgerPath() {
  return dshHomePath('dsh-cost-budget.json')
}

/** 默认组名。没配置分组时所有 provider 都归到这里。 */
export const DEFAULT_GROUP = 'default'

function emptyLedger(day, now) {
  return {
    version: LEDGER_VERSION,
    currency: 'CNY',
    day,
    spentUnits: 0,
    spentByGroup: {},
    events: [],
    updatedAt: new Date(now).toISOString(),
  }
}

/**
 * 把事件数组补算成"按组累计"。用于读取**旧格式账本**（没有 spentByGroup）
 * 以及外部只拿到 events 的场景。
 * @param events 账本事件数组（每条含 provider / units）
 * @param groupOf (provider) => groupName
 */
export function groupsFromEvents(events, groupOf) {
  // 组名来自配置，constructor / __proto__ 等也必须作为普通键参与计费。
  const out = Object.create(null)
  for (const e of Array.isArray(events) ? events : []) {
    const g = groupOf ? groupOf(e && e.provider) : DEFAULT_GROUP
    out[g] = (out[g] || 0) + (Number(e && e.units) || 0)
  }
  return out
}

/**
 * 按 (sessionId, at) 去重，保留**信息更全**的那条（有 group 字段的优先）。
 *
 * ★ 为什么必须在账本里做，而不能只靠内存里的 seen：
 *   实时订阅和"启动回填"会各记一次同一条 assistant/message。seen 是进程内的，
 *   重启就清空，于是回填可能把上个进程已经记过的消息再记一次。
 *   重复事件可能只有 group 字段不同
 *   （undefined = 实时记的，default = 回填记的）。
 *   去重放在读取路径上，所以对旧账本自动生效，且不依赖重启前的状态。
 */
export function dedupeEvents(events) {
  const byKey = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    if (!e) continue
    const key = `${e.sessionId || ''}|${e.at}`
    const cur = byKey.get(key)
    if (!cur) { byKey.set(key, e); continue }
    if (cur.group === undefined && e.group !== undefined) byKey.set(key, e)
  }
  return [...byKey.values()]
}

/** 读取账本；不存在或损坏时返回空账本（不抛错——账本不可用不该让宿主崩）。 */
export async function readLedger(path = ledgerPath(), now = Date.now(), day, groupOf) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ledger: emptyLedger(day, now), corrupt: true }
    const ledger = { ...emptyLedger(day, now), ...parsed }
    // ★ 读取时先去重：旧账本里实时+回填各记一次的重复事件会在此刻被合并，
    //   然后 spentUnits / spentByGroup 一律由去重后的事件重新派生 ——
    //   这样存量账本能自愈，不必手动跑修复脚本。
    ledger.events = dedupeEvents(ledger.events)
    ledger.spentUnits = ledger.events.reduce((a, e) => a + (Number(e && e.units) || 0), 0)
    ledger.spentByGroup = groupsFromEvents(ledger.events, groupOf)
    return { ledger, corrupt: false }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ledger: emptyLedger(day, now), corrupt: false }
    return { ledger: emptyLedger(day, now), corrupt: true, error: err && err.message }
  }
}

/**
 * 在跨进程锁内做一次读—改—写。
 *
 * ★ fn 拿到的 cur 是**锁内重读**的结果，不是锁外快照 —— 这是正确性的关键。
 * ★ 锁不重入：fn 内部不得再次对同一路径调 withFileLock。
 *
 * @param fn   (cur) => next | Promise<next>
 * @param opts { path?, now?, waitMs? }（旧 maxEvents 参数兼容忽略）
 * @returns    { ledger, wrote }
 */
export async function mutateLedger(fn, opts = {}) {
  const path = opts.path || ledgerPath()
  const now = opts.now ?? Date.now()
  const waitMs = opts.waitMs ?? 30_000 // ★ 默认只有 2000ms，必须显式调大

  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  let wrote = false
  const ledger = await withFileLock(
    path,
    async () => {
      const { ledger: cur } = await readLedger(path, now)
      const next = await fn(cur)
      if (!next) return cur // fn 返回假值 = 不改
      // 当日事件是累计金额、重新分组和跨重启去重的完整依据，不能按条数截断。
      // 即使保留截断前累计值，下次读取也无法辨别重复或还原 provider 分组。
      // 只在 appendEvent / rollDay 跨日时清空，旧 maxEvents 选项不再裁剪事件。
      next.updatedAt = new Date(now).toISOString()
      await writeFileAtomic(path, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
      wrote = true
      return next
    },
    { waitMs },
  )
  return { ledger, wrote }
}

/**
 * 追加一条计费事件，返回新的当日累计值（CNY）。
 *
 * 跨日处理：事件所属的北京日期与账本日期不同时，先归零再记。
 *
 * @param entry { at, day, sessionId, provider, model, cny, tokens, basis }
 * @returns { spentCny, ledger }
 */
export async function appendEvent(entry, opts = {}) {
  const groupOf = opts.groupOf
  const { ledger } = await mutateLedger((cur) => {
    const sameDay = cur.day === entry.day
    const events = sameDay ? dedupeEvents(cur.events) : []

    const g = groupOf ? groupOf(entry.provider) : DEFAULT_GROUP
    const units = toUnits(entry.cny)
    const nextEvents = dedupeEvents([...events, {
      at: entry.at,
      sessionId: entry.sessionId,
      provider: entry.provider,
      model: entry.model,
      group: g,
      units,
      basis: entry.basis,
      tokens: entry.tokens,
    }])

    // ★ spentUnits 与 spentByGroup 都必须由**去重后的事件数组重新派生**：
    //   · 派生而非"cur.spentUnits + units"，才能修掉存量账本里已存在的重复
    //     （实时订阅和启动回填可能各记一次）。
    //   · 也不能依赖"没有 spentByGroup 才补算"的迁移：字段一旦被写成
    //     {default: 0}，早期事件的消费就无法正确补算。
    return {
      ...cur,
      day: entry.day,
      currency: 'CNY',
      spentUnits: nextEvents.reduce((a, e) => a + (Number(e && e.units) || 0), 0),
      spentByGroup: groupsFromEvents(nextEvents, groupOf),
      events: nextEvents,
    }
  }, opts)
  return { spentCny: fromUnits(ledger.spentUnits), spentByGroup: ledger.spentByGroup, ledger }
}

/**
 * 快速读取当日累计（CNY）。供刹车点使用。
 * 跨日自动视为 0，不写盘。
 * @returns { spentCny, spentByGroup, events, day, stale, corrupt }
 */
export async function currentSpend(now = Date.now(), day, opts = {}) {
  const d = day || beijingDayOf(now)
  const { ledger, corrupt } = await readLedger(opts.path || ledgerPath(), now, d, opts.groupOf)
  const sameDay = ledger.day === d
  const byGroup = sameDay && ledger.spentByGroup ? ledger.spentByGroup : {}
  return {
    spentCny: sameDay ? fromUnits(ledger.spentUnits) : 0,
    spentByGroup: Object.fromEntries(Object.entries(byGroup).map(([k, v]) => [k, fromUnits(v)])),
    events: sameDay ? ledger.events : [],
    day: d,
    stale: !sameDay,
    corrupt,
  }
}

/** 本地实现，避免与 pricing.js 循环依赖。 */
function beijingDayOf(epochMs) {
  return new Date(epochMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 跨日归零（在锁内），返回归零后的账本。供定时器在午夜调用。 */
export async function rollDay(day, now = Date.now(), opts = {}) {
  const { ledger } = await mutateLedger((cur) => {
    if (cur.day === day) return null // 已是当天，不改
    return { ...cur, day, spentUnits: 0, spentByGroup: {}, events: [] }
  }, { ...opts, now })
  return ledger
}
