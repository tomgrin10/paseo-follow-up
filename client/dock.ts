// What a docked pane does around a field (`a-focused-field-and-its-send-stay-in-view`): pure, so tests can run it
// without React Native. client/docked-pane.tsx wires it to focus, the keyboard and the scroll view.

/** The bit of a DOM element this needs; tests pass plain objects. */
export type DockNode = {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: DockNode | null;
  dataset?: Record<string, string | undefined>;
  style?: { scrollMarginBottom?: string; scrollMarginTop?: string };
  scrollIntoView?(o?: { block?: "nearest" | "start" | "end" | "center"; inline?: "nearest" }): void;
};

/** A field the keyboard types into. */
export const isField = (n: DockNode | null | undefined): boolean =>
  !!n && (n.tagName === "TEXTAREA" || n.tagName === "INPUT" || !!n.isContentEditable);

/**
 * What must stay on screen while `field` has focus: the nearest enclosing primary form (the field with its Send,
 * marked `dataSet={{ primaryForm: "1" }}`, PRIMARY_FORM), else the field itself.
 */
export function revealTarget(field: DockNode): DockNode {
  for (let n: DockNode | null | undefined = field; n; n = n.parentElement) if (n.dataset?.primaryForm !== undefined) return n;
  return field;
}

/** Scroll the focused field's form into view, the least distance that shows it all. Returns what it revealed. */
export function revealFocused(field: DockNode | null | undefined): DockNode | null {
  if (!isField(field)) return null;
  const target = revealTarget(field!);
  // A gutter's gap from the dock below and the header above, never flush against either.
  if (target.style) { target.style.scrollMarginBottom = `${REVEAL_GAP}px`; target.style.scrollMarginTop = `${REVEAL_GAP}px`; }
  target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return target;
}

/**
 * The dock's extras (Sign off, Sign off & next, Later; setup's Back and Continue) step aside on a phone while a field
 * in the pane has focus or the keyboard is up, so the pane's height goes to what is being typed and its Send.
 */
export const dockYields = (s: { compact: boolean; fieldFocused: boolean; keyboardUp: boolean }): boolean =>
  s.compact && (s.fieldFocused || s.keyboardUp);

/**
 * What a docked pane shows around a field. `yields`: the dock drops its extras and the header its secondary lines.
 * `typingInContent`: a field in the content (not the dock's own reply box) has focus, so the whole dock steps aside
 * and only one text box is on screen.
 */
export type DockState = { yields: boolean; typingInContent: boolean };
export const dockState = (s: { compact: boolean; fieldFocused: boolean; fieldInDock: boolean; keyboardUp: boolean }): DockState =>
  ({ yields: dockYields(s), typingInContent: s.compact && s.fieldFocused && !s.fieldInDock });

/** The gap kept between a revealed form and the dock or header (the 16 px gutter). */
export const REVEAL_GAP = 16;

/**
 * How much of the layout the on-screen keyboard covers on the web: the layout viewport below the visual one. Zero
 * when the browser resizes the page for the keyboard (the pane shrinks on its own) or no keyboard is up.
 */
export const keyboardOverlap = (v: { innerHeight: number; viewportHeight: number; offsetTop: number }): number =>
  Math.max(0, Math.round(v.innerHeight - v.viewportHeight - v.offsetTop));

/** Above this, a shrunken visual viewport is the keyboard, not browser chrome sliding in. */
export const KEYBOARD_MIN = 150;

/**
 * The marker a primary form carries: spread it on the View holding a field and its Send. React Native web turns
 * dataSet into data-* attributes (dataset.primaryForm); its types don't list dataSet, hence the spread.
 */
export const PRIMARY_FORM = { dataSet: { primaryForm: "1" } } as object;

/**
 * Native (`the-keyboard-never-covers-a-field`): what to do so the focused field shows above the keyboard. Window
 * coordinates throughout. `room`: what stays clear under the field (its Send, for a primary form). With a scroll view
 * around the field, scroll it (as far as its content goes), and lift the whole room by what scrolling can't cover,
 * never so far that the field's top leaves the screen. A field that already shows does nothing.
 */
export function revealPlan(i: {
  fieldTop: number; fieldBottom: number; keyboardTop: number; room: number;
  scroll?: { top: number; bottom: number; offset: number; maxOffset: number } | null;
}): { scrollTo: number | null; lift: number } {
  const s = i.scroll ?? null;
  const visibleBottom = Math.min(i.keyboardTop, s ? s.bottom : Infinity);
  const visibleTop = s ? s.top : 0;
  if (i.fieldBottom <= visibleBottom && i.fieldTop >= visibleTop) return { scrollTo: null, lift: 0 };
  // Above the scroll view's top edge (the field scrolled away): bring its top back under the edge.
  if (s && i.fieldTop < visibleTop) {
    const up = Math.min(s.offset, visibleTop + REVEAL_GAP - i.fieldTop);
    return { scrollTo: up > 0 ? Math.round(s.offset - up) : null, lift: 0 };
  }
  const want = i.fieldBottom - (visibleBottom - Math.max(REVEAL_GAP, i.room));
  const take = s ? Math.max(0, Math.min(want, s.maxOffset - s.offset)) : 0;
  const top = i.fieldTop - take, bottom = i.fieldBottom - take;
  const covered = bottom - (i.keyboardTop - REVEAL_GAP);
  const lift = bottom > i.keyboardTop ? Math.max(0, Math.min(covered, top - REVEAL_GAP)) : 0;
  return { scrollTo: take > 0 ? Math.round(s!.offset + take) : null, lift: Math.round(lift) };
}

/** How much of a room (its bottom edge at `roomBottom`) the keyboard covers; 0 with no keyboard. Window coordinates. */
export const roomOverlap = (roomBottom: number | null, keyboardTop: number | null): number =>
  roomBottom === null || keyboardTop === null ? 0 : Math.max(0, Math.round(roomBottom - keyboardTop));
