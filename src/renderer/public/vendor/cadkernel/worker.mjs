/* CAD kernel worker (module). Loads OpenCascade (WebAssembly, built from
 * kernel/cadkernel.cpp) once and reads STEP / IGES / BREP files with names,
 * colours, layers, assemblies and STEP product data.
 * Message in:  { id, format, buffer, quality }
 * Message out: { id, stage, done, total } (progress) | { id, result } | { id, error } */
import createCadKernel from './cadkernel.js'
import { readStepInfo } from './step-info.mjs'

const QUALITY = {
  draft: { ratio: 0.003, angle: 0.8 },
  normal: { ratio: 0.001, angle: 0.35 },
  fine: { ratio: 0.0003, angle: 0.15 }
}

let ready = null
const kernel = () => (ready ??= createCadKernel({ locateFile: (p) => new URL(p, import.meta.url).href }))
// Start compiling straight away; the first import is then quicker.
kernel()

/** Attach STEP product data (part number, description...) by product name. */
function attachProps(node, products) {
  const p = products.get(node.ref) || products.get(node.name)
  if (p && Object.keys(p).length) node.props = p
  delete node.ref
  for (const c of node.children) attachProps(c, products)
}

onmessage = async (ev) => {
  const { id, format, buffer, quality } = ev.data
  try {
    const k = await kernel()
    const bytes = new Uint8Array(buffer)
    const q = QUALITY[quality] || QUALITY.normal
    const path = '/import.' + format
    k.FS.writeFile(path, bytes)
    let last = 0
    let result
    try {
      result = k.readCad(path, format, q.ratio, q.angle, (stage, done, total) => {
        const now = Date.now()
        if (done && done !== total && now - last < 150) return
        last = now
        postMessage({ id, stage, done, total })
      })
    } finally {
      try { k.FS.unlink(path) } catch { /* ignore */ }
    }
    if (result.error) throw new Error(result.error)
    if (format === 'step') {
      const info = readStepInfo(bytes)
      if (info) {
        attachProps(result.root, info.products)
        result.file = info.header
      }
    } else attachProps(result.root, new Map())
    const transfer = []
    for (const m of result.meshes) transfer.push(m.position.buffer, m.index.buffer, m.edges.buffer)
    postMessage({ id, result }, transfer)
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e) })
  }
}
