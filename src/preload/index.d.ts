import type { HostApi } from './index'

declare global {
  interface Window {
    /** Bridge to the Electron main process. Undefined when running in a plain browser. */
    host?: HostApi
  }
}
export {}
