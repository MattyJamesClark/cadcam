// Copies WebAssembly CAD libraries from node_modules into the renderer's
// public folder so they ship with the app and load at runtime.
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src/renderer/public/vendor')
const copies = [
  ['node_modules/rhino3dm/rhino3dm.js', 'rhino3dm/rhino3dm.js'],
  ['node_modules/rhino3dm/rhino3dm.wasm', 'rhino3dm/rhino3dm.wasm']
]
for (const [from, to] of copies) {
  mkdirSync(dirname(join(out, to)), { recursive: true })
  cpSync(join(root, from), join(out, to))
}
console.log(`vendor: copied ${copies.length} files`)
