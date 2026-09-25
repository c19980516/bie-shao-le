/**
 * dsh-cost-budget —— DSH 成本预算插件
 *
 * 按北京时间阶梯累计当日消费金额，触顶时硬停工具调用，到边界自动恢复。
 *
 * 分工：
 *   pricing.js  单价表与峰谷判定
 *   ladder.js   阶梯累积包络与边界计算
 *   ledger.js   全局账本（跨进程锁 + 原子写，格式为公开契约）
 *   本文件      接线：订阅用量、累计金额、刹车、恢复
 *
 * 配置与账本契约见 README.md。
 */

import fs from 'node:fs'
import path from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

import {
  DEFAULT_GROUP, appendEvent, currentSpend, dedupeEvents, fromUnits,
  groupsFromEvents, ledgerPath, rollDay, toUnits,
} from './ledger.js'
import { beijingDay, beijingParts, costOf, isPeak, resolvePrice } from './pricing.js'
import { DEFAULT_LADDER, check, describeBoundary, normalizeLadder, tierStartMs } from './ladder.js'
import { createCalendar, normalizeDay, parseOnlineCalendar } from './calendar.js'
import {
  activeBook, balancePath, balanceSummary, fetchBalance, observeBalance,
  observedSpendInWindow, readBalanceStore, readCredential, writeBalanceStore,
} from './balance.js'

/** 自写的运行日志：与账本同目录，便于排错（ctx.logger 的流向不可控）。 */
const LOG_PATH = path.join(path.dirname(ledgerPath()), 'dsh-cost-budget.log')

