/* OpenCascade worker (module). Loads the full OCCT WebAssembly build once and
 * reads STEP / IGES / BREP files with names, colours, layers and assemblies.
 * Message in:  { id, format, buffer, quality }
 * Message out: { id, result } | { id, error } */
import ocFull from './opencascade.full.js'
import { readCad } from './cad-reader.mjs'

let ready = null
function occt() {
  if (!ready) {
    ready = new Promise((resolve, reject) => {
      new ocFull({
        locateFile: (p) => new URL(p.endsWith('.wasm') ? 'opencascade.full.wasm' : p, import.meta.url).href
      }).then(resolve, reject)
    })
  }
  return ready
}
// Start compiling the kernel straight away; the first import is then quicker.
occt()

onmessage = async (ev) => {
  const { id, format, buffer, quality } = ev.data
  try {
    const oc = await occt()
    let last = 0
    const result = readCad(oc, new Uint8Array(buffer), format, quality, (stage, done, total) => {
      const now = Date.now()
      if (done && done !== total && now - last < 150) return
      last = now
      postMessage({ id, stage, done, total })
    })
    const transfer = []
    for (const m of result.meshes) transfer.push(m.position.buffer, m.index.buffer, m.edges.buffer)
    // (index arrays may be empty for wireframe bodies; still transferable)
    postMessage({ id, result }, transfer)
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e) })
  }
}
