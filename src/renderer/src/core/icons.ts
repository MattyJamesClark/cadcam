/** Stroke icons on a 24x24 grid, drawn in currentColor. */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  newDoc: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/>'),
  import: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v3h16v-3"/>'),
  export: svg('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 17v3h16v-3"/>'),
  merge: svg('<path d="M6 4v5a6 6 0 0 0 6 6h6"/><path d="M18 4v16"/><path d="m15 12 3 3-3 3"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
  box: svg('<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4"/><path d="M12 11v10"/>'),
  cylinder: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>'),
  sphere: svg('<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8"/>'),
  fitSel: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="3"/>'),
  iso: svg('<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10"/>'),
  top: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 4h16v5H4z" fill="currentColor" opacity=".35"/>'),
  front: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 15h16v5H4z" fill="currentColor" opacity=".35"/>'),
  right: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M15 4h5v16h-5z" fill="currentColor" opacity=".35"/>'),
  left: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 4h5v16H4z" fill="currentColor" opacity=".35"/>'),
  back: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 8h8v8H8z" fill="currentColor" opacity=".35"/>'),
  bottom: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 15h16v5H4z" fill="none"/><path d="M7 20 4 17M20 17l-3 3" />'),
  persp: svg('<path d="M3 6h18l-4 12H7z"/><path d="M8 6l1 12M16 6l-1 12"/>'),
  ortho: svg('<rect x="4" y="6" width="16" height="12"/><path d="M9 6v12M15 6v12"/>'),
  shaded: svg('<path d="M12 3 4 7v10l8 4 8-4V7z" fill="currentColor" opacity=".35"/><path d="M12 3 4 7v10l8 4 8-4V7z"/>'),
  edges: svg('<path d="M12 3 4 7v10l8 4 8-4V7z" fill="currentColor" opacity=".25"/><path d="M12 3 4 7v10l8 4 8-4V7z" stroke-width="2.2"/><path d="m4 7 8 4 8-4M12 11v10" stroke-width="2.2"/>'),
  wire: svg('<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10M4 12l8 4 8-4M8 5v10M16 5v10" opacity=".6"/>'),
  grid: svg('<path d="M3 8h18M3 16h18M8 3v18M16 3v18"/>'),
  axes: svg('<path d="M5 19V5M5 19h14M5 19l9-9"/><path d="m3 7 2-2 2 2M17 17l2 2-2 2"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>'),
  sketch: svg('<path d="M4 20 15 9l3 3L7 23H4z" transform="translate(0 -3)"/><path d="m14 7 3-3 3 3-3 3"/>'),
  part: svg('<path d="M4 18V8l8-5 8 5v10l-8 5z"/><circle cx="12" cy="13" r="3"/>'),
  cam: svg('<path d="M9 3h6v4l-1 3h-4L9 7z"/><path d="M12 10v6"/><path d="m10 16 2 3 2-3"/><path d="M3 21h18"/>'),
  planes: svg('<path d="M3 15 9 9h12l-6 6z"/><path d="M9 3v12M15 9V3"/><path d="M9 3h6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  update: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>')
}
