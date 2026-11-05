/* OpenCascade (occt-import-js) import worker. Classic worker so it can
 * importScripts the emscripten build. The wasm module is created once and
 * reused for every file. Message: { id, format: 'step'|'iges'|'brep', buffer, params } */
importScripts('occt-import-js.js')

let ready = null
function occt() {
  if (!ready) ready = occtimportjs({ locateFile: (p) => p })
  return ready
}

onmessage = async (ev) => {
  const { id, format, buffer, params } = ev.data
  try {
    const lib = await occt()
    const content = new Uint8Array(buffer)
    const result =
      format === 'step' ? lib.ReadStepFile(content, params)
      : format === 'iges' ? lib.ReadIgesFile(content, params)
      : lib.ReadBrepFile(content, params)
    if (!result || !result.success) throw new Error('The CAD kernel could not read this file')
    const transfer = []
    for (const m of result.meshes) {
      m.attributes.position.array = new Float32Array(m.attributes.position.array)
      transfer.push(m.attributes.position.array.buffer)
      if (m.attributes.normal) {
        m.attributes.normal.array = new Float32Array(m.attributes.normal.array)
        transfer.push(m.attributes.normal.array.buffer)
      }
      m.index.array = new Uint32Array(m.index.array)
      transfer.push(m.index.array.buffer)
    }
    postMessage({ id, result }, transfer)
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e) })
  }
}
