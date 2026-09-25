/**
 * 默认只运行合成数据校准。手工对账须同时指定 --ledger、--amount、--day、--provider。
 * 两份输入应覆盖同一时间窗；CSV 的第七列为指标、第九列为数量。
 * 不自动寻找用户文件，也不输出日期、路径、provider、账户数值或错误正文。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseArgs } from 'node:util'

let passed = 0, failed = 0
function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
  condition ? passed++ : failed++
}

// 支持引号字段与 CRLF；解析错误只由调用方输出固定分类。
function csvRows(text) {
  const rows = [], row = []
  let field = '', quoted = false, closed = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') { quoted = false; closed = true }
      else field += char
    } else if (char === '"' && !field && !closed) quoted = true
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false
      if (char !== ',') {
        if (char === '\r' && text[i + 1] === '\n') i++
        if (row.some((value) => value.trim())) rows.push([...row])
        row.length = 0
      }
    } else {
      if (closed || char === '"') throw new Error('Invalid CSV')
      field += char
    }
  }
  if (quoted) throw new Error('Invalid CSV')
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

async function synthetic({ costOf, dedupeEvents, readLedger }) {
  const a = { sessionId: 'fixture-a', at: 100, units: 10 }
  const b = { ...a, group: 'default' }
  const c = { sessionId: 'fixture-a', at: 200, units: 5, group: 'default' }
  const d = { sessionId: 'fixture-b', at: 100, units: 7, group: 'default' }
  check('duplicate events merge', dedupeEvents([a, b, c, d]).length === 3)
  check('richer event retained', dedupeEvents([a, b])[0].group === 'default')
  check('input order preserves richer event', dedupeEvents([b, a])[0].group === 'default')
  check('different sessions remain distinct', dedupeEvents([a, d]).length === 2)
  check('empty input supported', dedupeEvents(null).length === 0)

  const tempRoot = path.resolve(os.tmpdir())
  const sandbox = fs.mkdtempSync(path.join(tempRoot, 'dsh-calibrate-'))
  try {
    const day = '2000-01-01'
    const ledgerFile = path.join(sandbox, 'fixture-ledger.json')
    fs.writeFileSync(ledgerFile, JSON.stringify({
      version: 1, currency: 'CNY', day, spentUnits: 20, events: [a, b],
    }))
    const { ledger } = await readLedger(ledgerFile, Date.parse(`${day}T00:00:00+08:00`), day)
    check('stored duplicates removed on read', ledger.events.length === 1)
    check('stored total recomputed', ledger.spentUnits === 10)
  } finally {
    const cleanupPath = path.resolve(sandbox)
    if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-calibrate-')) {
      throw new Error('Unexpected cleanup directory')
    }
    fs.rmSync(cleanupPath, { recursive: true, force: true })
  }

  const price = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
  const usage = { inputTokens: 1_000_000, outputTokens: 0 }
  const raw = costOf(usage, price, false, 0)
  check('unadjusted input tokens', raw.tokens.miss === 1_000_000)
  check('unadjusted cost', raw.cny === 1)
  const adjusted = costOf(usage, price, false, 0.5)
  check('synthetic cache miss estimate', adjusted.tokens.miss === 500_000)
  check('synthetic cache hit estimate', adjusted.tokens.hit === 500_000)
  check('synthetic adjusted cost', Math.abs(adjusted.cny - 0.51) < 1e-9)
  const reported = costOf({ inputTokens: 1000, cacheReadTokens: 500_000 }, price, false, 0.5)
  check('reported cache hits not estimated twice', reported.tokens.assumedHit === 0)
  check('reported misses preserved', reported.tokens.miss === 1000)
}

function reconcile(values, { dedupeEvents, beijingDay }) {
  let raw, rows
  try {
    raw = JSON.parse(fs.readFileSync(values.ledger, 'utf8'))
    rows = csvRows(fs.readFileSync(values.amount, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    console.error('INPUT_READ_OR_FORMAT_ERROR')
    process.exitCode = 1
    return
  }
  const metrics = {
    input_cache_miss_tokens: 'miss', input_cache_hit_tokens: 'hit',
    output_tokens: 'out', request_count: 'requests',
  }
  const billed = { miss: 0, hit: 0, out: 0, requests: 0 }
  let knownRows = 0
  try {
    if (!Array.isArray(raw?.events) || rows.length < 2) throw new Error('Invalid input')
    for (const row of rows.slice(1)) {
      if (!Object.hasOwn(metrics, row[6])) continue
      const value = Number(row[8])
      if (!row[8]?.trim() || !Number.isFinite(value) || value < 0) throw new Error('Invalid amount')
      billed[metrics[row[6]]] += value
      knownRows++
    }
    if (!knownRows) throw new Error('Missing metrics')
    const matched = raw.events.filter((event) => event && event.provider === values.provider &&
      beijingDay(event.at) === values.day)
    const events = dedupeEvents(matched)
    if (!events.length || !billed.requests) {
      console.error('NO_COMPARABLE_DATA')
      process.exitCode = 1
      return
    }
    const totals = { miss: 0, hit: 0, out: 0, requests: events.length }
    for (const event of events) {
      for (const metric of ['miss', 'hit', 'out']) {
        const value = Number(event.tokens?.[metric] ?? 0)
        if (!Number.isFinite(value) || value < 0) throw new Error('Invalid tokens')
        totals[metric] += value
      }
    }
    const ratio = totals.requests / billed.requests
    check('request count within broad snapshot tolerance', ratio >= 0.5 && ratio <= 2)
    // Token 上报口径可能不同；只报告比较方向，不泄露原始量或比值。
    for (const metric of ['miss', 'hit', 'out']) {
      const category = totals[metric] === billed[metric] ? 'MATCH' :
        totals[metric] > billed[metric] ? 'LEDGER_HIGHER' : 'LEDGER_LOWER'
      console.log(`INFO ${metric}: ${category}`)
    }
  } catch {
    console.error('INPUT_FORMAT_ERROR')
    process.exitCode = 1
  }
}

async function main() {
  let values
  try {
    ;({ values } = parseArgs({ options: {
      ledger: { type: 'string' }, amount: { type: 'string' },
      day: { type: 'string' }, provider: { type: 'string' }, help: { type: 'boolean' },
    } }))
    const specified = ['ledger', 'amount', 'day', 'provider'].filter((key) => values[key] !== undefined)
    if (specified.length && (specified.length !== 4 || specified.some((key) => !values[key].trim()))) {
      throw new Error('Incomplete arguments')
    }
    if (values.day) {
      const date = new Date(`${values.day}T00:00:00Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(values.day) || !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== values.day) throw new Error('Invalid day')
    }
  } catch {
    console.error('INVALID_ARGUMENTS')
    process.exitCode = 2
    return
  }
  if (values.help) {
    console.log('Usage: node test/calibrate.mjs [--ledger FILE --amount CSV --day YYYY-MM-DD --provider NAME]')
    console.log('Without arguments, only synthetic fixtures are tested. Manual output is redacted.')
    return
  }
  const pricing = await import('../lib/pricing.js')
  const ledger = await import('../lib/ledger.js')
  if (values.ledger) reconcile(values, { ...pricing, ...ledger })
  else await synthetic({ ...pricing, ...ledger })
  console.log(`===== ${passed} passed, ${failed} failed =====`)
  if (failed) process.exitCode = 1
}

await main().catch(() => {
  console.error('CALIBRATION_ERROR')
  process.exitCode = 1
})
