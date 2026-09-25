/**
 * 测试凭证、金额、用量和 provider 名称均为合成数据；固定日期仅用于时间边界。
 * 节假日日历 / 峰谷判定测试。
 * 重点：法定节假日落在工作日时必须按谷价 —— 这是原来的 bug。
 * 用 import 断言"不传日历"的旧行为，防止改动悄悄退化。
 */
import { createCalendar, parseOnlineCalendar, BUILTIN_HOLIDAYS, normalizeDay } from '../lib/calendar.js'
import { isPeak } from '../lib/pricing.js'

let pass = 0, fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`)
  ok ? pass++ : fail++
}

const HOURS = [[9, 12], [14, 18]]
const cal = createCalendar({})
const bj = (s) => Date.parse(s + '+08:00')
const wd = (s) => new Date(bj(s) + 8 * 3600e3).getUTCDay()

console.log('=== 1. 普通工作日：按峰谷时段 ===')
check('周一 10:00 峰时', isPeak(bj('2026-09-21T10:00:00'), HOURS, cal), true)
check('周一 13:00 谷时（午休）', isPeak(bj('2026-09-21T13:00:00'), HOURS, cal), false)
check('周一 15:00 峰时', isPeak(bj('2026-09-21T15:00:00'), HOURS, cal), true)
check('周一 19:00 谷时', isPeak(bj('2026-09-21T19:00:00'), HOURS, cal), false)

console.log('\n=== 2. 周末：全天谷价 ===')
check('周六 10:00 谷时', isPeak(bj('2026-09-26T10:00:00'), HOURS, cal), false)
check('周日 15:00 谷时', isPeak(bj('2026-09-27T15:00:00'), HOURS, cal), false)

console.log('\n=== 3. 法定节假日落在工作日：全天谷价（原 bug）===')
check('10-01 是周四', wd('2026-10-01T12:00:00'), 4)
check('10-01 10:00 → 谷时', isPeak(bj('2026-10-01T10:00:00'), HOURS, cal), false)
check('02-17 是周二', wd('2026-02-17T12:00:00'), 2)
check('02-17 15:00 → 谷时', isPeak(bj('2026-02-17T15:00:00'), HOURS, cal), false)
check('05-01 是周五', wd('2026-05-01T12:00:00'), 5)
check('05-01 10:00 → 谷时', isPeak(bj('2026-05-01T10:00:00'), HOURS, cal), false)

console.log('\n=== 4. 反向断言：没有日历时旧 bug 仍在（防止悄悄退化）===')
check('不传日历 10-01 被判峰时', isPeak(bj('2026-10-01T10:00:00'), HOURS, undefined), true)

console.log('\n=== 5. valleyDays 覆盖线上表误判 ===')
const cal2 = createCalendar({ workdays: ['2026-10-01'] })
check('强制算工作日后 10-01 恢复峰时', isPeak(bj('2026-10-01T10:00:00'), HOURS, cal2), true)

console.log('\n=== 6. 自定义 holidays 增补 ===')
const cal3 = createCalendar({ extraHolidays: ['2026-09-21'] })
check('把今天加成节假日后 → 谷时', isPeak(bj('2026-09-21T10:00:00'), HOURS, cal3), false)

console.log('\n=== 7. 线上格式解析 ===')
check('nager 格式', parseOnlineCalendar([{ date: '2027-01-01', name: 'New Year' }]).days, ['2027-01-01'])
check('空数组 → ok=false', parseOnlineCalendar([]).ok, false)
check('垃圾输入不抛错', parseOnlineCalendar(null).days, [])
check('日期归一化拒绝非法值', normalizeDay('2026-13-99'), null)
check('内置表只含 2026', Object.keys(BUILTIN_HOLIDAYS), ['2026'])
check('内置表天数合理', BUILTIN_HOLIDAYS[2026].length >= 25, true)

console.log(`\n===== ${pass} passed, ${fail} failed =====`)
process.exit(fail ? 1 : 0)
