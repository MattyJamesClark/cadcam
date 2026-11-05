import * as THREE from 'three'
import { openTranslate } from '@/core/translate'
import { importerFor, listExporters, listImporters, loadFile, partMaterial, unsupportedReason } from '@/core/io'
import { icons } from '@/core/icons'
import type { CadModule, ModuleContext } from '@/core/types'
import { readCadFile, writeCadFile } from '@/core/occt'
import { isProject, PROJECT_EXT, readProject, saveProject } from '@/core/project'

interface PickedFile {
  name: string
  data: ArrayBuffer
  /** Full path on disk (desktop app only). */
  path?: string
}

/** Ask for files: native dialog in the app, <input type=file> in a plain browser. */
async function pickFiles(): Promise<PickedFile[]> {
  const exts = [...new Set(listImporters().flatMap((i) => i.extensions))]
  const host = window.host
  if (host) {
    const files = await host.openFiles([
      { name: 'All supported files', extensions: [PROJECT_EXT, ...exts] },
      { name: 'CADCAM Studio project', extensions: [PROJECT_EXT] },
      { name: 'CAD solids (STEP, IGES, BREP, 3DM)', extensions: listImporters().filter((i) => i.solid || i.extensions.includes('3dm')).flatMap((i) => i.extensions) },
      ...listImporters().map((i) => ({ name: i.name, extensions: i.extensions })),
      { name: 'All files', extensions: ['*'] }
    ])
    return files.map((f) => ({
      name: f.name,
      path: f.path,
      data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer
    }))
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = [PROJECT_EXT, ...exts].map((e) => '.' + e).join(',')
    input.onchange = async () => {
      const list = [...(input.files ?? [])]
      resolve(await Promise.all(list.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))))
    }
    input.click()
  })
}

/**
 * Load files into the document. Used by Open (replace), Import/Merge and
 * drag-and-drop. Everything is read first and then added in one undo step, so
 * a failed read never leaves the design half replaced.
 */
export async function importFiles(ctx: ModuleContext, files: PickedFile[], replace: boolean): Promise<void> {
  if (!files.length) return
  const tAll = performance.now()
  type Loaded =
    | { kind: 'model'; f: PickedFile; obj: THREE.Object3D; format: string }
    | { kind: 'project'; f: PickedFile; project: ReturnType<typeof readProject> }
  const loaded: Loaded[] = []
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.' + PROJECT_EXT) || isProject(f.data)) {
      try {
        loaded.push({ kind: 'project', f, project: readProject(f.data) })
      } catch (e) {
        ctx.status(`${f.name}: ${(e as Error).message ?? e}`, 'error')
      }
      continue
    }
    const imp = importerFor(f.name)
    if (!imp) {
      ctx.status(unsupportedReason(f.name), 'warn')
      continue
    }
    const t0 = performance.now()
    ctx.status(`Reading ${f.name}${imp.solid ? ' with the CAD kernel' : ''}…`)
    try {
      const obj = await loadFile(imp, f.data, f.name, (stage, done, total) =>
        ctx.status(`${f.name}: ${stage}${total ? ` ${done} of ${total}` : ''}…`)
      )
      loaded.push({ kind: 'model', f, obj, format: imp.name })
      console.info(`Imported ${f.name} in ${(performance.now() - t0).toFixed(0)} ms`)
    } catch (e) {
      ctx.status(`${f.name}: couldn't read it (${(e as Error).message ?? e})`, 'error')
    }
  }
  if (!loaded.length) return

  const doc = ctx.doc
  // Opening one project replaces the design and starts a fresh history.
  const single = loaded.length === 1 ? loaded[0] : null
  if (replace && single?.kind === 'project') {
    doc.reset()
    for (const r of single.project.roots) doc.addRestored(r.object, r.meta)
    doc.setDims(single.project.dims)
    doc.name = single.f.name
    doc.filePath = single.f.path ?? null
    doc.history.markSaved()
  } else {
    const label = replace ? `Open ${single ? single.f.name : `${loaded.length} files`}` : `Import ${single ? single.f.name : `${loaded.length} files`}`
    doc.history.batch(label, () => {
      if (replace) doc.clear()
      for (const l of loaded) {
        if (l.kind === 'project') {
          for (const r of l.project.roots) doc.addRestoredUndoable(r.object, r.meta)
          for (const { id: _id, ...d } of l.project.dims) doc.addDim(d)
          continue
        }
        const base = l.f.name.replace(/\.[^.]+$/, '')
        const node = doc.addFile(l.obj, { name: base, format: l.format, source: l.f.name })
        if (doc.bodies(node).length > 1) node.expanded = true
      }
    })
    if (replace && single) doc.name = single.f.name
  }
  doc.emit('changed', undefined)
  ctx.viewport.fitAll()
  const secs = ((performance.now() - tAll) / 1000).toFixed(1)
  const what = single ? single.f.name : `${loaded.length} files`
  ctx.status(`${replace ? 'Opened' : 'Merged'} ${what} in ${secs} s`, 'success')
}

