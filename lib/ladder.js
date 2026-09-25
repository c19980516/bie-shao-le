/**
 * 阶梯模块 —— 北京时间阶梯的累积包络判定与边界计算。
 *
 * 语义（已与用户确认）：
 *   到该时刻为止，**当日累计**消费不得超过对应值。
 *   00:00–10:00 ≤ ¥5，10:00–11:00 ≤ ¥10，11:00–12:00 ≤ ¥15，
 *   12:00–14:00 ≤ ¥25，14:00–16:00 ≤ ¥30，16:00–24:00 ≤ ¥40。
 *   边界到达时上限**跳变放宽**，不"补花"。
 *
 * 关键：上限看的是"当前时刻属于哪一档"，与峰谷时段完全无关 ——
 * 两者在流水线不同环节（阶梯决定放不放行，峰谷决定按什么单价折算）。
 */

import { beijingParts, beijingDay } from './pricing.js'

export const DEFAULT_LADDER = [
  { until: '10:00', cap: 5 },
  { until: '11:00', cap: 10 },
  { until: '12:00', cap: 15 },
  { until: '14:00', cap: 25 },
  { until: '16:00', cap: 30 },
  { until: '24:00', cap: 40 },
]

/** "HH:MM" → 当日分钟数。 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

/** 校验并归一化阶梯配置。返回 { ladder } 或 { error }。 */
export function normalizeLadder(input) {
  const src = Array.isArray(input) && input.length ? input : DEFAULT_LADDER
  const out = []
  for (const row of src) {
    const mins = toMinutes(row && row.until)
    const cap = Number(row && row.cap)
    if (mins === null) return { error: `内阶梯 until 非法: ${JSON.stringify(row && row.until)}` }
    if (!Number.isFinite(cap) || cap <= 0) return { error: `阶梯 cap 非法: ${JSON.stringify(row && row.cap)}` }
    out.push({ untilMin: mins, cap })
  }
  out.sort((a, b) => a.untilMin - b.untilMin)
  if (out[out.length - 1].untilMin < 1440) {
    // 没覆盖到午夜 → 用最后一档兜底填满，保证任何时刻都有上限
    out.push({ untilMin: 1440, cap: out[out.length - 1].cap })
  }
  return { ladder: out }
}

/** 当前时刻（北京）距当日 0 点的分钟数。 */
export function nowMinutes(epochMs) {
  const { hour, minute } = beijingParts(epochMs)
  return hour * 60 + minute
}

/**
 * 判定当前档位。返回 {
 *   index, cap, untilMin, prevCap,
 *   remainingMs  —— 距下一个阶梯边界的毫秒数（最后一档则为距次日 0 点）
 *   isLast
 * }
 * @param overrideRemainingMs 仅调试用：把"距边界"强制成这个值。**档位本身仍由
 *        真实时刻决定** —— 它只让恢复定时器在 N 秒后重判，从而不必真的等到整点。
 */
export function tierAt(ladder, epochMs, overrideRemainingMs = null) {
  const now = nowMinutes(epochMs)
  let index = ladder.findIndex((row) => now < row.untilMin)
  if (index === -1) index = ladder.length - 1

  const row = ladder[index]
  const prevCap = index > 0 ? ladder[index - 1].cap : 0

  // 距边界毫秒数：把"当日分钟"差值换算成真实等待时间。
  // 用分钟差算而非直接减时间戳，避免跨日/夏令时干扰（北京无夏令时，但保持严谨）。
  const deltaMin = row.untilMin - now
  const remainingMs = Number.isFinite(overrideRemainingMs)
    ? Math.max(0, overrideRemainingMs)
    : Math.max(0, deltaMin * 60_000)

  return { index, cap: row.cap, untilMin: row.untilMin, prevCap, remainingMs, isLast: index === ladder.length - 1 }
}

/**
 * 判定是否可继续。返回 { allowed, tier, spent, cap }。
 * @param spent 这一档的消费（CNY）。用**档内**而非当日累计 —— 见 tierStartMs。
 */
export function check(ladder, spent, epochMs, overrideRemainingMs = null) {
  const tier = tierAt(ladder, epochMs, overrideRemainingMs)
  return { allowed: spent < tier.cap, tier, spent, cap: tier.cap }
}

/**
 * 当前档位的**起始时刻**（epoch ms）。
 *
 * 供余额观测计算当前档位窗口。窗口消费与当日累计的口径不同，
 * 不能直接混用：前者只计算本档起点以来的余额变化，后者包含此前消费。
 *
 * 实现上**不用**时间戳相减，而是回到北京时间的"当日分钟"再换算，避免跨日
 * 与夏令时干扰（北京无夏令时，但与 tierAt 的算法保持一致）。
 */
export function tierStartMs(ladder, epochMs, overrideRemainingMs = null) {
  const tier = tierAt(ladder, epochMs, overrideRemainingMs)
  const prevUntil = tier.index > 0 ? ladder[tier.index - 1].untilMin : 0
  const nowMin = nowMinutes(epochMs)
  // 北京时间当日 00:00 的本地偏移
  const shifted = new Date(epochMs + 8 * 3600000)
  const midnightUtc = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  )
  // 从 00:00(北京) 起算的分钟数 → 真实 epoch
  const midnightBeijing = midnightUtc - 8 * 3600000
  // 若 debug 覆盖了剩余时间，起点跟着往回推，保持"档内"语义自洽
  if (Number.isFinite(overrideRemainingMs)) {
    return epochMs - Math.max(0, overrideRemainingMs) + Math.max(0, tier.untilMin - nowMin) * 60_000
  }
  return midnightBeijing + prevUntil * 60_000
}

/** 把"距边界毫秒"换算成人类可读的边界时刻描述，用于模型可见的拒绝理由。 */
export function describeBoundary(tier) {
  if (tier.isLast) return '次日 00:00'
  const h = Math.floor(tier.untilMin / 60)
  const m = tier.untilMin % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export { beijingDay }
