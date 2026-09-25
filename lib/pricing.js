/**
 * 计价模块 —— 把 DSH 的 token 用量折算成 CNY。
 *
 * DSH 用量字段的计价约定：
 *   1. 计数是**互斥**的：inputTokens 只含未命中，缓存单独上报。
 *      所以是 input×miss + cacheRead×hit + output×out，
 *      绝不是 (input)×miss + cache×hit —— 后者把命中重复计了一次未命中价。
 *   2. reasoningTokens 已含在 outputTokens 内，**不得再加**。
 */

/** 单价，CNY / 百万 token。[0] = 谷时，[1] = 峰时 */
const PRICING = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] },
}

/** 模型 id 别名 → 主键。按 key 长度降序匹配，避免短键抢先。 */
const ALIASES = {
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash', // 兼容模型别名，按 flash 价估算
}

/** 未匹配到任何价目时用的兜底（= flash 价），并告警一次。 */
const FALLBACK = PRICING['deepseek-flash']

const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length)
const PRICE_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length)

/**
 * 解析模型 id → 价目表条目。
 * 用子串匹配（与挂件 priceFor 一致），因为模型 id 可能带前缀/后缀。
 * @returns {{ price: object, matched: string|null }}
 */
export function resolvePrice(model) {
  const m = String(model || '').toLowerCase()
  if (!m) return { price: FALLBACK, matched: null }

  for (const key of ALIAS_KEYS) {
    if (m.includes(key)) {
      const canonical = ALIASES[key]
      return { price: PRICING[canonical], matched: canonical }
    }
  }
  for (const key of PRICE_KEYS) {
    if (m.includes(key)) return { price: PRICING[key], matched: key }
  }
  return { price: FALLBACK, matched: null }
}

/** 北京时间（UTC+8）的 星期(0=周日) 与 小时。 */
export function beijingParts(epochMs) {
  const d = new Date(epochMs + 8 * 3600 * 1000)
  return { weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() }
}

/** 北京时间日期串 YYYY-MM-DD —— 账本的"当天"口径。 */
export function beijingDay(epochMs) {
  return new Date(epochMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 是否峰时。峰时 = **工作日** 09:00-12:00 与 14:00-18:00（北京时间）。
 *
 * ⚠️ "工作日"不能只看星期几：法定节假日（含调休放假）全天谷价，
 *    所以必须查日历。calendar 为 undefined 时退化为"只看周末"（旧行为），
 *    这种情况会高估节假日成本 —— 调用方应尽量传入日历。
 *
 * @param calendar { isRestDay(day, weekday) } —— 见 lib/calendar.js
 */
export function isPeak(epochMs, peakHours, calendar) {
  const { weekday, hour } = beijingParts(epochMs)
  const day = beijingDay(epochMs)

  // 休息日（周末或法定节假日）全天谷价
  const rest = calendar
    ? calendar.isRestDay(day, weekday)
    : (weekday === 0 || weekday === 6)
  if (rest) return false

  for (const [from, to] of peakHours) {
    if (hour >= from && hour < to) return true
  }
  return false
}

/**
 * 单次调用的成本（CNY）。
 * @param usage  DSH 的 usage 对象：{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, ... }
 * @param price  resolvePrice() 返回的价目条目
 * @param peak   是否峰时
 * @param assumedHitRatio
 *        该 provider **未上报**缓存命中时的推定命中率（0–1）。
 *        为 0（默认）时不改动任何数值。
 *
 *        网关可能将全部输入报为未命中，导致按公开价目估算偏高。
 *        只有独立核实该 provider 存在未上报的缓存命中时才配置。
 *        不同账户或网关的账单没有共同计费来源，不能用于互相反推命中率。
 *
 * @returns {{ cny: number, tokens: object }}
 */
export function costOf(usage, price, peak, assumedHitRatio = 0) {
  const off = peak ? 1 : 0

  // DSH 侧字段名是 inputTokens（不含缓存），投影侧叫 uncachedInputTokens。两个都认。
  let miss = num(usage.uncachedInputTokens ?? usage.inputTokens)
  const hit = num(usage.cacheReadTokens)
  const write = num(usage.cacheWriteTokens)
  const out = num(usage.outputTokens) // reasoningTokens 已含在内，不加

  // provider 不上报缓存命中时，按推定命中率把 miss 拆成 miss + hit
  let assumedHit = 0
  const r = Number(assumedHitRatio)
  if (Number.isFinite(r) && r > 0 && r <= 1 && hit === 0 && miss > 0) {
    assumedHit = miss * r
    miss = miss - assumedHit
  }

  // 缓存写入按"未命中价"计（保守：DSH 未定义单独口径，宁可高估）
  const cny =
    (miss / 1e6) * price.miss[off] +
    ((hit + assumedHit) / 1e6) * price.hit[off] +
    (write / 1e6) * price.miss[off] +
    (out / 1e6) * price.out[off]

  return { cny, tokens: { miss, hit: hit + assumedHit, write, out, assumedHit } }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}
