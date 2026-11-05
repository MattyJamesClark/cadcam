// Prints the name of function #N in a wasm file (from its name section). Usage: node wasm-fn-name.mjs file.wasm N
import fs from 'fs'
const b = fs.readFileSync(process.argv[2]); const want = +process.argv[3]
let p = 8
const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 127) * 2 ** s; s += 7 } while (x & 128); return r }
let imports = 0
while (p < b.length) {
  const id = b[p++]; const size = leb(); const end = p + size
  if (id === 2) { let n = leb(); for (let i = 0; i < n; i++) { let l = leb(); p += l; l = leb(); p += l; const kind = b[p++]; if (kind === 0) { leb(); imports++ } else if (kind === 1) { p++; const f = leb(); leb(); if (f & 1) leb() } else if (kind === 2) { const f = leb(); leb(); if (f & 1) leb() } else if (kind === 3) { p += 2 } else if (kind === 4) { p++; leb() } } }
  if (id === 0) { const l = leb(); const name = b.slice(p, p + l).toString(); p += l
    if (name === 'name') { while (p < end) { const sid = b[p++]; const ssz = leb(); const se = p + ssz; if (sid === 1) { const n = leb(); for (let i = 0; i < n; i++) { const idx = leb(); const l2 = leb(); const nm = b.slice(p, p + l2).toString(); p += l2; if (idx === want || idx === want + imports) console.log(idx, nm) } } p = se } } }
  p = end
}
console.log('imports', imports)
