/**
 * 余额观测 —— 读官方余额接口，用"余额下降额"作为**真实消费**的观测值。
 *
 * 余额只覆盖所配置凭证对应的官方计费账户；其他网关或账户可能
 * 独立结算，不能与这个余额混合或互相校准。
 *
 * ★ 和 token 估算的关系：
 *   两者是**互相独立**的两套账。token 估算覆盖全部 provider 但依赖各自上报；
 *   余额观测准但只覆盖官方那条路。
 *
 * 设计取向照抄小鲸鱼挂件（它是这条路上已验证的参考实现）：
 *   · 余额**下降**按观测累计为消费（debit）
 *   · 余额**上升**（充值/赠金）单独记为 credit，**不冲掉已有消费**
 *   · 同一 (scope, currency) 一个账本；重复/乱序样本丢弃
 */
import fs from 'node:fs'
import path from 'node:path'

export const BALANCE_VERSION = 1

/** 金额用定点整数存，避免浮点累积误差。1 CNY = 100000000 units（照挂件的 SCALE）。 */
const SCALE = 100000000

export function moneyUnits(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const units = Math.round(n * SCALE)
  return Number.isSafeInteger(units) ? units : null
}

export function fromUnits(units) {
  return Number(units) / SCALE
}

/**
 * 从 DSH 的 .credentials.yaml 里读一个密钥。
 *
 * ★ 只读进内存，绝不写进配置文件、绝不落日志 —— API key 不属于可配置项。
 *   形如：   NAME: sk-xxxx     或   NAME: "sk-xxxx"
 * @returns 密钥字符串，或 null
 */