/** Save the design as a project file. `as` always asks where. */
export async function saveDesign(ctx: ModuleContext, as: boolean): Promise<boolean> {
  const doc = ctx.doc
  const host = window.host
  const version = host ? (await host.appInfo()).version : undefined
  const bytes = saveProject(doc, version)
  const base = doc.name.replace(/\.[^.]+$/, '') || 'Untitled'
  if (host) {
    let path: string | null = null
    if (!as && doc.filePath && (await host.writeFile(doc.filePath, bytes))) path = doc.filePath
    else path = await host.saveFile(`${base}.${PROJECT_EXT}`, [{ name: 'CADCAM Studio project', extensions: [PROJECT_EXT] }], bytes)
    if (!path) return false
    doc.filePath = path
    doc.name = path.split(/[\\/]/).pop() ?? doc.name
  } else {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart]))
    a.download = `${base}.${PROJECT_EXT}`
    a.click()
    URL.revokeObjectURL(a.href)
    doc.name = a.download
  }
  doc.history.markSaved()
  doc.emit('changed', undefined)
  ctx.status(`Saved ${doc.name} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`, 'success')
  return true
}

/** Before throwing the design away: true if it's fine to continue. */
export async function confirmDiscard(ctx: ModuleContext, action: string): Promise<boolean> {
  if (ctx.doc.isEmpty() || !ctx.doc.history.dirty) return true
  return confirm(`${action}? Unsaved changes to ${ctx.doc.name} will be lost (you can still undo it).`)
}

async function exportAs(ctx: ModuleContext, ext: string): Promise<void> {
  const exp = listExporters().find((e) => e.extension === ext)!
  const items = ctx.doc.selection().length ? ctx.doc.selectedTopNodes() : ctx.doc.roots.filter((n) => ctx.doc.isShown(n))
  const group = new THREE.Group()
  group.name = ctx.doc.name.replace(/\.[^.]+$/, '').replace(/ •$/, '')
  ctx.doc.root.updateMatrixWorld(true)
  for (const n of items) {
    // Bake each node's placement in the file (axis/unit conversion, assembly position).
    const copy = n.object.clone(true)
    copy.visible = true
    copy.name = n.name.replace(/\.[^.]+$/, '')
    n.object.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale)
    group.add(copy)
  }
  let bytes: Uint8Array
  try {
    bytes = await exp.write(group, (stage, done, total) =>
      ctx.status(total ? `${stage} ${done}/${total}…` : `${stage}…`)
    )
  } catch (e) {
    ctx.status(`Export failed: ${(e as Error).message}`, 'error')
    return
  }
  const name = `${ctx.doc.name.replace(/\.[^.]+$/, '') || 'export'}.${ext}`
  const host = window.host
  if (host) {
    const saved = await host.saveFile(name, [{ name: exp.name, extensions: [ext] }], bytes)
    if (saved) ctx.status(`Exported ${items.length} item(s) to ${saved}${exp.lastNote ? ` (${exp.lastNote})` : ''}`, exp.lastNote ? 'warn' : 'success')
    else ctx.status('')
  } else {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart]))
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
  }
}

/** Exact parameters of a quick shape, so it exports as a true box / cylinder / sphere. */
function primParams(kind: string, geo: THREE.BufferGeometry): Record<string, unknown> | undefined {
  const b = geo.boundingBox!
  const size = b.getSize(new THREE.Vector3())
  const c = b.getCenter(new THREE.Vector3())
  if (kind === 'Box') return { type: 'box', min: b.min.toArray(), dx: size.x, dy: size.y, dz: size.z }
  if (kind === 'Cylinder') return { type: 'cylinder', base: [c.x, c.y, b.min.z], radius: size.x / 2, height: size.z }
  if (kind === 'Sphere') return { type: 'sphere', center: c.toArray(), radius: size.x / 2 }
  return undefined
}

let counter = 0

