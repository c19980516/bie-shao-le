/** Verify the output of `pnpm pack --dry-run --json` (or npm's equivalent). */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const reportPath = process.argv[2]
assert.ok(reportPath, 'Usage: node scripts/verify-package.mjs <npm-pack-report.json>')
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''))
const reports = Array.isArray(report) ? report : [report]
assert.equal(reports.length, 1, 'Expected exactly one package')
const files = reports[0].files.map(file => file.path.replaceAll('\\', '/'))
const required = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'lib/index.js']
for (const file of required) assert.ok(files.includes(file), `Missing release file: ${file}`)
for (const file of files) {
  assert.ok(
    required.includes(file) || /^lib\/[a-z0-9-]+\.js$/.test(file),
    `Unexpected release file: ${file}`,
  )
}
console.log(`Package file check passed (${files.length} files; source, configuration example, documentation and license only).`)
