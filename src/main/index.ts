import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import log from 'electron-log/main'
import { IPC, type AppInfo, type FileFilter, type OpenedFile } from '../shared/ipc'
import { initUpdater } from './updater'

log.initialize()

function createWindow(): BrowserWindow {
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
      nodeIntegration: false
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
    win.loadFile(join(__dirname, '../renderer/index.html'))
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
      return res.filePath
    }
  )
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