/** Tessellated B-rep of a primitive: written by the kernel, read straight back. */
async function kernelSolid(kind: string, prim: Record<string, unknown>): Promise<THREE.BufferGeometry | null> {
  const { bytes } = await writeCadFile('brep', { name: kind, kind: 'body', prim })
  const root = await readCadFile('brep', bytes.slice().buffer)
  root.updateMatrixWorld(true)
  let found: THREE.Mesh | null = null
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.userData.brep) found = o as THREE.Mesh
  })
  if (!found) return null
  const m = found as THREE.Mesh
  const g = m.geometry
  if (!m.matrixWorld.equals(new THREE.Matrix4())) return null // the writer places the body itself; expect identity
  g.computeBoundingBox()
  return g
}
async function addPrimitive(ctx: ModuleContext, kind: string, geo: THREE.BufferGeometry, z: number): Promise<void> {
  // Sit on the XY plane, to the right of whatever is already there.
  geo.computeBoundingBox()
  const existing = ctx.doc.bounds()
  const x = existing.isEmpty() ? 0 : existing.max.x + 20 - geo.boundingBox!.min.x
  geo.translate(x, 0, z)
  geo.computeBoundingBox()
  const prim = primParams(kind, geo)
  // Build it as a true solid in the CAD kernel, so its faces, edges and points
  // can be picked and measured like an imported part. The plain mesh is only a fallback.
  const exact = prim ? await kernelSolid(kind, prim).catch(() => null) : null
  if (exact) {
    geo.dispose()
    geo = exact
  }
  geo.userData.prim = prim
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
      ribbon: false, // in the File menu and the quick toolbar
      commands: [
        {
          id: 'file.new',
          label: 'New',
          icon: icons.newDoc,
          shortcut: 'Ctrl+N',
          tooltip: 'Start an empty design',
          run: async (ctx) => {
            if (!(await confirmDiscard(ctx, 'Start a new design'))) return
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
            if (!files.length || !(await confirmDiscard(ctx, 'Open another design'))) return
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
        },
        {
          id: 'file.save',
          label: 'Save',
          icon: icons.save,
          shortcut: 'Ctrl+S',
          tooltip: 'Save the design as a CADCAM Studio project (.ccs)',
          run: (ctx) => void saveDesign(ctx, false)
        },
        {
          id: 'file.save-as',
          label: 'Save As',
          icon: icons.saveAs,
          shortcut: 'Ctrl+Shift+S',
          tooltip: 'Save the design under a new name',
          run: (ctx) => void saveDesign(ctx, true)
        }
      ]
    },
    {
      label: 'Export (selection or all)',
      ribbon: false, // File > Export
      commands: listExportCommands()
    },
    {
      label: 'Quick shapes',
      commands: [
        {
          id: 'shape.box',
          label: 'Box',
          icon: icons.box,
          run: (ctx) => void addPrimitive(ctx, 'Box', new THREE.BoxGeometry(100, 60, 40), 20)
        },
        {
          id: 'shape.cylinder',
          label: 'Cylinder',
          icon: icons.cylinder,
          run: (ctx) =>
            void addPrimitive(ctx, 'Cylinder', new THREE.CylinderGeometry(25, 25, 80, 96).rotateX(Math.PI / 2), 40)
        },
        {
          id: 'shape.sphere',
          label: 'Sphere',
          icon: icons.sphere,
          run: (ctx) => void addPrimitive(ctx, 'Sphere', new THREE.SphereGeometry(30, 96, 48), 30)
        }
      ]
    },
    {
      label: 'Edit',
      commands: [
        {
          id: 'edit.undo',
          label: 'Undo',
          icon: icons.undo,
          shortcut: 'Ctrl+Z',
          tooltip: 'Undo the last change',
          isEnabled: (ctx) => ctx.doc.history.canUndo,
          run: (ctx) => {
            const label = ctx.doc.history.undoLabels.at(-1)
            ctx.doc.undo()
            ctx.status(`Undid: ${label}`)
          }
        },
        {
          id: 'edit.redo',
          label: 'Redo',
          icon: icons.redo,
          shortcut: 'Ctrl+Y',
          altShortcut: 'Ctrl+Shift+Z',
          tooltip: 'Redo what was undone',
          isEnabled: (ctx) => ctx.doc.history.canRedo,
          run: (ctx) => {
            const label = ctx.doc.history.redoLabels[0]
            ctx.doc.redo()
            ctx.status(`Redid: ${label}`)
          }
        },
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
          id: 'edit.translate',
          label: 'Translate',
          icon: icons.move,
          shortcut: 'T',
          tooltip: 'Move or copy the selection by a distance (on-screen handle or typed values)',
          isEnabled: (ctx) => ctx.doc.selection().length > 0,
          run: (ctx) => openTranslate(ctx)
        },
        {
          id: 'edit.delete',
          label: 'Delete',
          icon: icons.trash,
          shortcut: 'Delete',
          tooltip: 'Delete selected items',
          isEnabled: (ctx) => ctx.doc.selection().length > 0,
          run: (ctx) => ctx.doc.removeMany(ctx.doc.selectedTopNodes().map((n) => n.id))
        }
      ]
    }
  ]
}

function listExportCommands(): CadModule['groups'][number]['commands'] {
  // Exporters are registered before modules load (see main.ts).
  return ['step', 'igs', 'brep', 'stl', 'obj', 'ply', 'glb'].map((ext) => ({
    id: `file.export.${ext}`,
    label: ext === 'igs' ? 'IGES' : ext.toUpperCase(),
    icon: icons.export,
    tooltip: `Export as .${ext}`,
    isEnabled: hasItems,
    run: (ctx: ModuleContext) => exportAs(ctx, ext)
  }))
}
