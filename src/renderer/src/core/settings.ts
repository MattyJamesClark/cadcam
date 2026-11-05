import { Emitter } from './events'

export type ThemeMode = 'dark' | 'light' | 'system'
export type NavStyle = 'solidworks' | 'generic'
export type ImportQuality = 'draft' | 'normal' | 'fine'

export interface Settings {
  theme: ThemeMode
  accent: string
  /** Viewport background gradient. null = follow the light/dark theme. */
  viewportTop: string | null
  viewportBottom: string | null
  partColor: string
  navStyle: NavStyle
  /** Flip wheel direction (wheel towards you zooms in). */
  reverseWheel: boolean
  /** Rotate about the point under the cursor instead of the view centre. */
  rotateAboutCursor: boolean
  showViewCube: boolean
  showTriad: boolean
  /** Tessellation quality for STEP/IGES/BREP solids. */
  importQuality: ImportQuality
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#ff9f1c',
  viewportTop: null,
  viewportBottom: null,
  partColor: '#9aa7b4',
  navStyle: 'solidworks',
  reverseWheel: false,
  rotateAboutCursor: true,
  showViewCube: true,
  showTriad: true,
  importQuality: 'normal'
}

export const ACCENTS = ['#ff9f1c', '#e5484d', '#3e8ef7', '#12a594', '#46a758', '#8e4ec6', '#d6409f', '#f5d90a']

export interface BackgroundPreset {
  name: string
  top: string | null
  bottom: string | null
}

export const BACKGROUNDS: BackgroundPreset[] = [
  { name: 'Theme default', top: null, bottom: null },
  { name: 'Classic blue', top: '#c9d8ea', bottom: '#ffffff' },
  { name: 'Studio grey', top: '#5a6270', bottom: '#20242a' },
  { name: 'Plain white', top: '#ffffff', bottom: '#ffffff' },
  { name: 'Plain black', top: '#0d0f12', bottom: '#0d0f12' },
  { name: 'Midnight', top: '#1d2b44', bottom: '#0b0f17' }
]

const KEY = 'cadcam.settings.v1'

type SettingsEvents = { changed: Settings }

/** App preferences, saved on this computer and applied live. */
class SettingsStore extends Emitter<SettingsEvents> {
  private value: Settings

  constructor() {
    super()
    let saved: Partial<Settings> = {}
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    } catch {
      /* fall back to defaults */
    }
    this.value = { ...DEFAULT_SETTINGS, ...saved }
  }

  get(): Settings {
    return this.value
  }

  set(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value))
    } catch {
      /* not fatal */
    }
    this.emit('changed', this.value)
  }

  reset(): void {
    this.set({ ...DEFAULT_SETTINGS })
  }
}

export const settings = new SettingsStore()

/** The light/dark mode actually in effect (resolves "system"). */
export function effectiveTheme(s: Settings = settings.get()): 'dark' | 'light' {
  if (s.theme !== 'system') return s.theme
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
