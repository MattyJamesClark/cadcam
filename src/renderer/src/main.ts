import './styles.css'
import { registerBuiltinFormats } from './core/formats'
import { extOf, importerFor, unsupportedReason } from './core/io'
import { Shell } from './core/shell'
import { warmUpCadKernel } from './core/occt'
import { initTheme } from './core/settingsDialog'
import { modules } from './modules'
import { importFiles } from './modules/home'

registerBuiltinFormats()
setTimeout(warmUpCadKernel, 1500) // compile the CAD kernel in the background after start-up
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
  const skipped = files.filter((f) => !importerFor(f.name))
  if (skipped.length === 1) shell.setStatus(unsupportedReason(skipped[0].name), 'warn')
  else if (skipped.length)
    shell.setStatus(`Skipped ${skipped.length} unsupported files: ${skipped.map((f) => '.' + extOf(f.name)).join(', ')}`, 'warn')
  await importFiles(
    shell.ctx,
    await Promise.all(supported.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))),
    false
  )
})

// Expose for debugging from devtools.
;(window as unknown as { cad: Shell }).cad = shell
