/** 离线测试入口；可显式借用本机 harness 的依赖，不改动其安装或配置。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'harness-root': { type: 'string' } } })
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const preload = new URL('./harness-dependencies.mjs', import.meta.url).href
const suites = [
  'calendar', 'groups', 'grouping', 'config', 'dryrun',
  'drive', 'bar', 'panelcontract', 'balance', 'spendsource', 'recovery', 'ledger', 'goalcontrol', 'privacy',
]
const harnessRoot = values['harness-root'] ? path.resolve(values['harness-root']) : ''
if (harnessRoot && !fs.existsSync(path.join(harnessRoot, 'package.json'))) {
  throw new Error(`harness 根目录缺少 package.json: ${harnessRoot}`)
}
// 显式借用宿主时额外验证其真实 round driver，插件本地依赖不包含该服务。
if (harnessRoot) suites.push('hostdriver')

const tempRoot = path.resolve(os.tmpdir())
const sandbox = fs.mkdtempSync(path.join(tempRoot, 'dsh-budget-tests-'))
const failed = []
try {
  for (const suite of suites) {
    const home = path.join(sandbox, suite)
    const temp = path.join(home, 'tmp')
    fs.mkdirSync(temp, { recursive: true })
    console.log(`\n===== ${suite} =====`)
    const result = spawnSync(process.execPath, [
      '--import', preload, path.join(pluginRoot, 'test', `${suite}.mjs`),
    ], {
      cwd: pluginRoot,
      stdio: 'inherit',
      timeout: 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        // 先于模块导入隔离路径，测试内部创建的临时文件也会落在该目录下。
        DSH_HOME: home, DSH_TEST_HOME: home, USERPROFILE: home, HOME: home,
        TMPDIR: temp, TMP: temp, TEMP: temp,
        DSH_TEST_HARNESS_ROOT: harnessRoot,
        // 不继承外部预加载器，避免测试从真实环境读取配置。
        NODE_OPTIONS: '',
      },
    })
    if (result.status !== 0 || result.error) {
      failed.push(suite)
      if (result.error) console.error(result.error.message)
      if (result.signal) console.error(`${suite} terminated by ${result.signal}`)
    }
  }
} finally {
  const cleanupPath = path.resolve(sandbox)
  if (path.dirname(cleanupPath) !== tempRoot || !path.basename(cleanupPath).startsWith('dsh-budget-tests-')) {
    throw new Error(`Refusing to remove unexpected test directory: ${cleanupPath}`)
  }
  fs.rmSync(cleanupPath, { recursive: true, force: true })
}

console.log(`\n===== ${suites.length - failed.length}/${suites.length} suites passed =====`)
if (failed.length) console.error(`Failed: ${failed.join(', ')}`)
process.exitCode = failed.length ? 1 : 0
