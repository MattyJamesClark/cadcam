import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo, type FileFilter, type OpenedFile, type UpdateStatus } from '../shared/ipc'

const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
  openFiles: (filters: FileFilter[]): Promise<OpenedFile[]> => ipcRenderer.invoke(IPC.openFile, filters),
  saveFile: (name: string, filters: FileFilter[], data: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveFile, name, filters, data),
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updateStatus),
    check: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheck),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const fn = (_: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on(IPC.updateStatus, fn)
      return () => ipcRenderer.removeListener(IPC.updateStatus, fn)
    }
  }
}

export type HostApi = typeof api

contextBridge.exposeInMainWorld('host', api)
