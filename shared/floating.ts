import { placeMenu } from "./row-menu";

export type FloatBox = { x: number; y: number; width: number; height: number };
export type FloatSide = "point" | "below" | "above" | "top-right";
/** Viewport coordinates throughout: portals have no transformed plugin ancestor or host clipping box. */
export function floatingPlacement(anchor: FloatBox, wanted: { width: number; height: number }, viewport: FloatBox, side: FloatSide = "point") {
  const margin = Math.min(8, viewport.width / 2, viewport.height / 2);
  const width = Math.min(wanted.width, Math.max(0, viewport.width - 2 * margin));
  const height = Math.min(wanted.height, Math.max(0, viewport.height - 2 * margin));
  const x = anchor.x - viewport.x;
  const y = anchor.y - viewport.y;
  let at;
  if (side === "point") at = placeMenu({ x, y }, { width, height }, viewport, margin);
  else {
    const below = y + anchor.height + 4, above = y - height - 8;
    const top = side === "top-right" ? y + 8 : side === "above" ? (above >= margin ? above : below) : (below + height <= viewport.height - margin ? below : above);
    const left = side === "above" ? x : x + anchor.width - width;
    at = { left: Math.max(margin, Math.min(left, viewport.width - width - margin)), top: Math.max(margin, Math.min(top, viewport.height - height - margin)) };
  }
  return { left: at.left + viewport.x, top: at.top + viewport.y, width, maxHeight: Math.max(0, viewport.height - 2 * margin) };
}

/** DOM ownership follows the probe across a portal, so the owning surface keeps its scoped keyboard shortcuts. */
export function floatingScopes<T extends { contains(other: unknown): boolean }>(root: T, document: unknown): T[] {
  const doc = document as { querySelectorAll?(q: string): Iterable<T & { getAttribute(k: string): string | null }>; getElementById?(id: string): unknown };
  const scopes = [root];
  for (const popup of doc.querySelectorAll?.("[data-floating-owner]") ?? []) {
    const id = popup.getAttribute("data-floating-owner");
    if (id && root.contains(doc.getElementById?.(id)) && !root.contains(popup)) scopes.push(popup);
  }
  return scopes;
}

/** The visible slice of a nonmodal help pane; it cannot escape local chrome without becoming modal. */
export function intersectFloatBox(a: FloatBox, b: FloatBox): FloatBox {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