export function readCredential(name, home = process.env.USERPROFILE || process.env.HOME || '') {
  if (!name) return null
  try {
    const raw = fs.readFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'utf8')
    const m = raw.match(new RegExp(`^\\s*${name}\\s*:\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm'))
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** 观测账本路径。独立文件 —— 不碰 token 账本，避免把两套账混在一起。 */
export function balancePath(dir) {
  const base = dir || process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  return path.join(base, 'dsh-cost-budget-balance.json')
}

export function emptyBalance() {
  return { version: BALANCE_VERSION, books: {}, active: null }
}

/**
 * 保留的原始样本上限。1 分钟一笔 → 一天约 1440 笔；留几天余量。
 * 全是小对象，内存与文件都无压力。
 */
const MAX_SAMPLES = 4500

/** 取当前 context 的 book（含 samples 序列）。 */
export function activeBook(store) {
  return (store && store.books && store.books[store.active]) || null
}

/**
 * 按**时间窗**算消费：锚点 = 窗口起点之前最近的一笔样本。
 *
 * ★ 为什么需要这个（而不是直接用"当日累计"）：
 *   阶梯的边界是**整点小时**（10:00/12:00/14:00/16:00/24:00），账单也按整点
 *   小时分桶。而"当日累计"只在 00:00 归零 ——
 *   两者在一天里的中间档位上**对不齐**。
 *   例：现在是 14:00–16:00 这一档，起点是 14:00。当日累计把 14:00 之前的
 *   消费也算进来了，这一档的"已用"会虚高，可能提前刹车。
 *   按窗口算就没有这个问题，而且**重启后依然正确**（锚点来自持久化的
 *   样本序列，不是内存里的 firstAt）。
 *
 * @param book   activeBook(store) 的结果
 * @param fromMs 窗口起点（含）
 * @param toMs   窗口终点（默认"现在"）
 * @returns { spend, anchored, anchorAt, current }
 *          anchored=false 表示窗口起点之前没有样本，spend 不可信（为 null）
 */
export function observedSpendInWindow(book, fromMs, toMs = Date.now()) {
  const samples = Array.isArray(book && book.samples) ? book.samples : []
  const unavailable = { spend: null, anchored: false, anchorAt: null, current: null, lastAt: null }
  if (!samples.length) return unavailable
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs ||
      samples.some((s) => !s || !Number.isFinite(s.at) || !Number.isSafeInteger(s.units))) {
    return { ...unavailable, invalid: true }
  }
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  const last = sorted[sorted.length - 1]
  // 最后一个样本不能晚于窗口终点，否则窗口末端没有可信读数
  if (last.at > toMs || sorted.some((s, i) => i && s.at === sorted[i - 1].at)) {
    return { ...unavailable, invalid: true }
  }
  // 窗口起点之前最近的一笔 = 锚点
  let anchor = null
  for (const s of sorted) {
    if (s.at <= fromMs) anchor = s
    else break
  }
  if (!anchor) return { ...unavailable, current: last.units / SCALE, lastAt: last.at }
  // 累加每次下降；充值单独发生，不能抵销此前已经花掉的钱。
  let debitUnits = 0
  let previousUnits = anchor.units
  for (const sample of sorted) {
    if (sample.at <= anchor.at) continue
    debitUnits += Math.max(0, previousUnits - sample.units)
    previousUnits = sample.units
    if (!Number.isSafeInteger(debitUnits)) return { ...unavailable, invalid: true }
  }
  return {
    spend: debitUnits / SCALE,
    anchored: true,
    anchorAt: anchor.at,
    anchorBalance: anchor.units / SCALE,
    current: last.units / SCALE,
    lastAt: last.at,
  }
}

/** 追加一笔原始样本并裁剪长度。 */
function pushSample(samples, at, units) {
  const next = [...(Array.isArray(samples) ? samples : []), { at, units }]
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
}

export function readBalanceStore(file = balancePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || parsed.version !== BALANCE_VERSION) return emptyBalance()
    return { ...emptyBalance(), ...parsed }
  } catch {
    return emptyBalance()
  }
}

export function writeBalanceStore(store, file = balancePath()) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // POSIX 权限设置尽力执行；Windows 上的访问隔离仍由目录 ACL 决定。
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch { /* 某些文件系统不支持，不致命 */ }
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* 同上 */ }
}

/**
 * 记录一次余额观测。**纯函数**：返回新 store，不改传入的对象。
 *
 * @param store 现有观测账本
 * @param snapshot { at, balance, currency?, scope? }
 * @returns { store, summary } —— summary 描述这次观测后的状态
 */
export function observeBalance(store, snapshot) {
  const at = Number(snapshot.at ?? Date.now())
  if (!Number.isFinite(at) || !beijingDayOf(at)) throw new Error('观测时间无效')
  const day = beijingDayOf(at)
  const units = moneyUnits(snapshot.balance)
  if (units === null) throw new Error('余额无效')
  const currency = String(snapshot.currency || 'CNY').toUpperCase()
  const scope = String(snapshot.scope || 'default')
  const context = `${scope}-${currency}`

  const next = {
    ...store,
    version: BALANCE_VERSION,
    books: { ...(store.books || {}) },
    active: context,
  }
  const book = { ...(next.books[context] || { currency, days: {}, lastAt: null, samples: [] }) }
  book.days = { ...(book.days || {}) }

  // ★ 重复或乱序样本（含"迟到"的昨日样本）直接丢弃，且**不落进样本序列**。
  //   顺序很重要：observedSpendInWindow 用"最后一笔"当窗口末端读数，
  //   所以一笔被丢弃的陈旧样本会污染判定值。必须先判丢弃、再 push。
  if (book.lastAt != null && at <= book.lastAt) {
    next.books[context] = book
    return { store: next, summary: balanceSummary(next, day), skipped: true }
  }

  // 原始样本序列：时间窗计算与"重启后锚点仍正确"都依赖它
  book.samples = pushSample(book.samples, at, units)

  let row = book.days[day]
  if (!row) {
    // 当天第一次观测 = 统计起点，不把此前的余额算成今天的消费
    row = {
      day, firstAt: at, lastAt: at,
      openingUnits: units, lastUnits: units,
      debitUnits: 0, creditUnits: 0, samples: 1,
    }
  } else {
    const delta = row.lastUnits - units
    row = { ...row, lastAt: at, lastUnits: units, samples: (row.samples || 0) + 1 }
    if (delta > 0) row.debitUnits += delta            // 余额下降 = 消费
    if (delta < 0) row.creditUnits += -delta          // 余额上升 = 充值/赠金，不冲消费
  }
  book.days[day] = row
  book.lastAt = at
  book.currency = currency
  book.scope = scope
  next.books[context] = book
  return { store: next, summary: balanceSummary(next, day), skipped: false }
}


/**
 * 某一天的观测汇总。
 *
 * ★ 从**原始样本**派生，而不是只读 book.days：
 *   样本是唯一权威数据（tierSpend 也从它算），days 只是同一批数据的聚合视图。
 *   只读 days 会出现"同一天、两条路径给出不同答案"—— 例如账本是从样本序列
 *   重建的（样本在、days 不在），此时判据有值而累计显示 0。
 *   同源就永远不会自相矛盾。
 *
 * 语义：当天**第一笔样本**是统计起点（不把此前余额算成今天的消费），
 *       之后逐笔累加下降额、单独累计上升额（充值不冲消费）。
 */
export function balanceSummary(store, day = beijingDayOf(Date.now())) {
  const book = activeBook(store)
  if (!book) return null
  const samples = (Array.isArray(book.samples) ? [...book.samples] : [])
    .filter((s) => s && beijingDayOf(s.at) === day)
    .sort((a, b) => a.at - b.at)
  if (!samples.length) return null

  let debit = 0, credit = 0
  let prev = samples[0].units
  for (let i = 1; i < samples.length; i++) {
    const delta = prev - samples[i].units
    if (delta > 0) debit += delta
    if (delta < 0) credit += -delta
    prev = samples[i].units
  }
  const first = samples[0]
  const last = samples[samples.length - 1]
  return {
    day,
    currency: book.currency || 'CNY',
    /** 观测到的消费（当天余额下降额累计） */
    observedSpend: fromUnits(debit),
    /** 观测到的充值/赠金 —— 不冲抵消费，仅记录 */
    credits: fromUnits(credit),
    openingBalance: fromUnits(first.units),
    currentBalance: fromUnits(last.units),
    samples: samples.length,
    firstObservedAt: first.at,
    lastObservedAt: last.at,
    /** 当天首次观测之前的部分看不到，所以永远是"部分天" */
    partialDay: true,
  }
}

/** 北京时间日期（YYYY-MM-DD）。 */
export function beijingDayOf(time = Date.now()) {
  const d = new Date(Number(time) + 8 * 3600000)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ''
}

/**
 * 拉一次余额。
 * @returns { balance, currency } 或抛错
 */
export async function fetchBalance(url, key, timeoutMs = 8000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (json?.is_available === false) throw new Error('余额账户不可用')
    // 官方形状： { is_available, balance_infos: [{ currency, total_balance, ... }] }
    const infos = Array.isArray(json && json.balance_infos) ? json.balance_infos : []
    const picked = infos.find((b) => String(b && b.currency).toUpperCase() === 'CNY') || infos[0]
    if (!picked) throw new Error('响应里没有 balance_infos')
    if (typeof picked.currency !== 'string' || !picked.currency.trim()) throw new Error('余额币种缺失')
    if ((typeof picked.total_balance !== 'number' && typeof picked.total_balance !== 'string') ||
        String(picked.total_balance).trim() === '') throw new Error('total_balance 不是数字')
    const balance = Number(picked.total_balance)
    if (!Number.isFinite(balance)) throw new Error('total_balance 不是数字')
    return { balance, currency: picked.currency.trim().toUpperCase() }
  } finally {
    clearTimeout(t)
  }
}
