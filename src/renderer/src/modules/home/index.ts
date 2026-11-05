import * as THREE from 'three'
import { importerFor, listExporters, listImporters, loadFile, partMaterial, unsupportedReason } from '@/core/io'
import { icons } from '@/core/icons'
import type { CadModule, ModuleContext } from '@/core/types'

interface PickedFile {
  name: string
  data: ArrayBuffer
}

/** Ask for files: native dialog in the app, <input type=file> in a plain browser. */
async function pickFiles(): Promise<PickedFile[]> {
  const exts = [...new Set(listImporters().flatMap((i) => i.extensions))]
  const host = window.host
  if (host) {
    const files = await host.openFiles([
      { name: 'All supported 3D files', extensions: exts },
      { name: 'CAD solids (STEP, IGES, BREP, 3DM)', extensions: listImporters().filter((i) => i.solid || i.extensions.includes('3dm')).flatMap((i) => i.extensions) },
      ...listImporters().map((i) => ({ name: i.name, extensions: i.extensions })),
      { name: 'All files', extensions: ['*'] }
    ])
    return files.map((f) => ({
      name: f.name,
      data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer
    }))
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = exts.map((e) => '.' + e).join(',')
    input.onchange = async () => {
      const list = [...(input.files ?? [])]
      resolve(await Promise.all(list.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))))
    }
    input.click()
  })
}

/** Load files into the document. Used by Import, Merge and drag-and-drop. */
export async function importFiles(ctx: ModuleContext, files: PickedFile[], replace: boolean): Promise<void> {
  if (!files.length) return
  if (replace) ctx.doc.clear()
  let ok = 0
  const tAll = performance.now()
  for (const f of files) {
    const imp = importerFor(f.name)
    if (!imp) {
      ctx.status(unsupportedReason(f.name), 'warn')
      continue
    }
    const t0 = performance.now()
    ctx.status(`Reading ${f.name}${imp.solid ? ' with the CAD kernel' : ''}…`)
    let obj
    try {
      obj = await loadFile(imp, f.data, f.name, (stage, done, total) =>
        ctx.status(`${f.name}: ${stage}${total ? ` ${done} of ${total}` : ''}…`)
      )
    } catch (e) {
      ctx.status(`${f.name}: couldn't read it (${(e as Error).message ?? e})`, 'error')
      continue
    }
    const base = f.name.replace(/\.[^.]+$/, '')
    const node = ctx.doc.addFile(obj, { name: base, format: imp.name, source: f.name })
    if (ctx.doc.bodies(node).length > 1) node.expanded = true
    ok++
    console.info(`Imported ${f.name} in ${(performance.now() - t0).toFixed(0)} ms`)
  }
  if (replace && files.length === 1) ctx.doc.name = files[0].name
  ctx.doc.emit('changed', undefined)
  if (ok) {
    ctx.viewport.fitAll()
    const secs = ((performance.now() - tAll) / 1000).toFixed(1)
    const what = ok === 1 && files.length === 1 ? files[0].name : `${ok} files`
    ctx.status(`${replace ? 'Opened' : 'Merged'} ${what} in ${secs} s`, 'success')
  }
}

async function exportAs(ctx: ModuleContext, ext: string): Promise<void> {
  const exp = listExporters().find((e) => e.extension === ext)!
  const items = ctx.doc.selection().length ? ctx.doc.selectedTopNodes() : ctx.doc.roots.filter((n) => ctx.doc.isShown(n))
  const group = new THREE.Group()
  ctx.doc.root.updateMatrixWorld(true)
  for (const n of items) {
    // Bake each node's placement in the file (axis/unit conversion, assembly position).
    const copy = n.object.clone(true)
    copy.visible = true
    n.object.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale)
    group.add(copy)
  }
  const bytes = await exp.write(group)
  const name = `${ctx.doc.name.replace(/\.[^.]+$/, '') || 'export'}.${ext}`
  const host = window.host
  if (host) {
    const saved = await host.saveFile(name, [{ name: exp.name, extensions: [ext] }], bytes)
    if (saved) ctx.status(`Exported ${items.length} item(s) to ${saved}`, 'success')
  } else {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart]))
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
  }
}

