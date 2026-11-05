import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import log from 'electron-log/main'
import { IPC, type AppInfo, type FileFilter, type OpenedFile } from '../shared/ipc'
import { initUpdater } from './updater'

log.initialize()

// The UI is served from app://bundle/ rather than file:// so that web workers
// and WebAssembly (the CAD kernel) load like on a normal web origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }
])

/** Files the user picked in an open/save dialog this session. */
const writablePaths = new Set<string>()

function registerAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url)
    const file = normalize(join(root, decodeURIComponent(pathname)))
    if (!file.startsWith(root + sep)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

function createWindow(): BrowserWindow {
  // The app draws its own menu bar; the default Electron menu would steal
  // Ctrl+Z / Ctrl+Y / Ctrl+A before the UI sees them.
  Menu.setApplicationMenu(null)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1e23',
    title: 'CADCAM Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Cache compiled JavaScript so the app opens faster after the first run.
      v8CacheOptions: 'bypassHeatCheck'
    }
  })

  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadURL('app://bundle/index.html')
  }
  return win
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged
  }))

  ipcMain.handle(IPC.openFile, async (e, filters: FileFilter[]): Promise<OpenedFile[]> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters
    })
    if (res.canceled) return []
    res.filePaths.forEach((p) => writablePaths.add(p))
    return Promise.all(
      res.filePaths.map(async (p) => ({ path: p, name: basename(p), data: new Uint8Array(await readFile(p)) }))
    )
  })

  ipcMain.handle(
    IPC.saveFile,
    async (e, defaultName: string, filters: FileFilter[], data: Uint8Array): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const res = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, data)
      writablePaths.add(res.filePath)
      return res.filePath
    }
  )

  // Save over a file the user chose in a dialog earlier (Ctrl+S). Paths the
  // user never picked are refused, so the UI can't write anywhere else.
  ipcMain.handle(IPC.writeFile, async (_e, path: string, data: Uint8Array): Promise<boolean> => {
    if (!writablePaths.has(path)) return false
    await writeFile(path, data)
    return true
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.mattyjamesclark.cadcam')
    registerAppProtocol()
    registerIpc()
    createWindow()
    initUpdater()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
