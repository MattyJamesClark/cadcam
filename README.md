# CADCAM Studio

A modular CAD/CAM desktop app for Windows. Built with Electron, Three.js and TypeScript.

## Install and updates

Download `CADCAM-Studio-Setup-x.y.z.exe` from the [latest release](https://github.com/MattyJamesClark/cadcam/releases/latest) and run it **once**.

After that the app keeps itself up to date. Every push to `main` builds a new installer
and publishes it as a GitHub Release. The installed app checks for a new version when it starts
and every 30 minutes, downloads it in the background, and shows an orange
**"Update ready. Restart to apply"** button in the title bar. If you ignore it, the update is
installed the next time you close the app.

The installer isn't code-signed yet, so Windows SmartScreen may warn on the very first install
("More info" → "Run anyway"). Updates after that install silently.

## Using the viewport

Navigation is SolidWorks-style by default (change it in Settings, the gear icon or Ctrl+,).

| Action | Mouse / key |
| --- | --- |
| Rotate | Middle-drag (about the point under the cursor) |
| Pan | Ctrl + middle-drag |
| Zoom | Wheel (zooms at the cursor), or Shift + middle-drag |
| Roll | Alt + middle-drag |
| Zoom to fit | Double-click middle, or F |
| Rotate 15° / 90° | Arrow keys / Shift + arrows (Alt + left/right rolls, Ctrl + arrows pans) |
| Standard views | Ctrl+1 Front, Ctrl+2 Back, Ctrl+3 Left, Ctrl+4 Right, Ctrl+5 Top, Ctrl+6 Bottom, Ctrl+7 Iso |
| Select / multi-select | Left-click / Ctrl+click |
| Hide / show selected, show all | H / Shift+H |
| Snap to a view | Click a face of the view cube, or an axis letter on the XYZ triad (Shift+click for the opposite side) |
| Grid on/off | G |
| New / Open / Import-merge | Ctrl+N / Ctrl+O / Ctrl+I |

Settings also cover light/dark/system mode, accent colour, viewport background, part colour,
wheel direction, and showing/hiding the view cube and triad. They're saved on this computer.

Drag files onto the window to merge them into the current design.

**Formats today:** import STEP, IGES and BREP through the CAD kernel (OpenCascade 7.9 compiled
to WebAssembly from `kernel/`, see below), plus Rhino 3DM,
STL, OBJ, PLY, glTF/GLB, 3MF, FBX, Collada, 3DS, VRML, AMF, VTK, USD and point clouds.
Export STL, OBJ, PLY, GLB.

## Model tree, layers and properties

STEP/IGES imports keep the structure of the source file: assemblies, parts, multi-body parts,
names, colours (per part, body and face) and layers. Wireframe curves come in as their own items.

* **Tree / Layers** (top of the side panel): switch between the assembly tree and the bodies
  grouped by layer, like the Layers tree in VISI. The eye on a layer hides or shows all of it.
* **Properties** (bottom of the side panel): for the selection, the name, type, layer, colour,
  STEP product data (part number, nomenclature, description, revision, source), the file header
  (author, originating system, STEP schema), and size, surface area, volume and triangle count.

Files that have been opened before load from a cache in a fraction of a second; the cache keeps
the 24 most recent files and is invalidated when the file changes.

## Architecture

```
src/
  main/        Electron main process: window, file dialogs, auto-updater
  preload/     Safe bridge exposed to the UI as window.host
  shared/      IPC types shared by main and UI
  renderer/src/
    core/      Shell (tabs, ribbon, model tree, status bar), Viewport, Document, file-format registry
    modules/   One folder per top tab. Each exports a CadModule.
```

### CAD kernel

`kernel/cadkernel.cpp` reads STEP/IGES/BREP with OpenCascade's XCAF and returns the assembly tree
and meshes in one call. The **CAD kernel** workflow (`.github/workflows/kernel.yml`) builds it with
Emscripten and native wasm exceptions and commits `cadkernel.js/.wasm` to
`src/renderer/public/vendor/cadkernel/`. It runs when anything in `kernel/` changes; the
OpenCascade build (about 45 minutes) is cached. `kernel/build.sh` works around an LLVM bug that
miscompiles a few OpenCascade functions at -O3 by rebuilding just those files at -O1.

### Adding a module

1. Create `src/renderer/src/modules/<name>/index.ts` exporting a `CadModule`
   (`id`, `title`, `order`, and `groups` of `commands`). See `modules/view` for a compact example.
2. Add it to the list in `src/renderer/src/modules/index.ts`.

Each command gets the `ModuleContext` (document, viewport, status bar), can declare a keyboard
shortcut, and can report `isEnabled` / `isActive` so the ribbon greys out or highlights it.

### Adding a file format

Call `registerImporter` / `registerExporter` from `core/io.ts` (see `core/formats.ts`). Import,
merge, drag-and-drop and the file dialogs pick up new formats automatically.

## Development

```bash
npm install
npm run dev         # run with hot reload
npm run typecheck
npm run dist        # build a local Windows installer into dist/ (no publish)
```

Releases are produced by `.github/workflows/release.yml`; the version is `major.minor` from
`package.json` plus the CI build number. Bump `major.minor` in `package.json` for milestone releases.