let counter = 0
function addPrimitive(ctx: ModuleContext, kind: string, geo: THREE.BufferGeometry, z: number): void {
  // Sit on the XY plane, to the right of whatever is already there.
  geo.computeBoundingBox()
  const existing = ctx.doc.bounds()
  const x = existing.isEmpty() ? 0 : existing.max.x + 20 - geo.boundingBox!.min.x
  geo.translate(x, 0, z)
  const mesh = new THREE.Mesh(geo, partMaterial())
  ctx.doc.addBody(mesh, `${kind} ${++counter}`, kind)
  ctx.viewport.fitAll()
}

const hasItems = (ctx: ModuleContext): boolean => !ctx.doc.isEmpty()

export const homeModule: CadModule = {
  id: 'home',
  title: 'Home',
  order: 0,
  groups: [
    {
      label: 'File',
      commands: [
        {
          id: 'file.new',
          label: 'New',
          icon: icons.newDoc,
          shortcut: 'Ctrl+N',
          tooltip: 'Start an empty design',
          run: (ctx) => {
            if (hasItems(ctx) && !confirm('Discard the current design?')) return
            ctx.doc.clear()
            ctx.viewport.fitAll()
          }
        },
        {
          id: 'file.open',
          label: 'Open',
          icon: icons.import,
          shortcut: 'Ctrl+O',
          tooltip: 'Open a file, replacing the current design',
          run: async (ctx) => {
            const files = await pickFiles()
            if (files.length && hasItems(ctx) && !confirm('Replace the current design?')) return
            await importFiles(ctx, files, true)
          }
        },
        {
          id: 'file.merge',
          label: 'Import / Merge',
          icon: icons.merge,
          shortcut: 'Ctrl+I',
          tooltip: 'Add files to the current design',
          run: async (ctx) => importFiles(ctx, await pickFiles(), false)
        }
      ]
    },
    {
      label: 'Export (selection or all)',
      commands: listExportCommands()
    },
    {
      label: 'Quick shapes',
      commands: [
        {
          id: 'shape.box',
          label: 'Box',
          icon: icons.box,
          run: (ctx) => addPrimitive(ctx, 'Box', new THREE.BoxGeometry(100, 60, 40), 20)
        },
        {
          id: 'shape.cylinder',
          label: 'Cylinder',
          icon: icons.cylinder,
          run: (ctx) =>
            addPrimitive(ctx, 'Cylinder', new THREE.CylinderGeometry(25, 25, 80, 96).rotateX(Math.PI / 2), 40)
        },
        {
          id: 'shape.sphere',
          label: 'Sphere',
          icon: icons.sphere,
          run: (ctx) => addPrimitive(ctx, 'Sphere', new THREE.SphereGeometry(30, 96, 48), 30)
        }
      ]
    },
    {
      label: 'Edit',
      commands: [
        {
          id: 'edit.hide',
          label: 'Hide / Show',
          icon: icons.eyeOff,
          shortcut: 'H',
          tooltip: 'Hide the selected items, or show them again if they are hidden',
          isEnabled: (ctx) => ctx.doc.selection().length > 0,
          run: (ctx) => {
            const nodes = ctx.doc.selectedTopNodes()
            const anyShown = nodes.some((n) => n.object.visible)
            ctx.doc.setVisible(
              nodes.map((n) => n.id),
              !anyShown
            )
            ctx.status(`${anyShown ? 'Hid' : 'Showed'} ${nodes.length} item${nodes.length > 1 ? 's' : ''}`)
          }
        },
        {
          id: 'edit.show-all',
          label: 'Show all',
          icon: icons.eye,
          shortcut: 'Shift+H',
          isEnabled: (ctx) => ctx.doc.all().some((n) => !n.object.visible),
          run: (ctx) => ctx.doc.showAll()
        },
        {
          id: 'edit.delete',
          label: 'Delete',
          icon: icons.trash,
          shortcut: 'Delete',
          tooltip: 'Delete selected items',
          isEnabled: (ctx) => ctx.doc.selection().length > 0,
          run: (ctx) => ctx.doc.selectedTopNodes().forEach((n) => ctx.doc.remove(n.id))
        }
      ]
    }
  ]
}

function listExportCommands(): CadModule['groups'][number]['commands'] {
  // Exporters are registered before modules load (see main.ts).
  return ['stl', 'obj', 'ply', 'glb'].map((ext) => ({
    id: `file.export.${ext}`,
    label: ext.toUpperCase(),
    icon: icons.export,
    tooltip: `Export as .${ext}`,
    isEnabled: hasItems,
    run: (ctx: ModuleContext) => exportAs(ctx, ext)
  }))
}
