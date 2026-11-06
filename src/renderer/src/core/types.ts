import type { CadDocument } from './document'
import type { Viewport } from './viewport'

export type StatusKind = 'info' | 'success' | 'warn' | 'error'

/** What every module gets handed: the open document, the viewport and a few app services. */
export interface ModuleContext {
  doc: CadDocument
  viewport: Viewport
  /** Show a message in the status bar. */
  status(message: string, kind?: StatusKind): void
  /** Re-evaluate command enabled/active states in the ribbon. */
  refreshRibbon(): void
  /** Run a command by id (if it exists and is enabled). */
  runCommand(id: string): void
  /** Look up a command by id. */
  command(id: string): Command | undefined
  /** Show a contextual module's tab and switch to it (e.g. Sketch while a sketch is open). */
  enterContext(id: string): void
  /** Hide a contextual module's tab again and go back to the tab the user was on. */
  leaveContext(id: string): void
}

export interface Command {
  /** Globally unique, e.g. "view.fit-all". */
  id: string
  label: string
  /** Inline SVG markup (24x24 viewBox). */
  icon: string
  tooltip?: string
  /** Keyboard shortcut, e.g. "F", "Ctrl+I", "Shift+5". Works from any tab. */
  shortcut?: string
  /** A second shortcut for the same command (e.g. Ctrl+Shift+Z for redo). */
  altShortcut?: string
  /** Shown in menus but not the ribbon. */
  menuOnly?: boolean
  run(ctx: ModuleContext): void | Promise<void>
  isEnabled?(ctx: ModuleContext): boolean
  /** For toggles: draw the button as pressed. */
  isActive?(ctx: ModuleContext): boolean
}

export interface CommandGroup {
  label: string
  commands: Command[]
  /** false: commands only in the menus / shortcuts / quick toolbar, not on the ribbon. */
  ribbon?: boolean
}

/**
 * A module is one tab along the top of the app. To add a module, create a
 * folder in src/renderer/src/modules, export a CadModule, and add it to
 * modules/index.ts. Nothing else in the shell needs to change.
 */
export interface CadModule {
  id: string
  title: string
  /** Tabs are sorted by this, low to high. */
  order: number
  groups: CommandGroup[]
  /**
   * No tab of its own: its tab only appears, highlighted, while it is entered
   * with ctx.enterContext (like SolidWorks' Sketch tools, which come up once
   * a sketch is open). Its commands are registered all the time.
   */
  contextual?: boolean
  /** If set, the tab shows this note instead of commands (module not built yet). */
  planned?: string
  /** Called once at startup, for always-on behaviour (e.g. hover info). */
  init?(ctx: ModuleContext): void
  activate?(ctx: ModuleContext): void
  deactivate?(ctx: ModuleContext): void
}
