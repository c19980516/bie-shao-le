/**
 * 官方余额接口的可用性探针。默认只显示用法，不读取凭证、不联网。
 * 显式传入 --live 后才从环境变量或 DSH 凭证文件读取官方 API key。
 * 输出限于可用性、HTTP 状态和固定错误分类，不输出账户数据或错误正文。
 */
import { parseArgs } from 'node:util'

async function main() {
  let values
  try {
    ;({ values } = parseArgs({ options: {
      live: { type: 'boolean' }, help: { type: 'boolean' },
    } }))
  } catch {
    console.error('INVALID_ARGUMENTS')
    process.exitCode = 2
    return
  }
  if (!values.live || values.help) {
    console.log('Usage: node test/probe-balance.mjs --live')
    console.log('Live mode reads DEEPSEEK_API_KEY from the environment or DSH credentials.')
    return
  }

  const { readCredential } = await import('../lib/balance.js')
  const key = process.env.DEEPSEEK_API_KEY?.trim() || readCredential('DEEPSEEK_API_KEY')
  if (!key) {
    console.log('MISSING_CREDENTIAL')
    process.exitCode = 1
    return
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` }, signal: controller.signal,
    })
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
      console.log(`HTTP ${response.status}`)
    }
    if (!response.ok) {
      console.log('UNAVAILABLE')
      process.exitCode = 1
      return
    }
    let body
    try {
      body = await response.json()
    } catch {
      console.log(controller.signal.aborted ? 'TIMEOUT' : 'INVALID_RESPONSE')
      process.exitCode = 1
      return
    }
    const valid = Array.isArray(body?.balance_infos) && body.balance_infos.some((row) =>
      row?.total_balance != null && String(row.total_balance).trim() !== '' &&
      Number.isFinite(Number(row.total_balance)))
    if (!valid) {
      console.log('INVALID_RESPONSE')
      process.exitCode = 1
    } else if (body.is_available === false) {
      console.log('UNAVAILABLE')
      process.exitCode = 1
    } else {
      console.log('AVAILABLE')
    }
  } catch (error) {
    console.log(controller.signal.aborted || error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR')
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

await main().catch(() => {
  console.error('PROBE_ERROR')
  process.exitCode = 1
})
