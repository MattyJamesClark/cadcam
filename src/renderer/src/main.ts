import './styles.css'
import { registerBuiltinFormats } from './core/formats'
import { extOf, importerFor } from './core/io'
import { Shell } from './core/shell'
import { initTheme } from './core/settingsDialog'
import { modules } from './modules'
import { importFiles } from './modules/home'

registerBuiltinFormats()
initTheme()

const shell = new Shell(document.getElementById('app')!, modules)

// Drag and drop files anywhere to merge them into the design.
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  document.body.classList.add('dropping')
})
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping')
})
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  document.body.classList.remove('dropping')
  const files = [...(e.dataTransfer?.files ?? [])]
  const supported = files.filter((f) => importerFor(f.name))
  const skipped = files.filter((f) => !importerFor(f.name)).map((f) => '.' + extOf(f.name))
  if (skipped.length) shell.setStatus(`Skipped unsupported: ${[...new Set(skipped)].join(', ')}`, 'warn')
  await importFiles(
    shell.ctx,
    await Promise.all(supported.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))),
    false
  )
})

// Expose for debugging from devtools.
;(window as unknown as { cad: Shell }).cad = shell
