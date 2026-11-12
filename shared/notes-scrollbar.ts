/** Marks the notes' scroll container; the scrollbar style below applies under it only, never globally. */
export const NOTES_SCROLL_ATTR = "data-follow-up-notes-scroll";

/**
 * The notes' scrollbar, always visible while the notes overflow (not only while scrolling): macOS hides overlay
 * scrollbars unless the container styles them, which Chromium/Electron honour through ::-webkit-scrollbar; Firefox
 * reads scrollbar-width/scrollbar-color (inside @supports, since Chromium ignores ::-webkit-scrollbar when those are
 * set). Colors come from the theme. Exported for the tests.
 */
export function notesScrollbarCss(c: { foregroundMuted: string }) {
  const sel = `[${NOTES_SCROLL_ATTR}]`;
  const thumb = `color-mix(in srgb, ${c.foregroundMuted} 45%, transparent)`;
  const hover = `color-mix(in srgb, ${c.foregroundMuted} 70%, transparent)`;
  return [
    `${sel}::-webkit-scrollbar { -webkit-appearance: none; width: 10px; height: 10px; }`,
    `${sel}::-webkit-scrollbar-track { background: transparent; }`,
    `${sel}::-webkit-scrollbar-button { display: none; height: 0; }`,
    `${sel}::-webkit-scrollbar-thumb { background-color: ${thumb}; border-radius: 8px; border: 2px solid transparent; background-clip: content-box; min-height: 32px; }`,
    `${sel}::-webkit-scrollbar-thumb:hover { background-color: ${hover}; }`,
    `@supports (-moz-appearance: none) { ${sel} { scrollbar-width: thin; scrollbar-color: ${thumb} transparent; } }`,
  ].join("\n");
}
