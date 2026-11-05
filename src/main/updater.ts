import { app, BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'
import { IPC, type UpdateStatus } from '../shared/ipc'

const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 30 * 60 * 1000

let lastStatus: UpdateStatus = { state: 'idle' }

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
  autoUpdater.on('download-progress', (p) =>
    broadcast({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (i) => broadcast({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => broadcast({ state: 'error', message: e?.message ?? String(e) }))

  check()
  setInterval(check, CHECK_INTERVAL_MS)
}

async function check(): Promise<void> {
  if (!app.isPackaged) return
  if (lastStatus.state === 'downloading' || lastStatus.state === 'ready') return
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    log.warn('Update check failed', e)
  }
}
