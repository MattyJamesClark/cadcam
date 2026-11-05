import { app, BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'
import { IPC, type UpdateStatus } from '../shared/ipc'

const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 30 * 60 * 1000

let lastStatus: UpdateStatus = { state: 'idle' }
let lastProgressAt = 0

function broadcast(status: UpdateStatus): void {
  lastStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.updateStatus, status)
  }
}

/**
 * Silent background updates from GitHub Releases.
 * - Checks on launch and every 30 minutes.
 * - Downloads automatically, then asks the user to restart (or installs on quit).
 */
export function initUpdater(): void {
  ipcMain.handle(IPC.updateStatus, () => lastStatus)
  ipcMain.handle(IPC.updateInstall, () => autoUpdater.quitAndInstall(false, true))
  ipcMain.handle(IPC.updateCheck, () => check())

  if (!app.isPackaged) {
    broadcast({ state: 'disabled', reason: 'Updates are off in development builds' })
    return
  }

  // Explicit feed so updates work even if app-update.yml is missing from the build.
  autoUpdater.setFeedURL({ provider: 'github', owner: 'MattyJamesClark', repo: 'cadcam' })
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => broadcast({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', (i) => broadcast({ state: 'not-available', version: i.version }))
  autoUpdater.on('download-progress', (p) => {
    lastProgressAt = Date.now()
    broadcast({ state: 'downloading', percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (i) => broadcast({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => {
    log.error('Update error', e)
    broadcast({ state: 'error', message: e?.message ?? String(e) })
  })

  check()
  setInterval(check, CHECK_INTERVAL_MS)
}

async function check(): Promise<void> {
  if (!app.isPackaged) return
  // Don't start a second download while one is moving; a download with no
  // progress for 10 minutes is treated as stuck and started again. A downloaded
  // update doesn't stop checks either: a newer release replaces it.
  if (lastStatus.state === 'downloading' && Date.now() - lastProgressAt < 10 * 60 * 1000) return
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    log.warn('Update check failed', e)
  }
}
