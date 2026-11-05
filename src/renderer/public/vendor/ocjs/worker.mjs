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
    const result = readCad(oc, new Uint8Array(buffer), format, quality)
    const transfer = []
    for (const m of result.meshes) transfer.push(m.position.buffer, m.index.buffer, m.edges.buffer)
    postMessage({ id, result }, transfer)
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e) })
  }
}
