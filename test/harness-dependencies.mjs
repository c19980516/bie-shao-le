/** 由测试入口预加载：可选宿主依赖桥接 + 禁止测试发出真实网络请求。 */
import path from 'node:path'
import net from 'node:net'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const harnessRoot = process.env.DSH_TEST_HARNESS_ROOT
const directDependencies = new Set([
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-llm',
])

if (harnessRoot) {
  const hostRequire = createRequire(path.join(harnessRoot, 'package.json'))
  const sourceRoot = new URL('../lib/', import.meta.url).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 只桥接插件直接引用；宿主包内部的 ESM/CJS 均保留正常解析语义。
      if (directDependencies.has(specifier) && context.parentURL?.startsWith(sourceRoot)) {
        return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

const offline = () => { throw new Error('Offline test: real network access is disabled') }
globalThis.fetch = async () => offline()
net.Socket.prototype.connect = offline
