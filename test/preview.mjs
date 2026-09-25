/** 本地浏览器预览：仅合成账本，禁用外部网络与真实凭证读取。输入 quit 退出并清理。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'harness-root': { type: 'string' } } })
const tempRoot = path.resolve(os.tmpdir())
const home = fs.mkdtempSync(path.join(tempRoot, 'dsh-budget-preview-'))
for (const key of ['DSH_HOME', 'DSH_TEST_HOME', 'USERPROFILE', 'HOME']) process.env[key] = home
globalThis.fetch = async () => { throw new Error('Preview: external requests disabled') }
if (values['harness-root']) {
  const hostRequire = createRequire(path.join(path.resolve(values['harness-root']), 'package.json'))
  const imports = new Set(['@deepseek-ai/dsh-atomic-write', '@deepseek-ai/dsh-home-paths'])
  const libRoot = new URL('../lib/', import.meta.url).href
  registerHooks({ resolve(specifier, context, next) {
    return imports.has(specifier) && context.parentURL?.startsWith(libRoot)
      ? { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true }
      : next(specifier, context)
  } })
}

const at = Date.now()
const day = new Date(at + 8 * 3600e3).toISOString().slice(0, 10)
fs.writeFileSync(path.join(home, 'dsh-cost-budget.json'), JSON.stringify({
  version: 1, currency: 'CNY', day, spentUnits: 300000, spentByGroup: {},
  events: [
    { sessionId: 'synthetic-a', at: at - 2000, provider: 'deepseek-official', units: 125000 },
    { sessionId: 'synthetic-b', at: at - 1000, provider: 'example-gateway', units: 175000 },
  ],
}))
const routes = new Map(), effects = [], taps = []
const { apply } = await import('../lib/index.js')
apply({
  logger: { info() {}, warn() {} },
  on: () => () => {},
  effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); return dispose },
  provide: () => () => {},
  inject: () => {},
  webServer: {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    tapIndex(tap) { taps.push(tap); return () => {} },
  },
  sessions: { list: () => [] }, agents: { list: () => [] },
  goals: { get: () => undefined }, tools: {}, sessionProjections: {},
}, {
  dryRun: true, ladder: [{ until: '24:00', cap: 40 }],
  balance: { enabled: false, poll: false }, calendarUrl: '', backfillDays: 0,
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const html = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预算插件隔离预览</title><body style="font-family:system-ui;background:#101014;color:#e4e4e7;padding:32px"><h1>预算插件隔离预览</h1><p>仅合成数据；修改设置不会影响真实 DSH。</p></body></html>'
    res.end(taps.reduce((page, tap) => tap(page), html))
    return
  }
  const route = routes.get(url.pathname)
  if (!route) { res.writeHead(404); res.end(); return }
  try {
    await route.handler(req, res)
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end('Preview request failed')
  }
})
server.listen(0, '127.0.0.1', () => {
  console.log('Preview: http://127.0.0.1:' + server.address().port)
  console.log('Type quit and press Enter to stop and remove the synthetic data.')
})
function cleanup() {
  for (const dispose of effects.reverse()) { try { dispose() } catch {} }
  const target = path.resolve(home)
  if (path.dirname(target) === tempRoot && path.basename(target).startsWith('dsh-budget-preview-')) {
    fs.rmSync(target, { recursive: true, force: true })
  }
}
process.once('exit', cleanup)
function shutdown() {
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (text) => { if (text.trim() === 'quit') shutdown() })
