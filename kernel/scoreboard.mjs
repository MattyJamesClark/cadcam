// Runs the kernel stress tests on a built wasm kernel and writes the scoreboard.
//   node kernel/scoreboard.mjs <dir with cadkernel.js> [filter]
// Writes docs/kernel/scoreboard.json and docs/kernel/scoreboard.md.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = resolve(process.argv[2] ?? 'src/renderer/public/vendor/cadkernel')
const filter = process.argv[3] ?? ''
const { default: create } = await import(pathToFileURL(resolve(dir, 'cadkernel.js')).href)
const k = await create()
const t0 = performance.now()
const rows = JSON.parse(k.stressTest(filter))
const total = performance.now() - t0
const build = existsSync(resolve(dir, 'BUILD.txt')) ? readFileSync(resolve(dir, 'BUILD.txt'), 'utf8').trim() : 'unknown build'

const out = resolve('docs/kernel')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'scoreboard.json'), JSON.stringify({ build, date: new Date().toISOString(), rows }, null, 1) + '\n')

const ICON = { pass: '✅ pass', fixed: '🔧 fixed', clear: '💬 clear error', fail: '❌ fail' }
const count = (s) => rows.filter((r) => r.status === s).length
const rawOk = rows.filter((r) => r.rawOk).length
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`)
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
let md = `# Kernel stress-test scoreboard

The classic ways CAD kernels fail, run against plain OpenCascade (**raw**: the call a
naive program would make) and our layer over it (**ours**, \`kernel/robust.hxx\`). Generated
by \`node kernel/scoreboard.mjs\` from the shipped WebAssembly kernel, so the times are the
app's own. Cases live in \`kernel/stress.hxx\`.

* ✅ **pass**: both work.  🔧 **fixed**: raw OpenCascade fails or gives a broken result, ours is right.
* 💬 **clear error**: impossible (or not solved yet), and we say why in plain English, naming the edge or face (shown red in the app).
* ❌ **fail**: wrong result or a vague error. Still to do.

Build: \`${build}\`, ${new Date().toISOString().slice(0, 10)}, ${rows.length} cases in ${ms(total)}.

| | Count |
| --- | --- |
| ✅ pass | ${count('pass')} |
| 🔧 fixed by our layer | ${count('fixed')} |
| 💬 clear error | ${count('clear')} |
| ❌ fail | ${count('fail')} |
| Raw OpenCascade alone correct | ${rawOk} of ${rows.length} |

`
let group = ''
for (const r of rows) {
  if (r.group !== group) {
    group = r.group
    md += `\n## ${group}\n\n| Case | Result | Raw OpenCascade | Ours | What we did / said |\n| --- | --- | --- | --- | --- |\n`
  }
  const raw = r.rawOk ? `ok, ${ms(r.rawMs)}` : `${cell(r.rawWhy)} (${ms(r.rawMs)})`
  const ours = r.error ? ms(r.oursMs) : `ok, ${ms(r.oursMs)}`
  const said = r.error ? `“${cell(r.error)}”` : cell([r.strategy, r.note].filter(Boolean).join('; '))
  md += `| **${r.id}** ${cell(r.title)} | ${ICON[r.status] ?? r.status} | ${raw} | ${ours} | ${said} |\n`
}
writeFileSync(resolve(out, 'scoreboard.md'), md)
console.log(md)
const fails = count('fail')
console.log(`${rows.length} cases: ${count('pass')} pass, ${count('fixed')} fixed, ${count('clear')} clear, ${fails} fail`)
