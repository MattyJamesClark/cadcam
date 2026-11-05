/** IPC contract shared by main, preload and renderer. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number; version?: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'disabled'; reason: string }

export const IPC = {
  updateStatus: 'update:status',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  appInfo: 'app:info',
  openFile: 'file:open',
  saveFile: 'file:save',
  writeFile: 'file:write'
} as const

export interface AppInfo {
  name: string
  version: string
  platform: string
  isPackaged: boolean
}

export interface OpenedFile {
  path: string
  name: string
  data: Uint8Array
}

export interface FileFilter {
  name: string
  extensions: string[]
}