function writeLog(level, msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${level} ${msg}\n`, 'utf8')
  } catch (err) {
    // 日志失败绝不能影响宿主
  }
}

export const name = 'dsh-cost-budget'

// cordis 服务访问是**严格注入**的，未声明的服务
// 属性访问会直接抛错（"cannot get property X without inject"）。所以必须列全。
export const inject = ['tools', 'sessionProjections', 'sessions', 'agents', 'goals', 'webServer']

const DEFAULTS = {
  ladder: DEFAULT_LADDER,
  peakHours: [[9, 12], [14, 18]],
  resetHour: 0,
  unknownModelPolicy: 'warn-and-fallback',
  ledgerWaitMs: 30_000,
  dryRun: false,
  /**
   * 自动恢复 goal 前，每组至少需要占各自上限这个百分比的余量。
   * 余量不足保持暂停，到下一档再检查。0 表示只要未触顶即可恢复。
   */
  resumeMinHeadroomPct: 15,
  /**
   * 额度模式：
   *   'total' —— 所有 provider 合并成一个额度（旧行为）
   *   'group' —— 按 providerGroups 分组，每组各有一套阶梯
   * 每个 provider 自己一组就等价于"按 provider"；多个 provider 同组即"按组"。
   */
  quotaMode: 'total',
  /** 组名 → provider 列表。仅 quotaMode='group' 时生效。 */
  providerGroups: {},
  /** 组名 → 上限倍率（默认 1.0）。0.5 表示该组上限只有阶梯的一半。 */
  groupCapScale: {},
  /** 额外/覆盖的法定节假日（YYYY-MM-DD）。会与线上日历和内置表合并。 */
  holidays: [],
  /** 强制视为工作日的日期，用来覆盖线上表的误判。 */
  valleyDays: [],
  /** 线上日历地址。留空 = 不联网。取回后落盘缓存，每天最多拉一次。 */
  calendarUrl: '',
  /**
   * provider → 推定缓存命中率（0–1）。只对**不上报 cacheReadTokens** 的网关生效。
   *
   * 只有独立核实该 provider 存在未上报的缓存命中时才配置；
   * 不同计费账户的账单不能用于互相反推命中率。
   * 留空/0 = 不折算（原始口径）。
   */
  assumedHitRatio: {},
  /**
   * 余额观测。
   *
   * 余额法只覆盖所配置凭证对应的官方计费账户。
   * 其他账户或网关的消费不一定计入此余额，应独立估算；
   * 两种口径不能相加或互相校准，provider 名称本身不决定计费归属。
   *
   * key 从 ~/.dsh/.credentials.yaml 按名读取，**不写进配置文件**。
   */
  balance: {
    enabled: true,
    /** 关掉网络轮询，但保留账本读取与判据使用（测试/离线用） */
    poll: true,
    url: 'https://api.deepseek.com/user/balance',
    keyRef: 'DEEPSEEK_API_KEY',
    pollMs: 60_000,
    scope: 'deepseek',
  },
  /**
   * 刹车判据用哪个口径：
   *   'estimated' —— token 法（按官方价目表估价，**按日累计**）
   *   'observed'  —— 余额法（**档内**实测消费，见 ladder.tierStartMs）
   *
   * ★ 两者不可混用：token 法的 spent 是"当日累计"，余额法的是"档内消费"。
   *   混用会让 cap 的含义在切换瞬间跳变。
   *
   * ★ 余额法在**窗口起点之前没有样本**时不可信（例如当天首次启动就落在中间
   *   档位），此时**回落到 token 法**并在 snapshot 里标出原因 ——
   *   绝不能当成 0，那等于暂时关掉刹车。
   */
  spendSource: 'estimated',
  notify: { browser: false, whale: false },
}

/** 配置归一化。config 可能来自 cordis patch，也可能是 undefined。 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}

  const { ladder, error } = normalizeLadder(raw.ladder)
  if (error) throw new Error(`dsh-cost-budget: ${error}`)
  if (raw.spendSource === 'observed' && raw.quotaMode === 'group') {
    throw new Error('dsh-cost-budget: observed 余额消费无法分摊到 provider 组；请使用 quotaMode: total，或改用 spendSource: estimated')
  }
  const balancePollMs = Math.max(15_000, Number(raw.balance?.pollMs) || 60_000)

  const peakHours = Array.isArray(raw.peakHours) && raw.peakHours.length
    ? raw.peakHours.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => p.every(Number.isFinite))
    : DEFAULTS.peakHours

  return {
    ladder,
    peakHours: peakHours.length ? peakHours : DEFAULTS.peakHours,
    resetHour: Number.isFinite(raw.resetHour) ? Number(raw.resetHour) : DEFAULTS.resetHour,
    unknownModelPolicy: raw.unknownModelPolicy === 'deny' ? 'deny' : 'warn-and-fallback',
    ledgerWaitMs: Number.isFinite(raw.ledgerWaitMs) ? Number(raw.ledgerWaitMs) : DEFAULTS.ledgerWaitMs,
    dryRun: raw.dryRun === true,
    resumeMinHeadroomPct: Number.isFinite(raw.resumeMinHeadroomPct)
      ? Math.max(0, Math.min(100, Number(raw.resumeMinHeadroomPct)))
      : DEFAULTS.resumeMinHeadroomPct,
    quotaMode: raw.quotaMode === 'group' ? 'group' : 'total',
    providerGroups: normalizeProviderGroups(raw.providerGroups),
    groupCapScale: normalizeGroupCapScale(raw.groupCapScale),
    holidays: toDayList(raw.holidays),
    valleyDays: toDayList(raw.valleyDays),
    calendarUrl: typeof raw.calendarUrl === 'string' ? raw.calendarUrl.trim() : '',
    assumedHitRatio: normalizeHitRatios(raw.assumedHitRatio),
    notify: {
      browser: raw.notify?.browser === true,
      whale: raw.notify?.whale ?? false,
    },
    balance: {
      enabled: raw.balance?.enabled !== false,
      poll: raw.balance?.poll !== false,
      url: typeof raw.balance?.url === 'string' && raw.balance.url.trim()
        ? raw.balance.url.trim()
        : 'https://api.deepseek.com/user/balance',
      keyRef: typeof raw.balance?.keyRef === 'string' && raw.balance.keyRef.trim()
        ? raw.balance.keyRef.trim()
        : 'DEEPSEEK_API_KEY',
      pollMs: balancePollMs,
      maxAgeMs: Number.isFinite(raw.balance?.maxAgeMs)
        ? Math.max(15_000, Number(raw.balance.maxAgeMs))
        : Math.max(180_000, balancePollMs * 3),
      scope: typeof raw.balance?.scope === 'string' && raw.balance.scope.trim()
        ? raw.balance.scope.trim()
        : 'deepseek',
    },
    spendSource: raw.spendSource === 'observed' ? 'observed' : 'estimated',
    // ── 调试开关（仅用于验证恢复链路，正常使用请全部留空）──────────────────
    // forceSpentCny:       强制一个"已花金额"，用来立刻触发刹车
    // treatBoundaryAsInMs: 把"距下一边界"强制成 N 毫秒，于是恢复定时器在
    //                      N 毫秒后重判 —— 不必真的等到整点
    // stepClockMs:         恢复定时器每次触发时把判定时钟往前推这么久，
    //                      模拟"时间真的流逝到了下一档"，好在一个重启内看完
    //                      "硬停 → 跨档 → 恢复"整条链路
    // timeOffsetMs:        把判定时钟整体平移（配合上面两个使用）
    debug: {
      timeOffsetMs: Number.isFinite(raw.debug?.timeOffsetMs) ? Number(raw.debug.timeOffsetMs) : 0,
      stepClockMs: Number.isFinite(raw.debug?.stepClockMs) ? Number(raw.debug.stepClockMs) : 0,
      forceSpentCny: Number.isFinite(raw.debug?.forceSpentCny) ? Number(raw.debug.forceSpentCny) : null,
      treatBoundaryAsInMs: Number.isFinite(raw.debug?.treatBoundaryAsInMs) ? Number(raw.debug.treatBoundaryAsInMs) : null,
    },
  }

  /** 日期数组归一化（YYYY-MM-DD），丢弃非法项。 */
  function toDayList(v) {
    const arr = Array.isArray(v) ? v : (v ? [v] : [])
    return arr.map(normalizeDay).filter(Boolean)
  }

  /** 分钟数 → "HH:MM"。 */

  /** providerGroups 归一化：只收非空字符串数组，组名去空白。 */
  function normalizeProviderGroups(raw) {
    const out = Object.create(null)
    if (!raw || typeof raw !== 'object') return out
    for (const [group, providers] of Object.entries(raw)) {
      const name = String(group || '').trim()
      if (!name) continue
      const list = (Array.isArray(providers) ? providers : [providers])
        .map((p) => String(p || '').trim())
        .filter(Boolean)
      if (list.length) out[name] = list
    }
    return out
  }

  /** groupCapScale 归一化：只收正有限数，非法值忽略（回落默认 1.0）。 */
  function normalizeGroupCapScale(raw) {
    const out = Object.create(null)
    if (!raw || typeof raw !== 'object') return out
    for (const [group, scale] of Object.entries(raw)) {
      const name = String(group || '').trim()
      const n = Number(scale)
      if (name && Number.isFinite(n) && n > 0) out[name] = n
    }
    return out
  }
}

/** 分钟数 → "HH:MM"。模块级：normalizeConfig 与界面回显都要用。 */
function minutesToHHMM(min) {
  const m = Math.max(0, Math.min(1440, Math.round(Number(min) || 0)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * assumedHitRatio 归一化：provider → 命中率(0–1)。
 * 只收 0 < r <= 1 的项，其余丢弃（0 等于不折算，无意义）。
 */
function normalizeHitRatios(raw) {
  const out = Object.create(null)
  if (!raw || typeof raw !== 'object') return out
  for (const [provider, r] of Object.entries(raw)) {
    const name = String(provider || '').trim()
    const n = Number(r)
    if (name && Number.isFinite(n) && n > 0 && n <= 1) out[name] = n
  }
  return out
}

export function apply(ctx, config) {
  const baseConfig = (config && typeof config === 'object') ? config : {}
  let cfg = normalizeConfig(baseConfig)
  const log = (msg) => {
    writeLog('INFO', msg)
    try { ctx.logger?.info?.(`[cost-budget] ${msg}`) } catch (err) { /* 日志失败不影响主流程 */ }
  }
  const warn = (msg) => {
    writeLog('WARN', msg)
    try { ctx.logger?.warn?.(`[cost-budget] ${msg}`) } catch (err) { /* 同上 */ }
  }

  /** 内存中的当日累计（CNY）。刹车点读它，避免每次工具调用都碰磁盘。 */
  let memory = {
    spentCny: 0,
    spentByGroup: {},
    events: [],
    day: beijingDay(Date.now()), // 此处故意用真实时钟：debug 偏移只影响判定
  }

  // 配置保存、记账、对账共用队列，防止较早开始的异步读写覆盖新分组。
  let pendingUpdate = Promise.resolve()
  const unpersistedEvents = new Map()
  function enqueueUpdate(update) {
    const result = pendingUpdate.then(update)
    pendingUpdate = result.catch(() => {})
    return result
  }

  // ── 可视化配置：可写的运行时覆盖层 ────────────────────────────────────────
  // cordis.patch.yml 里的配置要重启才生效，所以在 $DSH_HOME 另存一份 JSON
  // 覆盖层：界面保存 → 写文件 → 热重载判定逻辑，**不需要重启**。
  // 覆盖层只覆盖它显式写出的键，其余仍用 patch 里的值。
  const CONFIG_PATH = path.join(path.dirname(ledgerPath()), 'dsh-cost-budget-config.json')
  /**
   * 界面可改、且写进覆盖层的键白名单 —— 避免界面误写 debug 之类。
   *
   * ★ peakHours / holidays / valleyDays / calendarUrl **故意不在**这里：
   *   它们映射的是**官方计费规则**，属于事实而非偏好。界面上只读展示。
   *   留在白名单里的话，任何手搓的 PUT 都能把覆盖层写成与官方不一致的
   *   价格假设，而账本会照那个假设记账 —— 这种"数字看着对、其实按错的
   *   规则算"的问题最难发现，所以干脆不开这个口子。
   *   要调整就改 src 里的常量或 calendar 适配。
   */
  const MUTABLE_KEYS = new Set([
    'ladder', 'quotaMode', 'providerGroups', 'groupCapScale',
    'dryRun', 'resumeMinHeadroomPct',
  ])

  function readConfigFile() {
    try {
      const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      return (j && typeof j === 'object') ? j : {}
    } catch (err) {
      if (err && err.code !== 'ENOENT') warn(`配置文件读取失败: ${err.message}`)
      return {}
    }
  }

  function writeConfigFile(obj) {
    return writeFileAtomic(CONFIG_PATH, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  }

  /** 只把白名单内的键合进基础配置。 */
  function mergeConfig(base, override) {
    const merged = { ...base }
    for (const k of Object.keys(override || {})) {
      if (MUTABLE_KEYS.has(k)) merged[k] = override[k]
    }
    return merged
  }

  /** 供界面回显用的原始覆盖层值。 */
  function rawForUi() {
    const o = readConfigFile()
    const out = {}
    for (const k of MUTABLE_KEYS) if (k in o) out[k] = o[k]
    return out
  }

  /**
   * 从内存账本按 provider 汇总。金额用账本里每条**当次计价**的 units，
   * 而不是拿 token 总去重算（峰谷价不同，重算会失真）。
   * 只在读 state.json / config.json 时调用，所以按需算、不驻留。
   *
   * ⚠️ 必须在**模块作用域**：effectiveForUi（面板的 config.json）和
   *    snapshot（state.json）都要用。曾经把它写在 snapshot 内部，
   *    结果 effectiveForUi 调 availableProviders() 直接
   *    "availableProviders is not defined"，面板加载整条断掉。
   */
  function providersFromLedger() {
    const out = Object.create(null)
    for (const e of memory.events || []) {
      const p = (e && e.provider) || '(none)'
      const b = out[p] || (out[p] = { requestCount: 0, cny: 0, miss: 0, hit: 0, out: 0 })
      b.requestCount++
      b.cny += (Number(e.units) || 0) / 10000
      const t = (e && e.tokens) || {}
      b.miss += Number(t.miss) || 0
      b.hit += Number(t.hit) || 0
      b.out += Number(t.out) || 0
    }
    // 统一四舍五入，避免把浮点噪声透给界面
    return Object.entries(out)
      .map(([provider, b]) => ({
        provider,
        requestCount: b.requestCount,
        cny: Math.round(b.cny * 1e4) / 1e4,
        tokens: { miss: b.miss, hit: b.hit, out: b.out },
      }))
      .sort((a, b) => b.cny - a.cny)
  }

  /**
   * 界面上可选的 provider 名单。
   *
   * ★ 为什么必须由服务端给：provider 名是**字符串字面量**，界面上手打
   *   拼错不会有任何报错 —— 只是那个组永远匹配不到请求、消费恒为 0。
   *   例如 provider 名称输入错误时，
   *   该组显示零消费，而实际 provider 被当成“未配置”自成一组。
   *   给成勾选项就从根上杜绝这类静默失效。
   *
   * 来源 = 账本里**真实出现过**的 ∪ 配置里**已经写了的**（后者保证
   * 拼错的历史配置也能在界面上看到并改掉，而不是悄悄丢掉）。
   */
  function availableProviders() {
    const set = new Set()
    for (const p of providersFromLedger()) if (p.provider) set.add(p.provider)
    for (const list of Object.values(cfg.providerGroups || {})) {
      for (const p of list || []) if (p) set.add(p)
    }
    return [...set].sort()
  }

  /** 界面上可以改的键 + 当前生效值。 */
  function effectiveForUi() {
    return {
      ladder: cfg.ladder.map((r) => ({ until: minutesToHHMM(r.untilMin), cap: r.cap })),
      quotaMode: cfg.quotaMode,
      providerGroups: cfg.providerGroups,
      groupCapScale: cfg.groupCapScale,
      peakHours: cfg.peakHours,
      holidays: cfg.holidays,
      valleyDays: cfg.valleyDays,
      calendarUrl: cfg.calendarUrl,
      spendSource: cfg.spendSource,
      dryRun: cfg.dryRun,
      resumeMinHeadroomPct: cfg.resumeMinHeadroomPct,
      /** 下拉选项用：账本里真实出现过的 provider + 已配置的 */
      availableProviders: availableProviders(),
      /** 当前处于峰价还是谷价，以及原因（界面只展示这一条） */
      peakNow: peakNowInfo(),
    }
  }

  /**
   * 现在这一刻按峰价还是谷价，以及判定依据。
   *
   * ★ 界面只需要这一条，不需要完整峰时表 + 节假日清单：
   *   峰谷直接决定消费速度，是当下有用的信息；那张表是静态规则，铺出来只是噪声。
   */
  function peakNowInfo() {
    const at = now()
    const { weekday, hour } = beijingParts(at)
    const day = beijingDay(at)
    const isRest = calendar.isRestDay(day, weekday)
    // 调休：在 workdays 覆盖里被标成工作日（日历把它从休息日里排除了）
    const isHoliday = calendar.isHoliday(day)
    const isMakeup = !isRest && (weekday === 0 || weekday === 6)
    const peak = isPeak(at, cfg.peakHours, calendar)

    let reason
    if (isMakeup) reason = '调休工作日'
    else if (isHoliday) reason = '法定节假日'
    else if (isRest) reason = '周末'
    else reason = peak ? '工作日上午/下午峰时' : '工作日的平峰间隔'

    // 下一个状态切换点：峰时给结束点，谷时给下一个峰时起点
    let nextAt = null
    if (!isRest && !isMakeup) {
      if (peak) {
        const seg = cfg.peakHours.find(([f, t]) => hour >= f && hour < t)
        if (seg) nextAt = seg[1] + ':00 转谷价'
      } else {
        const seg = cfg.peakHours.find(([f]) => f > hour)
        nextAt = seg ? seg[0] + ':00 转峰价' : '今日峰时已结束'
      }
    }
    return { peak, hour, day, reason, nextAt, rest: isRest, makeup: isMakeup }
  }

  // 启动即应用覆盖层：这样 patch 里的值只是"基线"，界面改过的值优先。
  const initialOverride = readConfigFile()
  cfg = normalizeConfig(mergeConfig(baseConfig, initialOverride))
  /** 已计入的事件键，防止回填与实时订阅重复计数。 */
  const seen = new Set()
  /** 触顶状态，用于避免重复通知。 */
  let exhausted = false
  /** 恢复定时器句柄。 */
  let resumeTimer = null
  /** 只恢复本插件暂停且此后未被修改的 goal；ref 使用 pause 后的 revision。 */
  const pausedGoals = new Map()
  /** 卸载后不再安排恢复或操作 goal，包括已经排队/正在读盘的回调。 */
  let disposed = false

  /**
   * 统一的"现在"。debug.timeOffsetMs / stepClockMs 只用于验证：把时钟平移
   * 或按步推进，好在几十秒内观察"硬停 → 跨档 → 恢复"，而不必真等到整点。
   * 计价仍用事件自身的真实时间（event.time），不受此影响。
   */
  let clockStepMs = 0
  const now = () => Date.now() + cfg.debug.timeOffsetMs + clockStepMs

  /** 刹车判定用的累计值：debug.forceSpentCny 可强制一个超限值。 */
  /**
   * 判据用的"已花金额"。
   *
   *   estimated（默认）：token 法 —— memory.spentCny 是**当日累计**。
   *   observed：余额法 —— **本档内**的实测消费（阶梯边界在整点小时，
   *             见 ladder.tierStartMs 的说明）。
   *
   * ★ 余额法拿不到可信值时**回落到 token 法**，并把原因记在
   *   spendSource.fallback 里供界面显示。绝不把缺失的观测值当作 0。
   */
  function observedWindow(at = now()) {
    const startAt = tierStartMs(cfg.ladder, at, cfg.debug.treatBoundaryAsInMs)
    const metadata = { startAt, endAt: at, maxAgeMs: cfg.balance.maxAgeMs, lastObservedAt: null }
    const unavailable = (fallback) => ({ ...metadata, spend: null, fallback })
    if (!cfg.balance.enabled) return unavailable('disabled')
    const book = activeBook(balanceStore)
    if (!book) return unavailable('no-samples')
    if (balanceStore.active !== `${cfg.balance.scope}-CNY` || book.currency !== 'CNY' ||
        (book.scope !== undefined && book.scope !== cfg.balance.scope)) {
      return unavailable('context-mismatch')
    }
    const w = observedSpendInWindow(book, startAt, at)
    metadata.lastObservedAt = w.lastAt
    if (w.invalid) return unavailable('invalid-samples')
    if (w.lastAt === null) return unavailable('no-samples')
    if (at - w.lastAt > cfg.balance.maxAgeMs) return unavailable('stale-samples')
    if (!w.anchored || w.spend === null) return unavailable('no-anchor')
    if (startAt - w.anchorAt > cfg.balance.maxAgeMs) return unavailable('stale-anchor')
    return { ...metadata, spend: w.spend, fallback: null }
  }

  function spendSourceNow(at = now()) {
    const requested = cfg.spendSource
    const dayStart = Date.parse(`${beijingDay(at)}T00:00:00+08:00`)
    const base = { requested, effective: 'estimated', fallback: null, window: 'day',
      startAt: dayStart, endAt: at, lastObservedAt: null, maxAgeMs: cfg.balance.maxAgeMs }
    const forced = cfg.debug.forceSpentCny
    if (forced !== null && forced !== undefined) return { ...base, effective: 'debug', window: 'debug', spent: forced }
    if (requested !== 'observed') return { ...base, spent: memory.spentCny }
    const observed = observedWindow(at)
    if (observed.fallback) return { ...base, fallback: observed.fallback,
      lastObservedAt: observed.lastObservedAt, spent: memory.spentCny }
    const { spend, ...window } = observed
    return { ...base, ...window, effective: 'observed', window: 'tier', spent: spend }
  }

  function spentForVerdict() { return spendSourceNow().spent }

  /**
   * 热重载配置：重新归一化 → 重建日历 → 重排恢复定时器 → 重新判定。
   * 界面上保存配置后走这里，**不需要重启**。
   * 校验失败会抛错，调用方负责把错误回给界面（旧配置保持不变）。
   */
  function reloadConfig(nextOverride) {
    return enqueueUpdate(async () => {
      const next = normalizeConfig(mergeConfig(baseConfig, nextOverride))
      const at = Date.now()
      const day = beijingDay(at)
      // 先用候选配置重算，读取或保存失败时仍保留旧配置与旧内存。
      const fresh = await readSpend(at, day, next)
      if (fresh.corrupt) throw new Error('账本读取失败，配置未保存，请检查账本后重试')
      await writeConfigFile(nextOverride)
      cfg = next
      setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
      rebuildCalendar()
      // 配置与分组同一次更新后，才能重新判定和返回界面状态。
      await reevaluate('config-reload')
      return {
        quotaMode: cfg.quotaMode,
        ladder: cfg.ladder.map((r) => `${minutesToHHMM(r.untilMin)}=¥${r.cap}`),
        providerGroups: cfg.providerGroups,
        groupCapScale: cfg.groupCapScale,
        state: snapshot(),
      }
    })
  }

  // ── 按组额度 ──────────────────────────────────────────────────────────────
  // quotaMode:
  //   'total' —— 所有 provider 合并成一个额度（旧行为，group 恒为 'default'）
  //   'group' —— 按 providerGroups 分组，**每组各有一套阶梯、各算各的**
  //              （每个 provider 自己一组，就等价于"按 provider"）
  // groupCapScale 直接乘在该组当前档上限上，默认 1.0。
  // 例如基准额度 ¥40、倍率 0.5 时，该组最多可用 ¥20；消费金额保持原值。
  function normalizeProviderName(p) {
    return String(p || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  function groupOf(provider, config = cfg) {
    if (config.quotaMode !== 'group') return DEFAULT_GROUP
    const name = normalizeProviderName(provider)
    for (const [group, providers] of Object.entries(config.providerGroups)) {
      if (providers.some((x) => normalizeProviderName(x) === name)) return group
    }
    return name || DEFAULT_GROUP // 未配置的 provider 自成一组
  }

  function scaleOf(group) {
    const s = Number(cfg.groupCapScale?.[group])
    return Number.isFinite(s) && s > 0 ? s : 1
  }

  /**
   * 唯一的 memory 写入点 —— 保证 spentCny 与 spentByGroup 不会走散。
   * @param total 当日总额（CNY）
   * @param byGroup 组名 → CNY；传 null 用于跨日清空
   * @param events 当日事件；供 provider 列表和未落盘消费重分组使用
   */
  function setMemory(day, total, byGroup, events = []) {
    const totalCny = Number(total) || 0
    const groups = Object.create(null)
    if (byGroup && typeof byGroup === 'object') {
      for (const [k, v] of Object.entries(byGroup)) groups[k] = Number(v) || 0
    }
    memory = { day, spentCny: totalCny, spentByGroup: groups, events }
  }

  /**
   * 读账本的统一入口 —— **必须带上 groupOf**。
   *
   * ★ 这是踩过的坑：`currentSpend(now, day)` 不传 opts.groupOf 时，
   *   ledger.js 会把**所有事件都归到 default**，于是启动时
   *   memory.spentByGroup = {default: 全部}，分组从一开始就是错的；
   *   而 mergeGroups 取最大值，那个错误的 default 键再也清不掉
   *   （表现为各组之和 ≠ 当日总额，同一笔钱既算进 default 又算进各组）。
   *   三个调用点以前全漏了这个参数，统一收口到这里就不会再漏。
   */
  function spendFromEvents(events, config = cfg) {
    const unique = dedupeEvents(events)
    return {
      events: unique,
      spentCny: fromUnits(unique.reduce((sum, event) => sum + (Number(event.units) || 0), 0)),
      spentByGroup: Object.fromEntries(Object.entries(
        groupsFromEvents(unique, (provider) => groupOf(provider, config)),
      ).map(([group, units]) => [group, fromUnits(units)])),
    }
  }

  function includeUnpersisted(fresh, day, config = cfg) {
    const keyOf = (event) => `${event.sessionId || ''}|${event.at}`
    for (const event of fresh.events || []) unpersistedEvents.delete(keyOf(event))
    const pending = [...unpersistedEvents.values()].filter((event) => event.day === day)
    if (!pending.length) return fresh
    return { ...fresh, ...spendFromEvents([...(fresh.events || []), ...pending], config) }
  }

  async function readSpend(at, day, config = cfg) {
    const fresh = await currentSpend(at, day, { groupOf: (provider) => groupOf(provider, config) })
    // 写盘失败的已发生消费不能被后续对账/改组抹掉；发现已落盘同一事件才去掉内存补记。
    return includeUnpersisted(fresh, day, config)
  }

  /**
   * 参与判定的组。
   *
   * total 模式只有 default；group 模式 = "配置声明的组 ∪ 确实持有金额的组"。
   * 没有 provider、也没有消费的 default 不占一行；明确配置的 default 仍保留。
   *
   * ★ 最后一类为什么必须算进来：不变式是「各组之和 = 当日总额」。
   *   spentOfGroup 只从 memory.spentByGroup 取值，若某个键有钱却不在
   *   参与判定的组里，那笔钱就既没被任何上限约束、又从各组之和里消失了 ——
   *   总额看着没变，分组明细却对不上。带上它，明细才始终闭合。
   *
   * ★ 但**不是**把 memory.spentByGroup 的键无脑并进来：账本事件的 `group`
   *   字段是**写入当时**按当时配置记下的，改分组后旧组名即历史。
   *   区别在于：spentByGroup 是 groupsFromEvents 用**当前** groupOf
   *   对事件重算的结果 —— 它的键就是"当前配置下真实有归属的组"，
   *   所以可以安全采信；而事件里那个陈旧的 group 字符串才是要忽略的。
   */
  function activeGroups() {
    if (cfg.quotaMode !== 'group') return [DEFAULT_GROUP]
    const names = new Set(Object.keys(cfg.providerGroups))
    for (const [g, v] of Object.entries(memory.spentByGroup || {})) {
      if (Number(v)) names.add(g)
    }
    // 没有任何组时仍允许调试开关验证拦截，不影响正常空账本的显示。
    if (!names.size && cfg.debug.forceSpentCny !== null) names.add(DEFAULT_GROUP)
    return [...names]
  }

  /**
   * 单组的已花金额。
   * ⚠️ debug.forceSpentCny 必须对所有组生效 —— 否则在 group 模式下调这个开关
   * 完全没用（没有任何组叫 default，强制值落不到任何一组上），
   * 调试"触顶硬停"就没法验证了。
   */
  function spentOfGroup(group) {
    const forced = cfg.debug.forceSpentCny
    if (forced !== null && forced !== undefined) return forced
    return Number((memory.spentByGroup || {})[group] || 0)
  }

  /**
   * 统一的档位判定入口 —— 所有地方都必须走它，保证 debug 覆盖一致生效。
   * 返回增加 groups[] 与 blockedBy；**allowed 是所有组都未超**（任一超即硬停）。
   */
  function verdictNow() {
    const at = now()
    const base = check(cfg.ladder, 0, at, cfg.debug.treatBoundaryAsInMs)
    const source = spendSourceNow(at)
    const groups = activeGroups().map((group) => {
      const scale = scaleOf(group)
      const spent = cfg.quotaMode === 'total' ? source.spent : spentOfGroup(group)
      const cap = base.cap * scale
      return {
        group,
        spent,
        rawSpent: spent,
        scale,
        allowed: !atLeastAmount(spent, cap),
        cap,
      }
    })

    const blocked = groups.filter((g) => !g.allowed)
    const allowed = blocked.length === 0
    // 按实际消费占该组额度的比例选最吃紧的一组。
    const worst = (blocked.length ? blocked : groups).reduce(
      (a, b) => (b.spent / (b.cap || 1) > a.spent / (a.cap || 1) ? b : a),
      groups[0],
    )

    return {
      ...base,
      source,
      allowed,
      spent: worst ? worst.spent : 0,
      cap: cfg.quotaMode === 'group' ? base.cap : (groups[0]?.cap ?? base.cap),
      groups,
      blockedBy: blocked.map((g) => g.group),
    }
  }

  /** 只消除浮点运算误差；容差远小于正常金额下 0.0001 元的计费精度。 */
  function atLeastAmount(amount, threshold) {
    const epsilon = Number.EPSILON * 8 * Math.max(1, Math.abs(amount), Math.abs(threshold))
    return amount + epsilon >= threshold
  }

  // ── 节假日日历 ────────────────────────────────────────────────────────────
  // 决定"这天是不是休息日"（休息日全天谷价）。三种来源合并：
  //   内置表 → 配置的 holidays → 线上日历缓存
  // 配置的 valleyDays 用来覆盖线上表的误判（强制算工作日）。
  let holidayCache = []          // 线上日历取回的日期
  let calendar = buildCalendar()
  let calendarStats = calendar.stats()

  function buildCalendar() {
    return createCalendar({
      extraHolidays: [...cfg.holidays, ...holidayCache],
      workdays: cfg.valleyDays,
    })
  }

  function rebuildCalendar() {
    calendar = buildCalendar()
    calendarStats = calendar.stats()
  }

  const CALENDAR_CACHE = path.join(path.dirname(ledgerPath()), 'dsh-cost-budget-holidays.json')

  /** 读线上日历的落盘缓存（同步，启动时用；失败就当没有）。 */
  function loadCalendarCache() {
    try {
      const j = JSON.parse(fs.readFileSync(CALENDAR_CACHE, 'utf8'))
      if (j && Array.isArray(j.days)) {
        holidayCache = j.days.map(normalizeDay).filter(Boolean)
        rebuildCalendar()
        log(`节假日缓存已载入：${holidayCache.length} 天（${CALENDAR_CACHE}）`)
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') warn(`节假日缓存读取失败: ${err.message}`)
    }
  }

  /**
   * 拉线上日历。只在配了 calendarUrl 时做；成功就落盘缓存。
   * 失败**不影响**已有日历（内置表仍然兜着），只告警。
   */
  async function fetchCalendar() {
    if (!cfg.calendarUrl) return
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(cfg.calendarUrl, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { days } = parseOnlineCalendar(await res.json())
      if (!days.length) throw new Error('解析后没有任何日期')
      holidayCache = days
      rebuildCalendar()
      await fs.promises.writeFile(
        CALENDAR_CACHE,
        JSON.stringify({ at: Date.now(), url: cfg.calendarUrl, days }, null, 2) + '\n',
        { mode: 0o600 },
      )
      log(`线上日历已更新：${days.length} 天（${cfg.calendarUrl}）`)
    } catch (err) {
      warn(`线上日历拉取失败，沿用现有日历: ${err && err.message}`)
    }
  }

  // ── 余额观测 ──────────────────────────────────────────────────────────────
  /**
   * 读一次官方余额，把"余额下降额"累计为当日真实消费。
   *
   * 余额变化只代表当前凭证对应账户的消费。其他网关或账户的
   * token 估价不属于同一计费来源，不能与此余额混合。
   */
  let balanceStore = readBalanceStore()
  let lastBalanceError = null
  let balancePollPending = false

  async function pollBalance() {
    if (disposed || balancePollPending || !cfg.balance?.enabled || !cfg.balance?.poll) return
    balancePollPending = true
    const pollingConfig = cfg.balance
    try {
      const key = readCredential(pollingConfig.keyRef)
      if (!key) {
        throw new Error('MISSING_CREDENTIAL')
      }
      const { balance, currency } = await fetchBalance(pollingConfig.url, key)
      const sampledAt = Date.now()
      await enqueueUpdate(async () => {
        if (disposed || cfg.balance !== pollingConfig) return
        const { store } = observeBalance(balanceStore, {
          at: sampledAt, balance, currency, scope: pollingConfig.scope,
        })
        balanceStore = store
        lastBalanceError = null
        try { writeBalanceStore(balanceStore) } catch { lastBalanceError = 'PERSISTENCE_ERROR' }
        // 已取得的消费即使落盘失败也先参与刹车，不能只更新界面。
        await reevaluate('balance-poll')
      })
    } catch (err) {
      await enqueueUpdate(async () => {
        if (disposed || cfg.balance !== pollingConfig) return
        // 不回显响应正文或网络错误原文；旧样本只在有效期内继续使用。
        lastBalanceError = err?.message === 'MISSING_CREDENTIAL' ? 'MISSING_CREDENTIAL' : 'BALANCE_POLL_FAILED'
        await reevaluate('balance-poll-error')
      })
    } finally {
      balancePollPending = false
    }
  }

  // ── 计价一条 usage ────────────────────────────────────────────────────────
  /** 该 provider 的推定缓存命中率（未配置 = 0 = 不折算）。 */
  function providerHitRatio(provider) {
    if (!provider) return 0
    const direct = cfg.assumedHitRatio[provider]
    if (direct !== undefined) return direct
    // 也认归一化后的名字，避免 provider 大小写/符号差异导致漏配
    return cfg.assumedHitRatio[normalizeProviderName(provider)] ?? 0
  }

  function priceUsage(usage, model, at, provider) {
    const { price, matched } = resolvePrice(model)
    const peak = isPeak(at, cfg.peakHours, calendar)
    // 只对"不上报缓存命中"的网关折算，见 costOf 的说明
    const ratio = providerHitRatio(provider)
    const { cny, tokens } = costOf(usage, price, peak, ratio)
    const basis = `${matched || 'UNKNOWN'}/${peak ? 'peak' : 'valley'}` +
      (usage.cacheReadTokens ? `/hit${usage.cacheReadTokens}` : '') +
      (tokens.assumedHit ? `/assumed${Math.round(ratio * 100)}%` : '')
    return { cny, tokens, basis, matched }
  }

  // ── 记一笔（写账本 + 更新内存）────────────────────────────────────────────
  function record(entry) {
    return enqueueUpdate(() => recordUsage(entry))
  }

  async function recordUsage({ seq, sessionId, provider, model, usage, at }) {
    const key = `${sessionId}:${seq}`
    if (seen.has(key)) return null
    seen.add(key)

    const day = beijingDay(at)
    const { cny, tokens, basis, matched } = priceUsage(usage, model, at, provider)

    if (!matched) {
      if (cfg.unknownModelPolicy === 'deny') {
        warn(`未知模型 ${provider}/${model}，按 deny 策略拒绝计量`)
        return null
      }
      warn(`未知模型 ${provider}/${model}，按 flash 价兜底（¥${cny.toFixed(6)}）`)
    }

    try {
      const { spentCny, spentByGroup, ledger } = await appendEvent(
        { at, day, sessionId, provider, model, cny, tokens, basis },
        { waitMs: cfg.ledgerWaitMs, groupOf },
      )
      const fresh = includeUnpersisted({
        spentCny,
        spentByGroup: Object.fromEntries(
          Object.entries(spentByGroup || {}).map(([k, v]) => [k, Number(v) / 10_000]),
        ),
        events: ledger.events,
      }, day)
      setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
      await reevaluate('usage')
    } catch (err) {
      // 账本写失败不能让宿主崩；但必须显式告警，不能静默
      warn(`账本写入失败，本次仅计入内存: ${err && err.message}`)
      const entry = { day, at, sessionId, provider, model, units: toUnits(cny), tokens, basis }
      unpersistedEvents.set(`${sessionId || ''}|${at}`, entry)
      const fresh = spendFromEvents([...(memory.day === day ? memory.events : []), entry])
      setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
      await reevaluate('usage-memory')
    }
    return cny
  }

  // ── 重新判定是否触顶（状态翻转时通知 + 暂停 goal）──────────────────────────
  async function reevaluate(reason) {
    if (disposed) return
    const at = now()
    const day = beijingDay(at)
    if (memory.day !== day) {
      setMemory(day, 0, null)
      seen.clear()
    }

    const verdict = verdictNow()
    if (cfg.dryRun) {
      exhausted = false
      cancelResume()
      log(`DRY-RUN ¥${verdict.source.spent.toFixed(4)} / ¥${verdict.cap}（${reason}，预算${verdict.allowed ? '未超限' : '已超限'}，仅观察）`)
      return
    }
    if (reason === 'config-reload') cancelResume()
    // 分组模式下说清是哪一组顶的，否则只报总额会让人困惑
    const who = verdict.blockedBy && verdict.blockedBy.length
      ? `，触顶组：${verdict.blockedBy.join('、')}`
      : ''

    const wasExhausted = exhausted
    exhausted = !verdict.allowed
    if (exhausted) {
      const boundary = describeBoundary(verdict.tier)
      if (!wasExhausted) {
        const amounts = verdict.groups.filter((g) => !g.allowed)
          .map((g) => `${g.group} ¥${g.spent.toFixed(2)} / ¥${g.cap}`).join('；')
        warn(`预算用尽：${amounts}（${reason}）${who}，将于 ${boundary} 重新检查`)
        notifyExhausted(spentForVerdict(), verdict.cap, boundary)
      }
      await pauseGoals(boundary)
      if (!resumeTimer) scheduleResume(verdict.tier.remainingMs)
    } else {
      if (wasExhausted) log(`预算已恢复：¥${verdict.source.spent.toFixed(2)} / ¥${verdict.cap}`)
      await maybeResumeGoals(verdict)
    }
  }

  function cancelResume() {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = null
  }

  /** 遍历存活的 Agent。goals.pause 要求使用注册表里的同一实例。 */
  function liveAgents(strict = false) {
    try {
      return ctx.agents?.list?.() || []
    } catch (err) {
      warn(`枚举 agent 失败: ${err && err.message}`)
      if (strict) throw err
      return []
    }
  }

  // ── 暂停 goal（保留状态，等边界恢复）──────────────────────────────────────
  async function pauseGoals(boundary) {
    if (disposed || cfg.dryRun) return
    for (const agent of liveAgents()) {
      try {
        const view = ctx.goals.get(agent)
        // 未激活的旧 goal 本来不会自动跑，不能借预算恢复给它新增续跑权限。
        if (!view || view.phase !== 'active' || view.activation === 'disarmed') continue
        const paused = ctx.goals.pause(agent, { id: view.id, revision: view.revision })
          || ctx.goals.get(agent)
        if (paused?.phase === 'paused' && paused.id === view.id) {
          pausedGoals.set(agent, { id: paused.id, revision: paused.revision })
        }
        log(`已暂停 goal ${view.id}（等待 ${boundary}）`)
      } catch (err) {
        warn(`暂停 goal 失败（agent ${agent && agent.id}）: ${err && err.message}`)
      }
    }
  }

  // ── 到边界自动恢复 ────────────────────────────────────────────────────────
  function scheduleResume(delayMs, retry = false) {
    if (disposed || cfg.dryRun) return
    cancelResume()
    const delay = Math.max(1000, Math.min(delayMs, 6 * 3600 * 1000))
    log(`已安排恢复定时器：${Math.round(delay / 1000)} 秒后重新判定`)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      void enqueueUpdate(async () => {
        if (disposed || cfg.dryRun) return
        try {
          // 调试：让判定时钟真的往前跨一步，模拟时间流逝到下一个档位
          if (!retry && cfg.debug.stepClockMs) clockStepMs += cfg.debug.stepClockMs
          const at = now()
          const day = beijingDay(at)
          if (memory.day !== day) {
            await rollDay(day, at, { waitMs: cfg.ledgerWaitMs })
            seen.clear()
          }
          // 跨日也重读：其他进程可能已切到今天并产生消费，不能假定为零。
          const fresh = await readSpend(at, day)
          if (fresh.corrupt) throw new Error('账本读取失败，保留当前消费与分组')
          setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
          if (disposed) return
          log(`恢复定时器触发：当日累计 ¥${memory.spentCny.toFixed(4)}`)

          // 统一检查预算和各组续跑余量，不先放开刹车。
          await reevaluate('boundary')
        } catch (err) {
          warn(`定时恢复失败: ${err && err.message}`)
          // 定时器触发时已清空句柄；短暂读盘失败后必须重试，否则消费不变的
          // 对账不会重新判定，goal 和刹车会永远停在上一个档位。
          scheduleResume(15_000, true)
        }
      })
    }, delay)
    if (resumeTimer.unref) resumeTimer.unref()
  }

  async function maybeResumeGoals(verdict) {
    if (disposed || cfg.dryRun) return
    if (!pausedGoals.size) {
      cancelResume()
      return
    }
    let live
    try {
      live = new Set(liveAgents(true))
    } catch {
      // 枚举暂时失败不能被当作所有 agent 都已退出。
      scheduleResume(15_000, true)
      return
    }
    const candidates = []
    for (const [agent, ref] of pausedGoals) {
      try {
        const view = live.has(agent) ? ctx.goals.get(agent) : null
        if (!view || view.phase !== 'paused' || view.id !== ref.id || view.revision !== ref.revision) {
          pausedGoals.delete(agent)
        } else if (Number.isFinite(view.maxGoalRounds) && Number.isFinite(view.roundsStarted) &&
            view.roundsStarted >= view.maxGoalRounds) {
          // 宿主拒绝恢复耗尽轮数的 goal；反复 retry 不会增加轮数额度。
          pausedGoals.delete(agent)
          warn(`goal ${ref.id} 已用尽轮数，保持暂停；请调整轮数后手动恢复`)
        } else candidates.push([agent, ref])
      } catch (err) {
        warn(`读取待恢复 goal 失败: ${err && err.message}`)
      }
    }
    if (!pausedGoals.size) {
      cancelResume()
      return
    }
    const tight = verdict.groups.filter((g) => !atLeastAmount(g.cap * (1 - cfg.resumeMinHeadroomPct / 100), g.spent))
    if (tight.length) {
      if (!resumeTimer) {
        log(`续跑余量不足（${tight.map((g) => g.group).join('、')}），保持 goal 暂停，下一档再检查`)
        scheduleResume(verdict.tier.remainingMs)
      }
      return
    }
    for (const [agent, ref] of candidates) {
      try {
        // harness 的 resume 会 arm goal，由 round driver 安排续跑。
        // 插件不能再发 followup，否则会重复排队；也不能假称“仅恢复状态”。
        ctx.goals.resume(agent, ref)
        pausedGoals.delete(agent)
        log(`已恢复 goal ${ref.id}（agent ${agent.id}，由宿主调度续跑）`)
      } catch (err) {
        warn(`恢复 goal 失败: ${err && err.message}`)
      }
    }
    if (pausedGoals.size) scheduleResume(15_000, true)
    else cancelResume()
  }

  // ── 通知（下一批实现浏览器 + 气池双通道；现在先落日志）─────────────────────
  function notifyExhausted(spent, cap, boundary) {
    log(`NOTIFY exhausted spent=¥${spent.toFixed(2)} cap=¥${cap} resume=${boundary}`)
  }

  // ── 刹车：唯一能在回合中途拦住的点 ────────────────────────────────────────
  ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', (exec, next) => {
      const verdict = verdictNow()
      if (cfg.dryRun || (!exhausted && verdict.allowed)) return next()
      if (!verdict.allowed && !exhausted) void enqueueUpdate(() => reevaluate('tool-check')).catch(() => {})
      const spent = verdict.source.spent
      const boundary = describeBoundary(verdict.tier)
      writeLog('DENY', `拒绝工具 ${exec?.name || '?'}：¥${spent.toFixed(2)} / ¥${verdict.cap}，等 ${boundary}`)
      return {
        kind: 'deny',
        reason: [
          `[cost-budget] 本时段预算已用尽：¥${spent.toFixed(2)} / ¥${verdict.cap}。`,
          `下一个阶梯 ${boundary} 生效，届时重新检查额度与续跑余量，无需重试。`,
          `请立即停止调用工具，用一段话汇报当前进度与未完成事项。`,
        ].join('\n'),
      }
    })
    return () => off?.()
  })

  // ── 真正的止损点：拦在 LLM 请求之前 ──────────────────────────────────────
  // tools/pre-execute 只能让工具不执行，但"模型已经想好并写出这次调用"的
  // token 早就花掉了：plan → 生成调用 → 被拒，拒绝发生在花钱之后。
  // agent/pre-step 是 waterfall 钩子，在每一步进入 LLM 之前触发；
  // 返回 { kind: 'reject' } 表示这一步不进入模型调用，因此**不产生 token 消耗**。
  //
  // ⚠️ waterfall 的终止函数返回的是 { kind: 'enter', messages }，调用方紧接着
  //    读 decision.kind。所以**放行时必须 return next()** —— 直接 return
  //    （undefined）会让 waterfall 的结果变成 undefined，调用方读 .kind 时抛
  //    "Cannot read properties of undefined (reading 'kind')"，正常回合全崩。
  //    别的 listener 之所以看着像"提前返回"，是因为它们最后都 return decision。
  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', ({ agent, step, signal }, next) => {
      if (signal && signal.aborted) return next()
      const verdict = verdictNow()
      if (cfg.dryRun || (!exhausted && verdict.allowed)) return next()
      if (!verdict.allowed && !exhausted) void enqueueUpdate(() => reevaluate('model-check')).catch(() => {})
      const spent = verdict.source.spent
      const boundary = describeBoundary(verdict.tier)
      writeLog(
        'BLOCK',
        `拦下回合不进模型（agent ${agent && agent.id} step ${step}）：` +
        `¥${spent.toFixed(2)} / ¥${verdict.cap}，等 ${boundary}`,
      )
      return { kind: 'reject' }
    })
    return () => off?.()
  })

  // ── 计量：订阅所有会话的追加事件（全局 firehose，带 session.id）────────────
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      // 宿主会容纳监听器失败，但异步任务仍要自兜，避免未处理拒绝。
      void (async () => {
        try {
          if (!event || event.type !== 'assistant/message') return
          const d = event.data
          const src = d && d.message && d.message.source
          if (!d || !d.usage || !src) return
          await record({
            seq: event.seq,
            sessionId: session && session.id,
            provider: src.provider,
            model: src.model,
            usage: d.usage,
            at: event.time || Date.now(),
          })
        } catch (err) {
          warn(`session/event 处理失败: ${err && err.message}`)
        }
      })()
    })
    return () => off?.()
  })

  // ── 启动：回填 + 定时对账 ─────────────────────────────────────────────────
  ctx.effect(() => {
    let stopped = false

    void (async () => {
      // ① 回填：插件加载时已存在的会话不会重放构造种子事件（规格 §7.2 ③）。
      //    ⚠️ 只回填**当日**事件：历史消费不属于"当天预算"，拉进来会让计数虚高。
      const today = beijingDay(Date.now())
      let backfilled = 0
      try {
        for (const session of ctx.sessions.list()) {
          for (const event of session.snapshotEvents?.() || []) {
            if (stopped) return
            if (event.type !== 'assistant/message') continue
            const d = event.data
            const src = d && d.message && d.message.source
            if (!d || !d.usage || !src) continue
            const at = event.time || Date.now()
            if (beijingDay(at) !== today) continue // 跳过历史
            await record({
              seq: event.seq,
              sessionId: session.id,
              provider: src.provider,
              model: src.model,
              usage: d.usage,
              at,
            })
            backfilled++
          }
        }
        log(`回填完成：${backfilled} 条当日事件`)
      } catch (err) {
        warn(`历史回填失败: ${err && err.message}`)
      }

      // ①b 节假日日历：先载入落盘缓存（同步、离线可用），再异步拉线上。
      //     拉取失败不影响已有日历 —— 内置表始终兜着。
      loadCalendarCache()
      log(`节假日日历：${calendarStats.holidays} 天节假日，来源 ${calendarStats.sources.join('+') || '无'}` +
        (cfg.calendarUrl ? `，将拉取 ${cfg.calendarUrl}` : ''))
      void fetchCalendar()

      // ② 从账本同步真实值（回填可能因跨日被重置）。
      //    注意用真实时钟取 day：账本里的 day 是真实日期，不能被 debug 偏移带偏。
      try {
        await enqueueUpdate(async () => {
          const day = beijingDay(Date.now())
          const fresh = await readSpend(Date.now(), day)
          if (fresh.corrupt) throw new Error(`账本损坏，保留已有内存（${ledgerPath()}）`)
          setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
          if (fresh.stale) log(`账本属于别的日期（账本 ${fresh.day}，今天 ${day}），按今日 0 起算`)
        })
      } catch (err) {
        warn(`账本读取失败: ${err && err.message}`)
      }

      const ladderText = cfg.ladder
        .map((r) => `¥${r.cap}@${String(Math.floor(r.untilMin / 60)).padStart(2, '0')}:${String(r.untilMin % 60).padStart(2, '0')}`)
        .join(' ')
      const v = verdictNow()
      log(`就绪：当日已花 ¥${memory.spentCny.toFixed(4)} / 当前档上限 ¥${v.cap}（第 ${v.tier.index + 1} 档，` +
        `距边界 ${Math.round(v.tier.remainingMs / 60000)} 分钟 → ${describeBoundary(v.tier)}）` +
        `｜账本 ${ledgerPath()}｜阶梯 ${ladderText}` +
        (cfg.dryRun ? '｜DRY-RUN 只记账不刹车' : '｜已启用硬停') +
        (cfg.debug.forceSpentCny !== null ? `｜⚠️ 调试：强制累计 ¥${cfg.debug.forceSpentCny}` : '') +
        (cfg.debug.timeOffsetMs ? `｜⚠️ 调试：时钟偏移 ${Math.round(cfg.debug.timeOffsetMs / 1000)}s` : ''))
      // 数据源可用性自检：注入的服务是否真的在
      log(`服务自检：sessionProjections=${!!ctx.sessionProjections} sessions=${!!ctx.sessions} ` +
        `agents=${!!ctx.agents} goals=${!!ctx.goals} tools=${!!ctx.tools}`)

      await enqueueUpdate(() => reevaluate('startup'))
    })()

    // ③ 定时对账：多会话/多进程写账本时定期对齐内存值；
    //    顺便处理跨日归零与定时器丢失。
    const tick = setInterval(() => enqueueUpdate(async () => {
        if (disposed) return
        try {
          const at = now()
          const day = beijingDay(at)
          if (memory.day !== day) {
            await rollDay(day, at, { waitMs: cfg.ledgerWaitMs })
            const fresh = await readSpend(at, day)
            if (fresh.corrupt) throw new Error('账本读取失败，保留当前消费与分组')
            setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
            seen.clear()
            log(`跨日对账，进入 ${day}`)
            await reevaluate('new-day')
            return
          }
          const fresh = await readSpend(at, day)
          if (fresh.corrupt) throw new Error('账本读取失败，保留当前消费与分组')
          const changed = fresh.spentCny !== memory.spentCny ||
            JSON.stringify(fresh.spentByGroup) !== JSON.stringify(memory.spentByGroup)
          // 总额没变时也可能调整了归属；必须整份替换，不能保留旧组或只更新总额。
          setMemory(day, fresh.spentCny, fresh.spentByGroup, fresh.events)
          // 余额样本会过期、档位会变化；不能只在 token 账本金额变化时重评。
          if (cfg.spendSource === 'observed' || changed || (!resumeTimer && (exhausted || pausedGoals.size))) await reevaluate('reconcile')
        } catch (err) {
          warn(`对账失败: ${err && err.message}`)
        }
    }), 15_000)
    if (tick.unref) tick.unref()

    // 余额观测：立刻拉一次，然后按 pollMs 轮询。用独立定时器 ——
    // 余额拉取失败绝不能影响账本对账或刹车判据。
    const balanceTimer = setInterval(() => { void pollBalance() }, cfg.balance?.pollMs || 60_000)
    if (balanceTimer.unref) balanceTimer.unref()
    if (cfg.balance?.enabled && cfg.balance?.poll) void pollBalance()

    return () => {
      stopped = true
      disposed = true
      clearInterval(tick)
      clearInterval(balanceTimer)
      cancelResume()
    }
  })

  // 暴露只读查询，便于外部（挂件 / 调试）核对
  const snapshot = () => {
    const verdict = verdictNow()
    const { spent, ...spendSource } = verdict.source
    const observed = observedWindow()
    const blocked = !cfg.dryRun && (exhausted || !verdict.allowed)

    return {
      day: memory.day,
      spentCny: spent,
      spendSource,
      realSpentCny: memory.spentCny,
      capCny: verdict.cap,
      tier: verdict.tier.index,
      tierCount: cfg.ladder.length,
      allowed: !blocked,
      budgetAllowed: verdict.allowed,
      exhausted: blocked,
      dryRun: cfg.dryRun,
      resumeAt: verdict.tier.isLast ? '24:00' : describeBoundary(verdict.tier),
      remainingMs: verdict.tier.remainingMs,
      ladder: cfg.ladder.map((r) => ({ until: r.untilMin, cap: r.cap })),
      quotaMode: cfg.quotaMode,
      // 分组明细：total 模式下只有 default 一组，等同于总额
      groups: verdict.groups.map((g) => ({
        name: g.group,
        spentCny: g.rawSpent,
        effSpentCny: g.spent,
        capCny: g.cap,
        scale: g.scale,
        allowed: g.allowed,
      })),
      blockedBy: verdict.blockedBy,
      /**
       * 按 provider 拆分的 token 估价。balance 是配置凭证对应账户的
       * 独立观测值；只有确认同一计费来源时才能对账，不能直接相加。
       */
      providers: providersFromLedger(),
      /** 供界面做下拉选项的 provider 名单（避免手打拼错静默失效） */
      availableProviders: availableProviders(),
      /**
       * 余额观测 —— **与 token 估算是两套独立的账，不要相加**。
       *
       *   token 估算：覆盖全部 provider，但依赖各自上报。
       *   余额观测：只覆盖配置凭证对应的官方计费账户。
       *
       * observed + total 模式用本档消费驱动刹车；不可分摊为 provider 组。
       */
      balance: cfg.balance?.enabled
        ? {
            ...(balanceSummary(balanceStore) || {
              observedSpend: 0, credits: 0, samples: 0, partialDay: true,
              // 观测值缺失时**标记出来**：0 会被误读成"今天没花钱"，
              // 而实际含义是"今天还没取到样本"。
              pending: true,
            }),
            source: 'balance-observed',
            error: lastBalanceError,
            scope: cfg.balance.scope,
            covers: '仅覆盖配置凭证对应的官方计费账户；其他账户或网关需独立统计',
            /** 本档内的实测消费 —— 与上面的 observedSpend（当日累计）不同口径 */
            tierSpend: observed.spend,
            /** 刹车判据当前用的口径，以及余额法不可信时的回落原因 */
            spendSource: cfg.spendSource,
            effectiveSpendSource: spendSource.effective,
            sourceFallback: spendSource.fallback,
          }
        : null,
      ledger: ledgerPath(),
    }
  }
  ctx.effect(() => ctx.provide('costBudget', { snapshot }))

  // ── 可视进度条：HTTP 状态接口 + 往 index.html 注入客户端脚本 ────────────────
  // 机制与余额挂件相同：tapIndex 插入 <script>，脚本由一个自有路由送出。
  // 不依赖构建工具，脚本是手写 JS。
  ctx.effect(() => {
    const disposers = []
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-cost-budget/state.json',
        handler: (req, res) => {
          const body = JSON.stringify(snapshot())
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(body)
        },
      }))

      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-cost-budget/bar.js',
        handler: (req, res) => {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(CLIENT_JS)
        },
      }))

      // ── 可视化配置接口 ────────────────────────────────────────────────────
      // GET  取当前生效值 + 已保存的覆盖层 + 可改键白名单
      // PUT  保存：校验 → 写文件 → 热重载（不重启）
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-cost-budget/config.json',
        handler: (req, res) => {
          const send = (code, obj) => {
            res.statusCode = code
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(JSON.stringify(obj))
          }
          if (req.method === 'GET') {
            send(200, {
              effective: effectiveForUi(),
              override: rawForUi(),
              mutableKeys: [...MUTABLE_KEYS],
              configPath: CONFIG_PATH,
              holidays: calendarStats,
            })
            return
          }
          if (req.method !== 'PUT' && req.method !== 'POST') {
            send(405, { ok: false, error: '只支持 GET / PUT' })
            return
          }
          let body = ''
          req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy() })
          req.on('end', () => {
            void (async () => {
              try {
                const parsed = JSON.parse(body || '{}')
                const next = parsed && typeof parsed.override === 'object' && parsed.override
                  ? parsed.override
                  : parsed
                // 白名单过滤，防止界面误写 debug 等键
                const clean = {}
                for (const k of Object.keys(next || {})) {
                  if (MUTABLE_KEYS.has(k)) clean[k] = next[k]
                }
                const dropped = Object.keys(next || {}).filter((k) => !MUTABLE_KEYS.has(k))
                const { state, ...info } = await reloadConfig(clean) // 校验/保存失败会抛
                log(`配置已由界面更新：模式=${info.quotaMode} 阶梯=${info.ladder.join(' ')}` +
                  (dropped.length ? `｜忽略非可改键 ${dropped.join(',')}` : ''))
                send(200, { ok: true, applied: info, state, dropped, configPath: CONFIG_PATH })
              } catch (err) {
                send(400, { ok: false, error: String(err && err.message || err) })
              }
            })()
          })
        },
      }))

      disposers.push(ctx.webServer.tapIndex((html) => {
        if (html.includes('/dsh-cost-budget/bar.js')) return html
        const tag = '<script defer src="/dsh-cost-budget/bar.js"></script>'
        return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
      }))
      log('进度条已挂载：GET /dsh-cost-budget/state.json ｜ 配置 GET/PUT /dsh-cost-budget/config.json')
    } catch (err) {
      warn(`进度条挂载失败: ${err && err.message}`)
    }
    return () => {
      for (const d of disposers) { try { d() } catch (err) { /* 卸载失败不影响其他 */ } }
    }
  })
}

/**
 * 进度条客户端脚本。手写、无构建、无依赖。
 * 固定在左下角，可折叠；折叠状态记在 localStorage。
 */
const CLIENT_JS = String.raw`
(function () {
  if (window.__dshCostBudgetBar) return;
  window.__dshCostBudgetBar = true;

  var POLL_MS = 3000;
  var TITLE = '当前预算';   // 指的是"当前档位"的额度，不是全天额度
  var KEY_POS = 'dsh-cb-pos';
  var KEY_SIZE = 'dsh-cb-size';
  var KEY_MIN = 'dsh-cb-collapsed';
  // 默认/最小宽度按"⚙ 必须露出来"定：手柄 + 标题 + 金额 + ⚙ 再加间距和内边距，
  // 低于这个宽度就只能靠省略号保 ⚙ 了（150 时标题会被压成"当…"）。
  var DEFAULT_SIZE = { w: 240, h: 0 };
  var MIN_W = 180, MAX_W = 520, MIN_H = 64, MAX_H = 320;

  var host = null, els = null, lastExhausted = null;
  var saving = false, stateEpoch = 0, pollIssued = 0, pollRendered = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)) } catch (e) {} }
  function load(key) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null } catch (e) { return null }
  }

  function style() {
    var s = document.createElement('style');
    s.textContent = [
      '#dsh-cb-bar{position:fixed;z-index:2147483000;box-sizing:border-box;',
      'width:210px;',
      'font:12px/1.45 ui-sans-serif,system-ui,"Segoe UI",sans-serif;',
      'background:rgba(24,24,27,.92);color:#e4e4e7;border:1px solid rgba(255,255,255,.12);',
      'border-radius:10px;padding:9px 11px;',
      'box-shadow:0 6px 22px rgba(0,0,0,.4);backdrop-filter:blur(8px);',
      'user-select:none;overflow:hidden}',
      '#dsh-cb-bar.dragging,#dsh-cb-bar.resizing{transition:none;opacity:.9}',
      '#dsh-cb-head{display:flex;align-items:center;gap:8px;cursor:grab;min-width:0}',
      '#dsh-cb-bar.dragging #dsh-cb-head{cursor:grabbing}',
      '#dsh-cb-grip{flex:0 0 auto;opacity:.32;font-size:11px;letter-spacing:-1px;line-height:1}',
      '#dsh-cb-bar:hover #dsh-cb-grip{opacity:.7}',
      // ★ 标题必须可收缩（min-width:0 + ellipsis）。否则它的 min-content 宽度
      //   会把后面的 ⚙ 挤出面板 —— 表现就是"按钮被藏起来了，拉大面板才看得见"。
      '#dsh-cb-title{font-weight:600;letter-spacing:.02em;cursor:pointer;white-space:nowrap;',
      'min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}',
      '#dsh-cb-title:hover{text-decoration:underline dotted}',
      // 金额同理：可压缩、不够时省略，但绝不把 ⚙ 顶出去
      '#dsh-cb-num{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.92;',
      'white-space:nowrap;min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}',
      '#dsh-cb-body{display:block}',
      '#dsh-cb-track{margin-top:7px;height:7px;border-radius:99px;background:rgba(255,255,255,.13);overflow:hidden}',
      '#dsh-cb-fill{height:100%;width:0;border-radius:99px;background:#22c55e;transition:width .35s ease,background .35s ease}',
      '#dsh-cb-meta{margin-top:5px;display:flex;justify-content:space-between;gap:8px;opacity:.62;font-size:11px}',
      '#dsh-cb-source{margin-top:4px;font-size:11px;opacity:.8;overflow-wrap:anywhere}',
      // 分组模式下逐组进度（group 模式才显示）
      '#dsh-cb-groupbars{margin-top:7px;display:none;overflow-y:auto}',
      '.dsh-cb-grow{display:flex;align-items:center;gap:6px;margin:3px 0;font-size:11px}',
      '.dsh-cb-grow .dsh-cb-glabel{flex:0 0 auto;max-width:74px;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;opacity:.8}',
      '.dsh-cb-grow .dsh-cb-gtrack{flex:1 1 auto;min-width:0;height:5px;border-radius:99px;',
      'background:rgba(255,255,255,.13);overflow:hidden}',
      '.dsh-cb-grow .dsh-cb-gfill{display:block;height:100%;border-radius:99px;background:#22c55e;',
      'transition:width .35s ease}',
      '.dsh-cb-grow .dsh-cb-gnum{flex:0 0 auto;font-variant-numeric:tabular-nums;opacity:.7}',
      '.dsh-cb-grow.warn .dsh-cb-gfill{background:#f59e0b}',
      '.dsh-cb-grow.over .dsh-cb-gfill{background:#ef4444}',
      '.dsh-cb-grow.over .dsh-cb-glabel{color:#f87171;opacity:1}',
      '#dsh-cb-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;opacity:.28}',
      '#dsh-cb-cfg{flex:0 0 auto;cursor:pointer;opacity:.35;font-size:13px;line-height:1;padding:0 2px}',
      '#dsh-cb-bar:hover #dsh-cb-cfg{opacity:.85}',
      '#dsh-cb-cfg:hover{opacity:1;transform:rotate(35deg)}',
      // ── 配置面板 ──
      '#dsh-cb-panel{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:92vw;z-index:2147483001;',
      'background:#18181b;color:#e4e4e7;border-left:1px solid rgba(255,255,255,.14);',
      'font:12px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;overflow-y:auto;',
      'box-shadow:-8px 0 28px rgba(0,0,0,.45);padding:14px 16px 24px;box-sizing:border-box}',
      '#dsh-cb-panel h3{margin:16px 0 6px;font-size:12px;font-weight:600;opacity:.75;',
      'text-transform:uppercase;letter-spacing:.06em}',
      '#dsh-cb-panel h3:first-child{margin-top:0}',
      '#dsh-cb-panel label{display:block;margin:8px 0 3px;opacity:.7;font-size:11px}',
      '#dsh-cb-panel input[type=text],#dsh-cb-panel textarea,#dsh-cb-panel select{',
      'width:100%;box-sizing:border-box;background:#0b0b0d;color:#e4e4e7;',
      'border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:6px 8px;',
      'font:12px/1.4 inherit}',
      // ★ 显式声明可选 + 可编辑。
      //   宿主壳层或某个祖先若设了 user-select:none，会被输入区继承，
      //   表现为"能聚焦、能打字，但没法用鼠标定位光标或选中已有内容"——
      //   看起来就像"只能新增、不能修改"。输入区必须自己声明回来。
      '#dsh-cb-panel input,#dsh-cb-panel textarea{user-select:text;-webkit-user-select:text;',
      'cursor:text}',
      '#dsh-cb-panel ::selection{background:#3b82f6;color:#fff}',
      '#dsh-cb-panel textarea{resize:vertical;min-height:56px;font-family:ui-monospace,Consolas,monospace}',
      '#dsh-cb-panel input:focus,#dsh-cb-panel textarea:focus,#dsh-cb-panel select:focus{',
      'outline:none;border-color:#3b82f6}',
      '.dsh-cb-row{display:flex;gap:8px;align-items:center;margin:6px 0}',
      '.dsh-cb-row input[type=text]{flex:1}',
      '.dsh-cb-row .dsh-cb-del{cursor:pointer;opacity:.5;padding:2px 6px;border-radius:4px}',
      '.dsh-cb-row .dsh-cb-del:hover{opacity:1;background:rgba(239,68,68,.2)}',
      '#dsh-cb-panel .dsh-cb-actions{position:sticky;bottom:-24px;background:#18181b;',
      'padding:12px 0 6px;margin-top:18px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;',
      'border-top:1px solid rgba(255,255,255,.1)}',
      '#dsh-cb-panel button{cursor:pointer;border-radius:6px;padding:6px 14px;font:12px inherit;',
      'border:1px solid rgba(255,255,255,.18);background:#27272a;color:#e4e4e7}',
      '#dsh-cb-panel button:hover{background:#3f3f46}',
      '#dsh-cb-panel button.primary{background:#2563eb;border-color:#2563eb}',
      '#dsh-cb-panel button.primary:hover{background:#1d4ed8}',
      '#dsh-cb-close{position:absolute;top:12px;right:16px;cursor:pointer;opacity:.6;font-size:16px}',
      '#dsh-cb-close:hover{opacity:1}',
      '#dsh-cb-msg{flex:1 0 100%;font-size:11px;overflow-wrap:anywhere}',
      '.dsh-cb-ok{color:#4ade80}.dsh-cb-err{color:#f87171}',
      '#dsh-cb-panel .dsh-cb-hint{opacity:.5;font-size:11px;margin-top:3px}',
      // 只读字段：看起来就"不是输入框"，避免让人以为能改
      '.dsh-cb-ro{display:flex;gap:8px;align-items:baseline;margin:4px 0;font-size:12px}',
      '.dsh-cb-ro b{flex:0 0 52px;opacity:.6;font-weight:500}',
      '.dsh-cb-ro span{flex:1;opacity:.9;word-break:break-all}',
      '#dsh-cb-ro{font-size:10px;opacity:.45;font-weight:400;border:1px solid currentColor;',
      'border-radius:3px;padding:0 4px;margin-left:4px;vertical-align:middle}',
      // 当前时段：峰价醒目（它决定消费速度），谷价淡化
      '.dsh-cb-peaknow{display:flex;gap:8px;align-items:baseline;font-size:12px}',
      '.dsh-cb-peaknow b{flex:0 0 34px;font-weight:600;border-radius:3px;text-align:center;',
      'padding:1px 0;font-size:11px}',
      '.dsh-cb-peaknow span{flex:1;opacity:.75}',
      '.dsh-cb-peak{background:#b45309;color:#fff}',
      '.dsh-cb-valley{background:rgba(255,255,255,.12);color:#a1a1aa}',
      // 分组行：组名 + 倍率 + 可勾选的 provider
      '.dsh-cb-group{border:1px solid rgba(255,255,255,.12);border-radius:6px;',
      'padding:8px;margin:8px 0}',
      '.dsh-cb-grouphead{display:flex;gap:8px;align-items:center;margin-bottom:6px}',
      '.dsh-cb-grouphead input[type=text]{flex:1;min-width:0}',
      '.dsh-cb-gscale-wrap{display:flex;align-items:center;gap:2px;opacity:.8;font-size:11px;flex:0 0 auto}',
      '.dsh-cb-gscale{width:44px !important;text-align:center;padding:4px !important}',
      '.dsh-cb-chips{display:flex;flex-wrap:wrap;gap:4px 10px}',
      '.dsh-cb-chip{display:flex !important;align-items:center;gap:4px;margin:0 !important;',
      'opacity:1 !important;font-size:11px;cursor:pointer}',
      '.dsh-cb-chip input{flex:0 0 auto;margin:0}',
      '@media (prefers-color-scheme:light){#dsh-cb-panel{background:#fafafa;color:#18181b;',
      'border-left-color:rgba(0,0,0,.12)}#dsh-cb-panel input[type=text],#dsh-cb-panel textarea,',
      '#dsh-cb-panel select{background:#fff;color:#18181b;border-color:rgba(0,0,0,.18)}',
      '#dsh-cb-panel .dsh-cb-actions{background:#fafafa}',
      '#dsh-cb-panel button{background:#e4e4e7;color:#18181b;border-color:rgba(0,0,0,.15)}}',
      '#dsh-cb-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;',
      'border-right:2px solid currentColor;border-bottom:2px solid currentColor}',
      '#dsh-cb-bar:hover #dsh-cb-resize{opacity:.75}',
      '#dsh-cb-bar.collapsed{padding:6px 9px;cursor:grab;height:auto !important;min-height:0 !important}',
      '#dsh-cb-bar.collapsed #dsh-cb-body,#dsh-cb-bar.collapsed #dsh-cb-resize{display:none}',
      '.dsh-cb-paused #dsh-cb-fill{background:#ef4444}',
      '.dsh-cb-paused #dsh-cb-title::after{content:" · 已停";color:#f87171}',
      '.dsh-cb-dry #dsh-cb-title::after{content:" · 试跑";color:#fbbf24}',
      '@media (prefers-color-scheme:light){#dsh-cb-bar{background:rgba(255,255,255,.96);color:#18181b;border-color:rgba(0,0,0,.12)}',
      '#dsh-cb-track{background:rgba(0,0,0,.1)}}',
    ].join('');
    document.head.appendChild(s);
  }

  function build() {
    host = document.createElement('div');
    host.id = 'dsh-cb-bar';
    host.innerHTML =
      '<div id="dsh-cb-head">' +
        '<span id="dsh-cb-grip" title="拖动">\u22ee\u22ee</span>' +
        '<span id="dsh-cb-title" title="点击折叠 / 展开">' + TITLE + '</span>' +
        '<span id="dsh-cb-num">--</span>' +
        '<span id="dsh-cb-cfg" title="配置额度">\u2699</span>' +
      '</div>' +
      '<div id="dsh-cb-body">' +
        '<div id="dsh-cb-track"><div id="dsh-cb-fill"></div></div>' +
        '<div id="dsh-cb-groupbars"></div>' +
        '<div id="dsh-cb-meta"><span id="dsh-cb-l"></span><span id="dsh-cb-r"></span></div>' +
        '<div id="dsh-cb-source"></div>' +
      '</div>' +
      '<div id="dsh-cb-resize" title="拖动缩放"></div>';
    document.body.appendChild(host);
    els = {
      host: host,
      num: host.querySelector('#dsh-cb-num'),
      fill: host.querySelector('#dsh-cb-fill'),
      l: host.querySelector('#dsh-cb-l'),
      r: host.querySelector('#dsh-cb-r'),
      source: host.querySelector('#dsh-cb-source'),
      groupBars: host.querySelector('#dsh-cb-groupbars'),
      title: host.querySelector('#dsh-cb-title'),
      resize: host.querySelector('#dsh-cb-resize'),
      cfg: host.querySelector('#dsh-cb-cfg'),
    };
    restoreGeometry();
    wireDrag();
    wireResize();
    wireCollapse();
    els.cfg.addEventListener('click', function (e) {
      e.stopPropagation();
      if (panel && panel.style.display !== 'none') closePanel(); else openPanel();
    });
    window.addEventListener('resize', function () { applyGeometry(currentRect()); });
  }

  // ── 位置与尺寸 ──────────────────────────────────────────────────────────────
  // 只在拖过/缩过之后才写死 left/top；否则用 right/top 定位，
  // 这样窗口尺寸变化时默认位置会自然跟着走。
  function applyGeometry(g) {
    var w = host.offsetWidth || DEFAULT_SIZE.w;
    var h = host.offsetHeight || 44;
    var maxX = Math.max(0, window.innerWidth - w);
    var maxY = Math.max(0, window.innerHeight - h);
    var x = clamp(g.x, 0, maxX);
    var y = clamp(g.y, 0, maxY);
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    store(KEY_POS, { x: x, y: y });
  }

  function currentRect() {
    var r = host.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  // ── 配置面板 ────────────────────────────────────────────────────────────────
  // 读 /dsh-cost-budget/config.json 回显，保存时 PUT 回去（服务端热重载，无需重启）。
  var panel = null, pels = {}, configLoadId = 0;
  /** 服务端给的 provider 候选名单（勾选式分组用）——手打会拼错且不报错 */
  var availableProviders = [];

  function parseHHMM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
    return h * 60 + mi;
  }
  function toHHMM(min) {
    var m = Math.round(Number(min) || 0);
    return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
  }

  function pmsg(text, cls) {
    if (!pels.msg) return;
    pels.msg.textContent = text || '';
    pels.msg.className = cls || '';
  }

  function openPanel() {
    if (panel) { panel.style.display = 'block'; return; }
    panel = document.createElement('div');
    panel.id = 'dsh-cb-panel';
    panel.innerHTML =
      '<span id="dsh-cb-close" title="关闭">\u00d7</span>' +
      '<h3>额度模式</h3>' +
      '<select id="dsh-cb-mode">' +
        '<option value="total">total —— 所有 API 合并成一个额度</option>' +
        '<option value="group">group —— 按组各算各的额度</option>' +
      '</select>' +
      '<div class="dsh-cb-hint" id="dsh-cb-modehint"></div>' +

      '<div id="dsh-cb-groupsbox">' +
        '<h3>API 分组</h3>' +
        '<div id="dsh-cb-grouplist"></div>' +
        '<div class="dsh-cb-row"><button id="dsh-cb-addgroup">+ 加一组</button></div>' +
        '<div class="dsh-cb-hint">勾选属于该组的 provider（选项来自账本里真实出现过的，' +
        '手打容易拼错——拼错的组会恒为 ¥0 且不报错）。<br>' +
        '倍率 1.0 = 该组上限与阶梯相同；0.5 = 只有一半。留空按 <b>1.0</b> 处理。</div>' +
      '</div>' +

      '<h3 id="dsh-cb-laddertitle">阶梯额度（到几点为止，当天累计上限）</h3>' +
      '<div id="dsh-cb-ladder"></div>' +
      '<div class="dsh-cb-row"><button id="dsh-cb-add-tier">+ 加一档</button></div>' +
      '<div class="dsh-cb-hint" id="dsh-cb-ladderhint">上限只升不降；到下一档时重新检查额度和恢复余量。</div>' +

      // ★ 峰谷/节假日只显示**当前处于什么时段**。
      //   把完整峰时表、节假日清单铺出来只是噪声 —— 需要知道的只有
      //   "现在这一刻按峰价还是谷价"，因为它直接决定消费速度。
      '<h3>当前时段 <span id="dsh-cb-ro">系统提供 · 只读</span></h3>' +
      '<div id="dsh-cb-peaknow" class="dsh-cb-peaknow">--</div>' +
      '<div class="dsh-cb-hint">峰谷价与节假日按官方计费规则判定；周末与节假日全天谷价。' +
      '需要调整请改插件源码里的常量，不在此处修改。</div>' +

      '<h3>其他</h3>' +
      '<label><input type="checkbox" id="dsh-cb-dry"> 试跑模式（只记账，不拦任何工具）</label>' +
      '<label>恢复续跑的最低余量（%）</label>' +
      '<input type="text" id="dsh-cb-headroom" placeholder="15">' +
      '<div class="dsh-cb-hint">余量不足时保持 goal 暂停，下一档再检查。</div>' +

      '<div class="dsh-cb-actions">' +
        '<button id="dsh-cb-save" class="primary">保存并生效</button>' +
        '<button id="dsh-cb-reload">重新载入</button>' +
        '<span id="dsh-cb-msg" role="status" aria-live="polite"></span>' +
      '</div>';
    document.body.appendChild(panel);
    pels = {
      mode: panel.querySelector('#dsh-cb-mode'),
      modeHint: panel.querySelector('#dsh-cb-modehint'),
      groupsBox: panel.querySelector('#dsh-cb-groupsbox'),
      groupList: panel.querySelector('#dsh-cb-grouplist'),
      ladder: panel.querySelector('#dsh-cb-ladder'),
      ladderTitle: panel.querySelector('#dsh-cb-laddertitle'),
      ladderHint: panel.querySelector('#dsh-cb-ladderhint'),
      peakNow: panel.querySelector('#dsh-cb-peaknow'),
      dry: panel.querySelector('#dsh-cb-dry'),
      headroom: panel.querySelector('#dsh-cb-headroom'),
      save: panel.querySelector('#dsh-cb-save'),
      reload: panel.querySelector('#dsh-cb-reload'),
      msg: panel.querySelector('#dsh-cb-msg'),
    };
    panel.querySelector('#dsh-cb-close').addEventListener('click', closePanel);
    panel.querySelector('#dsh-cb-save').addEventListener('click', saveConfig);
    panel.querySelector('#dsh-cb-reload').addEventListener('click', loadConfig);
    panel.querySelector('#dsh-cb-add-tier').addEventListener('click', function () {
      addTierRow('24:00', 0);
    });
    panel.querySelector('#dsh-cb-addgroup').addEventListener('click', function () {
      // 新组默认倍率 1.0（与阶梯相同），不填就是 1.0
      addGroupRow('', [], 1.0, availableProviders);
    });
    // 切换模式要**看得见**：total 下分组/倍率不参与计算，就不该占着地方
    pels.mode.addEventListener('change', applyModeVisibility);
    loadConfig();
  }

  /** 按当前模式显隐分组设置，并把"这个模式到底怎么算"说清楚。 */
  function applyModeVisibility() {
    var isGroup = pels.mode.value === 'group';
    pels.groupsBox.style.display = isGroup ? 'block' : 'none';
    pels.modeHint.textContent = isGroup
      ? '每个组各自一套阶梯额度，任一组超限即全局硬停。'
      : '所有 API 合并成一个额度 —— 分组设置不参与计算，已隐藏。';
  }

  /**
   * 画一组：组名 + 该组包含的 provider（**勾选**，不给手打）+ 倍率。
   *
   * provider 必须是勾选而不是输入框：它是字符串字面量，拼错不会报错，
   * 只会让那个组永远匹配不到请求、消费恒为 0 —— 静默失效最难查。
   */
  function addGroupRow(name, providers, scale, available) {
    var picked = Object.create(null);
    (providers || []).forEach(function (p) { picked[p] = true });
    var opts = (available || []).slice();
    // 已配置但不在候选里的（例如历史拼错的），也列出来，方便看见并改掉
    (providers || []).forEach(function (p) { if (opts.indexOf(p) < 0) opts.push(p) });

    var row = document.createElement('div');
    row.className = 'dsh-cb-group';
    var head =
      '<div class="dsh-cb-grouphead">' +
        '<input type="text" class="dsh-cb-gname" value="' + escapeHtml(name) + '" placeholder="组名">' +
        '<span class="dsh-cb-gscale-wrap" title="该组上限倍率，1.0 = 与阶梯相同">×' +
          '<input type="text" class="dsh-cb-gscale" value="' + escapeHtml(scale === undefined || scale === null ? '1.0' : scale) + '" placeholder="1.0">' +
        '</span>' +
        '<span class="dsh-cb-del" title="删除该组">\u2715</span>' +
      '</div>';
    var boxes = '<div class="dsh-cb-chips">';
    if (!opts.length) {
      boxes += '<span class="dsh-cb-hint">（账本里还没有 provider，先跑一次）</span>';
    }
    opts.forEach(function (p) {
      boxes += '<label class="dsh-cb-chip"><input type="checkbox" class="dsh-cb-gpick" value="' +
        escapeHtml(p) + '"' + (picked[p] ? ' checked' : '') + '>' +
        '<span>' + escapeHtml(p) + '</span></label>';
    });
    boxes += '</div>';
    row.innerHTML = head + boxes;

    row.querySelector('.dsh-cb-del').addEventListener('click', function () {
      row.parentNode.removeChild(row);
    });
    pels.groupList.appendChild(row);
  }

  /** 把界面上的组读回成 { providerGroups, groupCapScale }。 */
  function collectGroups() {
    var providerGroups = Object.create(null);
    var groupCapScale = Object.create(null);
    var rows = pels.groupList.querySelectorAll('.dsh-cb-group');
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].querySelector('.dsh-cb-gname').value.trim();
      if (!name) continue; // 组名空 = 这行没填完，跳过
      var picks = rows[i].querySelectorAll('.dsh-cb-gpick');
      var list = [];
      for (var j = 0; j < picks.length; j++) if (picks[j].checked) list.push(picks[j].value);
      if (!list.length) continue; // 一个 provider 都没勾 = 该组不生效，跳过
      providerGroups[name] = list;
      var raw = rows[i].querySelector('.dsh-cb-gscale').value.trim();
      if (raw === '') { groupCapScale[name] = 1.0; continue }
      var n = Number(raw);
      if (!isFinite(n) || n <= 0) return { error: '「' + name + '」的倍率不是正数：' + raw };
      groupCapScale[name] = n;
    }
    return { providerGroups: providerGroups, groupCapScale: groupCapScale };
  }

  function closePanel() { if (panel) panel.style.display = 'none'; }

  function addTierRow(until, cap) {
    var row = document.createElement('div');
    // ★ 用专属类名 dsh-cb-tier，不能复用通用的 .dsh-cb-row。
    //   面板里"+ 加一组 / + 加一档"那两个按钮容器也是 .dsh-cb-row，
    //   而 collectConfig 靠 panel.querySelectorAll('.dsh-cb-row') 找档位行 ——
    //   会把按钮行也算成档位行，读不到 .dsh-cb-until 就报
    //   "档位格式不对：undefined / undefined"，**保存直接失效**。
    row.className = 'dsh-cb-row dsh-cb-tier';
    row.innerHTML =
      '<input type="text" class="dsh-cb-until" value="' + until + '" placeholder="10:00">' +
      '<input type="text" class="dsh-cb-cap" value="' + cap + '" placeholder="5">' +
      '<span class="dsh-cb-del" title="删除">\u2715</span>';
    row.querySelector('.dsh-cb-del').addEventListener('click', function () {
      row.parentNode.removeChild(row);
    });
    pels.ladder.appendChild(row);
  }

  function loadConfig() {
    if (saving) return Promise.resolve(false);
    var request = ++configLoadId;
    pmsg('载入中…', '');
    return fetch('/dsh-cost-budget/config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (request !== configLoadId) return;
        if (!j || !j.effective) { pmsg('读取失败', 'dsh-cb-err'); return; }
        var e = j.effective;
        var observed = e.spendSource === 'observed';
        pels.ladderTitle.textContent = observed
          ? '阶梯额度（本档余额消费上限）'
          : '阶梯额度（到几点为止，当天累计上限）';
        pels.ladderHint.textContent = observed
          ? '余额模式仅支持总额。每档重算窗口消费；余额数据不可用时按当日 token 估算，当前口径见预算条。'
          : '上限只升不降；到下一档时重新检查额度和恢复余量。';
        pels.mode.value = e.quotaMode || 'total';
        pels.ladder.innerHTML = '';
        (e.ladder || []).forEach(function (t) { addTierRow(t.until, t.cap) });
        // 分组：勾选式，provider 名单由服务端给（手打会拼错且不报错）
        availableProviders = e.availableProviders || [];
        pels.groupList.innerHTML = '';
        var pg = e.providerGroups || {};
        var gs = e.groupCapScale || {};
        var names = Object.keys(pg);
        // 只设了倍率、没设 provider 的组也列出来，否则它会被静默丢掉
        Object.keys(gs).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k) });
        names.forEach(function (k) {
          addGroupRow(k, Object.prototype.hasOwnProperty.call(pg, k) ? pg[k] : [],
            Object.prototype.hasOwnProperty.call(gs, k) ? gs[k] : undefined, availableProviders);
        });
        pels.dry.checked = !!e.dryRun;
        pels.headroom.value = e.resumeMinHeadroomPct;
        // 只显示"现在处于什么时段"——完整峰时表和节假日清单只是噪声
        // ★ 取 e.peakNow（effective 内），不是 j.peakNow：
        //   config.json 的形状是 { effective, override, mutableKeys, ... }，
        //   读错层级不会报错，只是永远渲染出 "--"（界面上看不出哪里坏了）。
        pels.peakNow.innerHTML = renderPeakNow(e.peakNow);
        applyModeVisibility();
        pmsg(j.override && Object.keys(j.override).length ? '已保存过设置' : '当前为配置文件默认值', '');
      })
      .catch(function (err) {
        if (request === configLoadId) pmsg('读取失败: ' + err.message, 'dsh-cb-err');
      });
  }

  function collectConfig() {
    // 只认档位行（.dsh-cb-tier）—— .dsh-cb-row 太通用，按钮容器也是它
    var rows = panel.querySelectorAll('.dsh-cb-tier');
    var ladder = [];
    for (var i = 0; i < rows.length; i++) {
      var u = rows[i].querySelector('.dsh-cb-until');
      var c = rows[i].querySelector('.dsh-cb-cap');
      if (!u || !c) continue;
      var min = parseHHMM(u.value);
      var cap = Number(c.value);
      if (min === null || !isFinite(cap)) {
        return { error: '档位格式不对：' + u.value + ' / ' + c.value };
      }
      ladder.push({ until: toHHMM(min), cap: cap });
    }
    if (!ladder.length) return { error: '至少要有一档' };

    var g = collectGroups();
    if (g.error) return { error: g.error };

    var head = Number(pels.headroom.value);
    if (!isFinite(head) || head < 0 || head > 100) return { error: '余量百分比要在 0-100 之间' };

    // ★ 不发送 peakHours / holidays / valleyDays / calendarUrl：
    //   它们是官方计费规则的映射，界面上只读。若照旧回传，会把界面上那份
    //   （可能过期的）快照固化进覆盖层 —— 这些字段从配置里删掉、或服务端
    //   接上了别的日历源，覆盖层就会拿旧值把新值盖回去。
    return {
      override: {
        ladder: ladder,
        quotaMode: pels.mode.value,
        providerGroups: g.providerGroups,
        groupCapScale: g.groupCapScale,
        dryRun: !!pels.dry.checked,
        resumeMinHeadroomPct: head,
      },
    };
  }

  function saveConfig() {
    if (saving) return;
    var built = collectConfig();
    if (built.error) { pmsg(built.error, 'dsh-cb-err'); return }
    saving = true;
    pels.save.disabled = true;
    pels.reload.disabled = true;
    // 先前的配置读取不能在保存后还原表单，也不能覆盖保存反馈。
    configLoadId++;
    // 保存前发出的轮询即使稍后才回来，也不能覆盖这次配置对应的新状态。
    stateEpoch++;
    var saved = false;
    pmsg('保存中…', '');
    return fetch('/dsh-cost-budget/config.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.override),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (res) {
        if (!res.ok || !res.j || !res.j.ok) {
          pmsg('保存失败: ' + ((res.j && res.j.error) || '未知错误'), 'dsh-cb-err');
          return;
        }
        saved = true;
        var a = res.j.applied || built.override;
        var ready;
        if (res.j.state) {
          applyState(res.j.state);
          ready = Promise.resolve(true);
        } else {
          // 兼容不返回 state 的宿主：看到新状态后才报告“已生效”。
          ready = poll(true);
        }
        return ready.then(function (ok) {
          if (!ok) { pmsg('配置已保存，状态刷新失败；稍后自动重试', 'dsh-cb-err'); return; }
          var detail = '总额模式';
          if (a.quotaMode === 'group') {
            var providers = a.providerGroups || built.override.providerGroups || {};
            var names = Object.keys(providers);
            var scales = a.groupCapScale || built.override.groupCapScale || {};
            detail = '分组模式 · ' + (names.length ? names.map(function (name) {
              return name + ' ×' + (scales[name] === undefined ? 1 : scales[name]) +
                ' [' + providers[name].join(', ') + ']';
            }).join('；') : '未设置具名分组，未分组的 API 各自独立计额');
          }
          pmsg('已生效：' + detail + '（无需重启）', 'dsh-cb-ok');
        });
      })
      .catch(function (err) {
        pmsg((saved ? '配置已保存，状态刷新失败: ' : '保存失败: ') + err.message, 'dsh-cb-err');
      })
      .then(function () { saving = false; pels.save.disabled = false; pels.reload.disabled = false; });
  }

  // 默认位置：右上角（避开左下角的设置入口）。用 right/top 定位，
  // 窗口尺寸变化时会自然跟着走，不需要重新计算。
  function positionDefault() {
    host.style.left = 'auto';
    host.style.top = '16px';
    host.style.right = '24px';
    host.style.bottom = 'auto';
  }

  function restoreGeometry() {
    var size = load(KEY_SIZE);
    if (size && size.w) host.style.width = clamp(size.w, MIN_W, MAX_W) + 'px';
    if (size && size.h && size.h > MIN_H) host.style.height = clamp(size.h, MIN_H, MAX_H) + 'px';

    try { if (localStorage.getItem(KEY_MIN) === '1') host.classList.add('collapsed') } catch (e) {}

    var pos = load(KEY_POS);
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      // 位置是写死的：直接按存下来的坐标放，越界就拉回来
      host.style.left = pos.x + 'px';
      host.style.top = pos.y + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      requestAnimationFrame(function () { applyGeometry(pos) });
    } else {
      positionDefault();
    }
  }

  // ── 拖动 ────────────────────────────────────────────────────────────────────
  function wireDrag() {
    var head = host.querySelector('#dsh-cb-head');
    var start = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      // ★ 标题（折叠）和齿轮（配置）都要**放行**，不能进拖动分支。
      //   齿轮曾经漏在这里：它在 #dsh-cb-head 内部，于是 pointerdown 走到了
      //   下面的 preventDefault()，而**在 pointerdown 上 preventDefault 会阻止
      //   后续的 click 事件**（Chrome/Edge 在 Windows 的实测行为）——
      //   结果齿轮的 click 监听器永远不触发，配置面板永远打不开。
      //   标题没这个问题，因为它先被上面这行挡掉了。
      if (e.target === els.title || e.target === els.cfg) return;
      var r = host.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top, moved: false };
      host.classList.add('dragging');
      try { head.setPointerCapture(e.pointerId) } catch (err) {}
      e.preventDefault();
    });
    head.addEventListener('pointermove', function (e) {
      if (!start) return;
      var dx = e.clientX - start.px;
      var dy = e.clientY - start.py;
      if (!start.moved && Math.abs(dx) + Math.abs(dy) < 3) return;  // 抖动容差
      start.moved = true;
      applyGeometry({ x: start.x + dx, y: start.y + dy });
    });
    function end(e) {
      if (!start) return;
      host.classList.remove('dragging');
      try { head.releasePointerCapture(e.pointerId) } catch (err) {}
      start = null;
    }
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  // ── 缩放 ────────────────────────────────────────────────────────────────────
  function wireResize() {
    var start = null;
    els.resize.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      start = { px: e.clientX, py: e.clientY, w: host.offsetWidth, h: host.offsetHeight };
      host.classList.add('resizing');
      try { els.resize.setPointerCapture(e.pointerId) } catch (err) {}
      e.preventDefault();
      e.stopPropagation();
    });
    els.resize.addEventListener('pointermove', function (e) {
      if (!start) return;
      var w = clamp(start.w + (e.clientX - start.px), MIN_W, MAX_W);
      var h = clamp(start.h + (e.clientY - start.py), MIN_H, MAX_H);
      host.style.width = w + 'px';
      host.style.height = h + 'px';
      store(KEY_SIZE, { w: w, h: h });
    });
    function end(e) {
      if (!start) return;
      host.classList.remove('resizing');
      try { els.resize.releasePointerCapture(e.pointerId) } catch (err) {}
      start = null;
      applyGeometry(currentRect());
    }
    els.resize.addEventListener('pointerup', end);
    els.resize.addEventListener('pointercancel', end);
  }

  // ── 折叠 ────────────────────────────────────────────────────────────────────
  function wireCollapse() {
    els.title.addEventListener('click', function () {
      host.classList.toggle('collapsed');
      try { localStorage.setItem(KEY_MIN, host.classList.contains('collapsed') ? '1' : '0') } catch (e) {}
      requestAnimationFrame(function () { applyGeometry(currentRect()) });
    });
    // 双击面板空白处 = 复位到默认位置（拖丢了就用这个找回来）
    host.addEventListener('dblclick', function (e) {
      if (e.target === els.title) return;
      try { localStorage.removeItem(KEY_POS); localStorage.removeItem(KEY_SIZE) } catch (err) {}
      host.style.width = DEFAULT_SIZE.w + 'px';
      host.style.height = '';
      positionDefault();
    });
  }

  function fmt(n) { return '\u00a5' + (Math.round(n * 100) / 100).toFixed(2); }

  /**
   * 分组模式下逐组显示进度。
   *
   * ★ 为什么必须有：total 模式一个进度条就够了，但 group 模式下
   *   各组各有各的上限，"总额没超"完全不代表"没组超"——
   *   只画一条总进度条，等于把分组设置的效果藏起来了。
   *   非 1 倍率必须显示，避免不同组的实际额度看起来相同。
   *
   * 用真实消费与已乘倍率的 capCny 作比，与服务端判定保持一致。
   */
  function renderGroups(s) {
    var groups = s.groups || [];
    var show = s.quotaMode === 'group';
    els.groupBars.style.display = show ? 'block' : 'none';
    // 保留用户缩放后的 height 偏好，只在分组内容较多时临时撑开。
    // 超过 MAX_H 的组列表单独滚动，标题、配置按钮和档位仍保持可见。
    els.host.style.minHeight = show ? Math.min(MAX_H, 84 + (groups.length || 2) * 24) + 'px' : '';
    els.groupBars.style.maxHeight = (MAX_H - 88) + 'px';
    if (!show) { els.groupBars.innerHTML = ''; return; }
    if (!groups.length) {
      els.groupBars.innerHTML = '<div class="dsh-cb-hint">暂无分组消费，可在 ⚙ 中设置 API 分组</div>';
      return;
    }
    els.groupBars.innerHTML = groups.map(function (g) {
      var spent = g.spentCny == null ? g.effSpentCny : g.spentCny;
      var pct = g.capCny > 0 ? Math.min(100, (spent / g.capCny) * 100) : 0;
      var cls = !g.allowed ? 'over' : (pct >= 80 ? 'warn' : '');
      var scale = g.scale === 1 ? '' : ' \u00d7' + g.scale;
      var labelTitle = g.name + ' \u00d7' + g.scale;
      return '<div class="dsh-cb-grow' + (cls ? ' ' + cls : '') + '">' +
        // 用 dsh-cb-glabel，**不能**复用 dsh-cb-gname：配置面板里的
        // .dsh-cb-gname 是组名 <input>，同名不同物会让选择器互相串味。
        '<span class="dsh-cb-glabel" title="' + escapeHtml(labelTitle) + '">' + escapeHtml(g.name + scale) + '</span>' +
        '<span class="dsh-cb-gtrack"><span class="dsh-cb-gfill" style="width:' +
          pct.toFixed(1) + '%"></span></span>' +
        '<span class="dsh-cb-gnum">' + fmt(spent) + '/' + fmt(g.capCny) + '</span>' +
      '</div>';
    }).join('');
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 渲染"当前时段"那一行。
   *
   * ⚠️ 必须在**客户端**作用域里：服务端函数调不到（CLIENT_JS 是被 eval 的
   *    独立脚本）。曾经把渲染函数写在服务端，结果 loadConfig 抛
   *    "renderPeakNow is not defined"，整个面板后半截渲染不出来。
   *    服务端只负责给数据（config.json 的 peakNow），渲染归客户端。
   */
  function renderPeakNow(info) {
    if (!info) return '<span class="dsh-cb-hint">--</span>';
    var tag = info.peak ? '峰价' : '谷价';
    var cls = info.peak ? 'dsh-cb-peak' : 'dsh-cb-valley';
    var tail = info.nextAt ? ' · ' + info.nextAt : '';
    return '<b class="' + cls + '">' + tag + '</b>' +
      '<span>' + info.reason + '（' + info.hour + ':00 北京时间）' + tail + '</span>';
  }

  function render(s) {
    var grouped = s.quotaMode === 'group';
    var source = s.spendSource || { effective: 'estimated', window: 'day' };
    var observed = source.effective === 'observed';
    var reasons = {
      disabled: '余额读取已关闭',
      'no-samples': '尚无余额数据',
      'context-mismatch': '账户范围或币种不匹配',
      'invalid-samples': '余额数据无效',
      'stale-samples': '余额数据已过期',
      'no-anchor': '缺少档位起点数据',
      'stale-anchor': '档位起点数据已过期'
    };
    var sourceLabel = observed ? '本档余额消费' : (source.effective === 'debug' ? '调试金额' : '当日 token 估算');
    if (source.fallback) sourceLabel += ' · 已回退：' + (reasons[source.fallback] || '余额数据不可用');
    els.source.textContent = sourceLabel;
    els.source.title = sourceLabel + (observed ? '；共享账户的其他消费也会计入，采样之间的充值可能掩盖消费' : '；金额按本地价格表估算');
    var pct = grouped ? (s.groups || []).reduce(function (highest, g) {
      var spent = g.spentCny == null ? g.effSpentCny : g.spentCny;
      return Math.max(highest, g.capCny > 0 ? Math.min(100, spent / g.capCny * 100) : 0);
    }, 0) : (s.capCny > 0 ? Math.min(100, (s.spentCny / s.capCny) * 100) : 0);
    els.num.textContent = grouped ? '累计 ' + fmt(s.spentCny) : fmt(s.spentCny) + ' / ' + fmt(s.capCny);
    els.num.title = grouped ? '当前档位基准额度 ' + fmt(s.capCny) + '，各组额度见下方' : '';
    els.fill.style.width = pct.toFixed(1) + '%';
    if (!s.exhausted) {
      els.fill.style.background = pct >= 80 ? '#f59e0b' : '#22c55e';
    }
    els.host.classList.toggle('dsh-cb-paused', !!s.exhausted);
    els.host.classList.toggle('dsh-cb-dry', !!s.dryRun);
    els.l.textContent = '第 ' + (s.tier + 1) + '/' + s.tierCount + ' 档';
    els.title.title = (grouped
      ? '当前档位：到 ' + s.resumeAt + ' 为止，各组上限为基准额度 ' + fmt(s.capCny) + ' × 各组倍率；进度显示额度占用最高的组'
      : '当前档位：到 ' + s.resumeAt + ' 为止，' + (observed ? '本档余额消费' : '当天累计估算') + '上限 ' + fmt(s.capCny)) +
      '\n点击折叠 / 展开；拖动可移动；双击空白复位';
    els.r.textContent = s.exhausted ? ('待到 ' + s.resumeAt) : ('下档 ' + s.resumeAt);
    renderGroups(s);
    // 内容增高也可能越界，不能只在用户拖动或窗口缩放时钳制位置。
    var bounds = host.getBoundingClientRect();
    if (bounds.left < 0 || bounds.top < 0 ||
        bounds.left + bounds.width > window.innerWidth ||
        bounds.top + bounds.height > window.innerHeight) {
      applyGeometry({ x: bounds.left, y: bounds.top });
    }
  }

  function applyState(s) {
    render(s);
    // 触顶/恢复时闪一下标题，作为不依赖 Notification 权限的提示。
    if (lastExhausted !== null && lastExhausted !== s.exhausted) {
      var old = document.title;
      document.title = (s.exhausted ? '\u26d4 预算用尽 · ' : '\u2705 预算恢复 · ') + old;
      setTimeout(function () { document.title = old; }, 6000);
    }
    lastExhausted = s.exhausted;
  }

  function poll(afterSave) {
    if (saving && afterSave !== true) return Promise.resolve(false);
    var epoch = stateEpoch, request = ++pollIssued;
    return fetch('/dsh-cost-budget/state.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (s) {
        if (!s || epoch !== stateEpoch || request < pollRendered) return false;
        pollRendered = request;
        applyState(s);
        return true;
      })
      .catch(function () { return false; });
  }

  function start() {
    style();
    build();
    poll();
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`

export default { name, inject, apply }
