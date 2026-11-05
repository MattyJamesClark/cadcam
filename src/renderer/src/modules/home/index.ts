import * as THREE from 'three'
import { extOf, importerFor, listExporters, listImporters, partMaterial } from '@/core/io'
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
      { name: 'Supported files', extensions: exts },
      ...listImporters().map((i) => ({ name: i.name, extensions: i.extensions }))
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
  for (const f of files) {
    const imp = importerFor(f.name)
    if (!imp) {
      ctx.status(`${f.name}: .${extOf(f.name)} files aren't supported yet`, 'warn')
      continue
    }
    const t0 = performance.now()
    const obj = await imp.load(f.data, f.name)
    const base = f.name.replace(/\.[^.]+$/, '')
    ctx.doc.add(obj, { name: base, kind: imp.name, source: f.name })
    ok++
    console.info(`Imported ${f.name} in ${(performance.now() - t0).toFixed(0)} ms`)
  }
  if (replace && files.length === 1) ctx.doc.name = files[0].name
  ctx.doc.emit('changed', undefined)
  if (ok) {
    ctx.viewport.fitAll()
    ctx.status(`${replace ? 'Opened' : 'Merged'} ${ok} file${ok > 1 ? 's' : ''}`, 'success')
  }
}

async function exportAs(ctx: ModuleContext, ext: string): Promise<void> {
  const exp = listExporters().find((e) => e.extension === ext)!
  const items = ctx.doc.selection().length
    ? ctx.doc.selection().map((id) => ctx.doc.get(id)!)
    : ctx.doc.all().filter((i) => i.visible)
  const group = new THREE.Group()
  for (const i of items) group.add(i.object.clone(true))
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
  ctx.doc.add(mesh, { name: `${kind} ${++counter}`, kind })
  ctx.viewport.fitAll()
}

const hasItems = (ctx: ModuleContext): boolean => ctx.doc.all().length > 0

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
          id: 'edit.delete',
          label: 'Delete',
          icon: icons.trash,
          shortcut: 'Delete',
          tooltip: 'Delete selected items',
          isEnabled: (ctx) => ctx.doc.selection().length > 0,
          run: (ctx) => ctx.doc.selection().forEach((id) => ctx.doc.remove(id))
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
