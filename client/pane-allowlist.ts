/**
 * Side-by-side layouts that stay outside ResizableSplit (side-panes-are-resizable). Every other client layout that puts
 * a fixed-width or fixed-share pane beside a flexible one draws it through `ResizableSplit` (`client/split.tsx`).
 * Key: "<file>:<what the guard matched>"; value: why it isn't a pane the developer should resize. Guarded by
 * tests/side-panes.test.ts.
 */
export const SIDE_PANE_ALLOWED: Record<string, string> = {
};
