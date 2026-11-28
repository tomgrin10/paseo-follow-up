/**
 * The agent peek's pure parts: when a line may peek, and when the peek opens, stays and closes.
 *
 * "Timeline already on screen" is ONE predicate, `timelineOnScreen`: a peek of an agent whose turn is already drawn
 * beside the pointer repeats it (Q180 A). An agent is on screen when a surface marked it (Home's selected row while its
 * pane shows Recent steps; the workspace view's selected agent) or, for a side-panel line, when it is the host's active
 * chat, the chat beside the panel. The workspace view uses the same predicate to hide its reply box there.
 *
 * The trigger (`peekStep`) is a small state machine so the timing is testable without a pointer:
 *   - intent: a line opens its peek after OPEN_MS at rest on it (pointer) or focused on it (Tab), so moving or tabbing
 *     down a list opens nothing on the way;
 *   - leaving the line or the peek closes it after CLOSE_MS grace, so the pointer can cross the gap into the peek;
 *   - moving into the peek never switches agents: lines crossed on the way only arm a takeover, which needs the same
 *     OPEN_MS rest on that line and is dropped when the pointer reaches the peek or leaves the line;
 *   - once the pointer entered the peek while it shows a permission request, it stays until closed (Esc, a click
 *     outside, Open chat, an answer) or another line takes over after its OPEN_MS rest;
 *   - where the pointer is, read from the document (`pointer`, `pointerWhere`), decides as the enter and leave events
 *     do, so an open peek closes once the pointer is outside the line and the peek even when a leave event never
 *     arrives (invariant 151, an-open-peek-closes-when-the-pointer-is-away).
 */

export const OPEN_MS = 350;
export const CLOSE_MS = 150;

export type OnScreen = { marked: ReadonlySet<string>; chatBeside: string | null };
export function timelineOnScreen(agentId: string | null | undefined, on: OnScreen): boolean {
  return !!agentId && (on.marked.has(agentId) || on.chatBeside === agentId);
}

export type PeekState = {
  open: string | null;
  /** The line waiting for its rest before it opens (or takes over). */
  pending: { id: string; at: number } | null;
  closeAt: number | null;
  inPeek: boolean;
  /** The open peek shows a permission request. */
  asking: boolean;
  /** The pointer entered the peek while it asked: no grace close. */
  sticky: boolean;
};
export const PEEK_CLOSED: PeekState = { open: null, pending: null, closeAt: null, inPeek: false, asking: false, sticky: false };

export type PeekEvent =
  | { type: "enter"; id: string; t: number }
  | { type: "leave"; t: number }
  | { type: "focus"; id: string; t: number }
  | { type: "blur"; t: number }
  | { type: "peekEnter"; t: number }
  | { type: "peekLeave"; t: number }
  | { type: "asking"; on: boolean; t: number }
  | { type: "tick"; t: number }
  /** Where the document says the pointer is: over the open line, the line arming a takeover, the peek, or none. */
  | { type: "pointer"; where: PointerWhere; t: number }
  | { type: "close" };

export type PointerWhere = "line" | "pending" | "peek" | "away";
export type Box = { left: number; top: number; right: number; bottom: number };
/** The peek first (it may overlap the line), then the open line, then the line arming a takeover. */
export function pointerWhere(p: { x: number; y: number }, b: { line: Box | null; pending: Box | null; peek: Box | null }): PointerWhere {
  const inside = (r: Box | null) => !!r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  return inside(b.peek) ? "peek" : inside(b.line) ? "line" : inside(b.pending) ? "pending" : "away";
}

const openOn = (id: string): PeekState => ({ ...PEEK_CLOSED, open: id });
const grace = (s: PeekState, t: number): PeekState => s.open && !s.inPeek && !s.sticky ? { ...s, closeAt: t + CLOSE_MS } : s;

export function peekStep(s: PeekState, e: PeekEvent): PeekState {
  switch (e.type) {
    case "enter":
      if (e.id === s.open) return { ...s, pending: null, closeAt: null };
      // Another line: arm it (a takeover while a peek is open), and keep the open peek while the pointer may be crossing.
      return { ...s, pending: { id: e.id, at: e.t + OPEN_MS }, closeAt: null };
    case "leave":
      return grace({ ...s, pending: null }, e.t);
    case "focus":
      return e.id === s.open ? { ...s, pending: null, closeAt: null } : { ...s, pending: { id: e.id, at: e.t + OPEN_MS }, closeAt: null };
    case "blur":
      return grace({ ...s, pending: null }, e.t);
    case "peekEnter":
      return s.open ? { ...s, inPeek: true, pending: null, closeAt: null, sticky: s.sticky || s.asking } : s;
    case "peekLeave":
      return grace({ ...s, inPeek: false }, e.t);
    case "asking":
      return { ...s, asking: e.on, sticky: e.on ? s.sticky || s.inPeek : false };
    case "tick": {
      if (s.pending && e.t >= s.pending.at) return openOn(s.pending.id);
      if (s.closeAt !== null && e.t >= s.closeAt) return PEEK_CLOSED;
      return s;
    }
    case "pointer":
      return pointerStep(s, e.where, e.t);
    case "close":
      return PEEK_CLOSED;
  }
}

/** The document's pointer, applied idempotently: the same state back when nothing changes (no redraw per move). */
function pointerStep(s: PeekState, where: PointerWhere, t: number): PeekState {
  if (!s.open && !s.pending) return s;
  switch (where) {
    case "peek":
      return s.open && (!s.inPeek || s.closeAt !== null || s.pending) ? peekStep(s, { type: "peekEnter", t }) : s;
    case "line":
      // On the open line: no grace, and a takeover armed elsewhere (its leave lost) is dropped.
      return s.closeAt !== null || s.pending || s.inPeek ? { ...s, pending: null, closeAt: null, inPeek: false } : s;
    case "pending":
      return s;
    case "away":
      if (s.sticky) return s.pending ? { ...s, pending: null } : s;
      if (!s.pending && !s.inPeek && (s.closeAt !== null || !s.open)) return s;
      // One grace from the first move away; later moves never push it back.
      return { ...s, pending: null, inPeek: false, closeAt: s.open ? s.closeAt ?? t + CLOSE_MS : null };
  }
}

/** When the machine next needs a tick, or null. */
export function peekDeadline(s: PeekState): number | null {
  const at = [s.pending?.at, s.closeAt ?? undefined].filter((n): n is number => typeof n === "number");
  return at.length ? Math.min(...at) : null;
}

/**
 * How long the host waits before its next tick, or null for none. Browsers fire setTimeout up to ~1 ms before its
 * delay on performance.now(), and a tick before the deadline changes nothing (the same state back), so a host that
 * re-arms only on a state change would never tick again. The host asks this when the timer fires and ticks only at 0,
 * else waits again for what is left; the 1 ms margin makes a second wait rare.
 */
export function peekWait(s: PeekState, now: number): number | null {
  const at = peekDeadline(s);
  return at === null ? null : now >= at ? 0 : Math.ceil(at - now) + 1;
}
