/**
 * Extra sections modules add under the model tree (e.g. sketches), so the
 * shell doesn't need to know about them. A section appends its own rows.
 */
export interface TreeSection {
  /** Append rows to the tree; return how many were added. */
  render(tree: HTMLElement): number
}

const sections: TreeSection[] = []
let refresh: (() => void) | null = null

export function addTreeSection(s: TreeSection): void {
  sections.push(s)
  refresh?.()
}
export function treeSections(): readonly TreeSection[] {
  return sections
}
/** Ask the shell to redraw the tree. */
export function refreshTree(): void {
  refresh?.()
}
export function setTreeRefresher(fn: () => void): void {
  refresh = fn
}
