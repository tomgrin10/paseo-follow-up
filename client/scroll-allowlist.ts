/**
 * React Native ScrollView/FlatList imports that stay native (sheet-content-scrolls-with-the-sheet). Every other client
 * scroll view comes from @getpaseo/plugin/client/ui, which hands the pan gesture to the list inside a host sheet or
 * popover and is React Native's own everywhere else. Key: "<file>:<ScrollView|FlatList>"; value: why it never renders
 * inside a host sheet or popover. Guarded by tests/sheet-scroll.test.ts.
 */
export const NATIVE_SCROLL_ALLOWED: Record<string, string> = {
  "client/floating-surface.tsx:ScrollView": "Menus are in their own React Native Modal, outside the host sheet, so need their own native scroller. Nonmodal keys help is desktop-only, bounded inside its screen pane, never a host sheet.",
  "client/image-viewer.tsx:ScrollView": "The zoom view inside the viewer's own React Native Modal, above every sheet: it needs native pinch zoom (maximumZoomScale), and the kit would swap in the sheet's scroller when the viewer opens from a sheet (release notes), although the Modal is outside it.",
};
