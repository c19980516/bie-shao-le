/**
 * 节假日日历 —— 决定某一天是否"全天谷价"。
 *
 * 官方规则（§实测查证）：
 *   峰谷时段只适用于**工作日**。以下两类日子全天按谷价计费：
 *     · 周六周日
 *     · 中国法定节假日（含调休放假）
 *   注意"调休上班的周末"也算谷价 —— DeepSeek 明确过"别人上班它放假"。
 *   所以判定退化成一句：**这天是不是休息日**，不需要区分调休方向。
 *
 * 光靠 getDay() 是错的：国庆、春节这类落在工作日的假期会被当成峰时，
 * 成本直接高估近一倍。所以需要一张日历。
 *
 * 日历来源按优先级：
 *   1. 配置文件里的 holidays / valleyDays（你手填的）
 *   2. 线上日历缓存（见 lib/index.js 的 fetchCalendar，落盘到 $DSH_HOME）
 *   3. 内置的 2026 年表（兜底，不联网也能对）
 */

/** 内置兜底表：中国法定节假日（放假日期）。每年国务院公布，需要更新。 */
export const BUILTIN_HOLIDAYS = {
  2026: [
    // 元旦
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节（2026-02-17 除夕）
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-02-19', '2026-02-20', '2026-02-21',
    // 清明
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋 + 国庆
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
}

/** 日期串 YYYY-MM-DD 归一化；非法返回 null。 */
export function normalizeDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const [, y, mo, d] = m
  const mm = Number(mo), dd = Number(d)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${y}-${mo}-${d}`
}

/**
 * 建一个日历查询器。
 * @param opts.holidays   额外/覆盖的节假日日期数组（YYYY-MM-DD）
 * @param opts.workdays   强制视为工作日的日期（用于覆盖线上表的误判）
 * @param opts.useBuiltin 是否合并内置表，默认 true
 * @param opts.years      只合并这些年份的内置表；不传则全部
 */
export function createCalendar(opts = {}) {
  const holidays = new Set()
  const workdays = new Set()
  const sources = []

  if (opts.useBuiltin !== false) {
    for (const [year, days] of Object.entries(BUILTIN_HOLIDAYS)) {
      if (opts.years && !opts.years.includes(Number(year))) continue
      for (const d of days) holidays.add(d)
    }
    sources.push('builtin')
  }

  for (const d of toDayList(opts.extraHolidays)) holidays.add(d)
  if (toDayList(opts.extraHolidays).length) sources.push('config')

  for (const d of toDayList(opts.workdays)) workdays.add(d)
  if (toDayList(opts.workdays).length) sources.push('workdays-override')

  return {
    /** 这天是否是休息日（周末或法定节假日）。workdays 覆盖优先。 */
    isRestDay(day, weekday) {
      if (workdays.has(day)) return false
      if (holidays.has(day)) return true
      return weekday === 0 || weekday === 6
    },
    /** 这天是否在节假日表里（不含普通周末） */
    isHoliday(day) {
      return holidays.has(day) && !workdays.has(day)
    },
    stats() {
      return { holidays: holidays.size, workdays: workdays.size, sources }
    },
    has(day) { return holidays.has(day) },
  }
}

function toDayList(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : [])
  return arr.map(normalizeDay).filter(Boolean)
}

/**
 * 解析线上日历（date.nager.at 的 PublicHolidays 格式）。
 * 返回 { days: [...], ok, error }。宽容解析：字段缺失就跳过，不抛错。
 */
export function parseOnlineCalendar(json) {
  const days = []
  const list = Array.isArray(json) ? json : (Array.isArray(json?.holidays) ? json.holidays : [])
  for (const item of list) {
    const raw = item?.date || item?.day || item?.holidayDate
    const d = normalizeDay(raw)
    if (d) days.push(d)
  }
  return { days, ok: days.length > 0 }
}
