/** 诊断脚本的输出防泄露回归；所有凭证、账户数据和网络响应均为虚构夹具。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const preload = new URL('./harness-dependencies.mjs', import.meta.url).href
const tempRoot = path.resolve(os.tmpdir())
const sandbox = fs.mkdtempSync(path.join(tempRoot, 'dsh-privacy-'))
const marker = path.join(sandbox, 'calls.jsonl')
const mock = path.join(sandbox, 'mock.mjs')
const fakeKey = 'FAKE_KEY_DO_NOT_USE_0123456789'
const fakeBalance = '88888.123456'
const fakeError = 'fixture-private-error-text'
const fakeProvider = 'fixture-private-provider'
const fakeDay = '2001-02-03'
let passed = 0, failed = 0
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  ok ? passed++ : failed++
}

try {
  fs.writeFileSync(mock, `
import fs from 'node:fs'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
const marker = process.env.DSH_PRIVACY_MARKER
const mode = process.env.DSH_PRIVACY_MODE
const record = value => fs.appendFileSync(marker, JSON.stringify(value) + '\\n')
const originalRead = fs.readFileSync
fs.readFileSync = function (file, ...args) {
  if (String(file).endsWith('.credentials.yaml')) {
    record({ type: 'credential' })
    if (mode === 'credential') return 'DEEPSEEK_API_KEY: ' + process.env.DSH_PRIVACY_FAKE_KEY + '\\n'
    throw new Error(process.env.DSH_PRIVACY_FAKE_ERROR)
  }
  return originalRead.call(this, file, ...args)
}
syncBuiltinESMExports()
net.Socket.prototype.connect = function () { throw new Error('Test network disabled') }
globalThis.fetch = async function (url, options) {
  record({ type: 'fetch', official: url === 'https://api.deepseek.com/user/balance',
    authenticated: options?.headers?.Authorization === 'Bearer ' + process.env.DSH_PRIVACY_FAKE_KEY })
  if (mode === 'network') throw new Error(process.env.DSH_PRIVACY_FAKE_ERROR)
  if (mode === 'timeout') { const error = new Error(process.env.DSH_PRIVACY_FAKE_ERROR); error.name = 'AbortError'; throw error }
  return {
    status: mode === 'http' ? 401 : 200,
    ok: mode !== 'http',
    async json() {
      record({ type: 'body' })
      if (mode === 'json') throw new Error(process.env.DSH_PRIVACY_FAKE_ERROR)
      if (mode === 'invalid') return { error: process.env.DSH_PRIVACY_FAKE_ERROR }
      return { is_available: mode !== 'unavailable', balance_infos: [{
        currency: 'CNY', total_balance: process.env.DSH_PRIVACY_FAKE_BALANCE,
        private_data: process.env.DSH_PRIVACY_FAKE_ERROR,
      }] }
    },
    async text() { record({ type: 'body' }); return process.env.DSH_PRIVACY_FAKE_ERROR },
  }
}
`)
  const forbidden = [fakeKey, fakeKey.slice(0, 6), fakeBalance, fakeError, fakeProvider, fakeDay, sandbox,
    'https://api.deepseek.com/user/balance', '7654321', '8765432', '9876543']
  function run(script, args = [], mode = 'success', key = fakeKey) {
    fs.writeFileSync(marker, '')
    const result = spawnSync(process.execPath, [
      '--import', preload, '--import', pathToFileURL(mock).href,
      path.join(pluginRoot, 'test', script), ...args,
    ], {
      cwd: pluginRoot, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: {
        ...process.env, NODE_OPTIONS: '', DSH_HOME: sandbox, DSH_TEST_HOME: sandbox,
        USERPROFILE: sandbox, HOME: sandbox, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox,
        DEEPSEEK_API_KEY: key,
        DSH_PRIVACY_MARKER: marker, DSH_PRIVACY_MODE: mode,
        DSH_PRIVACY_FAKE_KEY: fakeKey, DSH_PRIVACY_FAKE_BALANCE: fakeBalance,
        DSH_PRIVACY_FAKE_ERROR: fakeError,
      },
    })
    const output = `${result.stdout || ''}${result.stderr || ''}`
    const calls = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    return { ...result, output, calls, redacted: forbidden.every((value) => !output.includes(value)) }
  }

  const ordinary = run('probe-balance.mjs')
  check('probe default shows usage', ordinary.status === 0 && ordinary.output.includes('Usage:'))
  check('probe default never reads credentials or fetches', ordinary.calls.length === 0)
  check('probe default output is redacted', ordinary.redacted)
  const help = run('probe-balance.mjs', ['--live', '--help'])
  check('probe help never performs live work', help.status === 0 && help.calls.length === 0)
  const invalid = run('probe-balance.mjs', [`--${fakeError}`])
  check('probe invalid argument is classified without echo', invalid.status === 2 && invalid.redacted &&
    invalid.output.trim() === 'INVALID_ARGUMENTS' && invalid.calls.length === 0)

  for (const [mode, expected, status] of [
    ['success', 'AVAILABLE', 0], ['credential', 'AVAILABLE', 0],
    ['http', 'UNAVAILABLE', 1], ['network', 'NETWORK_ERROR', 1],
    ['timeout', 'TIMEOUT', 1], ['json', 'INVALID_RESPONSE', 1],
    ['invalid', 'INVALID_RESPONSE', 1], ['unavailable', 'UNAVAILABLE', 1],
  ]) {
    const result = run('probe-balance.mjs', ['--live'], mode, mode === 'credential' ? '' : fakeKey)
    check(`live probe ${mode} classified`, result.status === status && result.output.split(/\r?\n/).includes(expected))
    check(`live probe ${mode} output redacted`, result.redacted)
    check(`live probe ${mode} uses only authenticated official endpoint`, result.calls.filter((row) => row.type === 'fetch')
      .length === 1 && result.calls.find((row) => row.type === 'fetch')?.official &&
      result.calls.find((row) => row.type === 'fetch')?.authenticated)
    if (mode === 'http') check('HTTP failures do not inspect response body', !result.calls.some((row) => row.type === 'body'))
    if (mode === 'credential') check('credential file read requires live opt in', result.calls.some((row) => row.type === 'credential'))
  }
  const missing = run('probe-balance.mjs', ['--live'], 'missing', '')
  check('missing credential classified', missing.status === 1 && missing.output.trim() === 'MISSING_CREDENTIAL')
  check('missing credential never fetches or exposes read errors', missing.redacted && !missing.calls.some((row) => row.type === 'fetch'))

  const synthetic = run('calibrate.mjs')
  check('default calibration passes synthetic fixtures', synthetic.status === 0 && synthetic.output.includes('14 passed, 0 failed'))
  check('default calibration never reads credentials or fetches', synthetic.calls.length === 0)
  check('default calibration output redacted', synthetic.redacted)
  const ledgerFile = path.join(sandbox, 'fixture-private-ledger.json')
  const amountFile = path.join(sandbox, 'fixture-private-amount.csv')
  const at = Date.parse(`${fakeDay}T12:00:00+08:00`)
  const event = { sessionId: 'fixture-a', at, provider: fakeProvider,
    tokens: { miss: 7654321, hit: 8765432, out: 9876543 } }
  fs.writeFileSync(ledgerFile, JSON.stringify({ events: [
    event, { ...event, group: 'default' },
    { ...event, sessionId: 'fixture-b', provider: 'another-fixture' },
    { ...event, at: at + 86400000 },
  ] }))
  const csv = 'a,b,c,d,e,f,metric,h,amount\r\n' + [
    ['input_cache_miss_tokens', 7654321], ['input_cache_hit_tokens', 8765432],
    ['output_tokens', 9876543], ['request_count', 1],
  ].map(([metric, count]) => `"fixture,quoted",b,c,d,e,f,${metric},h,${count}`).join('\r\n') + '\r\n'
  fs.writeFileSync(amountFile, csv)
  const args = ['--ledger', ledgerFile, '--amount', amountFile, '--day', fakeDay, '--provider', fakeProvider]
  const manual = run('calibrate.mjs', args)
  check('explicit calibration selects day/provider and deduplicates', manual.status === 0 &&
    manual.output.includes('1 passed, 0 failed') && ['miss', 'hit', 'out'].every((metric) => manual.output.includes(`INFO ${metric}: MATCH`)))
  check('explicit calibration output redacted and offline', manual.redacted && manual.calls.length === 0)
  const incomplete = run('calibrate.mjs', ['--ledger', ledgerFile])
  check('incomplete calibration arguments classified without echo', incomplete.status === 2 && incomplete.redacted &&
    incomplete.output.trim() === 'INVALID_ARGUMENTS')
  const malformedDay = run('calibrate.mjs', args.map((value) => value === fakeDay ? fakeError : value))
  check('invalid calibration date classified without echo', malformedDay.status === 2 && malformedDay.redacted &&
    malformedDay.output.trim() === 'INVALID_ARGUMENTS')
  const absent = run('calibrate.mjs', args.map((value) => value === ledgerFile ? `${ledgerFile}.missing` : value))
  check('input file errors classified without paths', absent.status === 1 && absent.redacted &&
    absent.output.includes('INPUT_READ_OR_FORMAT_ERROR'))
  fs.writeFileSync(ledgerFile, `invalid-json-${fakeError}`)
  const malformed = run('calibrate.mjs', args)
  check('invalid JSON classified without source text', malformed.status === 1 && malformed.redacted &&
    malformed.output.includes('INPUT_READ_OR_FORMAT_ERROR'))
  fs.writeFileSync(ledgerFile, JSON.stringify({ events: [event] }))
  fs.writeFileSync(amountFile, csv.replace('7654321', fakeError))
  const badAmount = run('calibrate.mjs', args)
  check('invalid CSV amount classified without source text', badAmount.status === 1 && badAmount.redacted &&
    badAmount.output.includes('INPUT_FORMAT_ERROR'))
  fs.writeFileSync(amountFile, csv.replace('request_count,h,1', 'request_count,h,10'))
  const mismatch = run('calibrate.mjs', args)
  check('manual mismatch reports failure without quantities', mismatch.status === 1 && mismatch.redacted &&
    mismatch.output.includes('FAIL request count'))
} finally {
  const cleanupPath = path.resolve(sandbox)
  if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-privacy-')) {
    throw new Error('Unexpected cleanup directory')
  }
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}

console.log(`===== ${passed} passed, ${failed} failed =====`)
process.exitCode = failed ? 1 : 0
