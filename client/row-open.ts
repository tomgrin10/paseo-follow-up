import { useCallback, useRef } from "react";

/** Rows keep one opener while Home's render callback changes; activation always reads the latest callback. */
export function useRowOpen(open: ((key: string) => void) | undefined) {
  const openRef = useRef(open); openRef.current = open;
  const onOpen = useCallback((key: string) => openRef.current?.(key), []);
  return open ? onOpen : undefined;
}

/** Desktop row activation. Native views have no DOM listener; touch keeps its single-tap selection. */
type RowClick = { pointerType?: string; target?: { closest?(selector: string): unknown } };
type RowNode = {
  addEventListener?(type: string, listener: (event: RowClick) => void): void;
  removeEventListener?(type: string, listener: (event: RowClick) => void): void;
};

export function bindRowDoubleClick(node: RowNode | null, open: () => void) {
  if (!node?.addEventListener) return;
  const onDoubleClick = (event: RowClick) => {
    if (event.pointerType === "touch") return;
    // The row itself is a button. A closer control belongs to itself, including a menu or its items.
    const control = event.target?.closest?.('button, a, input, textarea, select, [role="button"], [role="link"], [role="menu"], [role="menuitem"], [contenteditable="true"]');
    if (control !== node) return;
    open();
  };
  node.addEventListener("dblclick", onDoubleClick);
  return () => node.removeEventListener?.("dblclick", onDoubleClick);
}
